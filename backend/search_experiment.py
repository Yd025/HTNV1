"""Offline first-detection experiments using the existing local simulator primitives.

Synthetic evidence only: no camera inference, terrain occlusion or flight dynamics.
The evaluator owns boat truth; the planner receives only fleet poses and time.
"""
from __future__ import annotations

import json
import math
import random
import statistics
from dataclasses import asdict, dataclass, replace
from pathlib import Path

from geo import ll_to_ne, ne_to_ll
from sim.local_sitl import KinematicCraft, _fleet_spec
from sim.target import TargetSim
from sim.types import Arena, TowerMount, VehicleState


@dataclass(frozen=True)
class Scenario:
    seed: int
    north: float
    east: float
    heading: float
    speed_mps: float
    profile: str
    spawn_delay_s: float


def scenarios(seed: int, count: int, half_m: float) -> list[Scenario]:
    """A complete episode, rather than individual frames, is the split unit."""
    if count < 1:
        raise ValueError("At least one scenario is required")
    out = []
    for index in range(count):
        rng = random.Random(seed + index)
        out.append(Scenario(seed + index, rng.uniform(-0.8, 0.8) * half_m,
                            rng.uniform(-0.8, 0.8) * half_m, rng.uniform(0, 360),
                            rng.uniform(2, 10), ("straight", "weave", "stop_and_go")[index % 3],
                            rng.uniform(0, 20)))
    return out


def default_policy() -> dict:
    # Deliberately fixed local stand-in coordinates, independent of live env vars.
    arena = Arena(74.6973, -94.8297, 1500.0)
    arena.towers = [TowerMount("tower-ne", *ne_to_ll(900, 900, arena.origin_lat, arena.origin_lon), 225),
                    TowerMount("tower-sw", *ne_to_ll(-900, -900, arena.origin_lat, arena.origin_lon), 45)]
    return {"schema_version": 1, "mode": "synthetic", "algorithm": "lawnmower", "observation_period_s": 1.0,
            "arena": asdict(arena), "planner": {"grid_size": 8, "scan_period_s": 60.0,
                                                "detection_probability": 0.9}}


def validate_policy(policy: dict) -> dict:
    """Fail closed on incompatible geometry and malformed optimizer artifacts."""
    if policy.get("schema_version") != 1 or policy.get("mode") != "synthetic":
        raise ValueError("Expected a version 1 synthetic search policy")
    if policy.get("algorithm") not in {"lawnmower", "belief_greedy"}:
        raise ValueError("Unknown search algorithm")
    period = policy.get("observation_period_s", 1.0)
    if not isinstance(period, (int, float)) or not math.isfinite(period) or not 0 < period <= 2:
        raise ValueError("observation_period_s must be finite and in (0, 2]")
    a = policy["arena"]
    for key in ("origin_lat", "origin_lon", "half_m"):
        if not isinstance(a[key], (int, float)) or not math.isfinite(a[key]):
            raise ValueError(f"Invalid arena {key}")
    if not (-85 <= a["origin_lat"] <= 85 and -180 <= a["origin_lon"] <= 180 and 100 <= a["half_m"] <= 10000):
        raise ValueError("Arena coordinates or extent are out of bounds")
    if a.get("no_fly"):
        raise ValueError("This local experiment does not model terrain/no-fly routing")
    towers = a["towers"]
    if len(towers) != 2 or len({t["vehicle_id"] for t in towers}) != 2:
        raise ValueError("A policy must contain exactly two distinct towers")
    if any(t["vehicle_id"] in {s["vehicle_id"] for s in _fleet_spec()} for t in towers):
        raise ValueError("Tower IDs must not collide with mobile vehicles")
    for t in towers:
        for key in ("lat", "lon", "heading", "range_m", "fov_deg"):
            if not isinstance(t[key], (int, float)) or not math.isfinite(t[key]):
                raise ValueError(f"Invalid tower {key}")
        n, e = ll_to_ne(t["lat"], t["lon"], a["origin_lat"], a["origin_lon"])
        if max(abs(n), abs(e)) > a["half_m"] + 1e-6:
            raise ValueError("Tower outside local arena")
        if not (0 <= t["heading"] < 360 and 0 < t["range_m"] <= 1500 and 0 < t["fov_deg"] <= 360):
            raise ValueError("Invalid tower sensor parameters")
    n0, e0 = ll_to_ne(towers[0]["lat"], towers[0]["lon"], towers[1]["lat"], towers[1]["lon"])
    if math.hypot(n0, e0) < 50:
        raise ValueError("Towers must be at least 50 metres apart")
    p = policy["planner"]
    if type(p["grid_size"]) is not int or not 2 <= p["grid_size"] <= 30:
        raise ValueError("grid_size must be an integer from 2 to 30")
    if not 10 <= p["scan_period_s"] <= 600 or not 0 < p["detection_probability"] <= 1:
        raise ValueError("Invalid scan period or detection probability")
    return policy


