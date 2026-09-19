from __future__ import annotations

import os

from sim.types import SimAdapter


def build_adapter(name: str | None = None) -> SimAdapter:
    kind = (name or os.getenv("ADAPTER", "local")).strip().lower()
    if kind != "local" and os.getenv("SEARCH_POLICY_FILE", "").strip():
        raise ValueError("SEARCH_POLICY_FILE is a local synthetic experiment; clear it before live/replay use")
    if kind == "replay":
        from replay import ReplayAdapter

        path = os.getenv("REPLAY_PATH", "").strip()
        if not path:
            raise ValueError("ADAPTER=replay requires REPLAY_PATH pointing to a complete recorded run")
        return ReplayAdapter(path)
    if kind in {"whiteout", "aura", "aurasim", "arctic", "arctic-sim"}:
        from sim.whiteout import WhiteoutAdapter

        return WhiteoutAdapter()
    if kind != "local":
        raise ValueError(f"Unknown adapter: {kind!r}; expected local, whiteout, or replay")
    from sim.local_sitl import LocalSitlAdapter

    return LocalSitlAdapter()
