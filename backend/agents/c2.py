"""Mission command / fusion cell. Assigns roles and custody. Does not fly vehicles."""

from __future__ import annotations

from typing import Any

from allocator import assign_roles
from sim.types import Role, VehicleState
from tracker import Track
from world import WorldModel

# Find → Fix → Track → PID. WHITEOUT stops before engage.
PHASE_FIND = "find"
PHASE_FIX = "fix"
PHASE_TRACK = "track"
PHASE_PID = "pid"

PHASE_INTENT = {
    PHASE_FIND: "Wide-area ISR. Plane sweeps, towers stare, copter holds QRF sector.",
    PHASE_FIX: "Cue qualified. Copter tasked; plane keeps searching.",
    PHASE_TRACK: "Copter has custody. Plane continues coverage. Rover on deck.",
    PHASE_PID: "Rover closing for positive ID. Air assets do not pile on.",
}


class MissionCommand:
    def __init__(self) -> None:
        self.phase = PHASE_FIND

    def tick(
        self,
        vehicles: list[VehicleState],
        track: Track | None,
        advisor: dict | None,
        world: WorldModel,
    ) -> dict[str, Role]:
        roles = assign_roles(vehicles, track, advisor)
        phase = _phase(roles, track, world.detections)
        if phase != self.phase:
            world.post(
                "c2",
                "all",
                "handoff",
                {"from": self.phase, "to": phase, "intent": PHASE_INTENT[phase]},
            )
            self.phase = phase
        world.phase = phase
        return roles

    def snapshot(self) -> dict[str, Any]:
        return {"phase": self.phase, "intent": PHASE_INTENT[self.phase]}


def _phase(roles: dict[str, Role], track: Track | None, detections: list) -> str:
    if any(r == "confirm" for r in roles.values()):
        return PHASE_PID
    if any(r == "track" for r in roles.values()) and track:
        return PHASE_TRACK
    if detections or (track and track.hits):
        return PHASE_FIX
    return PHASE_FIND
