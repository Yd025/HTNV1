"""A provisional observation can steer its camera without becoming evidence."""
import math
import unittest

import numpy as np

from flight_policy import DEFAULT_FLIGHT_POLICY
from graph_search import CoordinatedPlanner, Observation, Terrain, TowerMission
from test_graph_search import profile


class ObservationAttentionTests(unittest.TestCase):
    def setUp(self):
        self.terrain = Terrain(profile())
        self.planner = CoordinatedPlanner(self.terrain, dict(DEFAULT_FLIGHT_POLICY),
                                          {"plane": (-150., 0.), "quad": (150., 0.)})
        self.mission = TowerMission(any_sensor=True)

    def drone(self, kind):
        return {"id": kind, "x": 150., "y": 0., "z": 100., "heading": 0.}

    def test_own_camera_can_verify_sighting_without_confirming_track(self):
        self.mission.update([Observation("quad", (0., 250.), 0., 5., .9)], 0.)
        drone = self.drone("quad")
        self.planner.mission_goal(drone, self.mission, 0.)
        self.assertEqual(drone["missionRole"], "verify_contact")
        self.assertIsNone(self.mission.predict(0.))
        self.assertIsNone(self.mission.acquired_at)
        self.assertIsNone(self.mission.handoff_at)
        self.assertEqual(self.mission.accepted, [])
        self.assertEqual(self.mission.receiver_confirmed_sources, [])

    def test_other_aircraft_keeps_searching_on_unconfirmed_sighting(self):
        self.mission.update([Observation("quad", (0., 250.), 0., 5., .9)], 0.)
        drone = self.drone("plane")
        self.planner.mission_goal(drone, self.mission, 0.)
        self.assertEqual(drone["missionRole"], "wide_search")

    def test_expired_sighting_returns_camera_to_search(self):
        self.mission.update([Observation("quad", (0., 250.), 0., 5., .9)], 0.)
        drone = self.drone("quad")
        self.planner.mission_goal(drone, self.mission, 16.)
        self.assertEqual(drone["missionRole"], "gap_search")
        self.assertIsNone(self.mission.acquired_at)

    def test_following_preserves_camera_distance_without_grid_quantization(self):
        for now in (0., 5.):
            self.mission.update([Observation("quad", (0., 250.), now, 5., .9)], now)
        drone = self.drone("quad")
        goal = self.planner.mission_goal(drone, self.mission, 5.)
        pitch = abs(self.terrain.profile["sensors"]["quad"]["pitchDeg"])
        expected = (drone["z"]-1.5)/math.tan(math.radians(max(5., pitch)))
        self.assertAlmostEqual(np.linalg.norm(goal-self.mission.predict(5.)), expected)
        self.assertGreater(np.linalg.norm(goal-self.terrain.xy[self.terrain.node(*goal)]), 1.)

    def test_fresh_other_sensor_contact_does_not_trigger_an_outage_search(self):
        for now in (0., 5.):
            self.mission.update([Observation("quad", (0., 250.), now, 5., .9)], now)
        for now in (10., 15., 20.):
            self.mission.update([Observation("tower-1", (0., 250.), now, 5., .9)], now)
        self.assertEqual(self.mission.phase, "reacquire")
        drone = self.drone("quad")
        self.planner.mission_goal(drone, self.mission, 20.)
        self.assertEqual(drone["missionRole"], "visual_track")

    def test_own_camera_releases_a_distant_covered_patrol_waypoint(self):
        drone = self.drone("plane")
        old = self.planner.patrol["plane"][0]
        self.planner.goals["plane"] = old
        self.assertGreater(np.linalg.norm(self.terrain.xy[old]-[drone["x"], drone["y"]]), 90.)
        masks = [np.zeros(len(self.terrain.wids), dtype=bool) for _ in range(4)]
        masks[2][self.planner.water_index[old]] = True

        self.planner.observe(masks, [], 5.)
        goal = self.planner.patrol_goal(drone)

        self.assertIn(old, self.planner.visited["plane"])
        self.assertNotEqual(goal, old)
        self.assertIn(goal, self.planner.patrol["plane"])

    def test_camera_progress_does_not_mark_unseen_patrol_cells(self):
        old = self.planner.patrol["plane"][0]
        masks = [np.zeros(len(self.terrain.wids), dtype=bool) for _ in range(4)]
        masks[2][self.planner.water_index[old]] = True

        self.planner.observe(masks, [], 5.)

        self.assertEqual(self.planner.visited["plane"], {old})
        self.assertEqual(self.planner.visited["quad"], set())

    def test_towers_and_other_aircraft_cannot_complete_own_patrol_goal(self):
        for kind, own_mask in (("plane", 2), ("quad", 3)):
            with self.subTest(kind=kind):
                planner = CoordinatedPlanner(self.terrain, dict(DEFAULT_FLIGHT_POLICY),
                                             {"plane": (-150., 0.), "quad": (150., 0.)})
                old = planner.patrol[kind][0]
                planner.goals[kind] = old
                masks = [np.ones(len(self.terrain.wids), dtype=bool) for _ in range(4)]
                masks[own_mask][:] = False

                planner.observe(masks, [], 5.)

                self.assertEqual(planner.visited[kind], set())
                self.assertEqual(planner.patrol_goal(self.drone(kind)), old)

    def test_fully_observed_patrol_can_start_another_cycle(self):
        masks = [np.ones(len(self.terrain.wids), dtype=bool) for _ in range(4)]
        self.planner.observe(masks, [], 5.)
        for kind in ("plane", "quad"):
            self.assertEqual(self.planner.visited[kind], set(self.planner.patrol[kind]))
            self.planner.goals[kind] = self.planner.patrol[kind][0]

            goal = self.planner.patrol_goal(self.drone(kind))

            self.assertIn(goal, self.planner.patrol[kind])
            self.assertEqual(self.planner.visited[kind], set())


if __name__ == "__main__":
    unittest.main()
