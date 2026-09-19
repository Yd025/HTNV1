"""FastAPI owns one controller; optional consumers never run on its tick path."""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

import anyio
import sentry_sdk
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from sentry_sdk.integrations.fastapi import FastApiIntegration
from sentry_sdk.integrations.logging import LoggingIntegration
from sentry_sdk.integrations.starlette import StarletteIntegration

import db
from ai_orchestrator import OverwatchDAG
from brain import ADVISOR_EVERY_S, SwarmBrain

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logger = logging.getLogger("overwatch")

SENTRY_DSN = os.getenv("SENTRY_DSN") or None
CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "http://localhost:3000").split(",") if o.strip()]
DB_TIMEOUT_S = float(os.getenv("DB_TIMEOUT_SEC", "2"))
DB_RETRY_S = float(os.getenv("DB_RETRY_SEC", "15"))
WS_TIMEOUT_S = float(os.getenv("WS_SEND_TIMEOUT_SEC", "2"))
ADVISOR_TIMEOUT_S = float(os.getenv("ADVISOR_TIMEOUT_SEC", "12"))
STATE_STALE_S = float(os.getenv("STATE_STALE_SEC", "3"))
SHUTDOWN_TIMEOUT_S = float(os.getenv("SHUTDOWN_TIMEOUT_SEC", "5"))

_sentry_kwargs = {
    "dsn": SENTRY_DSN,
    "environment": os.getenv("SENTRY_ENVIRONMENT", "hackathon"),
    "integrations": [
        StarletteIntegration(transaction_style="endpoint"),
        FastApiIntegration(transaction_style="endpoint"),
        LoggingIntegration(level=logging.INFO, event_level=logging.ERROR),
    ],
    "traces_sample_rate": 1.0,
    "profiles_sample_rate": 1.0,
    "enable_tracing": True,
    "send_default_pii": False,
}
try:
    sentry_sdk.init(**_sentry_kwargs, enable_logs=True)
except TypeError:
    sentry_sdk.init(**_sentry_kwargs)


def _replace_latest(queue: asyncio.Queue, value: Any) -> None:
    """Keep one pending state: slow consumers must not accumulate history."""
    if queue.full():
        queue.get_nowait()
    queue.put_nowait(value)


