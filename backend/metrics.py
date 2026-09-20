"""Live WHITEOUT scoreboard: coverage, collaboration, efficiency, tracking accuracy."""

from __future__ import annotations

import math
import os
import time
from dataclasses import dataclass

from geo import heading_to_ne, ll_to_ne, ne_to_ll
from sim.types import Arena, VehicleState
from tracker import Track

GRID = int(os.getenv("COVERAGE_GRID", "24"))
WINDOW_S = float(os.getenv("COVERAGE_WINDOW_S", "45"))


@dataclass
class Scorecard:
    coverage: float = 0.0
    collaboration: float = 0.0
    efficiency: float = 0.0
    tracking: float = 0.0
    time_to_detect_s: float | None = None
    meters_flown: float = 0.0
    commands_issued: int = 0
    overlap_ratio: float = 0.0
    unique_roles: int = 0
    cells_seen: int = 0
    cells_total: int = GRID * GRID
    track_error_m: float | None = None

    def as_dict(self) -> dict:
        return {
            "coverage": round(self.coverage, 4),
            "collaboration": round(self.collaboration, 4),
            "efficiency": round(self.efficiency, 4),
            "tracking": round(self.tracking, 4),
            "time_to_detect_s": self.time_to_detect_s,
            "meters_flown": round(self.meters_flown, 1),
            "commands_issued": self.commands_issued,
            "overlap_ratio": round(self.overlap_ratio, 4),
            "unique_roles": self.unique_roles,
            "cells_seen": self.cells_seen,
            "cells_total": self.cells_total,
            "track_error_m": None if self.track_error_m is None else round(self.track_error_m, 1),
        }


class CoverageGrid:
    def __init__(self, arena: Arena, n: int = GRID) -> None:
        self.n = n
        self.half = arena.half_m
        self.origin_lat = arena.origin_lat
        self.origin_lon = arena.origin_lon
        self.last_seen = [[-1e9 for _ in range(n)] for _ in range(n)]

    def cell_of_ne(self, north: float, east: float) -> tuple[int, int] | None:
        u = (east + self.half) / (2 * self.half)
        v = (north + self.half) / (2 * self.half)
        i = math.floor(u * self.n)
        j = math.floor(v * self.n)
        if 0 <= i < self.n and 0 <= j < self.n:
            return i, j
        return None

    def mark_fov(self, vehicle: VehicleState, now: float) -> None:
        n0, e0 = ll_to_ne(vehicle.lat, vehicle.lon, self.origin_lat, self.origin_lon)
        range_m, half_fov, disk = _sensor(vehicle.vehicle_class)
        vn, ve = heading_to_ne(vehicle.heading)
        step = max(self.half * 2 / self.n, 40.0)
        samples = int(range_m / step) + 1
        for k in range(samples):
            dist = k * step
            if disk:
                for ang in range(0, 360, 30):
                    an, ae = heading_to_ne(ang)
                    self._touch(n0 + an * dist, e0 + ae * dist, now)
            else:
                self._touch(n0 + vn * dist, e0 + ve * dist, now)
                # smear FOV width
                px, py = -ve, vn
                width = math.tan(math.radians(half_fov)) * dist
                self._touch(n0 + vn * dist + px * width * 0.5, e0 + ve * dist + py * width * 0.5, now)
                self._touch(n0 + vn * dist - px * width * 0.5, e0 + ve * dist - py * width * 0.5, now)

    def _touch(self, north: float, east: float, now: float) -> None:
        cell = self.cell_of_ne(north, east)
        if cell:
            i, j = cell
            self.last_seen[i][j] = now

    def occupancy(self, now: float) -> tuple[float, int, list[dict]]:
        seen = 0
        cells = []
        for i in range(self.n):
            for j in range(self.n):
                age = now - self.last_seen[i][j]
                if 0 <= age <= WINDOW_S:
                    seen += 1
                    heat = 1.0 - age / WINDOW_S
                    north = (j + 0.5) / self.n * 2 * self.half - self.half
                    east = (i + 0.5) / self.n * 2 * self.half - self.half
                    lat, lon = ne_to_ll(north, east, self.origin_lat, self.origin_lon)
                    cells.append({"lat": lat, "lon": lon, "heat": round(heat, 3)})
        return seen / (self.n * self.n), seen, cells


