"""The simulator selects its arena after controller modules have been imported."""

import unittest
from unittest.mock import patch

import geo
from agents import Squad
from behaviors.trees import lawnmower_wp
from metrics import MetricsEngine
from sim.types import Arena, Detection, VehicleState
from tracker import TargetTracker
from world import WorldModel


FORT_ROSS = Arena(71.991960, -94.822428, 3250.0)


class ActiveArenaTests(unittest.TestCase):
    def setUp(self):
        # Deliberately patch after imports, as WhiteoutAdapter.connect does.
        for name, value in (
            ("ORIGIN_LAT", FORT_ROSS.origin_lat),
            ("ORIGIN_LON", FORT_ROSS.origin_lon),
            ("ARENA_HALF_M", FORT_ROSS.half_m),
        ):
            patcher = patch.object(geo, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)

    def vehicle(self, name, kind, role="search"):
        # The geometry test models aircraft already airborne. Grounded reserve
        # aircraft intentionally receive no command that could trigger takeoff.
        alt = 90.0 if kind == "plane" else 40.0 if kind == "copter" else 0.0
        return VehicleState(name, 1, kind, FORT_ROSS.origin_lat, FORT_ROSS.origin_lon, alt=alt, role=role)

    def assert_inside_site(self, lat, lon):
        north, east = geo.ll_to_ne(lat, lon, FORT_ROSS.origin_lat, FORT_ROSS.origin_lon)
        self.assertLessEqual(abs(north), FORT_ROSS.half_m)
        self.assertLessEqual(abs(east), FORT_ROSS.half_m)

    def test_runtime_origin_and_extent_preserve_explicit_overrides(self):
        self.assertEqual(geo.ll_to_ne(FORT_ROSS.origin_lat, FORT_ROSS.origin_lon), (0.0, 0.0))
        self.assertEqual(geo.ne_to_ll(0.0, 0.0), (FORT_ROSS.origin_lat, FORT_ROSS.origin_lon))
        self.assertEqual(geo.clamp_arena(4000.0, -4000.0), (3250.0, -3250.0))
        self.assertEqual(geo.ll_to_ne(0.0, 0.0, 0.0, 0.0), (0.0, 0.0))
        self.assertEqual(geo.ne_to_ll(0.0, 0.0, 0.0, 0.0), (0.0, 0.0))
        self.assertEqual(geo.clamp_arena(100.0, -100.0, 80.0), (80.0, -80.0))

    def test_search_and_hold_commands_use_active_site_after_imports(self):
        plane = self.vehicle("fixed-wing", "plane")
        copter = self.vehicle("quadcopter", "copter")
        rover = self.vehicle("rover", "rover", "reserve")
        world = WorldModel(vehicles={v.vehicle_id: v for v in (plane, copter, rover)})
        squad = Squad()
        for vehicle in (plane, copter, rover):
            with self.subTest(vehicle=vehicle.vehicle_id, role=vehicle.role):
                command = squad.tick(vehicle, world).command
                self.assertIsNotNone(command)
                self.assert_inside_site(command.lat, command.lon)
        copter.role = "reserve"
        hold = squad.tick(copter, world).command
        self.assert_inside_site(hold.lat, hold.lon)
        # Main deliberately limits Fort Ross flight to the inner water strait.
        lat, lon = lawnmower_wp(plane)
        north, _ = geo.ll_to_ne(lat, lon, FORT_ROSS.origin_lat, FORT_ROSS.origin_lon)
        self.assertAlmostEqual(abs(north), 1100.0 * 0.8)
        # A smaller active local arena still uses its runtime extent.
        with patch.object(geo, "ARENA_HALF_M", 900.0):
            lat, lon = lawnmower_wp(plane)
            north, _ = geo.ll_to_ne(lat, lon)
            self.assertAlmostEqual(abs(north), 900.0 * 0.8)

    def test_colocated_searchers_are_counted_in_active_coverage_grid(self):
        metrics = MetricsEngine(FORT_ROSS)
        score = metrics.update([self.vehicle("a", "plane"), self.vehicle("b", "copter")], None, None)
        self.assertEqual(score.overlap_ratio, 0.5)

    def test_track_prediction_uses_active_latitude_for_eastward_meters(self):
        tracker = TargetTracker()
        now = 100.0
        track = tracker.update([Detection("camera", FORT_ROSS.origin_lat, FORT_ROSS.origin_lon, "vessel", 0.9, 0.0)], now=now)
        track.ve = 20.0
        predicted = tracker.update([], now=now + 0.5)
        self.assertAlmostEqual(predicted.lat, FORT_ROSS.origin_lat)
        self.assertAlmostEqual(predicted.lon, FORT_ROSS.origin_lon + 10.0 / geo.m_per_deg_lon(FORT_ROSS.origin_lat))


if __name__ == "__main__":
    unittest.main()