class Hub:
    def __init__(self) -> None:
        self.brain = SwarmBrain()
        self.dag: OverwatchDAG | None = None
        self.latest: dict[str, Any] = {}
        self.last_state_at: float | None = None
        self.brain_error: str | None = None
        self.database_status = "warming" if db.enabled() and getattr(self.brain, "mode", None) != "replay" else "disabled"
        self.advisor_status = "idle"
        self.tasks: set[asyncio.Task] = set()
        self.brain_task: asyncio.Task | None = None
        self.advice_task: asyncio.Task | None = None
        self.clients: dict[WebSocket, asyncio.Queue] = {}
        self.db_queue: asyncio.Queue = asyncio.Queue(maxsize=1)
        self._last_db = float("-inf")
        self._published_status = "warming"
        self.closing = False

    def start_task(self, coroutine: Any, name: str) -> asyncio.Task:
        task = asyncio.create_task(coroutine, name=name)
        self.tasks.add(task)
        task.add_done_callback(self._task_done)
        return task

    def _task_done(self, task: asyncio.Task) -> None:
        self.tasks.discard(task)
        if not task.cancelled():
            # An HTTP caller can disconnect while its shielded advisor continues.
            # Retrieve failures even when no caller remains to await that task.
            task.exception()

    def publish(self, state: dict[str, Any]) -> None:
        """Called by the brain: no network, database, model, or blocking await."""
        self.latest = state
        now = asyncio.get_running_loop().time()
        self.last_state_at = now
        if self.database_status != "disabled" and now - self._last_db >= 1.0:
            self._last_db = now
            _replace_latest(self.db_queue, state)
        self.broadcast_telemetry()

    def broadcast_telemetry(self) -> None:
        payload = self.telemetry()
        self._published_status = payload["status"]
        self.broadcast(payload)

    def broadcast(self, payload: dict[str, Any]) -> None:
        for queue in tuple(self.clients.values()):
            _replace_latest(queue, payload)

    def status(self) -> str:
        if getattr(self.brain, "completed", False):
            return "complete"
        if self.brain_error or (self.brain_task is not None and self.brain_task.done()):
            return "failed"
        if getattr(self.brain, "last_error", None):
            return "failed"
        if self.last_state_at is None:
            return "warming"
        if asyncio.get_running_loop().time() - self.last_state_at > STATE_STALE_S:
            return "stale"
        return "ok"

    def recording_status(self) -> dict[str, Any]:
        recorder = getattr(self.brain, "recorder", None)
        return recorder.status if recorder else {"enabled": False}

    def telemetry(self) -> dict[str, Any]:
        status = self.status()
        if not self.latest:
            return {"status": status, "deployed": False}
        return {
            **self.latest,
            "status": status,
            "deployed": self.brain.connected and status == "ok",
            "recording": self.recording_status(),
        }

    async def send_states(self, ws: WebSocket, queue: asyncio.Queue) -> None:
        try:
            while True:
                payload = await queue.get()
                await asyncio.wait_for(ws.send_json(_jsonable(payload)), WS_TIMEOUT_S)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.info("telemetry client disconnected or exceeded send timeout")
        finally:
            self.clients.pop(ws, None)
            try:
                await asyncio.wait_for(ws.close(), WS_TIMEOUT_S)
            except Exception:
                pass

    async def advise(self) -> dict[str, Any]:
        if self.closing:
            raise RuntimeError("backend is stopping")
        # No await between checking and assigning: manual/background requests share
        # one in-flight call, and cancelling an HTTP request does not orphan it.
        if self.advice_task is None or self.advice_task.done():
            self.advice_task = self.start_task(self._compute_advice(), "advisor-request")
        return await asyncio.shield(self.advice_task)

    async def _compute_advice(self) -> dict[str, Any]:
        self.advisor_status = "running"
        try:
            if self.dag is None:
                self.dag = OverwatchDAG()
            advice = await asyncio.wait_for(
                self.dag.advise(_advisor_input(self.latest)), ADVISOR_TIMEOUT_S
            )
            self.brain.world.advisor = advice
            self.brain.world.post("fusion", "allocator", "advice", {"rationale": advice.get("rationale")})
            self.broadcast({"type": "strategy", "data": advice})
            self.advisor_status = "ok"
            return advice
        except asyncio.CancelledError:
            self.advisor_status = "stopped"
            raise
        except Exception:
            self.advisor_status = "unavailable"
            raise

    async def close(self) -> None:
        self.closing = True
        tasks = tuple(self.tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.clients.clear()
        try:
            await asyncio.wait_for(self.brain.close(), SHUTDOWN_TIMEOUT_S)
        except Exception:
            logger.exception("brain cleanup failed")
        try:
            await asyncio.wait_for(db.close_pool(), SHUTDOWN_TIMEOUT_S)
        except Exception:
            logger.exception("database cleanup failed")


@asynccontextmanager
async def lifespan(application: FastAPI):
    hub = Hub()
    application.state.hub = hub
    try:
        hub.brain_task = hub.start_task(_brain_loop(hub), "swarm-brain")
        hub.start_task(_status_loop(hub), "controller-status")
        hub.start_task(_advisor_loop(hub), "slow-advisor")
        if hub.database_status != "disabled":
            hub.start_task(_database_loop(hub), "database-ingest")
        logger.info("Overwatch backend starting adapter=%s", hub.brain.adapter.name)
        yield
    finally:
        await hub.close()
        application.state.hub = None


app = FastAPI(title="Operation Overwatch", version="0.2.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _hub(connection: Request | WebSocket) -> Hub:
    hub = getattr(connection.app.state, "hub", None)
    if hub is None:
        raise HTTPException(status_code=503, detail="backend is not running")
    return hub


@app.get("/health")
async def health(request: Request) -> dict[str, Any]:
    hub = _hub(request)
    latest = hub.latest
    status = hub.status()
    return {
        "backend": status,
        "deployed": hub.brain.connected and status == "ok",
        "adapter": getattr(hub.brain.adapter, "name", None),
        "postgres": hub.database_status == "ok",
        "database_status": hub.database_status,
        "advisor_status": hub.advisor_status,
        "run": latest.get("run"),
        "recording": hub.recording_status(),
        "heartbeat": latest.get("heartbeat"),
        "state_age_s": None if hub.last_state_at is None else round(asyncio.get_running_loop().time() - hub.last_state_at, 3),
        "tick_hz": latest.get("tick_hz"),
        "vehicle_count": len(latest.get("fleet") or {}),
        "last_detect_at": hub.brain.last_detect_at,
        "last_command_at": hub.brain.last_command_at,
        "scores": latest.get("scores"),
        "sentry": bool(SENTRY_DSN),
    }


@app.get("/cameras")
async def cameras(request: Request) -> list[dict[str, Any]]:
    catalog = getattr(_hub(request).brain.adapter, "camera_catalog", None)
    return catalog() if catalog is not None else []


@app.get("/cameras/{cam_id}/snapshot.jpg")
async def camera_snapshot(cam_id: str, request: Request) -> Response:
    # A globally known WHITEOUT camera is not active in local or replay mode.
    active = await cameras(request)
    if not any(camera.get("vehicle_id") == cam_id for camera in active):
        raise HTTPException(status_code=404, detail="unknown camera")
    from sim.cameras import grab_jpeg, spec_for

    spec = spec_for(cam_id)
    if spec is None:
        raise HTTPException(status_code=404, detail="unknown camera")
    import httpx

    async with httpx.AsyncClient(timeout=2.0) as client:
        jpeg = await grab_jpeg(spec, client)
    if not jpeg:
        return Response(status_code=204)
    return Response(content=jpeg, media_type="image/jpeg", headers={"Cache-Control": "no-store"})


@app.get("/telemetry/latest")
async def telemetry_latest(request: Request) -> dict[str, Any]:
    return _hub(request).telemetry()


@app.get("/strategy/latest")
async def strategy_latest(request: Request) -> dict[str, Any]:
    return _hub(request).brain.world.advisor or {"status": "none"}


@app.post("/strategy/run")
async def strategy_run(request: Request) -> dict[str, Any]:
    hub = _hub(request)
    if getattr(hub.brain, "mode", None) == "replay":
        raise HTTPException(status_code=409, detail="advisor is disabled during replay")
    if hub.status() != "ok":
        raise HTTPException(status_code=503, detail="fresh telemetry is unavailable")
    try:
        return await hub.advise()
    except TimeoutError as exc:
        raise HTTPException(status_code=504, detail="advisor timed out") from exc
    except Exception as exc:
        logger.exception("advisor request failed")
        raise HTTPException(status_code=503, detail="advisor unavailable") from exc


@app.websocket("/ws/telemetry")
async def ws_telemetry(ws: WebSocket) -> None:
    hub = _hub(ws)
    await ws.accept()
    queue: asyncio.Queue = asyncio.Queue(maxsize=1)
    hub.clients[ws] = queue
    _replace_latest(queue, hub.telemetry())
    sender = hub.start_task(hub.send_states(ws, queue), "telemetry-send")

    async def receive() -> None:
        try:
            while True:
                await ws.receive_text()
        except WebSocketDisconnect:
            pass

    receiver = hub.start_task(receive(), "telemetry-receive")
    try:
        await asyncio.wait((sender, receiver), return_when=asyncio.FIRST_COMPLETED)
    finally:
        hub.clients.pop(ws, None)
        sender.cancel()
        receiver.cancel()
        # ASGI servers may cancel the endpoint immediately after disconnect.
        # Finish the child cleanup without that scope cancelling gather again
        # and replacing the server's cancellation with a child CancelledError.
        with anyio.CancelScope(shield=True):
            await asyncio.gather(sender, receiver, return_exceptions=True)


async def _brain_loop(hub: Hub) -> None:
    try:
        await hub.brain.run_forever(on_state=hub.publish)
        if not getattr(hub.brain, "completed", False):
            hub.brain_error = "controller stopped"
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        hub.brain_error = type(exc).__name__
        logger.exception("brain startup or loop failed")
        sentry_sdk.capture_exception()
    finally:
        if not hub.closing:
            hub.broadcast_telemetry()


async def _status_loop(hub: Hub) -> None:
    """Notify connected clients when no successful tick can publish a change."""
    while True:
        await asyncio.sleep(0.25)
        if hub.closing:
            return
        status = hub.status()
        # Completion is published by _brain_loop after recorder/adapter cleanup,
        # so clients receive the final evidence status with the terminal state.
        if status == "complete" and hub.brain_task is not None and not hub.brain_task.done():
            continue
        if status != hub._published_status:
            hub.broadcast_telemetry()


async def _database_loop(hub: Hub) -> None:
    while True:
        try:
            async def prepare() -> None:
                await db.init_pool()
                await db.ensure_schema()

            await asyncio.wait_for(prepare(), DB_TIMEOUT_S)
            hub.database_status = "ok"
            while True:
                state = await hub.db_queue.get()
                await asyncio.wait_for(_ingest_state(state), DB_TIMEOUT_S)
        except asyncio.CancelledError:
            raise
        except Exception:
            hub.database_status = "unavailable"
            logger.warning("database unavailable; controller continues", exc_info=True)
            try:
                await asyncio.wait_for(db.close_pool(), DB_TIMEOUT_S)
            except Exception:
                logger.warning("database reset failed", exc_info=True)
            await asyncio.sleep(DB_RETRY_S)


async def _ingest_state(state: dict[str, Any]) -> None:
    await db.ingest_score(state.get("scores") or {})
    for sample in (state.get("fleet") or {}).values():
        if sample.get("lat") is not None:
            await db.ingest_telemetry({**sample, "msg_type": "FLEET", "payload": {"role": sample.get("role")}})


async def _advisor_loop(hub: Hub) -> None:
    await asyncio.sleep(8)
    while True:
        try:
            if hub.status() == "ok" and getattr(hub.brain, "mode", None) != "replay":
                await hub.advise()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("advisor loop error")
            sentry_sdk.capture_exception()
        await asyncio.sleep(ADVISOR_EVERY_S)


def _advisor_input(snapshot: dict[str, Any]) -> dict[str, Any]:
    """Positive field allowlists exclude evaluation truth and future debug fields."""
    fleet_fields = {
        "vehicle_id", "vehicle_class", "lat", "lon", "alt", "heading",
        "groundspeed", "battery_remaining", "armed", "mode", "role", "connected",
    }
    track_fields = {
        "lat", "lon", "vn", "ve", "speed_mps", "class_hint", "confidence",
        "age_s", "hits", "sigma_m", "status",
    }

    def select(value: dict[str, Any], fields: set[str]) -> dict[str, Any]:
        return {key: item for key, item in value.items() if key in fields and isinstance(item, (str, int, float, bool, type(None)))}

    fleet = {key: select(value, fleet_fields) for key, value in (snapshot.get("fleet") or {}).items()}
    track = snapshot.get("track")
    return {"fleet": fleet, "track": select(track, track_fields) if track else None}


def _jsonable(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat()
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    return value