def load_policy(path: str | Path) -> dict:
    return validate_policy(json.loads(Path(path).read_text(encoding="utf-8")))


def arena_for(policy: dict) -> Arena:
    validate_policy(policy)
    a = dict(policy["arena"])
    a["towers"] = [TowerMount(**t) for t in a["towers"]]
    return Arena(**a)


def run_trial(policy: dict, scenario: Scenario, horizon_s: float = 180, dt: float = 1.0,
              *, sensors: str = "combined") -> dict:
    from search_policy import SearchPlanner
    if not math.isfinite(horizon_s) or not math.isfinite(dt) or horizon_s <= 0 or not 0 < dt <= 2:
        raise ValueError("Positive finite horizon and 0 < dt <= 2 seconds required")
    if sensors not in {"combined", "towers", "vehicles"}:
        raise ValueError("Unknown sensor ablation")
    arena = arena_for(policy)
    if abs(dt - policy.get("observation_period_s", 1.0)) > 1e-8:
        raise ValueError("Trial dt must match the saved policy observation period")
    planning_arena = replace(arena, towers=[]) if sensors == "vehicles" else arena
    planner = SearchPlanner(planning_arena, algorithm=policy["algorithm"], **policy["planner"])
    craft = {s["vehicle_id"]: KinematicCraft(s, arena) for s in _fleet_spec()}
    boat = TargetSim(profile=scenario.profile, speed_mps=scenario.speed_mps,
                     north=scenario.north, east=scenario.east, heading=scenario.heading,
                     origin_lat=arena.origin_lat, origin_lon=arena.origin_lon, half_m=arena.half_m)
    rng = random.Random(scenario.seed ^ 0x512A9)
    elapsed, distance, commands = 0.0, 0.0, 0
    previous: dict[str, tuple] = {}
    source_ids = sorted([*craft, *(t.vehicle_id for t in arena.towers)])
    detected_at, source = None, None
    while elapsed <= horizon_s + scenario.spawn_delay_s + 1e-8:
        vehicles = [c.state(False) for c in craft.values()]
        vehicles += [VehicleState(t.vehicle_id, 10 + i, "tower", t.lat, t.lon, 12, t.heading)
                     for i, t in enumerate(arena.towers)]
        # Draw every source even when out of FOV: paired policies get common noise.
        draws = {sid: rng.random() for sid in source_ids}
        if elapsed >= scenario.spawn_delay_s:
            visible = boat.detections_for(vehicles, arena.towers, elapsed)
            visible = [d for d in visible if draws[d.source_id] < policy["planner"]["detection_probability"]
                       and (sensors == "combined" or (sensors == "towers") == (d.source_id not in craft))]
            if visible:
                detected_at = elapsed - scenario.spawn_delay_s
                source = visible[0].source_id
                break
        # The controller has no Scenario or TargetSim reference and sees no truth.
        observed_fleet = [v for v in vehicles if sensors == "combined" or (sensors == "towers") == (v.vehicle_class == "tower")]
        for command in planner.commands(observed_fleet, elapsed):
            signature = (command.type, command.lat, command.lon, command.alt)
            if previous.get(command.vehicle_id) != signature:
                commands += 1
                previous[command.vehicle_id] = signature
            if command.vehicle_id in craft:
                craft[command.vehicle_id].apply(command)
            elif command.lat is not None and command.lon is not None:
                from geo import bearing_deg
                tower = next(t for t in arena.towers if t.vehicle_id == command.vehicle_id)
                tower.heading = bearing_deg(tower.lat, tower.lon, command.lat, command.lon)
        step = dt
        if elapsed + step > horizon_s + scenario.spawn_delay_s + 1e-8:
            break
        for c in craft.values():
            before = c.north, c.east
            c.step(step)
            distance += math.hypot(c.north - before[0], c.east - before[1])
        active_dt = max(0.0, elapsed + step - max(elapsed, scenario.spawn_delay_s))
        if active_dt:
            boat.step(active_dt, elapsed_s=max(0.0, elapsed + step - scenario.spawn_delay_s))
        elapsed += step
    return {"seed": scenario.seed, "profile": scenario.profile, "detected": detected_at is not None,
            "detection_time_s": detected_at, "capped_detection_time_s": min(horizon_s, detected_at) if detected_at is not None else horizon_s,
            "first_source": source, "distance_m": distance, "setpoint_changes": commands}


