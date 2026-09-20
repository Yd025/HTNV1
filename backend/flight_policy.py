"""Portable, bounded surveillance policy parameters; no truth or route labels.

Each adapter generates routes in its own verified coordinate frame. These
parameters contain distances/times only, never coordinates from another arena.
"""
from __future__ import annotations

import math

COORDINATED_ALGORITHM = "coordinated-surveillance-v1"
LEGACY_ALGORITHM = "tower-first-v2"
FLIGHT_POLICY_BOUNDS = {
    "laneSpacingM": (200., 1600.),
    "routePhase": (0., 1.),
    "quadSearchRadiusM": (250., 2200.),
    "lookaheadS": (0., 40.),
    "supportOffsetM": (100., 1000.),
    "reacquireWidthM": (50., 700.),
}
DEFAULT_FLIGHT_POLICY = {
    "laneSpacingM": 700., "routePhase": 0., "quadSearchRadiusM": 1200.,
    "lookaheadS": 15., "supportOffsetM": 350., "reacquireWidthM": 250.,
}


def normalize_flight_policy(values=None):
    if values is not None and not isinstance(values, dict):
        raise ValueError("flightPolicy must be an object")
    values = values or {}
    unknown = set(values)-set(FLIGHT_POLICY_BOUNDS)
    if unknown:
        raise ValueError(f"Unknown flight policy parameters: {', '.join(sorted(unknown))}")
    policy = dict(DEFAULT_FLIGHT_POLICY)
    for key, value in values.items():
        if isinstance(value, bool):
            raise ValueError(f"{key} must be a finite number")
        try:
            value = float(value)
        except (TypeError, ValueError) as error:
            raise ValueError(f"{key} must be a finite number") from error
        low, high = FLIGHT_POLICY_BOUNDS[key]
        if not math.isfinite(value) or not low <= value <= high:
            raise ValueError(f"{key} must be between {low:g} and {high:g}")
        policy[key] = value
    return policy
