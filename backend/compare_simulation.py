"""Compare two frozen offline simulation models on disjoint paired episodes.

Each checkout runs in its own process. No training, adapter or vehicle commands
are imported. Excluded seed ranges use inclusive START:END notation.
"""
from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time


ROOT = Path(__file__).resolve().parents[1]
RULE_NAMES = ("Terrain", "scenario", "sensor_quality", "sample_observations", "summarize",
              "move_drone", "move_surveillance_drone", "sensor_pose", "towers_for")
PROTOCOL_FIELDS = ("horizonS", "stepS", "freshnessS", "confirmationHits",
                   "receiverConfirmationHits", "confirmationWindowS", "lostAfterS",
                   "evaluationToleranceM", "conditions")


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def assigned(node, name):
    return isinstance(node, ast.Assign) and any(
        isinstance(target, ast.Name) and target.id == name for target in node.targets)


def rule_hashes(source):
    """Ignore formatting while pinning world, sensors and evaluator arithmetic."""
    module = ast.parse(source)
    definitions = {node.name: node for node in module.body
                   if isinstance(node, (ast.FunctionDef, ast.ClassDef))}
    try:
        rules = {name: definitions[name] for name in RULE_NAMES}
        episode = definitions["run_episode"]
        loop = next(node for node in episode.body if isinstance(node, ast.For)
                    and any(assigned(item, "boat") for item in node.body))
        start = next(i for i, node in enumerate(loop.body) if assigned(node, "estimate_is_target"))
        end = next(i for i, node in enumerate(loop.body) if i > start and isinstance(node, ast.If)
                   and isinstance(node.test, ast.Name) and node.test.id == "replay")
        sampling_end = next((i for i, node in enumerate(loop.body) if isinstance(node, ast.Expr)
                             and isinstance(node.value, ast.Call) and isinstance(node.value.func, ast.Attribute)
                             and node.value.func.attr == "observe"), start)
        rules["episodeSampling"] = ast.Module(body=loop.body[:sampling_end], type_ignores=[])
        rules["episodeScoring"] = ast.Module(body=loop.body[start:end], type_ignores=[])
        rules["episodeMetrics"] = ast.Module(
            body=[node for node in episode.body[episode.body.index(loop) + 1:] if isinstance(node, ast.Assign)],
            type_ignores=[])
        if not all(any(assigned(node, name) for node in rules["episodeMetrics"].body) for name in ("samples", "metrics")):
            raise ValueError("Expected sample count and metric assignments")
        counters = {"custody", "estimate_count", "error_sum", "flight_distance", "any_custody", "longest_gap",
                    "gap_started", "post_tower_samples", "post_tower_custody", "false_confirmations",
                    "accepted_count", "contributions", "first_hit", "target_confirmed_at", "target_handoff_at",
                    "tower_confirmed_at", "last_true_drone", "true_drone_hits"}
        rules["episodeScoringInitialState"] = ast.Module(body=[node for node in episode.body[:episode.body.index(loop)]
            if isinstance(node, ast.Assign) and any(isinstance(part, ast.Name) and part.id in counters
                                                   for target in node.targets for part in ast.walk(target))], type_ignores=[])
    except (KeyError, StopIteration) as error:
        raise ValueError("Cannot identify the frozen simulation evaluation rules") from error
    return {name: digest(ast.dump(node, include_attributes=False).encode()) for name, node in rules.items()}


def snapshot(root, model_path):
    root, model_path = Path(root).resolve(), Path(model_path).resolve()
    model_bytes = model_path.read_bytes()
    model = json.loads(model_bytes)
    expected = model.get("sourceSha256")
    if not isinstance(expected, dict) or not expected or "graph_search.py" not in expected:
        raise ValueError("Frozen model must contain simulation source hashes")
    backend = root / "backend"
    actual = {}
    for name in expected:
        source = (backend / name).resolve()
        if not source.is_relative_to(backend.resolve()) or source.suffix != ".py":
            raise ValueError("Invalid source path in frozen model")
        actual[name] = digest(source.read_bytes().replace(b"\r\n", b"\n"))
    if actual != expected:
        raise ValueError(f"Frozen model source hashes do not match {root}")
    profile_path = root / "frontend/public/experiments/arctic-profile.json"
    profile_bytes = profile_path.read_bytes()
    profile = json.loads(profile_bytes)
    profile_hash = digest(canonical(profile))
    if model.get("profileHash") != profile_hash:
        raise ValueError("Frozen model profileHash does not match its terrain profile")
    if not isinstance(model.get("sensorModel"), dict):
        raise ValueError("Frozen model must record its sensorModel")
    return {"root": str(root), "modelPath": str(model_path), "modelSha256": digest(model_bytes),
            "profilePath": str(profile_path), "profileFileSha256": digest(profile_bytes),
            "profileHash": profile_hash, "sensorModel": model["sensorModel"],
            "sourceSha256": actual, "ruleSha256": rule_hashes((backend / "graph_search.py").read_text(encoding="utf-8")),
            "algorithm": model.get("algorithm", model.get("missionVersion")),
            "protocol": model["protocol"]}


