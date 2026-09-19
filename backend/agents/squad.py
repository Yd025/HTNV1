"""Persistent squad: one PlatformAgent per vehicle_id, created on first sight."""

from __future__ import annotations

from sim.types import VehicleClass, VehicleState
from world import WorldModel

from agents.base import AgentDecision, PlatformAgent
from agents.copter import CopterAgent
from agents.plane import PlaneAgent
from agents.rover import RoverAgent
from agents.tower import TowerAgent

_FACTORY: dict[VehicleClass, type[PlatformAgent]] = {
    "plane": PlaneAgent,
    "copter": CopterAgent,
    "rover": RoverAgent,
    "tower": TowerAgent,
}


class Squad:
    def __init__(self) -> None:
        self._agents: dict[str, PlatformAgent] = {}

    def tick(self, me: VehicleState, world: WorldModel) -> AgentDecision:
        agent = self._agents.get(me.vehicle_id)
        if agent is None:
            cls = _FACTORY.get(me.vehicle_class, PlatformAgent)
            agent = cls(me.vehicle_id, me.vehicle_class)
            self._agents[me.vehicle_id] = agent
        return agent.decide(me, world)

    def intents(self) -> dict[str, str]:
        return {vid: agent.intent for vid, agent in self._agents.items()}
