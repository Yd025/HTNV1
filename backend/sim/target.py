"""Moving contact + FOV occupancy. Used in-process by LocalSitlAdapter and as a debug HTTP service."""

from __future__ import annotations

import math
import os
import time
from dataclasses import dataclass, field

from geo import ARENA_HALF_M, ORIGIN_LAT, ORIGIN_LON, bearing_deg, haversine_m, heading_to_ne, ne_to_ll
from sim.types import Detection, TowerMount, VehicleState

TARGET_CLASS = os.getenv("TARGET_CLASS_HINT", "vehicle")


@dataclass
class TargetSim:
    """Kinematic contact inside the WHITEOUT arena. Profiles: straight | weave | stop_and_go."""

    profile: str = os.getenv("TARGET_PROFILE", "weave")
    speed_mps: float = float(os.getenv("TARGET_SPEED_MPS", "6.0"))
    north: float = 500.0
    east: float = 500.0
    heading: float = 220.0
    t0: float = field(default_factory=time.monotonic)
    paused_until: float = 0.0

    def reset(self, profile: str | None = None) -> None:
        if profile:
            self.profile = profile
        self.north, self.east = 500.0, 500.0
        self.heading = 220.0
        self.t0 = time.monotonic()
        self.paused_until = 0.0

    def step(self, dt: float) -> None:
        now = time.monotonic()
        elapsed = now - self.t0
        speed = self.speed_mps
        if self.profile == "stop_and_go":
            cycle = elapsed % 20.0
            if cycle > 12.0:
                speed = 0.0
        if self.profile == "weave":
            self.heading = 40.0 + 25.0 * math.sin(elapsed * 0.35)
        vn, ve = heading_to_ne(self.heading)
        self.north += vn * speed * dt
        self.east += ve * speed * dt
        half = ARENA_HALF_M * 0.85
        if abs(self.north) > half or abs(self.east) > half:
            self.heading = (self.heading + 140.0) % 360.0
            self.north = max(-half, min(half, self.north))
            self.east = max(-half, min(half, self.east))

    def latlon(self) -> tuple[float, float]:
        return ne_to_ll(self.north, self.east, ORIGIN_LAT, ORIGIN_LON)

    def detections_for(self, vehicles: list[VehicleState], towers: list[TowerMount], now: float) -> list[Detection]:
        tlat, tlon = self.latlon()
        out: list[Detection] = []
        for v in vehicles:
            if v.vehicle_class == "tower":
                continue
            rng, inside = _in_fov(
                v.lat, v.lon, v.heading, tlat, tlon,
                **_fov_params(v.vehicle_class),
            )
            if inside:
                out.append(
                    Detection(
                        source_id=v.vehicle_id,
                        lat=tlat,
                        lon=tlon,
                        class_hint=_classify(self.speed_mps, v.vehicle_class),
                        confidence=max(0.35, 1.0 - rng / 800.0),
                        timestamp=now,
                        bearing=bearing_deg(v.lat, v.lon, tlat, tlon),
                        range_m=rng,
                    )
                )
        for tw in towers:
            rng, inside = _in_fov(
                tw.lat, tw.lon, tw.heading, tlat, tlon,
                range_m=tw.range_m, half_fov_deg=tw.fov_deg / 2.0, width_m=0.0,
            )
            if inside:
                out.append(
                    Detection(
                        source_id=tw.vehicle_id,
                        lat=tlat,
                        lon=tlon,
                        class_hint=TARGET_CLASS,
                        confidence=max(0.4, 1.0 - rng / tw.range_m),
                        timestamp=now,
                        bearing=bearing_deg(tw.lat, tw.lon, tlat, tlon),
                        range_m=rng,
                    )
                )
        return out


def _fov_params(vehicle_class: str) -> dict[str, float]:
    if vehicle_class == "plane":
        return {"range_m": 400.0, "half_fov_deg": 18.0, "width_m": 150.0}
    if vehicle_class == "copter":
        return {"range_m": 120.0, "half_fov_deg": 180.0, "width_m": 120.0}
    if vehicle_class == "rover":
        return {"range_m": 40.0, "half_fov_deg": 180.0, "width_m": 40.0}
    return {"range_m": 80.0, "half_fov_deg": 30.0, "width_m": 40.0}


def _in_fov(
    slat: float, slon: float, heading: float, tlat: float, tlon: float,
    range_m: float, half_fov_deg: float, width_m: float,
) -> tuple[float, bool]:
    rng = haversine_m(slat, slon, tlat, tlon)
    if rng > range_m:
        return rng, False
    if half_fov_deg >= 170:
        return rng, True
    brg = bearing_deg(slat, slon, tlat, tlon)
    d = abs((brg - heading + 180.0) % 360.0 - 180.0)
    return rng, d <= half_fov_deg


def _classify(speed: float, observer_class: str) -> str:
    if speed >= 8.0:
        return "vehicle"
    if observer_class == "rover" or speed < 2.0:
        return "person"
    return "vehicle"
