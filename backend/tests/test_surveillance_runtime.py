"""Actual controller checks: opt-in patrol, fresh cues and portable training."""
import json
import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from agents.surveillance import (PatrolRoute, arena_xy_to_ne, bounded_ll, load_runtime_policy,
                                 ne_to_arena_xy, point_ne)
from brain import SwarmBrain
from flight_policy import COORDINATED_ALGORITHM, DEFAULT_FLIGHT_POLICY, LEGACY_ALGORITHM
from geo import haversine_m, ne_to_ll
from sim.local_sitl import KinematicCraft, LocalSitlAdapter
from sim.types import Arena, VehicleState
from test_tower_handoff import MissionAdapter
from world import WorldModel


class PolicyLoadingTests(unittest.TestCase):
    def setUp(self):
        env = patch.dict(os.environ, {"MISSION_ALGORITHM": "", "SURVEILLANCE_POLICY_FILE": ""})
        env.start()
        self.addCleanup(env.stop)

    def test_default_preserves_legacy_and_unknown_algorithm_fails(self):
        self.assertEqual(load_runtime_policy()["algorithm"], LEGACY_ALGORITHM)
        with patch.dict(os.environ, {"MISSION_ALGORITHM": "typo"}):
            with self.assertRaisesRegex(ValueError, "Unknown MISSION_ALGORITHM"):
                SwarmBrain(MissionAdapter())

    def test_trained_knobs_load_without_graph_coordinates_or_sensor_model(self):
        with TemporaryDirectory() as tmp:
            file = Path(tmp) / "policy.json"
            file.write_text(json.dumps({
                "profileHash": "different-frame",
                "sensorModel": {"probability": 1},
                "trained": {"algorithm": COORDINATED_ALGORITHM,
                            "towers": [{"x": 999999, "y": 999999}],
                            "flightPolicy": dict(DEFAULT_FLIGHT_POLICY, laneSpacingM=250.)},
            }), encoding="utf-8")
            with patch.dict(os.environ, {"SURVEILLANCE_POLICY_FILE": str(file)}):
                policy = load_runtime_policy()
                self.assertEqual(policy["algorithm"], COORDINATED_ALGORITHM)
                self.assertEqual(policy["flightPolicy"]["laneSpacingM"], 250.)
                self.assertEqual(policy["applied_sections"], ["flightPolicy"])
                self.assertFalse(policy["sensor_model_applied"])
                self.assertFalse(policy["terrain_validated"])
                self.assertNotIn("towers", policy)
                with patch.dict(os.environ, {"MISSION_ALGORITHM": LEGACY_ALGORITHM}):
                    with self.assertRaisesRegex(ValueError, "conflicts"):
                        load_runtime_policy()
            file.write_text(json.dumps({"algorithm": COORDINATED_ALGORITHM,
                                        "flightPolicy": {"worldX": 100}}), encoding="utf-8")
            with patch.dict(os.environ, {"SURVEILLANCE_POLICY_FILE": str(file)}):
                with self.assertRaisesRegex(ValueError, "Unknown flight policy"):
                    load_runtime_policy()

    def test_routes_use_current_arena_origin_and_loaded_lane_spacing(self):
        arena = Arena(51.2, -12.5, 900., heading_offset_deg=-49.8)
        plane = VehicleState("plane", 1, "plane", *ne_to_ll(100, 200, arena.origin_lat, arena.origin_lon), alt=90)
        world = WorldModel(algorithm=COORDINATED_ALGORITHM, arena=arena, vehicles={"plane": plane})
        wide = PatrolRoute()
        wide.waypoint(plane, world)
        world.flight_policy["laneSpacingM"] = 200.
        narrow = PatrolRoute()
        narrow.waypoint(plane, world)
        self.assertGreater(len(narrow.points), len(wide.points))
        for point in narrow.points:
            north, east = point_ne(world, *point)
            x, y = ne_to_arena_xy(world, north, east)
            self.assertLess(abs(x), arena.half_m)
            self.assertLess(abs(y), arena.half_m)
        # Graph +X/+Y and its rotated bearing are not interpreted as NE.
        self.assertLess(max(haversine_m(plane.lat, plane.lon, *p) for p in narrow.points), 2200)

    def test_fort_ross_rotated_arena_contains_patrol_and_clamped_follow_goals(self):
        arena = Arena(71.99, -94.83, 3250., heading_offset_deg=-49.8)
        world = WorldModel(algorithm=COORDINATED_ALGORITHM, arena=arena)
        aircraft = [VehicleState("plane", 1, "plane", arena.origin_lat, arena.origin_lon, alt=90),
                    VehicleState("quad", 2, "copter", arena.origin_lat, arena.origin_lon, alt=40)]
        world.vehicles = {v.vehicle_id: v for v in aircraft}
        # +Y is rotated toward the west here; never treat worldXY as true NE.
        north, east = arena_xy_to_ne(world, 0., 1000.)
        self.assertGreater(north, 600.)
        self.assertLess(east, -700.)
        for vehicle in aircraft:
            route = PatrolRoute()
            route.waypoint(vehicle, world)
            for waypoint in route.points:
                x, y = ne_to_arena_xy(world, *point_ne(world, *waypoint))
                self.assertLessEqual(max(abs(x), abs(y)), arena.half_m * .88 + .001)
        for north, east in ((3250., 3250.), (-6000., 4000.), (10000., -10000.)):
            goal = bounded_ll(world, north, east)
            x, y = ne_to_arena_xy(world, *point_ne(world, *goal))
            self.assertLessEqual(max(abs(x), abs(y)), arena.half_m * .88 + .001)


class CoordinatedRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        env = patch.dict(os.environ, {"RUN_LOG_DIR": "", "MISSION_ALGORITHM": COORDINATED_ALGORITHM,
                                     "SURVEILLANCE_POLICY_FILE": ""})
        env.start()
        self.addCleanup(env.stop)
        self.adapter = MissionAdapter()
        self.brain = SwarmBrain(self.adapter)
        await self.brain.connect()
        self.addAsyncCleanup(self.brain.close)

    async def tick(self, when, sources=(), detections=None):
        self.adapter.observation_now = float(when)
        self.adapter.elapsed_s = float(when) - 1000.
        self.adapter.detections = ([self.adapter.detection(s) for s in sources]
                                   if detections is None else detections)
        return await self.brain.tick()

    async def test_no_cue_aircraft_search_and_grounded_aircraft_can_take_off_only_when_selected(self):
        for vehicle in self.adapter.vehicles:
            if vehicle.vehicle_class in {"plane", "copter"}:
                vehicle.alt = 0.
                vehicle.armed = False
        state = await self.tick(1000)
        commands = {c["vehicle_id"]: c for c in state["commands"]}
        self.assertTrue({"quad-alpha", "hawk-alpha"}.issubset(commands))
        self.assertFalse(state["c2"]["mission_active"])
        self.assertIsNone(state["track"])
        self.assertEqual(state["c2"]["phase"], "surveillance_search")
        self.assertEqual(state["intents"]["quad-alpha"], "complementary_search")
        self.assertEqual(state["intents"]["hawk-alpha"], "surveillance_sweep")
        self.assertNotEqual((commands["quad-alpha"]["lat"], commands["quad-alpha"]["lon"]),
                            (commands["hawk-alpha"]["lat"], commands["hawk-alpha"]["lon"]))
        self.assertIsNotNone(commands["quad-alpha"]["yaw_deg"])
        self.assertEqual(state["mission_algorithm"]["algorithm"], COORDINATED_ALGORITHM)

    async def test_plane_discovers_and_quad_handoff_needs_its_own_repeated_hits(self):
        state = await self.tick(1000, ["hawk-alpha"])
        self.assertFalse(state["c2"]["mission_active"])
        self.assertEqual(state["c2"]["phase"], "sensor_confirm")
        state = await self.tick(1001, ["hawk-alpha"])
        self.assertTrue(state["c2"]["mission_active"])
        self.assertEqual(state["c2"]["custody"], "hawk-alpha")
        self.assertEqual(state["c2"]["handoff"]["state"], "pending")
        self.assertEqual(state["c2"]["metrics"]["successful_handoffs"], 0)
        self.assertEqual(state["c2"]["metrics"]["confirmed_tower_cues"], 0)
        state = await self.tick(1002, ["quad-alpha", "hawk-alpha"])
        self.assertEqual(state["c2"]["metrics"]["successful_handoffs"], 0)
        state = await self.tick(1003, ["quad-alpha"])
        self.assertEqual(state["c2"]["handoff"]["receiver"], "quad-alpha")
        self.assertEqual(state["c2"]["handoff"]["evidence"], "receiver_observation")
        self.assertEqual(state["c2"]["metrics"]["successful_handoffs"], 1)

    async def test_duplicate_stale_future_outliers_and_disconnected_frames_cannot_confirm(self):
        first = self.adapter.detection("hawk-alpha")
        await self.tick(1000, detections=[first])
        stale = self.adapter.detection("hawk-alpha", stamp=900., observation_id="stale")
        future = self.adapter.detection("hawk-alpha", stamp=1100., observation_id="future")
        outlier = self.adapter.detection("quad-alpha", stamp=1001., point=ne_to_ll(-1200, -1200))
        state = await self.tick(1001, detections=[first, stale, future, outlier])
        self.assertFalse(state["c2"]["mission_active"])
        self.adapter.offline.add("hawk-alpha")
        state = await self.tick(1002, ["hawk-alpha"])
        self.assertFalse(state["c2"]["mission_active"])

    async def test_expired_contact_resumes_search_and_requires_a_new_confirmation(self):
        await self.tick(1000, ["hawk-alpha"])
        await self.tick(1001, ["hawk-alpha"])
        state = await self.tick(1005)
        self.assertEqual(state["c2"]["phase"], "coasting")
        self.assertIsNone(state["c2"]["custody"])
        state = await self.tick(1008)
        self.assertEqual(state["c2"]["phase"], "reacquire")
        state = await self.tick(1030, ["quad-alpha"])
        self.assertFalse(state["c2"]["mission_active"])
        self.assertEqual(state["c2"]["phase"], "sensor_confirm")
        state = await self.tick(1031, ["quad-alpha"])
        self.assertTrue(state["c2"]["mission_active"])
        self.assertEqual(state["c2"]["metrics"]["confirmed_sensor_cues"], 2)

    async def test_local_kinematic_aircraft_continue_moving_without_any_detection(self):
        crafts = {}
        for vehicle in self.adapter.vehicles:
            if vehicle.vehicle_class not in {"plane", "copter"}:
                continue
            north, east = point_ne(self.brain.world, vehicle.lat, vehicle.lon)
            crafts[vehicle.vehicle_id] = KinematicCraft({"vehicle_id": vehicle.vehicle_id,
                "sysid": vehicle.sysid, "vehicle_class": vehicle.vehicle_class,
                "north": north, "east": east}, self.adapter.arena())
        travelled = {key: 0. for key in crafts}
        halfway = {}
        for tick in range(121):
            self.adapter.vehicles = [crafts[v.vehicle_id].state(False) if v.vehicle_id in crafts else v
                                     for v in self.adapter.vehicles]
            state = await self.tick(1000 + tick)
            for command in self.brain.commands_last:
                if command.vehicle_id in crafts:
                    crafts[command.vehicle_id].apply(command)
            for name, craft in crafts.items():
                before = (craft.north, craft.east)
                craft.step(1.)
                travelled[name] += ((craft.north - before[0]) ** 2 + (craft.east - before[1]) ** 2) ** .5
            if tick == 60:
                halfway = dict(travelled)
        for name in crafts:
            self.assertGreater(halfway[name], 300.)
            self.assertGreater(travelled[name] - halfway[name], 300.)
        self.assertIsNone(state["track"])
        self.assertFalse(state["c2"]["mission_active"])

    async def test_battery_reserve_overrides_patrol_without_claiming_contact(self):
        for vehicle in self.adapter.vehicles:
            vehicle.battery_remaining = 15.
        state = await self.tick(1000)
        self.assertEqual(state["fleet"]["quad-alpha"]["role"], "reserve")
        self.assertEqual(state["intents"]["quad-alpha"], "battery_return_reserve")
        self.assertEqual(state["intents"]["hawk-alpha"], "battery_reserve_orbit")
        self.assertIsNone(state["c2"]["custody"])


class LocalBatteryBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_zero_battery_survives_local_mavlink_and_none_keeps_default(self):
        with patch.dict(os.environ, {"FORCE_KINEMATIC": "1", "SEARCH_POLICY_FILE": ""}):
            adapter = LocalSitlAdapter()
        self.addAsyncCleanup(adapter.close)
        snap = {"lat": adapter.arena().origin_lat, "lon": adapter.arena().origin_lon,
                "alt": 40., "battery_remaining": 0.}
        adapter._bridges["copter-1"] = SimpleNamespace(
            is_connected=lambda: True, snapshot=lambda: dict(snap),
            recv_sample=AsyncMock(return_value=None), close=AsyncMock())
        fleet = {v.vehicle_id: v for v in await adapter.list_vehicles()}
        self.assertEqual(fleet["copter-1"].battery_remaining, 0.)
        snap["battery_remaining"] = None
        fleet = {v.vehicle_id: v for v in await adapter.list_vehicles()}
        self.assertEqual(fleet["copter-1"].battery_remaining, 100.)


if __name__ == "__main__":
    unittest.main()
