"""ISR / hunter. Wide-area search only. Never prosecutes a contact."""

from __future__ import annotations

from behaviors.trees import CRUISE_ALT, cue_ll, lawnmower_wp
from sim.types import Command, VehicleState
from world import WorldModel

from agents.base import AgentDecision, PlatformAgent


class PlaneAgent(PlatformAgent):
    def decide(self, me: VehicleState, world: WorldModel) -> AgentDecision:
        cue = cue_ll(world)
        lat, lon = lawnmower_wp(me, bias=cue)
        cmd = Command(
            vehicle_id=me.vehicle_id,
            type="search_sector",
            lat=lat,
            lon=lon,
            alt=CRUISE_ALT["plane"],
        )
        own = self.own_detections(world)
        if own:
            self.intent = "contact"
            call = self.radio(
                "contact",
                "c2",
                {
                    "class_hint": own[0].class_hint,
                    "confidence": round(own[0].confidence, 2),
                    "range_m": own[0].range_m,
                },
            )
        elif cue:
            self.intent = "keep_search"
            call = self.radio("keep_search", "c2", {"note": "ISR on cued lane; copter prosecutes"})
        else:
            self.intent = "search"
            call = self.radio("searching", "c2", {"pattern": "lawnmower"})
        return AgentDecision(command=self.hold_setpoint(cmd, min_m=40.0), calls=self.calls_of(call), intent=self.intent)
