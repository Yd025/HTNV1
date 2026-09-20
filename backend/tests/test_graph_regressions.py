"""Review regressions for source geometry and benchmark interpretation."""
import math
import unittest

from graph_search import Terrain, run_episode, scenario, summarize


def flat_profile():
    water = [False, True, False, True, True, True, True, True, True]
    edges = [[1, 4], [3, 4], [4, 5], [3, 6], [4, 7], [5, 8], [6, 7], [7, 8]]
    sensor = {"hfovDeg": 60, "vfovDeg": 45, "nearClipM": 1, "farClipM": 1500, "pitchDeg": 0}
    return {
        "halfM": 300,
        "grid": {"size": 3, "cellM": 300, "xMin": -300, "yMin": -300,
                 "elevations": [0] * 9, "water": water, "waterEdges": edges, "landCandidates": [0, 2]},
        "sensors": {"tower": sensor, "quad": dict(sensor, hfovDeg=178), "plane": sensor},
        "assetHeightsM": {"tower": 2.7, "quad": 60, "plane": 120},
        "speedsMps": {"boat": 3, "quad": 10, "plane": 15},
        "assets": [{"id": "fixed-wing", "sensor": "plane", "x": 120, "y": 75},
                   {"id": "quadcopter", "sensor": "quad", "x": -80, "y": 125}],
    }


class GraphReviewRegressions(unittest.TestCase):
    def test_optical_depth_controls_both_clip_planes(self):
        terrain = Terrain(flat_profile())
        pose = {"x": 0, "y": 0, "z": 1.5, "heading": 0, "pitch": 0}
        # Slant distance exceeds 1500 m, but optical depth is inside the far plane.
        self.assertTrue(terrain.camera_mask(pose, "quad", [[800, 1400]])[0])
        # Slant distance exceeds 1 m, but optical depth is before the near plane.
        self.assertFalse(terrain.camera_mask(pose, "quad", [[10, 0.5]])[0])

    def test_clockwise_grid_heading_90_looks_along_positive_x(self):
        terrain = Terrain(flat_profile())
        pose = {"x": 0, "y": 0, "z": 1.5, "heading": 90, "pitch": 0}
        self.assertTrue(terrain.camera_mask(pose, "tower", [[200, 0]])[0])
        self.assertFalse(terrain.camera_mask(pose, "tower", [[0, 200]])[0])

    def test_replay_starts_at_source_aircraft_xy(self):
        profile = flat_profile()
        terrain = Terrain(profile)
        config = {"towers": [{"id": "tower-1", "x": -300, "y": -300},
                              {"id": "tower-2", "x": 300, "y": -300}]}
        result = run_episode(terrain, config, scenario(terrain, 17, 10, 5), horizon=10, step=5, replay=True)
        starts = {drone["id"]: drone for drone in result["frames"][0]["drones"]}
        for asset in profile["assets"]:
            self.assertEqual(starts[asset["sensor"]]["x"], asset["x"])
            self.assertEqual(starts[asset["sensor"]]["y"], asset["y"])

    def test_misses_remain_in_denominator_and_rmse_is_sample_weighted(self):
        common = {"coveragePct": 0, "custodyPct": 0, "estimateAvailabilityPct": 0,
                  "distanceM": 0, "handoffs": 0, "bySource": {"tower-1": 0}}
        found = dict(common, detectionRate=100, meanCappedS=0, estimateSamples=1, squaredErrorSum=4)
        later = dict(common, detectionRate=100, meanCappedS=200, estimateSamples=9, squaredErrorSum=81)
        missed = dict(common, detectionRate=0, meanCappedS=300, estimateSamples=0, squaredErrorSum=0)
        score = summarize([{"metrics": found}, {"metrics": later}, {"metrics": missed}])
        self.assertEqual(score["episodes"], 3)
        self.assertAlmostEqual(score["detectionRate"], 200 / 3)
        self.assertAlmostEqual(score["meanCappedS"], 500 / 3)
        self.assertEqual(score["p90CappedS"], 300)
        self.assertAlmostEqual(score["rmseM"], math.sqrt(85 / 10))


if __name__ == "__main__":
    unittest.main()
