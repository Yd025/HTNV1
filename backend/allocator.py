"""Roles after a visual confirm. Any camera can open the mission."""

from __future__ import annotations

from sim.types import Role, VehicleState
from tracker import Track


def assign_roles(
    vehicles: list[VehicleState],
    track: Track | None,
    advisor: dict | None = None,
    *,
    mission_active: bool = False,
) -> dict[str, Role]:
    """Plane always searches. Copter searches until a cue, then tracks.

    A track or advisor suggestion cannot invent a target. MissionCommand still
    has to confirm two fresh visual observations first.
    """
    return {
        v.vehicle_id: (
            "cue" if v.vehicle_class == "tower" else
            "track" if mission_active and v.vehicle_class == "copter" else
            "search" if v.vehicle_class == "plane" else
            "search" if v.vehicle_class == "copter" else
            "reserve"
        )
        for v in vehicles
    }
