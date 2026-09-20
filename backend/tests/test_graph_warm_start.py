"""Warm starts supply candidates, never historical evidence or selection results."""
import copy
import hashlib
import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

from flight_policy import COORDINATED_ALGORITHM, DEFAULT_FLIGHT_POLICY, LEGACY_ALGORITHM
from graph_search import DEFAULT_WEIGHTS, Terrain, profile_hash
from train_graph_search import load_initial_model, main, snap_towers, train
from test_graph_search import profile


class GraphWarmStartTests(unittest.TestCase):
    def setUp(self):
        self.directory = TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.profile = profile()
        self.terrain = Terrain(self.profile)
        self.model = {"algorithm":COORDINATED_ALGORITHM, "missionVersion":COORDINATED_ALGORITHM,
                      "profileHash":profile_hash(self.profile), "seed":12345,
                      "trained":{"towers":[{"x":-260., "y":-280., "heading":-30.},
                                           {"x":270., "y":-280., "heading":390.}],
                                 "algorithm":COORDINATED_ALGORITHM, "flightPolicy":{"lookaheadS":38.}},
                      "motion":{"shouldNotImport":True}, "history":[{"selectedIndex":999}],
                      "metrics":{"trained":{"detectionRate":999}}, "selectedIndex":999}
        self.path = self.root/"initial.json"

    def write_model(self):
        self.path.write_text(json.dumps(self.model), encoding="utf-8")
        return self.path

    def test_loads_only_validated_parameters_and_exact_artifact_provenance(self):
        config, provenance = load_initial_model(self.write_model(), self.terrain)
        self.assertEqual(set(config), {"towers", "weights", "algorithm", "flightPolicy"})
        self.assertEqual(config["towers"], snap_towers(self.terrain, self.model["trained"]["towers"]))
        self.assertEqual([tower["heading"] for tower in config["towers"]], [330., 30.])
        self.assertEqual(config["weights"], DEFAULT_WEIGHTS)
        self.assertEqual(config["flightPolicy"], dict(DEFAULT_FLIGHT_POLICY, lookaheadS=38.))
        self.assertEqual(provenance, {"sha256":hashlib.sha256(self.path.read_bytes()).hexdigest(), "seed":12345})

    def test_rejects_mismatched_profile_algorithm_or_invalid_parameters(self):
        mutations = [lambda model:model.update(profileHash="different"),
                     lambda model:model.update(algorithm=LEGACY_ALGORITHM),
                     lambda model:model["trained"].update(algorithm=LEGACY_ALGORITHM),
                     lambda model:model["trained"].update(flightPolicy={"lookaheadS":41}),
                     lambda model:model["trained"].update(towers=[{"x":float("nan"), "y":0}]*2),
                     lambda model:model["trained"].update(towers=[]),
                     lambda model:model["trained"].update(towers=[{"x":None, "y":0}]*2),
                     lambda model:model.update(seed=True)]
        original = copy.deepcopy(self.model)
        for mutate in mutations:
            with self.subTest(mutate=mutate):
                self.model = copy.deepcopy(original)
                mutate(self.model)
                with self.assertRaises(ValueError):
                    load_initial_model(self.write_model(), self.terrain)

    def fake_row(self, seed, detection_rate=100.):
        return {"seed":seed, "frames":[], "metrics":{
            "detectedAt":0, "detectionRate":detection_rate, "meanCappedS":0., "coveragePct":20.,
            "custodyPct":20., "estimateAvailabilityPct":20., "distanceM":100., "handoffs":1,
            "estimateSamples":1, "squaredErrorSum":1., "bySource":{"quad":1}}}

    def run_mock_training(self, initial=True):
        profile_path = self.root/"profile.json"
        profile_path.write_text(json.dumps(self.profile), encoding="utf-8")
        args = SimpleNamespace(profile=profile_path, quick=True, seed=100, progress=None,
                               output=self.root/"report.json", model_output=self.root/"model.json")
        if initial:
            args.initial_model = self.write_model()
        evaluated = []
        test_started_after_freeze = []

        def fake_scenario(terrain, seed, *unused):
            if seed >= args.seed+400000:
                test_started_after_freeze.append(args.model_output.exists())
            return SimpleNamespace(seed=seed)

        def fake_evaluate(terrain, config, episodes, *unused, **kwargs):
            evaluated.append(copy.deepcopy(config))
            # Initial candidate is worst on training, still reaches validation,
            # then loses validation to candidate 1 regardless of saved claims.
            detection_rate = [10., 40., 60., 80., 20., 90., 70., 60.][len(evaluated)-1]
            row = self.fake_row(episodes[0].seed, detection_rate)
            return row["metrics"], [row]

        with patch("train_graph_search.scenario", side_effect=fake_scenario), \
             patch("train_graph_search.train_motion", return_value={"trainingTransitions":0}), \
             patch("train_graph_search.propose_tower_pair", return_value=snap_towers(self.terrain, self.profile["towerDefaults"])), \
             patch("train_graph_search.evaluate", side_effect=fake_evaluate), \
             patch("train_graph_search.run_episode", side_effect=lambda terrain, config, episode, *unused:self.fake_row(episode.seed)), \
             patch("train_graph_search.source_hashes", return_value={"frozen":"source"}), \
             patch("builtins.print"):
            report = train(args)
        self.assertTrue(test_started_after_freeze and all(test_started_after_freeze))
        self.assertEqual(report["selectedIndex"], 1)
        self.assertFalse(report["comparison"]["testUsedForSelection"])
        self.assertEqual(len(report["history"]), 4)
        self.assertEqual(evaluated[0], evaluated[4])
        return report, evaluated, json.loads(args.model_output.read_text())

    def test_warm_start_is_retested_as_initial_finalist_and_can_lose(self):
        report, evaluated, saved_model = self.run_mock_training()
        self.assertEqual(evaluated[0]["flightPolicy"]["lookaheadS"], 38.)
        self.assertEqual(report["protocol"]["initialModel"]["seed"], self.model["seed"])
        self.assertEqual(report["protocol"]["initialModel"]["sha256"], hashlib.sha256(self.path.read_bytes()).hexdigest())
        self.assertEqual(saved_model["protocol"], json.loads(json.dumps(report["protocol"])))
        self.assertEqual(saved_model["motion"], {"trainingTransitions":0})
        self.assertEqual(saved_model["seed"], 100)
        self.assertIn("any sensor", report["metricDefinitions"]["postTowerCustodyPct"])

    def test_namespace_without_optional_flag_preserves_default_initial_candidate(self):
        report, evaluated, saved_model = self.run_mock_training(initial=False)
        self.assertNotIn("initialModel", report["protocol"])
        self.assertEqual(evaluated[0]["flightPolicy"], DEFAULT_FLIGHT_POLICY)
        self.assertEqual(evaluated[0]["towers"], snap_towers(self.terrain, self.profile["towerDefaults"]))

    def test_legacy_training_rejects_warm_start_before_generating_episodes(self):
        path = self.root/"profile.json"
        path.write_text(json.dumps(self.profile), encoding="utf-8")
        args = SimpleNamespace(profile=path, algorithm=LEGACY_ALGORITHM, quick=True,
                               initial_model=self.write_model())
        with patch("train_graph_search.scenario") as generate:
            with self.assertRaisesRegex(ValueError, "requires coordinated"):
                train(args)
            generate.assert_not_called()

    def test_cli_exposes_optional_initial_model_argument(self):
        with patch("sys.argv", ["train_graph_search.py", "--initial-model", "saved.json"]), \
             patch("train_graph_search.train") as run:
            main()
        self.assertEqual(run.call_args.args[0].initial_model, "saved.json")


if __name__ == "__main__":
    unittest.main()
