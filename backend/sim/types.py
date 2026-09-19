from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

VehicleClass = Literal["plane", "copter", "rover", "tower"]
Role = Literal["search", "track", "confirm", "cue", "reserve"]
CommandType = Literal["goto", "loiter", "search_sector", "look_at", "hold"]


@dataclass
class TowerMount:
    vehicle_id: str
    lat: float
    lon: float
    heading: float
    fov_deg: float = 40.0
    range_m: float = 600.0


@dataclass
class Arena:
    origin_lat: float
    origin_lon: float
    half_m: float
    towers: list[TowerMount] = field(default_factory=list)
    no_fly: list[dict[str, Any]] = field(default_factory=list)
    heading_offset_deg: float = 0.0  # world +Y vs true north; Fort Ross ≈ -49.8

    def bounds_ll(self) -> dict[str, float]:
        from geo import ne_to_ll

        n, w = ne_to_ll(self.half_m, -self.half_m, self.origin_lat, self.origin_lon)
        s, e = ne_to_ll(-self.half_m, self.half_m, self.origin_lat, self.origin_lon)
        return {"north": n, "south": s, "west": w, "east": e}


@dataclass
class VehicleState:
    vehicle_id: str
    sysid: int
    vehicle_class: VehicleClass
    lat: float
    lon: float
    alt: float = 0.0
    heading: float = 0.0
    groundspeed: float = 0.0
    battery_remaining: float = 100.0
    armed: bool = True
    mode: str = "GUIDED"
    role: Role | None = None
    connected: bool = True
    mavlink: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {
            "vehicle_id": self.vehicle_id,
            "sysid": self.sysid,
            "vehicle_class": self.vehicle_class,
            "lat": self.lat,
            "lon": self.lon,
            "alt": self.alt,
            "heading": self.heading,
            "groundspeed": self.groundspeed,
            "battery_remaining": self.battery_remaining,
            "armed": self.armed,
            "mode": self.mode,
            "role": self.role,
            "connected": self.connected,
            "mavlink": self.mavlink,
        }


@dataclass
class Detection:
    source_id: str
    lat: float
    lon: float
    class_hint: str
    confidence: float
    timestamp: float
    bearing: float | None = None
    range_m: float | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "source_id": self.source_id,
            "lat": self.lat,
            "lon": self.lon,
            "class_hint": self.class_hint,
            "confidence": self.confidence,
            "timestamp": self.timestamp,
            "bearing": self.bearing,
            "range_m": self.range_m,
        }


@dataclass
class Command:
    vehicle_id: str
    type: CommandType
    lat: float | None = None
    lon: float | None = None
    alt: float | None = None
    sector: int | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "vehicle_id": self.vehicle_id,
            "type": self.type,
            "lat": self.lat,
            "lon": self.lon,
            "alt": self.alt,
            "sector": self.sector,
        }


class SimAdapter(Protocol):
    name: str

    async def connect(self) -> None: ...
    def arena(self) -> Arena: ...
    async def list_vehicles(self) -> list[VehicleState]: ...
    async def poll_detections(self) -> list[Detection]: ...
    async def send_command(self, command: Command) -> None: ...
    def comms_ok(self, vehicle_id: str) -> bool: ...
    def truth_target(self) -> tuple[float, float] | None:
        """Ground-truth lat/lon if the local target-sim publishes it. None in WHITEOUT until they give truth."""
        ...
