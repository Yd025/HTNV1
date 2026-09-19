"""10 Hz swarm brain. Deterministic controller. LLM is a slow advisor only."""

from __future__ import annotations

import asyncio
import logging
import os
import platform
import subprocess
import time
import uuid
import hashlib
from dataclasses import asdict
from pathlib import Path
from typing import Any, Callable

try:
    import sentry_sdk
except ImportError:  # local eval without Docker deps
    from contextlib import nullcontext

    class sentry_sdk:  # type: ignore[no-redef]
        @staticmethod
        def start_span(**_kwargs):
            return nullcontext()

        @staticmethod
        def capture_exception(_exc=None):
            return None

from agents import MissionCommand, Squad
from evidence import ObservationGate
from metrics import MetricsEngine, Scorecard
from sim.adapter import build_adapter
from sim.types import Command, SimAdapter
from tracker import TargetTracker
from world import WorldModel

logger = logging.getLogger("overwatch.brain")

TICK_HZ = float(os.getenv("BRAIN_HZ", "10"))
ADVISOR_EVERY_S = float(os.getenv("STRATEGY_INTERVAL_SEC", "15"))


class SwarmBrain:
    def __init__(self, adapter: SimAdapter | None = None) -> None:
        self.adapter = adapter or build_adapter()
        self.world = WorldModel()
        self.tracker = TargetTracker()
        self.squad = Squad()
        self.c2 = MissionCommand()
        self.metrics: MetricsEngine | None = None
        self.score = Scorecard()
        self.connected = False
        self.last_detect_at: float | None = None
        self.last_command_at: float | None = None
        self.commands_last: list[Command] = []
        self._ticks = 0
        self._hz_t = time.monotonic()
        self.run_id = uuid.uuid4().hex
        self.mode = getattr(self.adapter, "mode", "live" if self.adapter.name == "whiteout" else "synthetic")
        self.sequence = 0
        self._published_sequence = 0
        self._started = time.monotonic()
        self._gate = ObservationGate()
        self._sent: dict[str, tuple[tuple, float, str]] = {}
        self._desired: dict[str, tuple[tuple, str]] = {}
        self.command_outcomes: list[dict] = []
        self.observation_status: dict = {}
        self.recorder = None
        self.completed = False
        self.last_error: str | None = None
        self._closed = False
        self._truth: tuple[float, float] | None = None
        self.search_planner = None
        self._search_sample_time_s: float | None = None
        self._search_commands: dict[str, Command] = {}
        self._search_detected = False

    async def connect(self) -> None:
        if self._closed:
            raise RuntimeError("A closed brain cannot be restarted; create a fresh SwarmBrain for a new run")
        if self.connected:
            return
        search_policy = getattr(self.adapter, "search_policy", None)
        if search_policy and (self.adapter.name != "local" or self.mode != "synthetic"):
            raise ValueError("Search policies are supported only by the local synthetic adapter")
        await self.adapter.connect()
        if search_policy:
            from search_policy import SearchPlanner
            self.search_planner = SearchPlanner(self.adapter.arena(), algorithm=search_policy["algorithm"], **search_policy["planner"])
            self._search_sample_time_s = None
            self._search_commands.clear()
            self._search_detected = False
        self.metrics = MetricsEngine(self.adapter.arena())
        self._started = time.monotonic()
        record_dir = os.getenv("RUN_LOG_DIR", "").strip()
        if record_dir:
            from recording import RunRecorder

            try:
                revision = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, timeout=2).stdout.strip() or None
            except (OSError, subprocess.TimeoutExpired):
                revision = None
            source_hash = hashlib.sha256()
            source_root = Path(__file__).parent
            for source_file in sorted(source_root.rglob("*.py")):
                if "tests" not in source_file.relative_to(source_root).parts:
                    source_hash.update(source_file.relative_to(source_root).as_posix().encode())
                    source_hash.update(source_file.read_bytes())
            manifest = {
                "run_id": self.run_id, "mode": self.mode, "source": self.adapter.name,
                "arena": asdict(self.adapter.arena()), "source_revision": revision,
                "source_sha256": source_hash.hexdigest(),
                "python_version": platform.python_version(),
                "scenario": os.getenv("RUN_SCENARIO", "unspecified"),
                "search_policy": search_policy,
                "settings": {"brain_hz": TICK_HZ, "observation_max_age_s": self._gate.max_age_s,
                             "command_refresh_s": 1.0, "tracker_gate_m": self.tracker.gate_m},
            }
            self.recorder = RunRecorder(manifest, record_dir)
            await self.recorder.start()
        self.connected = True
        logger.info("brain online adapter=%s", getattr(self.adapter, "name", "?"))

    async def tick(self) -> dict[str, Any]:
        try:
            return await self._tick()
        except StopAsyncIteration:
            raise
        except BaseException as exc:
            if self.recorder:
                self.recorder.invalidate(f"incomplete tick {self.sequence}: {type(exc).__name__}")
            raise

    async def _tick(self) -> dict[str, Any]:
        with sentry_sdk.start_span(op="bt.tick", name="swarm_tick"):
            vehicles = await self.adapter.list_vehicles()
            raw_vehicles = [v.as_dict() for v in vehicles]
            vehicle_ids = {v.vehicle_id for v in vehicles}
            self._sent = {k: v for k, v in self._sent.items() if k in vehicle_ids}
            self._desired = {k: v for k, v in self._desired.items() if k in vehicle_ids}
            raw_detections = await self.adapter.poll_detections()
            if self.mode == "replay":
                self.world.advisor = getattr(self.adapter, "current_advisor", None)
            receipt_time = getattr(self.adapter, "observation_now", time.time())
            elapsed_s = getattr(self.adapter, "elapsed_s", time.monotonic() - self._started)
            comms = {v.vehicle_id: self.adapter.comms_ok(v.vehicle_id) for v in vehicles}
            detections, rejected = self._gate.filter(raw_detections, receipt_time, self.mode)
            self.observation_status = {
                "received": len(raw_detections), "forwarded": len(detections), "rejected": rejected,
                "latest_age_s": max(0.0, receipt_time - max(d.timestamp for d in detections)) if detections else None,
                "basis": "receipt time unless capture_unix explicitly supplied",
            }
            self.world.vehicles = {v.vehicle_id: v for v in vehicles}
            self.world.detections = detections
            if detections:
                self.last_detect_at = time.time()
                if self.search_planner:
                    self._search_detected = True
                    self._search_commands.clear()

            with sentry_sdk.start_span(op="track.update", name="target_track"):
                self.world.track = self.tracker.update(detections, now=self._started + elapsed_s)

            roles = self.c2.tick(vehicles, self.world.track, self.world.advisor, self.world)
            self.world.set_roles(roles)
            for v in vehicles:
                v.role = roles.get(v.vehicle_id, v.role)

            cmds: list[Command] = []
            self.command_outcomes = []
            # Placement experiments affect FIND only. Existing C2 and platform
            # agents retain acquisition/handoff/tracking, through this dispatcher.
            search_commands = {}
            if self.search_planner and not (self._search_detected or self.world.track or self.world.detections or self.world.last_cue):
                sample_time_s = getattr(self.adapter, "search_sample_time_s", None)
                if sample_time_s is not None and sample_time_s != self._search_sample_time_s:
                    self._search_commands = {c.vehicle_id: c for c in self.search_planner.commands(vehicles, sample_time_s)}
                    self._search_sample_time_s = sample_time_s
                # Empty polls between sampled observations are not negative
                # evidence. Existing dispatch suppression handles cached goals.
                search_commands = self._search_commands
            for v in vehicles:
                if not comms[v.vehicle_id]:
                    continue
                decision = self.squad.tick(v, self.world)
                for call in decision.calls:
                    self.world.post(v.vehicle_id, call.recipient, call.kind, call.body)
                cmd = search_commands.get(v.vehicle_id, decision.command)
                if cmd:
                    cmds.append(cmd)
            for cmd in cmds:
                signature = (cmd.type, cmd.lat, cmd.lon, cmd.alt, cmd.sector)
                previous = self._sent.get(cmd.vehicle_id)
                desired = self._desired.get(cmd.vehicle_id)
                now = time.monotonic()
                same = previous is not None and previous[0] == signature
                cmd.command_id = desired[1] if desired and desired[0] == signature else f"{self.run_id}:{uuid.uuid4().hex}:{cmd.vehicle_id}"
                self._desired[cmd.vehicle_id] = (signature, cmd.command_id)
                if same and now - previous[1] < 1.0:
                    self.command_outcomes.append({"command_id": cmd.command_id, "vehicle_id": cmd.vehicle_id, "status": "suppressed"})
                    continue
                with sentry_sdk.start_span(op="adapter.send", name=cmd.vehicle_id):
                    try:
                        await asyncio.wait_for(self.adapter.send_command(cmd), timeout=0.5)
                    except asyncio.CancelledError:
                        raise
                    except Exception as exc:
                        self.command_outcomes.append({"command_id": cmd.command_id, "vehicle_id": cmd.vehicle_id, "status": "dispatch_error", "error": type(exc).__name__})
                        continue
                self._sent[cmd.vehicle_id] = (signature, now, cmd.command_id)
                self.command_outcomes.append({"command_id": cmd.command_id, "vehicle_id": cmd.vehicle_id, "status": "dispatched"})
                if self.metrics:
                    self.metrics.note_command()
                self.last_command_at = receipt_time
                self.world.last_command = cmd.as_dict()
            self.commands_last = cmds

            truth = self.adapter.truth_target()
            self._truth = truth
            if self.metrics:
                self.score = self.metrics.update(vehicles, self.world.track, truth, now=self._started + elapsed_s)

            self._ticks += 1
            now = time.monotonic()
            if now - self._hz_t >= 1.0:
                self.world.tick_hz = self._ticks / (now - self._hz_t)
                self._ticks = 0
                self._hz_t = now
            self.last_error = None
            self._published_sequence = self.sequence
            state = self.snapshot()
            if self.recorder:
                self.recorder.offer({
                    "sequence": self.sequence, "elapsed_s": elapsed_s, "recorded_at": receipt_time,
                    "vehicles": raw_vehicles, "detections": [d.as_dict() for d in raw_detections],
                    "comms": comms, "accepted": [d.observation_id for d in detections], "rejected": rejected,
                    "commands": [c.as_dict() for c in cmds], "outcomes": self.command_outcomes,
                    "track": state["track"], "scores": state["scores"],
                    "advisor": self.world.advisor, "evaluation_truth": _truth_dict(truth),
                })
            self.sequence += 1
            return state

    def snapshot(self) -> dict[str, Any]:
        track = self.world.track.as_dict() if self.world.track else None
        heatmap = self.metrics.heatmap if self.metrics else []
        scores = self.score.as_dict()
        if self._truth is None:
            # Metrics owner retains the legacy heuristic internally. Do not expose
            # uncertainty/confidence as measured tracking accuracy on the wire.
            scores["tracking"] = None
            scores["track_error_m"] = None
        return {
            "type": "state",
            "adapter": getattr(self.adapter, "name", "unknown"),
            "deployed": self.connected,
            "heartbeat": time.time(),
            "tick_hz": round(self.world.tick_hz, 2),
            "scores": scores,
            "run": {"run_id": self.run_id, "mode": self.mode, "source": self.adapter.name, "sequence": self._published_sequence,
                    "clock": "Unix receipt timestamps; monotonic control intervals",
                    "evaluation_truth_available": self._truth is not None,
                    "source_run_id": getattr(self.adapter, "manifest", {}).get("run_id")},
            "search_experiment": {"enabled": self.search_planner is not None,
                                  "mode": "synthetic" if self.search_planner else None,
                                  "algorithm": getattr(self.adapter, "search_policy", {}).get("algorithm") if getattr(self.adapter, "search_policy", None) else None},
            "observations": self.observation_status,
            "command_outcomes": self.command_outcomes,
            "recording": self.recorder.status if self.recorder else {"enabled": False},
            "fleet": {k: v.as_dict() for k, v in self.world.vehicles.items()},
            "detections": [d.as_dict() for d in self.world.detections[-12:]],
            "track": track,
            "truth": _truth_dict(self._truth),
            "heatmap": sorted(heatmap, key=lambda c: -c.get("heat", 0))[:80],
            "blackboard": self.world.blackboard[-12:],
            "advisor": self.world.advisor,
            "c2": self.c2.snapshot(),
            "intents": self.squad.intents(),
            "commands": [c.as_dict() for c in self.commands_last],
            "arena": {
                "origin_lat": self.adapter.arena().origin_lat,
                "origin_lon": self.adapter.arena().origin_lon,
                "half_m": self.adapter.arena().half_m,
                "heading_offset_deg": getattr(self.adapter.arena(), "heading_offset_deg", 0.0),
            },
        }

    async def run_forever(self, on_state: Callable[[dict[str, Any]], Any] | None = None) -> None:
        try:
            await self.connect()
            period = 1.0 / max(1.0, TICK_HZ)
            while True:
                t0 = time.monotonic()
                try:
                    state = await self.tick()
                    if on_state:
                        result = on_state(state)
                        if asyncio.iscoroutine(result):
                            await result
                except StopAsyncIteration:
                    self.completed = True
                    return
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    self.last_error = type(exc).__name__
                    logger.exception("brain tick failed")
                    sentry_sdk.capture_exception()
                delay = period - (time.monotonic() - t0)
                if delay > 0:
                    await asyncio.sleep(delay)
        finally:
            await self.close()

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self.connected = False
        try:
            close = getattr(self.adapter, "close", None)
            if close:
                await close()
        finally:
            if self.recorder:
                await self.recorder.close()


def _truth_dict(pair: tuple[float, float] | None) -> dict[str, float] | None:
    if not pair:
        return None
    return {"lat": pair[0], "lon": pair[1]}