def seed_range(value):
    try:
        start, end = (int(part) for part in value.split(":"))
    except (ValueError, AttributeError) as error:
        raise argparse.ArgumentTypeError("Use an inclusive START:END seed range") from error
    if not 0 <= start <= end <= 2**31 - 1:
        raise argparse.ArgumentTypeError("Invalid seed range")
    return start, end


def validate_comparison(reference, candidate, start, episodes, excluded=()):
    if not isinstance(start, int) or not isinstance(episodes, int) or episodes < 1:
        raise ValueError("Seed start and positive episode count must be integers")
    end = start + episodes - 1
    if not 0 <= start <= end <= 2**31 - 1:
        raise ValueError("Evaluation seeds must fit between 0 and 2147483647")
    for field in ("profileHash", "sensorModel", "ruleSha256"):
        if reference[field] != candidate[field]:
            raise ValueError(f"Reference and candidate {field} differ; the comparison is not equivalent")
    for field in PROTOCOL_FIELDS:
        if reference["protocol"].get(field) != candidate["protocol"].get(field):
            raise ValueError(f"Reference and candidate scoring protocol differs: {field}")
    for label, model in (("reference", reference), ("candidate", candidate)):
        ranges = model["protocol"].get("seedRanges")
        if not isinstance(ranges, dict) or not ranges:
            raise ValueError(f"{label} model must record its used seed ranges")
        for split, interval in ranges.items():
            if (not isinstance(interval, (list, tuple)) or len(interval) != 2
                    or not all(isinstance(value, int) for value in interval) or interval[0] > interval[1]):
                raise ValueError(f"Invalid {label} seed range: {split}")
            if start <= interval[1] and interval[0] <= end:
                raise ValueError(f"Evaluation seeds overlap {label} {split} seeds")
    for lower, upper in excluded:
        if start <= upper and lower <= end:
            raise ValueError("Evaluation seeds overlap an explicitly excluded development range")


def paired_statistics(reference, candidate, samples=2000, seed=8675309):
    import numpy as np

    if not reference or len(reference) != len(candidate):
        raise ValueError("Paired evaluation requires equal nonempty episode lists")
    seeds = [row["seed"] for row in reference]
    if seeds != [row["seed"] for row in candidate] or len(set(seeds)) != len(seeds):
        raise ValueError("Paired episodes must have the same ordered unique seeds")
    if samples < 100:
        raise ValueError("Use at least 100 bootstrap resamples")
    differences = np.asarray([[b["detectionRate"] - a["detectionRate"],
                               b["custodyPct"] - a["custodyPct"],
                               a["longestGapS"] - b["longestGapS"]]
                              for a, b in zip(reference, candidate)], dtype=float)
    if not np.isfinite(differences).all():
        raise ValueError("Paired metrics must be finite")
    rng = np.random.default_rng(seed)
    # Resample whole paired episodes, including every missed mission.
    bootstrap = np.asarray([differences[rng.integers(len(seeds), size=len(seeds))].mean(axis=0)
                            for _ in range(samples)])
    result = {"episodes": len(seeds), "bootstrapSamples": samples, "bootstrapSeed": seed,
              "method": "Paired whole-episode percentile bootstrap; all missions including misses",
              "positiveMeansImprovement": True}
    for index, name in enumerate(("detectionGainPp", "custodyGainPp", "gapSecondsSaved")):
        result[name] = {"mean": float(differences[:, index].mean()),
                        "ci95": np.quantile(bootstrap[:, index], [.025, .975]).tolist()}
    return result


def worker(manifest_path, start, episodes, output):
    manifest = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
    if snapshot(manifest["root"], manifest["modelPath"]) != manifest:
        raise ValueError("Frozen inputs changed before worker execution")
    backend = str(Path(manifest["root"]) / "backend")
    own_backend = Path(__file__).resolve().parent
    sys.path = [backend] + [entry for entry in sys.path if Path(entry or ".").resolve() != own_backend]
    from graph_search import SENSOR_MODEL, Terrain, profile_hash, run_episode, scenario, summarize

    if SENSOR_MODEL != manifest["sensorModel"]:
        raise ValueError("Executable sensor rules differ from the frozen model")
    model = json.loads(Path(manifest["modelPath"]).read_text(encoding="utf-8"))
    profile = json.loads(Path(manifest["profilePath"]).read_text(encoding="utf-8"))
    if profile_hash(profile) != manifest["profileHash"]:
        raise ValueError("Executable terrain hash differs from the frozen model")
    terrain = Terrain(profile)
    horizon, step = model["protocol"]["horizonS"], model["protocol"]["stepS"]
    rows, scenarios = [], []
    for seed in range(start, start + episodes):
        episode = scenario(terrain, seed, horizon, step)
        scenarios.append({"seed": seed, "sha256": digest(canonical({
            "positions": episode.positions.tolist(), "condition": episode.condition}))})
        rows.append(run_episode(terrain, model["trained"], episode, model["motion"], horizon, step, False))
    if snapshot(manifest["root"], manifest["modelPath"]) != manifest:
        raise ValueError("Frozen inputs changed during evaluation")
    result = {"metrics": summarize(rows), "perEpisode": [row["metrics"] for row in rows],
              "scenarios": scenarios, "byCondition": {condition: summarize(selected)
                  for condition in SENSOR_MODEL["conditions"]
                  if (selected := [row for row in rows if row["metrics"]["condition"] == condition])}}
    Path(output).write_bytes(canonical(result))


