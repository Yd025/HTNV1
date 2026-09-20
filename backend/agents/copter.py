"""Complementary surveillance when selected; follow only confirmed contacts."""

from __future__ import annotations

from behaviors.trees import CRUISE_ALT, camera_follow_wp, cue_ll, reacquire_wp
from flight_policy import COORDINATED_ALGORITHM
from geo import bearing_deg
from sim.types import Command, VehicleState
from world import WorldModel

from agents.base import AgentDecision, PlatformAgent
from agents.surveillance import PatrolRoute, coordinated_reacquire, follow_waypoint, patrol_yaw


class CopterAgent(PlatformAgent):
    def __init__(self, vehicle_id: str, vehicle_class: str) -> None:
        super().__init__(vehicle_id, vehicle_class)
        self._reserve_point: tuple[float, float] | None = None
        self._patrol = PatrolRoute()

    def decide(self, me: VehicleState, world: WorldModel) -> AgentDecision:
        if self._reserve_point is None:
            self._reserve_point = (me.lat, me.lon)
        coordinated = world.algorithm == COORDINATED_ALGORITHM
        if coordinated and me.battery_remaining <= 20.0:
            self.intent = "battery_return_reserve"
            if me.alt < 5.0:
                return AgentDecision(command=None, intent=self.intent)
            cmd = Command(me.vehicle_id, "hold", *self._reserve_point, CRUISE_ALT["copter"])
            return AgentDecision(command=self.hold_setpoint(cmd, min_m=30.0), intent=self.intent)
        aim = ((world.track.lat, world.track.lon) if world.mission_active and world.track else None) if coordinated else cue_ll(world)
        if aim:
            follow = follow_waypoint(world, me) if coordinated else camera_follow_wp(world.track, me)
            if follow is None:
                self.intent = "camera_height_pending"
                return AgentDecision(command=None, intent=self.intent)
            if world.phase == "reacquire":
                aim = coordinated_reacquire(world, me) if coordinated else reacquire_wp(world, me)
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

        if coordinated:
            goal = self._patrol.waypoint(me, world)
            self.intent = "complementary_search"
            cmd = Command(me.vehicle_id, "search_sector", *goal, CRUISE_ALT["copter"], yaw_deg=patrol_yaw(me, goal))
            call = self.radio(self.intent, "c2", {"role": "local camera patrol", "algorithm": world.algorithm})
            return AgentDecision(command=self.hold_setpoint(cmd, min_m=20.0), calls=self.calls_of(call), intent=self.intent)

        self.intent = "reserve_ground" if me.alt < 5.0 else "reserve_hold"
        if me.alt < 5.0:
            return AgentDecision(command=None, intent=self.intent)
        cmd = Command(me.vehicle_id, "hold", *self._reserve_point, CRUISE_ALT["copter"])
        return AgentDecision(command=self.hold_setpoint(cmd, min_m=30.0), intent=self.intent)
