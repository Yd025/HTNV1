"""Fixed OP. No transit. Slews stare and cues C2 when the contact is in FOV."""

from __future__ import annotations

import time

from behaviors.trees import water_stare
from geo import bearing_deg
from sim.types import Command, VehicleState
from world import WorldModel

from agents.base import AgentDecision, PlatformAgent


class TowerAgent(PlatformAgent):
    def decide(self, me: VehicleState, world: WorldModel) -> AgentDecision:
        own = self.own_detections(world)
        if own:
            det = own[0]
            self.intent = "cue"
            cmd = _slew(me, det.lat, det.lon)
            call = self.radio(
                "cue",
                "c2",
                {
                    "class_hint": det.class_hint,
                    "confidence": round(det.confidence, 2),
                    "bearing": det.bearing,
                    "range_m": det.range_m,
                },
            )
            return AgentDecision(command=cmd, calls=self.calls_of(call), intent=self.intent)

        track = world.track
        if track and track.confidence >= 0.25:
            self.intent = "stare"
            return AgentDecision(command=_slew(me, track.lat, track.lon), calls=[], intent=self.intent)

        self.intent = "scan"
        sector = (int(time.monotonic() / 22.0) + (0 if "1" in me.vehicle_id else 3)) % 6
        lat, lon = water_stare(sector, me)
        call = self.radio("overwatch", "c2", {"heading": round(me.heading, 1), "sector": sector})
        return AgentDecision(
            command=Command(vehicle_id=me.vehicle_id, type="look_at", lat=lat, lon=lon, alt=0.0, sector=sector),
            calls=self.calls_of(call),
            intent=self.intent,
        )


def _slew(me: VehicleState, lat: float, lon: float) -> Command | None:
    want = bearing_deg(me.lat, me.lon, lat, lon)
    delta = abs(((want - me.heading + 180.0) % 360.0) - 180.0)
    if delta <= 8.0:
        return None
    return Command(vehicle_id=me.vehicle_id, type="look_at", lat=lat, lon=lon, alt=me.alt)
