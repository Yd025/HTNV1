"""Train and evaluate two-tower placement offline; never connects to ArcticSim.

python -B train_search.py --candidates 24 --train 24 --validation 32 --test 96
python -B train_search.py --resume ../runs/tower-search --candidates 24
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import subprocess
import time
from dataclasses import asdict
from pathlib import Path

from search_experiment import (default_policy, evaluate, objective, paired_interval,
                               propose, scenarios, validate_policy)


def save_json(path: Path, value: dict) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    temporary.replace(path)


def train(args: argparse.Namespace) -> dict:
    started = time.perf_counter()
    source_hash = hashlib.sha256()
    source_contents = {}
    for relative in ("train_search.py", "search_experiment.py", "search_policy.py", "geo.py", "sim/types.py", "sim/target.py", "sim/local_sitl.py"):
        source_contents[relative] = (Path(__file__).parent / relative).read_bytes()
        source_hash.update(relative.encode())
        source_hash.update(source_contents[relative])
    source_sha256 = source_hash.hexdigest()
    try:
        revision = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, timeout=2).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        revision = "unknown"
    output = Path(args.resume or args.output).resolve()
    old = None
    if args.resume:
        old = json.loads((output / "latest_report.json").read_text(encoding="utf-8"))
        # Keep the optimization/validation distribution; use fresh untouched test seeds each round.
        settings = old["settings"]
        # One canonical checkpoint prevents a crash between artifact writes from
        # pairing an older report with a newer policy (or a manually edited one).
        incumbent = validate_policy(old["selected_policy"])
        round_number = old["round"] + 1
    else:
        if (output / "latest_report.json").exists():
            raise ValueError("Output already contains an experiment; use --resume to continue it")
        settings = {"seed": args.seed, "train": args.train, "validation": args.validation,
                    "test": args.test, "horizon_s": args.horizon, "dt_s": args.dt}
        incumbent = default_policy()
        round_number = 1
    if any(settings[k] < 1 for k in ("train", "validation", "test")) or args.candidates < 1:
        raise ValueError("Episode counts and candidate budget must be positive")
    if max(settings[k] for k in ("train", "validation", "test")) >= 100000:
        raise ValueError("Episode count must be below 100000 to keep seed splits disjoint")
    if not math.isfinite(settings["horizon_s"]) or settings["horizon_s"] <= 0 or not 0 < settings["dt_s"] <= 2:
        raise ValueError("Horizon must be positive and 0 < dt <= 2")
    baseline_policy = default_policy()
    baseline_policy["observation_period_s"] = settings["dt_s"]
    incumbent["observation_period_s"] = settings["dt_s"]
    base = settings["seed"]
    training = scenarios(base, settings["train"], incumbent["arena"]["half_m"])
    validation = scenarios(base + 1_000_000, settings["validation"], incumbent["arena"]["half_m"])
    test = scenarios(base + 2_000_000 + round_number * 100_000, settings["test"], incumbent["arena"]["half_m"])
    horizon, dt = settings["horizon_s"], settings["dt_s"]
    rng = random.Random(base + round_number * 19_919)
    history = []
    finalists = [("fixed_towers_sweep", baseline_policy)]
    if old:
        finalists.append(("previous_incumbent", incumbent))
    for algorithm in ("lawnmower", "belief_greedy"):
        best = json.loads(json.dumps(incumbent))
        best["algorithm"] = algorithm
        best_result = evaluate(best, training, horizon, dt)
        history.append({"algorithm": algorithm, "candidate": 0, "accepted": True,
                        "training": best_result["summary"], "policy": best})
        print(f"{algorithm}: initial training mean {objective(best_result)[0]:.2f}s", flush=True)
        for index in range(1, args.candidates + 1):
            candidate = propose(best, rng, index)
            result = evaluate(candidate, training, horizon, dt)
            accepted = objective(result) < objective(best_result)
            if accepted:
                best, best_result = candidate, result
            history.append({"algorithm": algorithm, "candidate": index, "accepted": accepted,
                            "training": result["summary"], "policy": candidate})
            if accepted or index % 8 == 0:
                print(f"{algorithm}: {index}/{args.candidates}; best training {objective(best_result)[0]:.2f}s", flush=True)
        finalists.append((f"optimized_{algorithm}", best))
    validation_results = {name: evaluate(policy, validation, horizon, dt) for name, policy in finalists}
    reference_name = "previous_incumbent" if old else "fixed_towers_sweep"
    reference_result = validation_results[reference_name]
    eligible = [(name, policy) for name, policy in finalists
                if validation_results[name]["summary"]["miss_rate"] <= reference_result["summary"]["miss_rate"]]
    selected_name, selected_policy = min(eligible, key=lambda item: objective(validation_results[item[0]]))
    # Selection is now frozen. Test results never feed proposals or promotion.
    print(f"Validation selected {selected_name}; evaluating untouched test episodes", flush=True)
    test_results = {name: evaluate(policy, test, horizon, dt) for name, policy in finalists}
    ablations = {kind: evaluate(selected_policy, test, horizon, dt, sensors=kind)
                 for kind in ("towers", "vehicles")}
    if any((Path(__file__).parent / relative).read_bytes() != content for relative, content in source_contents.items()):
        raise ValueError("Experiment source changed during evaluation; rerun with stable code before saving results")
    report = {"schema_version": 1, "mode": "synthetic", "round": round_number, "settings": settings,
              "source_revision": revision, "source_sha256": source_sha256,
              "optimizer": "seeded random exploration plus incumbent coordinate perturbation; no global optimum guarantee",
              "objective": "minimize mean min(first sensor detection delay from spawn, deadline); promotion cannot increase validation miss rate",
              "selected": selected_name, "selected_policy": selected_policy,
              "previous_round": old["round"] if old else None,
              "scenarios": {"training": [asdict(s) for s in training], "validation": [asdict(s) for s in validation],
                            "test": [asdict(s) for s in test]},
              "training_history": history, "validation": validation_results, "test": test_results,
              "sensor_ablations": ablations,
              "comparison": paired_interval(test_results["fixed_towers_sweep"]["episodes"],
                                            test_results[selected_name]["episodes"], base + round_number),
              "limitations": ["Local flat 3 km stand-in; no actual ArcticSim terrain or water mask.",
                              "Synthetic FOV hits, not verified camera detections or confirmed tracks.",
                              "Instant kinematic turns and tower slew; no occlusion, false alarms, wind, battery or network latency.",
                              "Fixed 600 m / 40 degree tower model; not the live 1500 m camera far clip.",
                              "Boat spawn prior uniform within inner square; all profiles bounded; not a real shipping distribution.",
                              "Sensor ablations rerun search with the disabled sensors omitted; not full tracking missions.",
                              "Repeated validation can overfit; evaluate final configuration on new real episodes."]}
    report["wall_seconds"] = time.perf_counter() - started
    output.mkdir(parents=True, exist_ok=True)
    save_json(output / f"round-{round_number:03d}.json", report)
    save_json(output / "best_policy.json", selected_policy)
    save_json(output / "latest_report.json", report)
    print(json.dumps({"selected": selected_name, "test": test_results[selected_name]["summary"],
                      "comparison": report["comparison"], "output": str(output)}, indent=2), flush=True)
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default="../runs/tower-search")
    parser.add_argument("--resume", help="Continue an experiment directory; reuses its settings and validation split")
    parser.add_argument("--seed", type=int, default=2026)
    parser.add_argument("--candidates", type=int, default=24, help="New placements per algorithm in this round")
    parser.add_argument("--train", type=int, default=24)
    parser.add_argument("--validation", type=int, default=32)
    parser.add_argument("--test", type=int, default=96)
    parser.add_argument("--horizon", type=float, default=180)
    parser.add_argument("--dt", type=float, default=1.0)
    args = parser.parse_args()
    try:
        train(args)
    except (ValueError, KeyError, OSError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
