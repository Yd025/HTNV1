"""Named-policy patrol/reserve, then observation-driven forward support."""

from __future__ import annotations

from behaviors.trees import CRUISE_ALT, forward_search_wp, reacquire_wp, reserve_orbit_wp
from flight_policy import COORDINATED_ALGORITHM
from plane_shadow import PlaneShadow
from geo import haversine_m
from sim.types import Command, VehicleState
from world import WorldModel

from agents.base import AgentDecision, PlatformAgent
from agents.surveillance import PatrolRoute, reserve_waypoint, support_waypoint


class PlaneAgent(PlatformAgent):
    def __init__(self, vehicle_id: str, vehicle_class: str) -> None:
        super().__init__(vehicle_id, vehicle_class)
        self._reserve_center: tuple[float, float] | None = None
        self._leg = 0
        self._patrol = PatrolRoute()
        self._shadow = PlaneShadow()

    def decide(self, me: VehicleState, world: WorldModel) -> AgentDecision:
        if self._reserve_center is None:
            self._reserve_center = (me.lat, me.lon)
        coordinated = world.algorithm == COORDINATED_ALGORITHM
        if coordinated and me.battery_remaining <= 20.0:
            self.intent = "battery_reserve_orbit"
            if me.alt < 5.0:
                return AgentDecision(command=None, intent=self.intent)
            lat, lon = reserve_waypoint(world, me, self._reserve_center)
            cmd = Command(me.vehicle_id, "loiter", lat, lon, CRUISE_ALT["plane"])
            return AgentDecision(command=self.hold_setpoint(cmd, min_m=45.0), intent=self.intent)
        if not world.mission_active or world.track is None:
            self._shadow.reset()
            if coordinated:
                lat, lon = self._patrol.waypoint(me, world)
                self.intent = "surveillance_sweep"
                cmd = Command(me.vehicle_id, "search_sector", lat, lon, CRUISE_ALT["plane"])
                call = self.radio(self.intent, "c2", {"role": "forward-camera patrol", "algorithm": world.algorithm})
                return AgentDecision(command=self.hold_setpoint(cmd, min_m=35.0), calls=self.calls_of(call), intent=self.intent)
            self.intent = "reserve_ground" if me.alt < 5.0 else "reserve_orbit"
            # Even a hold command advances the live adapter's takeoff machine.
            if me.alt < 5.0:
                return AgentDecision(command=None, intent=self.intent)
            lat, lon = reserve_orbit_wp(me, self._reserve_center)
            cmd = Command(me.vehicle_id, "loiter", lat, lon, CRUISE_ALT["plane"])
            return AgentDecision(command=self.hold_setpoint(cmd, min_m=45.0), intent=self.intent)

        if world.phase == "reacquire":
            # Continue bounded offset passes around the coasting estimate. A
            # direct reacquisition waypoint can put the fixed camera overhead
            # and blind just when receiver evidence is already missing.
            goal = support_waypoint(world, me, self._shadow) if coordinated else reacquire_wp(world, me)
            if goal is None:
                goal = self._patrol.waypoint(me, world)
            lat, lon = goal
            self.intent = "forward_reacquire"
        else:
            goal = support_waypoint(world, me, self._shadow) if coordinated else forward_search_wp(world.track, self._leg)
            if goal is None:
                goal = self._patrol.waypoint(me, world)
            lat, lon = goal
            if not coordinated and haversine_m(me.lat, me.lon, lat, lon) < 80.0:
                self._leg += 1
                lat, lon = forward_search_wp(world.track, self._leg)
            self.intent = "air_custody" if world.custody_source == me.vehicle_id else "forward_cover"
            if coordinated and self._shadow.phase == "reposition":
                self.intent = "support_reposition"
        cmd = Command(me.vehicle_id, "search_sector", lat, lon, CRUISE_ALT["plane"])
        call = self.radio(self.intent, "c2", {"role": "forward corridor and reacquisition",
                                              "custody_confirmed": world.custody_source == me.vehicle_id})
        return AgentDecision(command=self.hold_setpoint(cmd, min_m=35.0), calls=self.calls_of(call), intent=self.intent)
