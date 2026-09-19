"""Mission command / fusion cell. Assigns roles and custody. Does not fly vehicles."""

from __future__ import annotations

import time
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
        self.handoff: dict[str, Any] = {
            "state": "idle",
            "cue_source": None,
            "receiver": None,
            "evidence": None,
            "cue_at": None,
            "acquired_at": None,
            "lat": None,
            "lon": None,
        }

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
        self._note_handoff(vehicles, track, world)
        return roles

    def snapshot(self) -> dict[str, Any]:
        return {
            "phase": self.phase,
            "intent": PHASE_INTENT[self.phase],
            "handoff": dict(self.handoff),
        }

    def _note_handoff(self, vehicles: list[VehicleState], track: Track | None, world: WorldModel) -> None:
        from geo import haversine_m

        tower_dets = [d for d in world.detections if str(d.source_id).startswith("tower")]
        air_dets = [
            d
            for d in world.detections
            if d.source_id in {"quadcopter", "copter-1", "fixed-wing", "plane-1"}
        ]
        copter = next((v for v in vehicles if v.vehicle_class == "copter"), None)
        if tower_dets:
            src = tower_dets[0]
            world.last_cue = (src.lat, src.lon)
            if self.handoff["state"] == "idle":
                self.handoff.update(
                    state="cued",
                    cue_source=src.source_id,
                    cue_at=src.timestamp,
                    receiver=None,
                    evidence=None,
                    acquired_at=None,
                    lat=src.lat,
                    lon=src.lon,
                )
                world.post("c2", "quadcopter", "cue", {"from": src.source_id, "lat": src.lat, "lon": src.lon})
        if self.handoff["state"] != "cued":
            return
        if air_dets:
            hit = air_dets[0]
            self.handoff.update(
                state="acquired",
                receiver=hit.source_id,
                evidence="receiver_camera",
                acquired_at=hit.timestamp,
            )
            world.post("c2", "all", "acquired", {"receiver": hit.source_id, "evidence": "receiver_camera"})
            return
        if copter and track and (copter.role == "track" or self.phase in {PHASE_FIX, PHASE_TRACK}):
            dist = haversine_m(copter.lat, copter.lon, track.lat, track.lon)
            if dist <= 90.0:
                self.handoff.update(
                    state="acquired",
                    receiver=copter.vehicle_id,
                    evidence="range",
                    acquired_at=time.time(),
                )
                world.post("c2", "all", "acquired", {"receiver": copter.vehicle_id, "evidence": "range", "m": round(dist, 1)})


def _phase(roles: dict[str, Role], track: Track | None, detections: list) -> str:
    if any(r == "confirm" for r in roles.values()):
        return PHASE_PID
    if any(r == "track" for r in roles.values()) and track:
        return PHASE_TRACK
    if detections or (track and track.hits):
        return PHASE_FIX
    return PHASE_FIND
