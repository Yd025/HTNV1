"""10 Hz swarm brain. Deterministic controller. LLM is a slow advisor only."""

from __future__ import annotations

import asyncio
import logging
import os
import time
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

    async def connect(self) -> None:
        await self.adapter.connect()
        self.metrics = MetricsEngine(self.adapter.arena())
        self.connected = True
        logger.info("brain online adapter=%s", getattr(self.adapter, "name", "?"))

    async def tick(self) -> dict[str, Any]:
        with sentry_sdk.start_span(op="bt.tick", name="swarm_tick"):
            vehicles = await self.adapter.list_vehicles()
            detections = await self.adapter.poll_detections()
            self.world.vehicles = {v.vehicle_id: v for v in vehicles}
            self.world.detections = detections
            if detections:
                self.last_detect_at = time.time()

            with sentry_sdk.start_span(op="track.update", name="target_track"):
                self.world.track = self.tracker.update(detections)

            roles = self.c2.tick(vehicles, self.world.track, self.world.advisor, self.world)
            self.world.set_roles(roles)
            for v in vehicles:
                v.role = roles.get(v.vehicle_id, v.role)

            prev_by_id = {c.vehicle_id: c for c in self.commands_last}
            cmds: list[Command] = []
            for v in vehicles:
                if not self.adapter.comms_ok(v.vehicle_id):
                    continue
                decision = self.squad.tick(v, self.world)
                for call in decision.calls:
                    self.world.post(v.vehicle_id, call.recipient, call.kind, call.body)
                cmd = decision.command
                if cmd:
                    cmds.append(cmd)
                    prev = prev_by_id.get(v.vehicle_id)
                    changed = (
                        prev is None
                        or prev.lat != cmd.lat
                        or prev.lon != cmd.lon
                        or prev.type != cmd.type
                    )
                    if changed and self.metrics:
                        self.metrics.note_command()
            for cmd in cmds:
                with sentry_sdk.start_span(op="adapter.send", name=cmd.vehicle_id):
                    await self.adapter.send_command(cmd)
            if cmds:
                self.last_command_at = time.time()
                self.commands_last = cmds
                self.world.last_command = cmds[0].as_dict()

            truth = self.adapter.truth_target()
            if self.metrics:
                self.score = self.metrics.update(vehicles, self.world.track, truth)

            self._ticks += 1
            now = time.monotonic()
            if now - self._hz_t >= 1.0:
                self.world.tick_hz = self._ticks / (now - self._hz_t)
                self._ticks = 0
                self._hz_t = now
            return self.snapshot()

    def snapshot(self) -> dict[str, Any]:
        track = self.world.track.as_dict() if self.world.track else None
        heatmap = self.metrics.heatmap if self.metrics else []
        return {
            "type": "state",
            "adapter": getattr(self.adapter, "name", "unknown"),
            "deployed": self.connected,
            "heartbeat": time.time(),
            "tick_hz": round(self.world.tick_hz, 2),
            "scores": self.score.as_dict(),
            "fleet": {k: v.as_dict() for k, v in self.world.vehicles.items()},
            "detections": [d.as_dict() for d in self.world.detections[-12:]],
            "track": track,
            "truth": _truth_dict(self.adapter.truth_target()),
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
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("brain tick failed")
                sentry_sdk.capture_exception()
            delay = period - (time.monotonic() - t0)
            if delay > 0:
                await asyncio.sleep(delay)


def _truth_dict(pair: tuple[float, float] | None) -> dict[str, float] | None:
    if not pair:
        return None
    return {"lat": pair[0], "lon": pair[1]}
