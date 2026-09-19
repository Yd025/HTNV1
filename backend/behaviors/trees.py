"""Doctrine behavior trees. Tick from world state; never call an LLM in here."""

from __future__ import annotations

from geo import ARENA_HALF_M, ORIGIN_LAT, ORIGIN_LON, ll_to_ne, ne_to_ll
from sim.types import Command, VehicleState
from tracker import Track
from world import WorldModel

CRUISE_ALT = {"plane": 90.0, "copter": 40.0, "rover": 0.0, "tower": 0.0}


def tick_vehicle(v: VehicleState, world: WorldModel) -> Command | None:
    if v.vehicle_class == "tower":
        return None
    track = world.track
    role = v.role or "reserve"
    if v.vehicle_class == "plane":
        return _plane(v, role, track)
    if v.vehicle_class == "copter":
        return _copter(v, role, track)
    if v.vehicle_class == "rover":
        return _rover(v, role, track)
    return Command(vehicle_id=v.vehicle_id, type="hold", lat=v.lat, lon=v.lon, alt=v.alt)


def _plane(v: VehicleState, role: str, track: Track | None) -> Command:
    if role == "track" and track:
        # Stand-off trail: offset north-east of the contact, never hover.
        n, e = ll_to_ne(track.lat, track.lon)
        lat, lon = ne_to_ll(n + 180.0, e - 80.0)
        return Command(vehicle_id=v.vehicle_id, type="loiter", lat=lat, lon=lon, alt=CRUISE_ALT["plane"])
    lat, lon = _lawnmower(v)
    return Command(vehicle_id=v.vehicle_id, type="search_sector", lat=lat, lon=lon, alt=CRUISE_ALT["plane"])


def _copter(v: VehicleState, role: str, track: Track | None) -> Command:
    if role == "track" and track:
        n, e = ll_to_ne(track.lat, track.lon)
        # lead the contact by ~4s of velocity
        lat, lon = ne_to_ll(n + track.vn * 4.0, e + track.ve * 4.0)
        return Command(vehicle_id=v.vehicle_id, type="goto", lat=lat, lon=lon, alt=CRUISE_ALT["copter"])
    if role == "search":
        lat, lon = _box_search(v)
        return Command(vehicle_id=v.vehicle_id, type="search_sector", lat=lat, lon=lon, alt=CRUISE_ALT["copter"])
    # Hold reserve near origin
    lat, lon = ne_to_ll(-80.0, 40.0)
    return Command(vehicle_id=v.vehicle_id, type="hold", lat=lat, lon=lon, alt=CRUISE_ALT["copter"])


def _rover(v: VehicleState, role: str, track: Track | None) -> Command:
    if role == "confirm" and track:
        return Command(vehicle_id=v.vehicle_id, type="goto", lat=track.lat, lon=track.lon, alt=0.0)
    lat, lon = ne_to_ll(-250.0, -80.0)
    return Command(vehicle_id=v.vehicle_id, type="hold", lat=lat, lon=lon, alt=0.0)


def _lawnmower(v: VehicleState) -> tuple[float, float]:
    """North-south lanes across the arena, indexed by hashed vehicle id + time buckets via position."""
    n, e = ll_to_ne(v.lat, v.lon)
    lane_w = 280.0
    lane = round((e + ARENA_HALF_M) / lane_w)
    lane = int(max(0, min(int(2 * ARENA_HALF_M / lane_w) - 1, lane)))
    target_e = -ARENA_HALF_M + (lane + 0.5) * lane_w
    going_north = (lane % 2 == 0)
    # If near the end, hop to next lane
    if going_north and n > ARENA_HALF_M * 0.75:
        target_e = -ARENA_HALF_M + (lane + 1.5) * lane_w
        target_n = ARENA_HALF_M * 0.75
    elif (not going_north) and n < -ARENA_HALF_M * 0.75:
        target_e = -ARENA_HALF_M + (lane + 1.5) * lane_w
        target_n = -ARENA_HALF_M * 0.75
    else:
        target_n = ARENA_HALF_M * 0.8 if going_north else -ARENA_HALF_M * 0.8
    target_e = max(-ARENA_HALF_M * 0.9, min(ARENA_HALF_M * 0.9, target_e))
    return ne_to_ll(target_n, target_e, ORIGIN_LAT, ORIGIN_LON)


def _box_search(v: VehicleState) -> tuple[float, float]:
    n, e = ll_to_ne(v.lat, v.lon)
    box = 350.0
    corners = [(box, box), (box, -box), (-box, -box), (-box, box)]
    # pick next corner by nearest + 1
    dists = [((n - c[0]) ** 2 + (e - c[1]) ** 2, i) for i, c in enumerate(corners)]
    i = min(dists)[1]
    nxt = corners[(i + 1) % 4]
    return ne_to_ll(nxt[0], nxt[1])
