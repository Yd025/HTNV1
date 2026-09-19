"""Close recce / QRF. Holds a sector until C2 grants custody, then leads the track."""

from __future__ import annotations

from behaviors.trees import CRUISE_ALT, box_search_wp, hold_wp, intercept_wp
from geo import haversine_m
from sim.types import Command, VehicleState
from world import WorldModel

from agents.base import AgentDecision, PlatformAgent

CUSTODY_M = 90.0


class CopterAgent(PlatformAgent):
    def decide(self, me: VehicleState, world: WorldModel) -> AgentDecision:
        role = me.role or "reserve"
        track = world.track
        plane = self.peer(world, "plane")

        if role == "track" and track:
            lat, lon = intercept_wp(track)
            cmd = Command(vehicle_id=me.vehicle_id, type="goto", lat=lat, lon=lon, alt=CRUISE_ALT["copter"])
            dist = haversine_m(me.lat, me.lon, track.lat, track.lon)
            if dist <= CUSTODY_M:
                self.intent = "custody"
                call = self.radio(
                    "custody",
                    "c2",
                    {"range_m": round(dist, 1), "class_hint": track.class_hint},
                )
            else:
                self.intent = "commit"
                call = self.radio("commit", "c2", {"lead_s": 4.0})
            return AgentDecision(command=self.hold_setpoint(cmd, min_m=22.0), calls=self.calls_of(call), intent=self.intent)

        if role == "search":
            lat, lon = box_search_wp(me, avoid=plane)
            cmd = Command(
                vehicle_id=me.vehicle_id,
                type="search_sector",
                lat=lat,
                lon=lon,
                alt=CRUISE_ALT["copter"],
            )
            self.intent = "qrf_search"
            call = self.radio("qrf", "c2", {"note": "box search opposite the plane"})
            return AgentDecision(command=self.hold_setpoint(cmd, min_m=30.0), calls=self.calls_of(call), intent=self.intent)

        lat, lon = hold_wp("copter")
        cmd = Command(vehicle_id=me.vehicle_id, type="hold", lat=lat, lon=lon, alt=CRUISE_ALT["copter"])
        self.intent = "qrf_hold"
        call = self.radio("hold", "c2", {"note": "QRF on deck"})
        return AgentDecision(command=self.hold_setpoint(cmd, min_m=30.0), calls=self.calls_of(call), intent=self.intent)
