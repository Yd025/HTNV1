import argparse
import contextlib
import io
import json
import math
import tempfile
import unittest
from pathlib import Path

from geo import ne_to_ll
from search_experiment import (Scenario, arena_for, default_policy, paired_interval, propose,
                               run_trial, scenarios, summarize, validate_policy)
from sim.local_sitl import KinematicCraft
from sim.types import Arena, Command
from train_search import train
import random


class SearchExperimentTests(unittest.TestCase):
    def test_repeated_episode_is_deterministic_and_seeded(self):
        policy = default_policy()
        episode = scenarios(17, 1, 1500)[0]
        self.assertEqual(run_trial(policy, episode, 40), run_trial(policy, episode, 40))
        self.assertNotEqual(episode, scenarios(18, 1, 1500)[0])

    def test_misses_count_at_deadline_not_dropped(self):
        rows = [{"detected": True, "capped_detection_time_s": 10, "distance_m": 20},
                {"detected": False, "capped_detection_time_s": 100, "distance_m": 40}]
        summary = summarize(rows, 100)
        self.assertEqual(summary["restricted_mean_detection_s"], 55)
        self.assertEqual(summary["miss_rate"], 0.5)
        self.assertEqual(summary["p90_capped_s"], 100)

    def test_no_detection_has_null_time_and_finite_penalty(self):
        result = run_trial(default_policy(), Scenario(1, -1200, 1200, 0, 0, "straight", 0), 0.1)
        self.assertFalse(result["detected"])
        self.assertIsNone(result["detection_time_s"])
        self.assertEqual(result["capped_detection_time_s"], 0.1)

    def test_tower_hit_measures_delay_from_spawn(self):
        policy = default_policy()
        policy["planner"]["detection_probability"] = 1
        for t in policy["arena"]["towers"]:
            t["fov_deg"] = 360
        result = run_trial(policy, Scenario(1, 900, 900, 0, 0, "straight", 2.4), 10)
        self.assertTrue(result["detected"])
        self.assertAlmostEqual(result["detection_time_s"], 0.6)

    def test_invalid_policy_and_mismatched_cadence_rejected(self):
        for change in (lambda p: p.update(mode="live"),
                       lambda p: p["arena"]["towers"][0].update(lat=math.nan),
                       lambda p: p["planner"].update(grid_size=100),
                       lambda p: p.update(observation_period_s=math.nan),
                       lambda p: p["arena"].update(no_fly=[{"x": 0}])):
            policy = default_policy()
            change(policy)
            with self.assertRaises(ValueError):
                validate_policy(policy)
        with self.assertRaises(ValueError):
            run_trial(default_policy(), scenarios(1, 1, 1500)[0], 10, 0.5)

    def test_proposals_respect_boundaries_and_spacing(self):
        incumbent = default_policy()
        rng = random.Random(11)
        for i in range(100):
            incumbent = propose(incumbent, rng, i)
            validate_policy(incumbent)

    def test_sensor_ablations_remove_source_classes(self):
        policy = default_policy()
        policy["planner"]["detection_probability"] = 1
        for t in policy["arena"]["towers"]:
            t["fov_deg"] = 360
        episode = Scenario(1, 900, 900, 0, 0, "straight", 0)
        self.assertTrue(run_trial(policy, episode, 1, sensors="towers")["detected"])
        self.assertFalse(run_trial(policy, episode, 1, sensors="vehicles")["detected"])

    def test_craft_uses_explicit_arena_and_travel_heading(self):
        arena = Arena(71.99196, -94.822428, 3250)
        craft = KinematicCraft({"vehicle_id": "c", "sysid": 1, "vehicle_class": "copter", "north": 0, "east": 0}, arena)
        lat, lon = ne_to_ll(0, 100, arena.origin_lat, arena.origin_lon)
        craft.apply(Command("c", "goto", lat, lon))
        craft.step(1)
        self.assertAlmostEqual(craft.east, 12)
        self.assertAlmostEqual(craft.heading, 90)
        self.assertAlmostEqual(craft.state(False).lat, arena.origin_lat)

    def test_bootstrap_requires_paired_seeds(self):
        rows = [{"seed": 1, "capped_detection_time_s": 10, "detected": True}]
        self.assertEqual(paired_interval(rows, rows, 1)["bootstrap_95_percent_ci_s"], [0, 0])
        with self.assertRaises(ValueError):
            paired_interval(rows, [{"seed": 2, "capped_detection_time_s": 10}], 1)

    def test_training_resume_preserves_rounds_and_holds_out_new_test(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            args = argparse.Namespace(output=directory, resume=None, seed=11, candidates=1,
                                      train=2, validation=2, test=2, horizon=3.0, dt=1.0)
            first = train(args)
            args.resume = directory
            second = train(args)
            self.assertEqual(first["round"], 1)
            self.assertEqual(second["round"], 2)
            self.assertTrue((Path(directory) / "round-001.json").exists())
            self.assertTrue((Path(directory) / "round-002.json").exists())
            self.assertEqual(first["scenarios"]["training"], second["scenarios"]["training"])
            sets = [set(s["seed"] for s in first["scenarios"][split]) for split in ("training", "validation", "test")]
            sets.append(set(s["seed"] for s in second["scenarios"]["test"]))
            for i, a in enumerate(sets):
                for b in sets[i + 1:]:
                    self.assertFalse(a & b)
            selected = second["selected"]
            self.assertLessEqual(second["validation"][selected]["summary"]["miss_rate"],
                                 second["validation"]["previous_incumbent"]["summary"]["miss_rate"])
            self.assertEqual(json.loads((Path(directory) / "best_policy.json").read_text()), second["selected_policy"])


if __name__ == "__main__":
    unittest.main()
