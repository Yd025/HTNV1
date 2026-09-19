"""Close recce / QRF. Holds a sector until C2 grants custody, then leads the track."""

from __future__ import annotations

from behaviors.trees import CRUISE_ALT, box_search_wp, cue_ll, hold_wp
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
        aim = cue_ll(world)

        # FIX/TRACK: any vision cue is enough to leave the box and prosecute.
        if aim and (role == "track" or track or world.detections):
            lat, lon = aim
            cmd = Command(vehicle_id=me.vehicle_id, type="goto", lat=lat, lon=lon, alt=CRUISE_ALT["copter"])
            dist = haversine_m(me.lat, me.lon, lat, lon)
            src = "track" if track and track.confidence >= 0.20 else "detection"
            if dist <= CUSTODY_M:
                self.intent = "custody"
                call = self.radio(
                    "custody",
                    "c2",
                    {"range_m": round(dist, 1), "source": src, "class_hint": getattr(track, "class_hint", "vessel")},
                )
            else:
                self.intent = "commit"
                call = self.radio("commit", "c2", {"source": src, "lead_s": 4.0, "range_m": round(dist, 1)})
            return AgentDecision(command=self.hold_setpoint(cmd, min_m=12.0), calls=self.calls_of(call), intent=self.intent)

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
