"""Regression checks for unbiased, repeatable moving-target training episodes."""

import math
import unittest
from unittest.mock import patch

from sim.target import TargetSim


class SearchTargetTests(unittest.TestCase):
    def test_weave_respects_arbitrary_initial_heading(self):
        for heading in (0.0, 90.0, 180.0, 270.0):
            with self.subTest(heading=heading):
                boat = TargetSim(profile="weave", north=0.0, east=0.0, heading=heading)
                boat.step(1.0, elapsed_s=1.0)
                expected = (heading + 25.0 * math.sin(0.35)) % 360.0
                self.assertAlmostEqual(boat.heading, expected)
                self.assertAlmostEqual(math.hypot(boat.north, boat.east), boat.speed_mps)

    def test_weave_leaves_every_corner_after_outward_heading(self):
        for north, east, heading in ((1275, 1275, 45), (1275, -1275, 315),
                                     (-1275, 1275, 135), (-1275, -1275, 225)):
            with self.subTest(corner=(north, east)):
                boat = TargetSim(profile="weave", north=north, east=east, heading=heading)
                boat.step(1.0, elapsed_s=1.0)
                self.assertLess(abs(boat.north), 1275)
                self.assertLess(abs(boat.east), 1275)
                first = boat.north, boat.east
                for elapsed in range(2, 6):
                    boat.step(1.0, elapsed_s=float(elapsed))
                self.assertGreater(math.dist(first, (boat.north, boat.east)), 10.0)

    def test_reflection_preserves_overshoot_and_reverses_normal_component(self):
        north = TargetSim(profile="straight", speed_mps=10, north=84.5, east=0,
                          heading=0, half_m=100)
        north.step(1, elapsed_s=1)
        self.assertAlmostEqual(north.north, 75.5)
        self.assertAlmostEqual(north.heading, 180)
        east = TargetSim(profile="straight", speed_mps=10, north=0, east=84.5,
                         heading=90, half_m=100)
        east.step(1, elapsed_s=1)
        self.assertAlmostEqual(east.east, 75.5)
        self.assertAlmostEqual(east.heading, 270)
        # Crossing both walls reflects both velocity components.
        corner = TargetSim(profile="straight", speed_mps=10, north=84, east=84,
                           heading=45, half_m=100)
        corner.step(1, elapsed_s=1)
        self.assertAlmostEqual(corner.north, 86 - 10 / math.sqrt(2))
        self.assertAlmostEqual(corner.east, corner.north)
        self.assertAlmostEqual(corner.heading, 225)

    def test_all_profiles_stay_bounded_and_keep_moving_over_long_runs(self):
        for profile in ("straight", "weave", "stop_and_go"):
            with self.subTest(profile=profile):
                boat = TargetSim(profile=profile, north=100, east=100, heading=45,
                                 speed_mps=10, half_m=120)
                tail = []
                for elapsed in range(1, 2001):
                    boat.step(1, elapsed_s=float(elapsed))
                    self.assertLessEqual(abs(boat.north), 102)
                    self.assertLessEqual(abs(boat.east), 102)
                    self.assertTrue(math.isfinite(boat.heading))
                    if elapsed > 1900:
                        tail.append((round(boat.north, 5), round(boat.east, 5)))
                self.assertGreater(len(set(tail)), 30)

    def test_explicit_time_reproduces_trajectory_independently_of_wall_clock(self):
        for profile in ("straight", "weave", "stop_and_go"):
            first = TargetSim(profile=profile, heading=312, t0=0, half_m=900)
            second = TargetSim(profile=profile, heading=312, t0=12345, half_m=900)
            with patch("sim.target.time.monotonic", side_effect=AssertionError("wall clock accessed")):
                for tick in range(1, 201):
                    first.step(0.5, elapsed_s=tick * 0.5)
                    second.step(0.5, elapsed_s=tick * 0.5)
                    self.assertEqual((first.north, first.east, first.heading),
                                     (second.north, second.east, second.heading))

    def test_default_clock_and_reset_match_fresh_explicit_time(self):
        live = TargetSim(profile="weave", t0=100)
        explicit = TargetSim(profile="weave", t0=0)
        with patch("sim.target.time.monotonic", return_value=103):
            live.step(1)
        explicit.step(1, elapsed_s=3)
        self.assertEqual((live.north, live.east, live.heading),
                         (explicit.north, explicit.east, explicit.heading))
        # Clear reflected curvature and phase as well as public position state.
        live.north, live.east, live.heading = 1275, 0, 0
        live.step(1, elapsed_s=4)
        live.reset()
        fresh = TargetSim(profile="weave")
        live.step(1, elapsed_s=1)
        fresh.step(1, elapsed_s=1)
        self.assertEqual((live.north, live.east, live.heading),
                         (fresh.north, fresh.east, fresh.heading))


if __name__ == "__main__":
    unittest.main()