def _sensor(vehicle_class: str) -> tuple[float, float, bool]:
    if vehicle_class == "plane":
        return 400.0, 18.0, False
    if vehicle_class == "copter":
        return 120.0, 180.0, True
    if vehicle_class == "rover":
        return 40.0, 180.0, True
    return 600.0, 20.0, False


class MetricsEngine:
    def __init__(self, arena: Arena) -> None:
        self.grid = CoverageGrid(arena)
        self.score = Scorecard()
        self._prev_ne: dict[str, tuple[float, float]] = {}
        self._t0 = time.monotonic()
        self._first_detect: float | None = None
        self._overlap_acc = 0.0
        self._overlap_n = 0
        self.heatmap: list[dict] = []

    def note_command(self) -> None:
        self.score.commands_issued += 1

    def update(
        self,
        vehicles: list[VehicleState],
        track: Track | None,
        truth: tuple[float, float] | None,
        now: float | None = None,
    ) -> Scorecard:
        now = now or time.monotonic()
        search_cells: dict[tuple[int, int], int] = {}
        for v in vehicles:
            if not v.connected:
                # Home placeholders and lost poses are not observed travel or
                # coverage. Resume from a new baseline after a telemetry gap.
                self._prev_ne.pop(v.vehicle_id, None)
                continue
            n, e = ll_to_ne(v.lat, v.lon)
            prev = self._prev_ne.get(v.vehicle_id)
            if prev:
                self.score.meters_flown += math.hypot(n - prev[0], e - prev[1])
            self._prev_ne[v.vehicle_id] = (n, e)
            self.grid.mark_fov(v, now)
            if v.role == "search":
                cell = self.grid.cell_of_ne(n, e)
                if cell:
                    search_cells[cell] = search_cells.get(cell, 0) + 1

        cov, seen, heat = self.grid.occupancy(now)
        self.heatmap = heat
        self.score.coverage = cov
        self.score.cells_seen = seen

        roles = {v.role for v in vehicles if v.connected and v.role}
        self.score.unique_roles = len(roles)
        overlap = 0
        stacked = 0
        for c, n in search_cells.items():
            stacked += n
            if n > 1:
                overlap += n - 1
        self.score.overlap_ratio = (overlap / stacked) if stacked else 0.0
        self._overlap_acc += self.score.overlap_ratio
        self._overlap_n += 1
        mean_overlap = self._overlap_acc / max(1, self._overlap_n)
        self.score.collaboration = max(0.0, min(1.0, (len(roles) / 4.0) * (1.0 - mean_overlap)))

        if track and self._first_detect is None:
            self._first_detect = now - self._t0
            self.score.time_to_detect_s = self._first_detect

        ttd = self.score.time_to_detect_s
        ttd_term = 1.0 if ttd is None else max(0.15, 1.0 - (ttd / 90.0))
        path_term = 1.0 / (1.0 + self.score.meters_flown / 4000.0)
        cmd_term = 1.0 / (1.0 + self.score.commands_issued / 80.0)
        self.score.efficiency = max(0.0, min(1.0, 0.45 * ttd_term + 0.35 * path_term + 0.20 * cmd_term))

        if track and truth:
            n1, e1 = ll_to_ne(track.lat, track.lon)
            n2, e2 = ll_to_ne(truth[0], truth[1])
            err = math.hypot(n1 - n2, e1 - e2)
            self.score.track_error_m = err
            self.score.tracking = max(0.0, min(1.0, 1.0 - err / 400.0)) * min(1.0, track.confidence + 0.2)
        elif track:
            self.score.track_error_m = track.sigma_m
            self.score.tracking = max(0.0, min(1.0, track.confidence * (1.0 - min(track.sigma_m, 250.0) / 250.0)))
        else:
            self.score.tracking = 0.0
            self.score.track_error_m = None
        return self.score
