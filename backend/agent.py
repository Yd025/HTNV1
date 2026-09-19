"""Headless deploy: python -m agent --adapter local|whiteout

Judges can score this without the Next.js UI. FastAPI (main.py) runs the same brain.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os

from brain import SwarmBrain
from observability import configure_sentry, flush_sentry
from sim.adapter import build_adapter

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logger = logging.getLogger("overwatch.agent")


async def _run(adapter_name: str, seconds: float | None = None) -> None:
    brain = SwarmBrain(build_adapter(adapter_name))

    async def log_state(state: dict) -> None:
        scores = state.get("scores") or {}
        logger.info(
            "cov=%.2f collab=%.2f eff=%.2f track=%s vehicles=%s",
            scores.get("coverage", 0),
            scores.get("collaboration", 0),
            scores.get("efficiency", 0),
            scores.get("tracking") if scores.get("tracking") is not None else "unavailable",
            list((state.get("fleet") or {}).keys()),
        )

    try:
        if seconds is None:
            await brain.run_forever(on_state=log_state)
        else:
            try:
                await asyncio.wait_for(brain.run_forever(on_state=log_state), timeout=seconds)
            except asyncio.TimeoutError:
                pass
    finally:
        await brain.close()
        await flush_sentry()


def main() -> None:
    parser = argparse.ArgumentParser(description="Operation Overwatch swarm agent")
    parser.add_argument(
        "--adapter",
        default=os.getenv("ADAPTER", "local"),
        help="local (kinematic default), whiteout (live simulator), or replay",
    )
    parser.add_argument("--dump", action="store_true", help="print one snapshot JSON and exit")
    parser.add_argument("--record-dir", help="bounded run evidence directory (or RUN_LOG_DIR)")
    parser.add_argument("--replay", help="recorded run directory; implies --adapter replay")
    parser.add_argument("--seconds", type=float, help="stop and flush after this many seconds")
    args = parser.parse_args()
    if args.seconds is not None and args.seconds <= 0:
        parser.error("--seconds must be positive")
    if args.record_dir:
        os.environ["RUN_LOG_DIR"] = args.record_dir
    if args.replay:
        args.adapter = "replay"
        os.environ["REPLAY_PATH"] = args.replay
    configure_sentry()
    if args.dump:
        async def once() -> None:
            brain = SwarmBrain(build_adapter(args.adapter))
            try:
                await brain.connect()
                print(json.dumps(await brain.tick(), default=str, indent=2, allow_nan=False))
            finally:
                await brain.close()
                await flush_sentry()

        asyncio.run(once())
        return
    try:
        asyncio.run(_run(args.adapter, args.seconds))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
