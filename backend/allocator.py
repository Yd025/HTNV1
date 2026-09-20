"""Named mission roles. MissionCommand alone confirms a target response."""

from __future__ import annotations

from flight_policy import COORDINATED_ALGORITHM, LEGACY_ALGORITHM
from sim.types import Role, VehicleState
from tracker import Track


def assign_roles(
    vehicles: list[VehicleState],
    track: Track | None,
    advisor: dict | None = None,
    *,
    mission_active: bool = False,
    algorithm: str = LEGACY_ALGORITHM,
) -> dict[str, Role]:
    """A track or advisor suggestion cannot bypass observation confirmation.

    The quad provides close visual custody. The fixed wing covers the predicted
    forward corridor for reacquisition. Coordinated mode also permits pre-cue
    patrol; legacy mode retains tower-first dispatch. Ground assets stay reserve: no
    navigable shoreline route has been established for the moving boat.
    """
    return {
        v.vehicle_id: (
            "cue" if v.vehicle_class == "tower" else
            "reserve" if algorithm == COORDINATED_ALGORITHM and v.vehicle_class in {"plane", "copter"} and v.battery_remaining <= 20.0 else
            "track" if mission_active and v.vehicle_class == "copter" else
            "search" if mission_active and v.vehicle_class == "plane" else
            "search" if algorithm == COORDINATED_ALGORITHM and v.vehicle_class in {"plane", "copter"} else
            "reserve"
        )
        for v in vehicles
    }
