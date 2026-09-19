"""Maneuver primitives the platform agents call. Never call an LLM in here."""

from __future__ import annotations

import geo
from geo import bearing_deg, heading_to_ne, ll_to_ne, ne_to_ll
from sim.types import Command, VehicleState
from tracker import Track
from world import WorldModel

CRUISE_ALT = {"plane": 90.0, "copter": 40.0, "rover": 0.0, "tower": 0.0}
HOLD = {"copter": (-80.0, 40.0), "rover": (-250.0, -80.0), "plane": (200.0, -300.0)}


def tick_vehicle(v: VehicleState, world: WorldModel) -> Command | None:
    """Fallback dispatcher. SwarmBrain ticks PlatformAgents; this stays for eval/debug."""
    if v.vehicle_class == "tower":
        return None
    track = world.track
    role = v.role or "reserve"
    if v.vehicle_class == "plane":
        lat, lon = lawnmower_wp(v, bias=cue_ll(world))
        return Command(vehicle_id=v.vehicle_id, type="search_sector", lat=lat, lon=lon, alt=CRUISE_ALT["plane"])
    if v.vehicle_class == "copter":
        aim = cue_ll(world)
        if aim and (role == "track" or track or world.detections or world.last_cue):
            return Command(vehicle_id=v.vehicle_id, type="goto", lat=aim[0], lon=aim[1], alt=CRUISE_ALT["copter"])
        if role == "search":
            plane = next((x for x in world.vehicles.values() if x.vehicle_class == "plane"), None)
            lat, lon = box_search_wp(v, avoid=plane)
            return Command(vehicle_id=v.vehicle_id, type="search_sector", lat=lat, lon=lon, alt=CRUISE_ALT["copter"])
        lat, lon = hold_wp("copter")
        return Command(vehicle_id=v.vehicle_id, type="hold", lat=lat, lon=lon, alt=CRUISE_ALT["copter"])
    if v.vehicle_class == "rover":
        if role == "confirm" and track:
            return Command(vehicle_id=v.vehicle_id, type="goto", lat=track.lat, lon=track.lon, alt=0.0)
        lat, lon = hold_wp("rover")
        return Command(vehicle_id=v.vehicle_id, type="hold", lat=lat, lon=lon, alt=0.0)
    return Command(vehicle_id=v.vehicle_id, type="hold", lat=v.lat, lon=v.lon, alt=v.alt)


def water_stare(sector: int, observer: VehicleState | None = None) -> tuple[float, float]:
    """Look points on water. From a tower, stay inside the 1.5 km camera clip."""
    if observer is None:
        rings = (
            (800.0, 30.0),
            (1100.0, 90.0),
            (800.0, 150.0),
            (1100.0, 210.0),
            (800.0, 270.0),
            (1100.0, 330.0),
        )
        dist, bearing = rings[int(sector) % len(rings)]
        n, e = heading_to_ne(bearing)
        return ne_to_ll(n * dist, e * dist)
    # Channel through the arena origin — Fort Ross water — stepped range + sweep.
    brg = bearing_deg(observer.lat, observer.lon, geo.ORIGIN_LAT, geo.ORIGIN_LON)
    # Stay on the strait. Wide sweeps put the 60° EO on hills and lose the hull.
    sweep = (-8.0, 0.0, 8.0, -8.0, 0.0, 8.0)[int(sector) % 6]
    dist = (800.0, 1050.0, 1300.0, 800.0, 1050.0, 1300.0)[int(sector) % 6]
    n, e = heading_to_ne(brg + sweep)
    return ne_to_ll(n * dist, e * dist, observer.lat, observer.lon)


def cue_ll(world: WorldModel) -> tuple[float, float] | None:
    """Where air should point given vision: predicted track, else loudest detection."""
    track = world.track
    if track and track.confidence >= 0.20:
        return intercept_wp(track)
    dets = list(world.detections or [])
    if dets:
        best = max(dets, key=lambda d: d.confidence)
        return best.lat, best.lon
    if world.last_cue:
        return world.last_cue
    return None


