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
from sim.adapter import build_adapter

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
logger = logging.getLogger("overwatch.agent")


async def _run(adapter_name: str) -> None:
    brain = SwarmBrain(build_adapter(adapter_name))

    async def log_state(state: dict) -> None:
        scores = state.get("scores") or {}
        logger.info(
            "cov=%.2f collab=%.2f eff=%.2f track=%.2f vehicles=%s",
            scores.get("coverage", 0),
            scores.get("collaboration", 0),
            scores.get("efficiency", 0),
            scores.get("tracking", 0),
            list((state.get("fleet") or {}).keys()),
        )

    await brain.run_forever(on_state=log_state)


def main() -> None:
    parser = argparse.ArgumentParser(description="Operation Overwatch swarm agent")
    parser.add_argument(
        "--adapter",
        default=os.getenv("ADAPTER", "local"),
        help="local (multi-SITL + kinematic) or whiteout (Saturday sim)",
    )
    parser.add_argument("--dump", action="store_true", help="print one snapshot JSON and exit")
    args = parser.parse_args()
    if args.dump:
        async def once() -> None:
            brain = SwarmBrain(build_adapter(args.adapter))
            await brain.connect()
            print(json.dumps(await brain.tick(), default=str, indent=2))

        asyncio.run(once())
        return
    asyncio.run(_run(args.adapter))


if __name__ == "__main__":
    main()