def compare(args):
    started = time.perf_counter()
    script = Path(__file__).resolve()
    script_hash = digest(script.read_bytes())
    manifests = {"reference": snapshot(args.reference_root, args.reference_model),
                 "candidate": snapshot(ROOT, args.candidate_model)}
    output = Path(args.output).resolve()
    frozen_paths = {Path(manifest[key]) for manifest in manifests.values() for key in ("modelPath", "profilePath")}
    frozen_paths.update(Path(manifest["root"]) / "backend" / name
                        for manifest in manifests.values() for name in manifest["sourceSha256"])
    if output in frozen_paths or output == script:
        raise ValueError("Comparison output must not overwrite a frozen input or the runner")
    validate_comparison(manifests["reference"], manifests["candidate"], args.seed_start,
                        args.episodes, args.exclude_range)
    results = {}
    with tempfile.TemporaryDirectory(prefix="simulation-comparison-") as temporary:
        for label, manifest in manifests.items():
            manifest_path = Path(temporary) / f"{label}-manifest.json"
            result_path = Path(temporary) / f"{label}-result.json"
            manifest_path.write_bytes(canonical(manifest))
            command = [sys.executable, "-B", str(script), "--worker-manifest", str(manifest_path),
                       "--seed-start", str(args.seed_start), "--episodes", str(args.episodes),
                       "--output", str(result_path)]
            environment = {**os.environ, "ADAPTER": "local", "FORCE_KINEMATIC": "1"}
            subprocess.run(command, cwd=Path(manifest["root"]) / "backend", env=environment, check=True)
            results[label] = json.loads(result_path.read_text(encoding="utf-8"))
    if results["reference"]["scenarios"] != results["candidate"]["scenarios"]:
        raise ValueError("Reference and candidate evaluated different scenarios")
    expected_seeds = list(range(args.seed_start, args.seed_start + args.episodes))
    if any([row["seed"] for row in result["perEpisode"]] != expected_seeds for result in results.values()):
        raise ValueError("Worker results do not contain every requested evaluation seed")
    for manifest in manifests.values():
        if snapshot(manifest["root"], manifest["modelPath"]) != manifest:
            raise ValueError("Frozen inputs changed before comparison publication")
    if digest(script.read_bytes()) != script_hash:
        raise ValueError("Comparison runner changed during evaluation")
    report = {"schemaVersion": 1, "mode": "offline-paired-simulation-comparison",
              "protocol": {"seedRange": [args.seed_start, args.seed_start + args.episodes - 1],
                           "episodes": args.episodes, "excludedSeedRanges": [list(interval) for interval in args.exclude_range],
                           "modelsFrozenBeforeEvaluation": True, "testUsedForSelection": False,
                           "sameSensorAndScoringRules": True},
              "provenance": {"runnerSha256": script_hash, **manifests},
              "metrics": {label: result["metrics"] for label, result in results.items()},
              "perEpisode": {label: result["perEpisode"] for label, result in results.items()},
              "byCondition": {label: result["byCondition"] for label, result in results.items()},
              "scenarios": results["reference"]["scenarios"],
              "comparison": paired_statistics(results["reference"]["perEpisode"], results["candidate"]["perEpisode"]),
              "metricNotes": {"custodyPct": "Share of all sampled mission times, including unsuccessful missions",
                              "longestGapS": "Original evaluator metric; never-detected missions retain the full horizon penalty"},
              "wallSeconds": time.perf_counter() - started}
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary_output = output.with_suffix(output.suffix + ".tmp")
    temporary_output.write_bytes(canonical(report))
    temporary_output.replace(output)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference-root", type=Path)
    parser.add_argument("--reference-model", type=Path)
    parser.add_argument("--candidate-model", type=Path)
    parser.add_argument("--seed-start", type=int, required=True)
    parser.add_argument("--episodes", type=int, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--exclude-range", type=seed_range, action="append", default=[])
    parser.add_argument("--worker-manifest", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    try:
        if args.worker_manifest:
            worker(args.worker_manifest, args.seed_start, args.episodes, args.output)
        else:
            if any(getattr(args, name) is None for name in ("reference_root", "reference_model", "candidate_model")):
                parser.error("--reference-root, --reference-model and --candidate-model are required")
            report = compare(args)
            print(json.dumps(report["comparison"], indent=2))
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
