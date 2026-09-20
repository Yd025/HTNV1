"""Fairness, frozen-input and paired-statistics checks without training."""
import copy
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from compare_simulation import (canonical, compare, digest, paired_statistics,
                                rule_hashes, seed_range, snapshot, validate_comparison)


STUB_ENGINE = '''
import hashlib
import json
from types import SimpleNamespace
import numpy as np
SENSOR_MODEL = {"conditions": {"clear": {}}, "freshnessS": 10}
class Terrain:
    def __init__(self, profile):
        self.profile = profile
def scenario(terrain, seed, horizon, step):
    return SimpleNamespace(seed=seed, positions=np.array([[float(seed), 0.]]), condition="clear")
def sensor_quality():
    return 1
def sample_observations():
    return []
def move_drone():
    return 1
def move_surveillance_drone():
    return 1
def sensor_pose():
    return 1
def towers_for():
    return []
def run_episode(terrain, config, episode, motion, horizon, step, replay):
    value = config["value"]
    for tick in range(1):
        boat = episode.positions[tick]
        estimate_is_target = value > 0
        detected = 100 if estimate_is_target else 0
        gap = 0 if estimate_is_target else horizon
        if replay:
            pass
    samples = 1
    metrics = {"seed": episode.seed, "condition": episode.condition,
               "detectionRate": detected, "custodyPct": value, "longestGapS": gap}
    return {"metrics": metrics}
def summarize(rows):
    return {"episodes": len(rows), **{key: sum(row["metrics"][key] for row in rows)/len(rows)
        for key in ("detectionRate", "custodyPct", "longestGapS")}}
def profile_hash(profile):
    return hashlib.sha256(json.dumps(profile, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
'''


def fixture(root, value=10, source=STUB_ENGINE):
    backend = root / "backend"
    backend.mkdir(parents=True)
    (backend / "graph_search.py").write_text(source, encoding="utf-8")
    profile = {"fixture": "same world"}
    profile_path = root / "frontend/public/experiments/arctic-profile.json"
    profile_path.parent.mkdir(parents=True)
    profile_path.write_bytes(canonical(profile))
    model = {"profileHash": digest(canonical(profile)),
             "sensorModel": {"conditions": {"clear": {}}, "freshnessS": 10},
             "sourceSha256": {"graph_search.py": digest(source.encode())},
             "protocol": {"horizonS": 300, "stepS": 5, "seedRanges": {"train": [10, 20], "test": [50, 60]}},
             "trained": {"value": value}, "motion": None, "missionVersion": "fixture"}
    model_path = root / "model.json"
    model_path.write_bytes(canonical(model))
    return model_path


