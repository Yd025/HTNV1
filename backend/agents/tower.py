"""Fixed OP. No transit. Slews a continuous water sweep and cues C2 when a contact is in FOV."""

from __future__ import annotations

from behaviors.trees import water_stare
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
        if world.mission_active and track and track.confidence >= 0.25:
            self.intent = "stare"
            return AgentDecision(command=_slew(me, track.lat, track.lon), calls=[], intent=self.intent)

        self.intent = "scan"
        stamp = world.observation_now if world.observation_now is not None else None
        lat, lon = water_stare(0, me, now=stamp)
        call = self.radio("overwatch", "c2", {"heading": round(me.heading, 1)})
        return AgentDecision(
            command=Command(vehicle_id=me.vehicle_id, type="look_at", lat=lat, lon=lon, alt=0.0),
            calls=self.calls_of(call),
            intent=self.intent,
        )


def _slew(me: VehicleState, lat: float, lon: float) -> Command:
    return Command(vehicle_id=me.vehicle_id, type="look_at", lat=lat, lon=lon, alt=0.0)
