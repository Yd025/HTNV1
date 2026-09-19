from __future__ import annotations

import os

from sim.types import SimAdapter


def build_adapter(name: str | None = None) -> SimAdapter:
    kind = (name or os.getenv("ADAPTER", "local")).strip().lower()
    if kind in {"whiteout", "aura", "aurasim"}:
        from sim.whiteout import WhiteoutAdapter

        return WhiteoutAdapter()
    from sim.local_sitl import LocalSitlAdapter

    return LocalSitlAdapter()
