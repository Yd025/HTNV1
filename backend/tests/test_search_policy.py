import math
import unittest
from unittest.mock import patch

from geo import bearing_deg, ll_to_ne, ne_to_ll
from search_policy import SearchPlanner
from sim.types import Arena, TowerMount, VehicleState


def arena(half=1500):
    # Different from geo module defaults: explicit origin handling is required.
    return Arena(68.2, -105.5, half)


def vehicle(world, kind="plane", name="plane-1", north=0, east=0):
    return VehicleState(name, 1, kind, *ne_to_ll(north, east, world.origin_lat, world.origin_lon))


class SearchPolicyTests(unittest.TestCase):
    def test_deterministic_and_independent_of_fleet_input_order(self):
        for algorithm in ("lawnmower", "belief_greedy"):
            world = arena()
            fleet = [vehicle(world), vehicle(world, "copter", "copter-1")]
            a, b = SearchPlanner(world, algorithm), SearchPlanner(world, algorithm)
            for elapsed in (0, 1, 16, 32):
                self.assertEqual(a.commands(fleet, elapsed), b.commands(list(reversed(fleet)), elapsed))
                self.assertEqual(a.belief, b.belief)

    def test_no_target_or_randomness_dependency(self):
        world = arena()
        with patch("sim.target.TargetSim.latlon", side_effect=AssertionError("target truth accessed")), \
                patch("random.random", side_effect=AssertionError("randomness accessed")), \
                patch("time.monotonic", side_effect=AssertionError("wall clock accessed")):
            planner = SearchPlanner(world, "belief_greedy")
            self.assertEqual(len(planner.commands([vehicle(world)], 0)), 1)
            self.assertEqual(len(planner.commands([vehicle(world)], 20)), 1)

    def test_empty_fleet_and_probability_conservation(self):
        planner = SearchPlanner(arena(), "belief_greedy")
        for elapsed in (0, 1, 10, 90):
            self.assertEqual(planner.commands([], elapsed), [])
            self.assertAlmostEqual(sum(planner.belief), 1.0)
            self.assertTrue(all(math.isfinite(p) and p >= 0 for p in planner.belief))

    def test_negative_observation_respects_tower_range_and_fov(self):
        world = arena(300)
        world.towers = [TowerMount("tower-1", world.origin_lat, world.origin_lon,
                                   heading=0, fov_deg=70, range_m=150)]
        planner = SearchPlanner(world, "belief_greedy", grid_size=6)
        planner.commands([], 0)
        north_cell = planner.cells.index((50.0, 50.0))
        east_cell = planner.cells.index((50.0, 150.0))
        # 50N/50E is 45 degrees: outside the 35-degree half-FOV.
        self.assertGreater(planner.belief[north_cell], 0)
        self.assertGreater(planner.belief[east_cell], 0)
        world.towers[0].heading = 45
        planner.commands([], 1)
        self.assertEqual(planner.belief[north_cell], 0)
        self.assertGreater(planner.belief[east_cell], 0)  # beyond 150m range
        self.assertAlmostEqual(sum(planner.belief), 1)

    def test_zero_detection_probability_does_not_remove_visible_mass(self):
        world = arena(100)
        craft = vehicle(world, "copter", "copter-1")
        planner = SearchPlanner(world, "belief_greedy", detection_probability=0)
        before = planner.belief
        planner.commands([craft], 0)
        for actual, expected in zip(planner.belief, before):
            self.assertAlmostEqual(actual, expected)

    def test_complete_exclusion_recovers_and_repeated_time_is_idempotent(self):
        world = arena(20)
        craft = vehicle(world, "copter", "copter-1")
        planner = SearchPlanner(world, "belief_greedy")
        planner.commands([craft], 0)
        self.assertAlmostEqual(sum(planner.belief), 1)
        self.assertTrue(all(p > 0 for p in planner.belief))
        before = planner.belief
        planner.commands([craft], 0)
        self.assertEqual(before, planner.belief)

    def test_mobile_bounds_altitude_deconfliction_and_hold(self):
        for algorithm in ("lawnmower", "belief_greedy"):
            world = arena()
            fleet = [vehicle(world), vehicle(world, "copter", "copter-1"),
                     vehicle(world, "rover", "rover-1")]
            planner = SearchPlanner(world, algorithm)
            first = planner.commands(fleet, 0)
            self.assertEqual(first, planner.commands(fleet, 1))
            self.assertEqual(len({(c.lat, c.lon) for c in first}), len(first))
            self.assertEqual([c.alt for c in first], [90, 40, 0])
            for command in first:
                north, east = ll_to_ne(command.lat, command.lon, world.origin_lat, world.origin_lon)
                self.assertLessEqual(abs(north), world.half_m)
                self.assertLessEqual(abs(east), world.half_m)

    def test_tower_sweep_preserves_initial_heading_when_adapter_mutates_mount(self):
        world = arena()
        mount = TowerMount("tower-1", world.origin_lat, world.origin_lon, heading=25)
        self.assertEqual(mount.range_m, 600)
        world.towers = [mount]
        planner = SearchPlanner(world, scan_period_s=60)
        for elapsed in (0, 15, 30, 45, 60):
            command = planner.commands([], elapsed)[0]
            actual = bearing_deg(mount.lat, mount.lon, command.lat, command.lon)
            expected = (25 + elapsed * 6) % 360
            self.assertAlmostEqual(actual, expected, delta=0.01)
            mount.heading = actual

    def test_lawnmower_disjoint_routes_visit_every_cell(self):
        world = arena()
        fleet = [vehicle(world), vehicle(world, "copter", "copter-1")]
        planner = SearchPlanner(world, grid_size=4)
        visited = {v.vehicle_id: set() for v in fleet}
        for elapsed in range(20):
            commands = planner.commands(fleet, elapsed)
            for craft, command in zip(fleet, commands):
                visited[craft.vehicle_id].add((command.lat, command.lon))
                craft.lat, craft.lon = command.lat, command.lon
        a, b = visited.values()
        self.assertFalse(a & b)
        self.assertEqual(len(a | b), 16)

    def test_rejects_obstacles_and_invalid_parameters(self):
        world = arena()
        world.no_fly = [{"polygon": [[0, 0], [1, 1], [0, 1]]}]
        with self.assertRaisesRegex(ValueError, "no_fly"):
            SearchPlanner(world)
        for options in ({"algorithm": "astar"}, {"grid_size": 1}, {"grid_size": 2.5},
                        {"scan_period_s": 0}, {"detection_probability": 1.1}):
            with self.assertRaises(ValueError):
                SearchPlanner(arena(), **options)
        planner = SearchPlanner(arena())
        planner.commands([], 5)
        with self.assertRaises(ValueError):
            planner.commands([], 4)


if __name__ == "__main__":
    unittest.main()
