"""Operation: Overwatch — FastAPI process wrapping the 10 Hz swarm brain."""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Any

import sentry_sdk
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from sentry_sdk.integrations.fastapi import FastApiIntegration
from sentry_sdk.integrations.logging import LoggingIntegration
from sentry_sdk.integrations.starlette import StarletteIntegration

import db
from ai_orchestrator import OverwatchDAG
from brain import ADVISOR_EVERY_S, SwarmBrain
from sim.adapter import build_adapter

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logger = logging.getLogger("overwatch")

SENTRY_DSN = os.getenv("SENTRY_DSN") or None
CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "http://localhost:3000").split(",") if o.strip()]

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


class Hub:
    def __init__(self) -> None:
        self.clients: set[WebSocket] = set()
        self.brain = SwarmBrain(build_adapter())
        self.dag = OverwatchDAG()
        self.latest: dict[str, Any] = {}
        self._last_db = 0.0

    async def broadcast(self, payload: dict[str, Any]) -> None:
        dead: list[WebSocket] = []
        for ws in list(self.clients):
            try:
                await ws.send_json(payload)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)


hub = Hub()


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await db.init_pool()
    await db.ensure_schema()
    loop = asyncio.get_running_loop()
    brain_task = loop.create_task(_brain_loop(), name="swarm-brain")
    advisor_task = loop.create_task(_advisor_loop(), name="slow-advisor")
    logger.info("Overwatch backend online adapter=%s", hub.brain.adapter.name)
    try:
        yield
    finally:
        brain_task.cancel()
        advisor_task.cancel()
        await db.close_pool()


app = FastAPI(title="Operation Overwatch", version="0.2.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, Any]:
    latest = hub.latest
    return {
        "backend": "ok",
        "deployed": hub.brain.connected,
        "adapter": getattr(hub.brain.adapter, "name", None),
        "postgres": await db.ping(),
        "heartbeat": latest.get("heartbeat"),
        "tick_hz": latest.get("tick_hz"),
        "vehicle_count": len(latest.get("fleet") or {}),
        "last_detect_at": hub.brain.last_detect_at,
        "last_command_at": hub.brain.last_command_at,
        "scores": latest.get("scores"),
        "sentry": bool(SENTRY_DSN),
    }


@app.get("/telemetry/latest")
async def telemetry_latest() -> dict[str, Any]:
    return hub.latest or {"status": "warming"}


@app.get("/strategy/latest")
async def strategy_latest() -> dict[str, Any]:
    return hub.brain.world.advisor or {"status": "none"}


@app.post("/strategy/run")
async def strategy_run() -> dict[str, Any]:
    advice = await hub.dag.advise(hub.latest)
    hub.brain.world.advisor = advice
    hub.brain.world.post("fusion", "allocator", "advice", {"rationale": advice.get("rationale")})
    await hub.broadcast({"type": "strategy", "data": _jsonable(advice)})
    return advice


@app.websocket("/ws/telemetry")
async def ws_telemetry(ws: WebSocket) -> None:
    await ws.accept()
    hub.clients.add(ws)
    if hub.latest:
        await ws.send_json(_jsonable(hub.latest))
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        hub.clients.discard(ws)
    except Exception:
        hub.clients.discard(ws)


async def _brain_loop() -> None:
    async def push(state: dict[str, Any]) -> None:
        hub.latest = state
        now = asyncio.get_running_loop().time()
        if now - hub._last_db >= 1.0:
            hub._last_db = now
            try:
                await db.ingest_score(state.get("scores") or {})
                for sample in (state.get("fleet") or {}).values():
                    if sample.get("lat") is not None:
                        await db.ingest_telemetry(
                            {
                                **sample,
                                "msg_type": "FLEET",
                                "payload": {"role": sample.get("role")},
                            }
                        )
            except Exception:
                logger.exception("score ingest failed")
        await hub.broadcast(_jsonable(state))

    await hub.brain.run_forever(on_state=push)


async def _advisor_loop() -> None:
    await asyncio.sleep(8)
    while True:
        try:
            if hub.latest:
                advice = await hub.dag.advise(hub.latest)
                hub.brain.world.advisor = advice
                hub.brain.world.post("fusion", "allocator", "advice", {"rationale": advice.get("rationale")})
                await hub.broadcast({"type": "strategy", "data": _jsonable(advice)})
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("advisor loop error")
            sentry_sdk.capture_exception()
        await asyncio.sleep(ADVISOR_EVERY_S)


def _jsonable(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat()
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_jsonable(v) for v in value]
    return value