class CompareSimulationTests(unittest.TestCase):
    def test_paired_statistics_include_misses_and_use_percentage_points(self):
        reference = [{"seed": 1, "detectionRate": 0, "custodyPct": 0, "longestGapS": 300},
                     {"seed": 2, "detectionRate": 100, "custodyPct": 40, "longestGapS": 40}]
        candidate = [{"seed": 1, "detectionRate": 100, "custodyPct": 60, "longestGapS": 20},
                     {"seed": 2, "detectionRate": 0, "custodyPct": 0, "longestGapS": 300}]
        result = paired_statistics(reference, candidate, samples=200)
        self.assertEqual(result["episodes"], 2)
        self.assertEqual(result["detectionGainPp"]["mean"], 0)
        self.assertEqual(result["custodyGainPp"]["mean"], 10)
        self.assertEqual(result["gapSecondsSaved"]["mean"], 10)
        self.assertEqual(result, paired_statistics(reference, candidate, samples=200))
        with self.assertRaisesRegex(ValueError, "ordered unique"):
            paired_statistics(reference, list(reversed(candidate)))
        with self.assertRaisesRegex(ValueError, "ordered unique"):
            paired_statistics([reference[0]] * 2, [candidate[0]] * 2)

    def test_frozen_source_and_profile_mismatches_are_rejected(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            model = fixture(root)
            self.assertEqual(snapshot(root, model)["profileHash"], json.loads(model.read_text())["profileHash"])
            (root / "backend/graph_search.py").write_text(STUB_ENGINE + "\n# changed", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "source hashes"):
                snapshot(root, model)
            (root / "backend/graph_search.py").write_text(STUB_ENGINE, encoding="utf-8")
            (root / "frontend/public/experiments/arctic-profile.json").write_text("{}")
            with self.assertRaisesRegex(ValueError, "profileHash"):
                snapshot(root, model)

    def test_both_models_and_explicit_development_ranges_are_excluded(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            original = snapshot(root, fixture(root))
            candidate = copy.deepcopy(original)
            candidate["protocol"]["seedRanges"] = {"validation": [100, 110]}
            validate_comparison(original, candidate, 200, 10, [(150, 160)])
            for start, count, message in ((9, 2, "reference train"), (60, 1, "reference test"),
                                          (99, 2, "candidate validation"), (160, 1, "development")):
                with self.assertRaisesRegex(ValueError, message):
                    validate_comparison(original, candidate, start, count, [(150, 160)])
            with self.assertRaises(ValueError):
                validate_comparison(original, candidate, 2**31 - 1, 2)
            self.assertEqual(seed_range("20770001:20770048"), (20770001, 20770048))

    def test_rule_sensor_and_timing_changes_are_rejected(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            original = snapshot(root, fixture(root))
            for field, value in (("profileHash", "different"), ("sensorModel", {}), ("ruleSha256", {})):
                candidate = copy.deepcopy(original)
                candidate[field] = value
                with self.assertRaisesRegex(ValueError, field):
                    validate_comparison(original, candidate, 200, 2)
            candidate = copy.deepcopy(original)
            candidate["protocol"]["stepS"] = 1
            with self.assertRaisesRegex(ValueError, "stepS"):
                validate_comparison(original, candidate, 200, 2)
        self.assertEqual(rule_hashes(STUB_ENGINE), rule_hashes("# formatting only\n" + STUB_ENGINE))
        self.assertNotEqual(rule_hashes(STUB_ENGINE), rule_hashes(STUB_ENGINE.replace("else horizon", "else 0")))
        self.assertNotEqual(rule_hashes(STUB_ENGINE), rule_hashes(
            STUB_ENGINE.replace("def move_surveillance_drone():\n    return 1", "def move_surveillance_drone():\n    return 2")))

    def test_separate_workers_evaluate_frozen_models_and_preserve_inputs(self):
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            reference, candidate = root / "reference", root / "candidate"
            reference_model = fixture(reference, 0)
            # Only pre-scoring controller behavior differs; isolated imports
            # must execute each checkout's own implementation.
            candidate_model = fixture(candidate, 60, STUB_ENGINE.replace('value = config["value"]', 'value = config["value"] + 5'))
            before = {path: path.read_bytes() for path in (reference_model, candidate_model)}
            args = SimpleNamespace(reference_root=reference, reference_model=reference_model,
                                   candidate_model=candidate_model, seed_start=200, episodes=3,
                                   exclude_range=[(150, 160)], output=root / "comparison.json")
            with patch("compare_simulation.ROOT", candidate):
                result = compare(args)
            self.assertEqual(result["metrics"]["reference"]["detectionRate"], 0)
            self.assertEqual(result["metrics"]["candidate"]["detectionRate"], 100)
            self.assertEqual(result["metrics"]["candidate"]["custodyPct"], 65)
            self.assertEqual(result["comparison"]["gapSecondsSaved"], {"mean": 300, "ci95": [300, 300]})
            self.assertEqual([row["seed"] for row in result["perEpisode"]["candidate"]], [200, 201, 202])
            self.assertEqual(len(result["scenarios"]), 3)
            self.assertEqual(json.loads(args.output.read_text()), result)
            self.assertTrue(all(path.read_bytes() == content for path, content in before.items()))


if __name__ == "__main__":
    unittest.main()
