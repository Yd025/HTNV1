"""Close vessel tracking only after C2 confirms a tower cue."""

from __future__ import annotations

from behaviors.trees import CRUISE_ALT, camera_follow_wp, cue_ll, reacquire_wp
from geo import bearing_deg
from sim.types import Command, VehicleState
from world import WorldModel

from agents.base import AgentDecision, PlatformAgent


class CopterAgent(PlatformAgent):
    def __init__(self, vehicle_id: str, vehicle_class: str) -> None:
        super().__init__(vehicle_id, vehicle_class)
        self._reserve_point: tuple[float, float] | None = None

    def decide(self, me: VehicleState, world: WorldModel) -> AgentDecision:
        if self._reserve_point is None:
            self._reserve_point = (me.lat, me.lon)
        aim = cue_ll(world)
        if aim:
            follow = camera_follow_wp(world.track, me)
            if follow is None:
                self.intent = "camera_height_pending"
                return AgentDecision(command=None, intent=self.intent)
            if world.phase == "reacquire":
                aim = reacquire_wp(world, me)
                self.intent = "reacquire"
            elif world.custody_source == me.vehicle_id:
                self.intent = "visual_custody"
            else:
                self.intent = "coasting" if world.phase == "coasting" else "intercept"
            if world.phase != "reacquire":
                aim = follow
            yaw = bearing_deg(me.lat, me.lon, world.track.lat, world.track.lon)
            cmd = Command(me.vehicle_id, "goto", aim[0], aim[1], CRUISE_ALT["copter"], yaw_deg=yaw)
            call = self.radio(self.intent, "c2", {"lead_s": 4.0,
                                                  "custody_confirmed": world.custody_source == me.vehicle_id})
            return AgentDecision(command=self.hold_setpoint(cmd, min_m=12.0), calls=self.calls_of(call), intent=self.intent)

        self.intent = "reserve_ground" if me.alt < 5.0 else "reserve_hold"
        if me.alt < 5.0:
            return AgentDecision(command=None, intent=self.intent)
        cmd = Command(me.vehicle_id, "hold", *self._reserve_point, CRUISE_ALT["copter"])
        return AgentDecision(command=self.hold_setpoint(cmd, min_m=30.0), intent=self.intent)