def lawnmower_wp(v: VehicleState, bias: tuple[float, float] | None = None) -> tuple[float, float]:
    """North-south lanes. Optional bias steers ISR onto the cued lane — not an intercept."""
    n, e = ll_to_ne(v.lat, v.lon)
    lane_w = 280.0
    if bias is not None:
        _, be = ll_to_ne(bias[0], bias[1])
        lane = round((be + geo.ARENA_HALF_M) / lane_w)
    else:
        lane = round((e + geo.ARENA_HALF_M) / lane_w)
    lane = int(max(0, min(int(2 * geo.ARENA_HALF_M / lane_w) - 1, lane)))
    target_e = -geo.ARENA_HALF_M + (lane + 0.5) * lane_w
    going_north = lane % 2 == 0
    if going_north and n > geo.ARENA_HALF_M * 0.75:
        target_e = -geo.ARENA_HALF_M + (lane + 1.5) * lane_w
        target_n = geo.ARENA_HALF_M * 0.75
    elif (not going_north) and n < -geo.ARENA_HALF_M * 0.75:
        target_e = -geo.ARENA_HALF_M + (lane + 1.5) * lane_w
        target_n = -geo.ARENA_HALF_M * 0.75
    else:
        target_n = geo.ARENA_HALF_M * 0.8 if going_north else -geo.ARENA_HALF_M * 0.8
    target_e = max(-geo.ARENA_HALF_M * 0.9, min(geo.ARENA_HALF_M * 0.9, target_e))
    return ne_to_ll(target_n, target_e)


def box_search_wp(v: VehicleState, avoid: VehicleState | None = None) -> tuple[float, float]:
    if avoid is not None:
        return _box_search_away(v, avoid)
    return _box_search(v)


def intercept_wp(track: Track, lead_s: float = 4.0) -> tuple[float, float]:
    n, e = ll_to_ne(track.lat, track.lon)
    return ne_to_ll(n + track.vn * lead_s, e + track.ve * lead_s)


def standoff_wp(track: Track) -> tuple[float, float]:
    n, e = ll_to_ne(track.lat, track.lon)
    return ne_to_ll(n + 180.0, e - 80.0)


def hold_wp(kind: str) -> tuple[float, float]:
    n, e = HOLD.get(kind, (0.0, 0.0))
    return ne_to_ll(n, e)


def _box_search(v: VehicleState) -> tuple[float, float]:
    n, e = ll_to_ne(v.lat, v.lon)
    box = 350.0
    corners = [(box, box), (box, -box), (-box, -box), (-box, box)]
    dists = [((n - c[0]) ** 2 + (e - c[1]) ** 2, i) for i, c in enumerate(corners)]
    i = min(dists)[1]
    nxt = corners[(i + 1) % 4]
    return ne_to_ll(nxt[0], nxt[1])


def _box_search_away(v: VehicleState, avoid: VehicleState) -> tuple[float, float]:
    """Opposite quadrant from a searcher so two searchers do not stack cells."""
    an, ae = ll_to_ne(avoid.lat, avoid.lon)
    qn = -1.0 if an >= 0 else 1.0
    qe = -1.0 if ae >= 0 else 1.0
    box = 420.0
    corners = [
        (qn * box, qe * box),
        (qn * box, qe * 80.0),
        (qn * 80.0, qe * box),
        (qn * box * 0.5, qe * box * 0.5),
    ]
    n, e = ll_to_ne(v.lat, v.lon)
    dists = [((n - c[0]) ** 2 + (e - c[1]) ** 2, i) for i, c in enumerate(corners)]
    i = min(dists)[1]
    nxt = corners[(i + 1) % 4]
    return ne_to_ll(nxt[0], nxt[1])
