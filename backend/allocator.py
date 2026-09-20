"""Tower-first roles. MissionCommand alone authorizes an air response."""

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
    """A track or advisor suggestion cannot bypass tower confirmation.

    The quad provides close visual custody. The fixed wing covers the predicted
    forward corridor for reacquisition. Ground assets remain in reserve: no
    navigable shoreline route has been established for the moving boat.
    """
    return {
        v.vehicle_id: (
            "cue" if v.vehicle_class == "tower" else
            "track" if mission_active and v.vehicle_class == "copter" else
            "search" if mission_active and v.vehicle_class == "plane" else
            "reserve"
        )
        for v in vehicles
    }
