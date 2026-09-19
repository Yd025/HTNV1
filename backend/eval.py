"""Replay harness. Run from /app (backend): python eval.py

Prints the four WHITEOUT scores on scripted target paths so you can tune BTs
before Saturday without Dominion's binary.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import time

# Force kinematic twins so eval does not wait on SITL.
os.environ.setdefault("FORCE_KINEMATIC", "1")
os.environ.setdefault("ADAPTER", "local")

from brain import SwarmBrain
from sim.local_sitl import LocalSitlAdapter
from sim.adapter import build_adapter


PROFILES = ("straight", "weave", "stop_and_go")


async def run_profile(profile: str, seconds: float) -> dict:
    adapter = build_adapter("local")
    assert isinstance(adapter, LocalSitlAdapter)
    adapter.set_profile(profile)
    brain = SwarmBrain(adapter)
    await brain.connect()
    t_end = time.monotonic() + seconds
    last = {}
    while time.monotonic() < t_end:
        last = await brain.tick()
        await asyncio.sleep(0.05)
    scores = last.get("scores") or {}
    return {"profile": profile, **scores}


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seconds", type=float, default=20.0)
    parser.add_argument("--profile", choices=[*PROFILES, "all"], default="all")
    args = parser.parse_args()
    profiles = PROFILES if args.profile == "all" else (args.profile,)
    rows = []
    for p in profiles:
        print(f"running {p} for {args.seconds:.0f}s …")
        row = await run_profile(p, args.seconds)
        rows.append(row)
        print(json.dumps(row, indent=2))
    print("\n=== WHITEOUT eval summary ===")
    print(f"{'profile':<14} {'cov':>6} {'collab':>7} {'eff':>6} {'track':>6} {'ttd':>7} {'err_m':>7}")
    for r in rows:
        ttd = r.get("time_to_detect_s")
        err = r.get("track_error_m")
        print(
            f"{r['profile']:<14} {r.get('coverage',0):6.2f} {r.get('collaboration',0):7.2f} "
            f"{r.get('efficiency',0):6.2f} {r.get('tracking',0):6.2f} "
            f"{(ttd if ttd is not None else -1):7.1f} {(err if err is not None else -1):7.1f}"
        )


if __name__ == "__main__":
    asyncio.run(main())
