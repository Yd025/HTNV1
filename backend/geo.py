"""Arena geo helpers. Positions are WGS84; planning happens in local north/east meters."""

from __future__ import annotations

import math
import os
from typing import Iterable

ORIGIN_LAT = float(os.getenv("SITL_LAT", "74.6973"))
ORIGIN_LON = float(os.getenv("SITL_LON", "-94.8297"))
ARENA_HALF_M = float(os.getenv("ARENA_HALF_M", "1500"))
M_PER_DEG_LAT = 111_111.0


def m_per_deg_lon(lat: float) -> float:
    return M_PER_DEG_LAT * max(0.2, abs(math.cos(math.radians(lat))))


def ll_to_ne(
    lat: float,
    lon: float,
    origin_lat: float | None = None,
    origin_lon: float | None = None,
) -> tuple[float, float]:
    # Read module globals at call time — WhiteoutAdapter pins Fort Ross after import.
    origin_lat = ORIGIN_LAT if origin_lat is None else origin_lat
    origin_lon = ORIGIN_LON if origin_lon is None else origin_lon
    north = (lat - origin_lat) * M_PER_DEG_LAT
    east = (lon - origin_lon) * m_per_deg_lon(origin_lat)
    return north, east


def ne_to_ll(
    north: float,
    east: float,
    origin_lat: float | None = None,
    origin_lon: float | None = None,
) -> tuple[float, float]:
    origin_lat = ORIGIN_LAT if origin_lat is None else origin_lat
    origin_lon = ORIGIN_LON if origin_lon is None else origin_lon
    lat = origin_lat + north / M_PER_DEG_LAT
    lon = origin_lon + east / m_per_deg_lon(origin_lat)
    return lat, lon


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6_371_000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(x, y)) + 360.0) % 360.0


def wrap_heading(deg: float) -> float:
    return (deg + 360.0) % 360.0


def heading_to_ne(heading_deg: float) -> tuple[float, float]:
    rad = math.radians(heading_deg)
    return math.cos(rad), math.sin(rad)


def clamp_arena(north: float, east: float, half: float | None = None) -> tuple[float, float]:
    span = ARENA_HALF_M if half is None else half
    return max(-span, min(span, north)), max(-span, min(span, east))


def dist_ne(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def mean_ne(points: Iterable[tuple[float, float]]) -> tuple[float, float]:
    pts = list(points)
    if not pts:
        return 0.0, 0.0
    n = sum(p[0] for p in pts) / len(pts)
    e = sum(p[1] for p in pts) / len(pts)
    return n, e
