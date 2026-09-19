from __future__ import annotations

import time
from dataclasses import dataclass, field

from sim.types import Role, VehicleState
from tracker import Track


@dataclass
class WorldModel:
    vehicles: dict[str, VehicleState] = field(default_factory=dict)
    detections: list = field(default_factory=list)
    track: Track | None = None
    roles: dict[str, Role] = field(default_factory=dict)
    blackboard: list[dict] = field(default_factory=list)
    advisor: dict | None = None
    last_command: dict | None = None
    phase: str = "find"
    tick_hz: float = 0.0
    t: float = field(default_factory=time.monotonic)

    def set_roles(self, roles: dict[str, Role]) -> None:
        self.roles = roles
        for vid, v in self.vehicles.items():
            v.role = roles.get(vid, v.role)

    def post(self, sender: str, recipient: str, kind: str, body: dict) -> None:
        self.blackboard.append(
            {"sender": sender, "recipient": recipient, "kind": kind, "body": body, "t": time.time()}
        )
        self.blackboard = self.blackboard[-24:]