def summarize(rows: list[dict], horizon_s: float) -> dict:
    capped = sorted(r["capped_detection_time_s"] for r in rows)
    if not capped:
        raise ValueError("Cannot summarize an empty evaluation")
    success = sum(r["detected"] for r in rows)
    return {"episodes": len(rows), "success_rate": success / len(rows), "miss_rate": 1 - success / len(rows),
            "restricted_mean_detection_s": statistics.mean(capped),
            "median_capped_s": statistics.median(capped), "p90_capped_s": capped[math.ceil(0.9 * len(rows)) - 1],
            "mean_distance_m": statistics.mean(r["distance_m"] for r in rows), "deadline_s": horizon_s}


def evaluate(policy: dict, episodes: list[Scenario], horizon_s: float, dt: float, **kwargs) -> dict:
    rows = [run_trial(policy, s, horizon_s, dt, **kwargs) for s in episodes]
    return {"summary": summarize(rows, horizon_s), "episodes": rows}


def objective(result: dict) -> tuple[float, float, float]:
    """Minimize capped detection time; break exact ties by misses then distance."""
    s = result["summary"]
    return s["restricted_mean_detection_s"], s["miss_rate"], s["mean_distance_m"]


def propose(incumbent: dict, rng: random.Random, index: int) -> dict:
    policy = json.loads(json.dumps(incumbent))
    a = policy["arena"]
    # Global exploration every third candidate; otherwise refine the incumbent.
    for t in a["towers"]:
        n, e = ll_to_ne(t["lat"], t["lon"], a["origin_lat"], a["origin_lon"])
        if index % 3 == 0:
            n, e = rng.uniform(-0.9, 0.9) * a["half_m"], rng.uniform(-0.9, 0.9) * a["half_m"]
        else:
            scale = a["half_m"] * (0.18 if index % 2 else 0.07)
            n, e = n + rng.gauss(0, scale), e + rng.gauss(0, scale)
        n, e = max(-a["half_m"], min(a["half_m"], n)), max(-a["half_m"], min(a["half_m"], e))
        t["lat"], t["lon"] = ne_to_ll(n, e, a["origin_lat"], a["origin_lon"])
        t["heading"] = (t["heading"] + rng.uniform(-60, 60)) % 360
    try:
        return validate_policy(policy)
    except ValueError:
        return json.loads(json.dumps(incumbent))


def paired_interval(baseline: list[dict], selected: list[dict], seed: int) -> dict:
    if [r["seed"] for r in baseline] != [r["seed"] for r in selected]:
        raise ValueError("Paired comparison requires identical scenario seeds")
    differences = [a["capped_detection_time_s"] - b["capped_detection_time_s"] for a, b in zip(baseline, selected)]
    success_differences = [int(b["detected"]) - int(a["detected"]) for a, b in zip(baseline, selected)]
    rng = random.Random(seed)
    time_means, rate_means = [], []
    for _ in range(1000):
        indices = rng.choices(range(len(differences)), k=len(differences))
        time_means.append(statistics.mean(differences[i] for i in indices))
        rate_means.append(statistics.mean(success_differences[i] for i in indices))
    means, rates = sorted(time_means), sorted(rate_means)
    return {"mean_seconds_saved": statistics.mean(differences), "bootstrap_95_percent_ci_s": [means[25], means[974]],
            "success_rate_gain": statistics.mean(success_differences), "success_rate_gain_95_percent_ci": [rates[25], rates[974]],
            "interpretation": "Positive favours selected; interval is paired episode bootstrap, conditional on this synthetic model."}
