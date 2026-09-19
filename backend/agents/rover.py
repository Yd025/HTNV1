"""Ground PID. Ignores air intercepts until C2 tasks confirm."""

from __future__ import annotations

from behaviors.trees import hold_wp
from geo import haversine_m
from sim.types import Command, VehicleState
from world import WorldModel

from agents.base import AgentDecision, PlatformAgent

PID_M = 45.0


class RoverAgent(PlatformAgent):
    def decide(self, me: VehicleState, world: WorldModel) -> AgentDecision:
        role = me.role or "reserve"
        track = world.track

        if role == "confirm" and track:
            cmd = Command(vehicle_id=me.vehicle_id, type="goto", lat=track.lat, lon=track.lon, alt=0.0)
            dist = haversine_m(me.lat, me.lon, track.lat, track.lon)
            if dist <= PID_M:
                self.intent = "pid"
                call = self.radio(
                    "pid",
                    "c2",
                    {"class_hint": track.class_hint, "range_m": round(dist, 1)},
                )
            else:
                self.intent = "confirming"
                call = self.radio("enroute", "c2", {"range_m": round(dist, 1)})
            return AgentDecision(command=self.hold_setpoint(cmd, min_m=18.0), calls=self.calls_of(call), intent=self.intent)

        lat, lon = hold_wp("rover")
        cmd = Command(vehicle_id=me.vehicle_id, type="hold", lat=lat, lon=lon, alt=0.0)
        self.intent = "reserve"
        call = self.radio("reserve", "c2", {"note": "holding; air cues are not PID"})
        return AgentDecision(command=self.hold_setpoint(cmd, min_m=25.0), calls=self.calls_of(call), intent=self.intent)
