"""Platform-agent contract. Observe → decide → report. No LLM, no adapter I/O."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from geo import haversine_m
from sim.types import Command, Detection, VehicleClass, VehicleState
from world import WorldModel


@dataclass
class RadioCall:
    recipient: str
    kind: str
    body: dict[str, Any]


@dataclass
class AgentDecision:
    command: Command | None
    calls: list[RadioCall] = field(default_factory=list)
    intent: str = ""


class PlatformAgent:
    """One persistent decision-maker per vehicle_id. Memory survives ticks."""

    def __init__(self, vehicle_id: str, vehicle_class: VehicleClass) -> None:
        self.vehicle_id = vehicle_id
        self.vehicle_class = vehicle_class
        self.intent = "boot"
        self._last_radio: str | None = None
        self._last_cmd: Command | None = None

    def decide(self, me: VehicleState, world: WorldModel) -> AgentDecision:
        return AgentDecision(command=None, intent=self.intent)

    def own_detections(self, world: WorldModel) -> list[Detection]:
        return [d for d in world.detections if d.source_id == self.vehicle_id]

    def peer(self, world: WorldModel, vehicle_class: str) -> VehicleState | None:
        for v in world.vehicles.values():
            if v.vehicle_class == vehicle_class and v.vehicle_id != self.vehicle_id:
                return v
        return None

    def radio(self, kind: str, recipient: str, body: dict[str, Any]) -> RadioCall | None:
        if self._last_radio == kind:
            return None
        self._last_radio = kind
        return RadioCall(recipient=recipient, kind=kind, body=body)

    def calls_of(self, *maybe: RadioCall | None) -> list[RadioCall]:
        return [c for c in maybe if c is not None]

    def hold_setpoint(self, cmd: Command | None, min_m: float = 20.0) -> Command | None:
        """Do not chatter: reuse the last goto until the aim point moves."""
        if cmd is None:
            return None
        prev = self._last_cmd
        if (
            prev is not None
            and prev.type == cmd.type
            and prev.lat is not None
            and cmd.lat is not None
            and prev.lon is not None
            and cmd.lon is not None
            and haversine_m(prev.lat, prev.lon, cmd.lat, cmd.lon) < min_m
        ):
            return prev
        self._last_cmd = cmd
        return cmd
