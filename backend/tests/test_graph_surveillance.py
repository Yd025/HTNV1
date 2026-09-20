"""Observation boundary, aircraft search/continuity and fitted policy contract."""
import copy
import json
import math
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

from flight_policy import (COORDINATED_ALGORITHM, DEFAULT_FLIGHT_POLICY,
                           FLIGHT_POLICY_BOUNDS, normalize_flight_policy)
from graph_search import (CoordinatedPlanner, Observation, Scenario, Terrain, TowerMission,
                          angle_delta, move_surveillance_drone, objective, profile_hash,
                          run_episode, scenario, summarize)
from train_graph_search import propose_flight_policy, replay, source_hashes
from test_graph_search import profile


class SurveillanceTests(unittest.TestCase):
    def setUp(self):
        self.profile = profile()
        self.terrain = Terrain(self.profile)
        self.config = {"towers":self.profile["towerDefaults"], "algorithm":COORDINATED_ALGORITHM,
                       "flightPolicy":dict(DEFAULT_FLIGHT_POLICY)}

    def test_aircraft_can_confirm_first_but_duplicate_and_same_time_frames_cannot(self):
        mission = TowerMission(any_sensor=True)
        first = Observation("plane", (0., 0.), 0., 5., .9)
        self.assertIsNone(mission.update([first], 0))
        self.assertIsNone(mission.update([first, Observation("quad", (0., 0.), 0., 5., .9)], 0))
        self.assertIsNotNone(mission.update([Observation("plane", (5., 0.), 5., 5., .9)], 5))
        self.assertEqual(mission.acquired_source, "plane")
        self.assertEqual(mission.phase, "drone_track")
        self.assertIsNone(mission.tower_confirmed_at)
        self.assertIn("sensor_confirmed", [event["type"] for event in mission.events])

    def test_both_aircraft_search_without_any_sighting_and_plane_does_not_stop(self):
        with patch("graph_search.sample_observations", return_value=[]):
            result = run_episode(self.terrain, self.config, scenario(self.terrain, 4, 80), horizon=80, replay=True)
        for kind in ("plane", "quad"):
            positions = [next(d for d in frame["drones"] if d["id"] == kind) for frame in result["frames"]]
            distances = [math.hypot(a["x"]-b["x"], a["y"]-b["y"]) for a,b in zip(positions, positions[1:])]
            self.assertGreater(sum(distances), 200.)
            if kind == "plane":
                self.assertTrue(all(distance > 40 for distance in distances), distances)
                self.assertAlmostEqual(result["metrics"]["flightDistanceByAssetM"][kind], 80*15)
        self.assertEqual(result["metrics"]["longestGapS"], 80.)
        self.assertEqual(result["metrics"]["custodyPct"], 0.)

    def test_no_observation_means_identical_actions_for_different_hidden_routes(self):
        a = scenario(self.terrain, 1, 40)
        b = Scenario(1, scenario(self.terrain, 999, 40).positions)
        with patch("graph_search.sample_observations", return_value=[]):
            left = run_episode(self.terrain, self.config, a, horizon=40, replay=True)
            right = run_episode(self.terrain, self.config, b, horizon=40, replay=True)
        for x,y in zip(left["frames"], right["frames"]):
            for key in ("drones", "estimate", "phase", "events"):
                self.assertEqual(x[key], y[key])

    def test_aircraft_first_target_is_scored_without_awarding_a_tower_detection(self):
        def observe(terrain, pose, kind, boat, condition, seed, t, mask):
            return [Observation("plane", (0.,0.), t, 5., .9)] if pose["id"] == "plane" and t <= 10 else []
        with patch("graph_search.sample_observations", side_effect=observe):
            result = run_episode(self.terrain, self.config, Scenario(1,np.zeros((13,2))), horizon=60, replay=True)
        metrics = result["metrics"]
        self.assertEqual(metrics["detectedAt"], 5)
        self.assertEqual(metrics["handoffAt"], 5)
        self.assertEqual(metrics["towerAcquisitionRate"], 0.)
        self.assertGreater(metrics["anySensorCustodyPct"], 0.)
        self.assertGreater(metrics["longestGapS"], 20.)
        self.assertEqual(result["frames"][-1]["phase"], "lost")
        self.assertFalse(any(frame["towerConfirmed"] for frame in result["frames"]))

    def test_fixed_wing_support_cannot_read_hidden_route_after_confirmation(self):
        def observe(terrain, pose, kind, boat, condition, seed, t, mask):
            return [Observation("tower-1", (t * .5, 0.), t, 5., .9)] if pose["id"] == "tower-1" else []
        a = scenario(self.terrain, 1, 60)
        b = Scenario(1, scenario(self.terrain, 999, 60).positions)
        with patch("graph_search.sample_observations", side_effect=observe):
            left = run_episode(self.terrain, self.config, a, horizon=60, replay=True)
            right = run_episode(self.terrain, self.config, b, horizon=60, replay=True)
        self.assertTrue(any(frame["estimate"] for frame in left["frames"]))
        for x, y in zip(left["frames"], right["frames"]):
            self.assertEqual(x["drones"], y["drones"])
            self.assertEqual(x["phase"], y["phase"])

    def test_plane_at_waypoint_keeps_forward_speed_with_bounded_heading(self):
        drone = {"id":"plane", "x":0., "y":0., "z":120., "heading":0.}
        distance = move_surveillance_drone(self.terrain, drone, self.terrain.node(0.,0.), 1.)
        self.assertAlmostEqual(distance, 15.)
        self.assertLessEqual(abs(angle_delta(drone["heading"],0.)), 15.)

    def test_policy_mutation_is_bounded_and_search_parameters_change_actual_routes(self):
        rng = np.random.default_rng(7)
        for _ in range(12):
            candidate = propose_flight_policy(rng, explore=True)
            for key, (low, high) in FLIGHT_POLICY_BOUNDS.items():
                self.assertTrue(low <= candidate[key] <= high)
        # Route phase is a real route-order feature, not display-only metadata.
        launch = {"plane":(-150.,0.), "quad":(150.,0.)}
        a = CoordinatedPlanner(self.terrain, normalize_flight_policy({"laneSpacingM":200,"routePhase":0}), launch)
        b = CoordinatedPlanner(self.terrain, normalize_flight_policy({"laneSpacingM":200,"routePhase":.7}), launch)
        self.assertNotEqual(a.patrol["plane"], b.patrol["plane"])
        config = copy.deepcopy(self.config)
        config["flightPolicy"].update(laneSpacingM=200.,routePhase=.7,quadSearchRadiusM=250.)
        with patch("graph_search.sample_observations", return_value=[]):
            left = run_episode(self.terrain,self.config,scenario(self.terrain,4,40),horizon=40,replay=True)
            right = run_episode(self.terrain,config,scenario(self.terrain,4,40),horizon=40,replay=True)
        self.assertNotEqual(left["frames"][-1]["drones"], right["frames"][-1]["drones"])

    def test_policy_rejects_invalid_inputs_and_returns_independent_defaults(self):
        for values in ({"routePhase":float("nan")},{"lookaheadS":50},{"targetX":1},{"laneSpacingM":True},[]):
            with self.assertRaises(ValueError):
                normalize_flight_policy(values)
        policy = normalize_flight_policy()
        policy["routePhase"] = 1
        self.assertEqual(DEFAULT_FLIGHT_POLICY["routePhase"], 0)

    def test_objective_rewards_continuity_even_when_tower_acquisition_is_zero(self):
        score = {"detectionRate":80.,"towerAcquisitionRate":0.,"custodyPct":20.,"anySensorCustodyPct":30.,
                 "meanCappedS":100.,"longestGapS":90.,"distanceM":7000.,"falseConfirmations":0.,"rmseM":10.}
        better = dict(score,custodyPct=60.,anySensorCustodyPct=70.,longestGapS=20.)
        self.assertLess(objective(better,COORDINATED_ALGORITHM),objective(score,COORDINATED_ALGORITHM))

    def test_legacy_saved_model_remains_replayable_with_explicit_provenance_warning(self):
        with TemporaryDirectory() as directory:
            directory = Path(directory)
            profile_path, model_path, request_path = [directory/name for name in ("profile.json","model.json","request.json")]
            profile_path.write_text(json.dumps(self.profile))
            model = {"missionVersion":"tower-first-v2","seed":1,"profileHash":profile_hash(self.profile),
                     "sourceSha256":{"old":"hash"},"trained":{"towers":self.profile["towerDefaults"],"weights":[4,1.3,1,1,.4]},
                     "protocol":{"horizonS":10,"stepS":5},"motion":None}
            model_path.write_text(json.dumps(model))
            request_path.write_text(json.dumps({"seed":2}))
            result = replay(SimpleNamespace(profile=profile_path,model=model_path,replay=request_path,output=directory/"out.json"))
            self.assertEqual(result["algorithm"], "tower-first-v2")
            self.assertIn("compatibilityWarning", result)
            self.assertIsNone(result["flightPolicy"])


if __name__ == "__main__":
    unittest.main()
