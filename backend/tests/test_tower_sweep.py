"""Commanded tower pan is a 180° water arc, not a 20° hillside twitch."""

import unittest

from behaviors.trees import TOWER_SWEEP, sweep_bearing


def _wrap_delta(heading: float, center: float) -> float:
    return ((heading - center + 180.0) % 360.0) - 180.0


class TowerSweepTests(unittest.TestCase):
    def test_both_towers_sweep_a_180_degree_water_arc(self):
        for vehicle_id, cfg in TOWER_SWEEP.items():
            self.assertEqual(cfg["half"], 90.0)
            bearings = [sweep_bearing(vehicle_id, t * 0.5) for t in range(0, 121)]
            deltas = [_wrap_delta(bearing, cfg["center"]) for bearing in bearings]
            self.assertLessEqual(min(deltas), -89.0, vehicle_id)
            self.assertGreaterEqual(max(deltas), 89.0, vehicle_id)
            self.assertAlmostEqual(max(deltas) - min(deltas), 180.0, delta=2.0)

    def test_tower_two_center_is_160_clockwise_of_the_uphill_heading(self):
        cfg = TOWER_SWEEP["tower-2"]
        self.assertAlmostEqual(cfg["center"], 346.840964, places=5)
        self.assertAlmostEqual(_wrap_delta(cfg["center"], 186.840964), 160.0, places=5)
        for t in (0.0, 15.0, 30.0, 45.0, 60.0):
            self.assertGreater(abs(_wrap_delta(sweep_bearing("tower-2", t), 186.840964)), 40.0)


if __name__ == "__main__":
    unittest.main()
