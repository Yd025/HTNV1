"""Maneuver primitives the platform agents call. Never call an LLM in here."""

from __future__ import annotations

import geo
import math
import time
from geo import bearing_deg, heading_to_ne, ll_to_ne, ne_to_ll
from sim.types import Command, VehicleState
from tracker import Track
from world import WorldModel

CRUISE_ALT = {"plane": 90.0, "copter": 40.0, "rover": 0.0, "tower": 0.0}
HOLD = {"copter": (-80.0, 40.0), "rover": (-250.0, -80.0), "plane": (200.0, -300.0)}
CAM_FAR_M = 1480.0
SWEEP_DEG_S = 6.0
# Fort Ross channel, fitted to the 401 DEM water cells in arctic-sim
# out/fort_ross/terrain.json: a 1.4 km wide strait on true 073.3 deg, centred
# 218 m north / 394 m east of the arena origin. Terrain, not the target's
# course — re-derive from the water mask if the site changes.
RIVER_CENTRE_NE = (218.0, 394.0)
RIVER_BEARING_DEG = 73.3
# Plane racetrack: 3 km straights, 400 m apart, joined by 400 m radius turns.
RIVER_LEG_HALF_M = 1500.0
RIVER_LANE_OFFSET_M = 400.0
# Quad works a compact box on the centreline, well along-channel from the plane.
RIVER_BOX_HALF_M = 320.0
RIVER_QUAD_STANDOFF_M = 700.0
# 180° water arcs. Tower-2 is +160° clockwise from the uphill 186.8° look.
TOWER_SWEEP = {
    "tower-1": {"center": 29.471640, "half": 90.0},
    "tower-2": {"center": 346.840964, "half": 90.0},
}


def tick_vehicle(v: VehicleState, world: WorldModel) -> Command | None:
    """Debug entry point uses the same mission gate as the brain's squad."""
    from agents.squad import Squad
    squad = getattr(world, "_debug_squad", None)
    if squad is None:
        squad = Squad()
        world._debug_squad = squad
    return squad.tick(v, world).command


def water_stare(sector: int, observer: VehicleState | None = None, now: float | None = None) -> tuple[float, float]:
    """Look point on water at the camera far clip along the current sweep bearing."""
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
    bearing = sweep_bearing(observer.vehicle_id, now)
    n, e = heading_to_ne(bearing)
    return ne_to_ll(n * CAM_FAR_M, e * CAM_FAR_M, observer.lat, observer.lon)


def sweep_bearing(vehicle_id: str, now: float | None = None) -> float:
    """Triangle wave at 6 deg/s across the tower's water sector."""
    cfg = TOWER_SWEEP.get(vehicle_id, {"center": 0.0, "half": 45.0})
    half = cfg["half"]
    period = max(1.0, 2.0 * half / SWEEP_DEG_S)
    stamp = time.monotonic() if now is None else now
    phase = stamp % (2.0 * period)
    offset = -half + SWEEP_DEG_S * phase if phase < period else half - SWEEP_DEG_S * (phase - period)
    return (cfg["center"] + offset) % 360.0


def cue_ll(world: WorldModel) -> tuple[float, float] | None:
    """Only an authorized, unexpired mission can steer aircraft to a target."""
    if not world.mission_active:
        return None
    track = world.track
    if track and track.age_s < 25.0:
        return bounded_wp(*ll_to_ne(*intercept_wp(track)))
    return None


def bounded_wp(north: float, east: float) -> tuple[float, float]:
    """Keep requested goals inside the configured arena; not a terrain planner."""
    half = geo.ARENA_HALF_M * 0.92
    return ne_to_ll(max(-half, min(half, north)), max(-half, min(half, east)))


def forward_search_wp(track: Track, leg: int) -> tuple[float, float]:
    """Alternating corridor passes at the plane's altitude, ahead of the quad."""
    n, e = ll_to_ne(track.lat, track.lon)
    speed = math.hypot(track.vn, track.ve)
    un, ue = (track.vn / speed, track.ve / speed) if speed > 0.5 else (1.0, 0.0)
    along = (220.0 if leg % 2 == 0 else -220.0) + min(120.0, speed * 6.0)
    side = 80.0 if leg % 2 == 0 else -80.0
    return bounded_wp(n + un * along - ue * side, e + ue * along + un * side)


def camera_follow_wp(track: Track, me: VehicleState) -> tuple[float, float] | None:
    """Keep the fixed downward camera's view on the boat, with body yaw control.

    The inspected ArcticSim quad mount is fixed 20 degrees below body forward.
    Standoff uses camera height above sea, not home-relative cruise altitude.
    Ownship roll/pitch during manoeuvres still require live calibration/testing.
    """
    from sim.cameras import QUAD_CAMERA_PITCH_DEG
    height = me.alt_msl if me.alt_msl is not None else (None if me.mavlink else me.alt)
    if height is None or not math.isfinite(height) or height < 0:
        return None
    standoff = max(80.0, min(1000.0, height / math.tan(math.radians(-QUAD_CAMERA_PITCH_DEG))))
    n, e = ll_to_ne(track.lat, track.lon)
    mn, meast = ll_to_ne(me.lat, me.lon)
    speed = math.hypot(track.vn, track.ve)
    if speed > 0.5:
        un, ue = track.vn / speed, track.ve / speed
    else:
        distance = math.hypot(n - mn, e - meast)
        un, ue = ((n - mn) / distance, (e - meast) / distance) if distance > 1.0 else (1.0, 0.0)
    return bounded_wp(n + track.vn * 4.0 - un * standoff, e + track.ve * 4.0 - ue * standoff)


def reacquire_wp(world: WorldModel, vehicle: VehicleState) -> tuple[float, float] | None:
    if not world.mission_active or world.track is None:
        return None
    track = world.track
    n, e = ll_to_ne(track.lat, track.lon)
    radius = min(420.0, max(80.0, 2.0 * track.sigma_m + track.age_s * 6.0))
    # Distinct sides and altitudes avoid assigning both aircraft the same point.
    phase = int((world.observation_now or 0.0) / 6.0) % 4
    if vehicle.vehicle_class == "plane":
        phase = (phase + 2) % 4
    corners = ((1, 1), (1, -1), (-1, -1), (-1, 1))
    dn, de = corners[phase]
    return bounded_wp(n + dn * radius, e + de * radius)


def reserve_orbit_wp(me: VehicleState, center: tuple[float, float]) -> tuple[float, float]:
    """An already airborne fixed wing needs a moving reserve orbit, not hover."""
    n, e = ll_to_ne(me.lat, me.lon)
    cn, ce = ll_to_ne(*center)
    angle = math.atan2(e - ce, n - cn) + math.pi / 3.0
    return bounded_wp(cn + 160.0 * math.cos(angle), ce + 160.0 * math.sin(angle))


def _river_frame() -> tuple[tuple[float, float], tuple[float, float]]:
    """Unit vectors along and across the channel, in arena north/east metres."""
    return heading_to_ne(RIVER_BEARING_DEG), heading_to_ne(RIVER_BEARING_DEG + 90.0)


def river_ne(along_m: float, across_m: float) -> tuple[float, float]:
    """Channel coordinates to arena north/east metres."""
    (an, ae), (cn, ce) = _river_frame()
    centre_n, centre_e = RIVER_CENTRE_NE
    return centre_n + an * along_m + cn * across_m, centre_e + ae * along_m + ce * across_m


def river_coords(lat: float, lon: float) -> tuple[float, float]:
    """Position as (along-channel, across-channel) metres from the channel centre."""
    (an, ae), (cn, ce) = _river_frame()
    north, east = ll_to_ne(lat, lon)
    dn, de = north - RIVER_CENTRE_NE[0], east - RIVER_CENTRE_NE[1]
    return dn * an + de * ae, dn * cn + de * ce


def _river_ring() -> list[tuple[float, float]]:
    """Racetrack in channel coordinates: two straights joined by 180 deg turns."""
    leg, lane = RIVER_LEG_HALF_M, RIVER_LANE_OFFSET_M
    turn = (math.pi / 4.0, math.pi / 2.0, 3.0 * math.pi / 4.0)
    ring = [(-leg + i * leg / 2.0, lane) for i in range(5)]
    ring += [(leg + lane * math.sin(a), lane * math.cos(a)) for a in turn]
    ring += [(leg - i * leg / 2.0, -lane) for i in range(5)]
    ring += [(-leg - lane * math.sin(a), -lane * math.cos(a)) for a in turn]
    return ring


def _next_on_circuit(
    lat: float, lon: float, circuit: list[tuple[float, float]]
) -> tuple[float, float]:
    """Nearest leg of a closed channel circuit, then the waypoint after it."""
    along, across = river_coords(lat, lon)
    nearest = min(
        ((along - s) ** 2 + (across - w) ** 2, i) for i, (s, w) in enumerate(circuit)
    )[1]
    return bounded_wp(*river_ne(*circuit[(nearest + 1) % len(circuit)]))


def river_racetrack_wp(v: VehicleState) -> tuple[float, float]:
    """Long-range oval along the channel; the plane's standing search pattern."""
    return _next_on_circuit(v.lat, v.lon, _river_ring())


def river_box_wp(
    v: VehicleState,
    avoid: VehicleState | None = None,
    bias: tuple[float, float] | None = None,
) -> tuple[float, float]:
    """Compact box on the channel centreline; the quad's targeted search."""
    if bias is not None:
        centre = river_coords(*bias)[0]
    elif avoid is not None:
        # Hold a standoff down-channel of the plane so the two do not share cells.
        centre = -math.copysign(RIVER_QUAD_STANDOFF_M, river_coords(avoid.lat, avoid.lon)[0] or 1.0)
    else:
        centre = 0.0
    box = RIVER_BOX_HALF_M
    corners = [(centre + box, box), (centre + box, -box), (centre - box, -box), (centre - box, box)]
    return _next_on_circuit(v.lat, v.lon, corners)


def _search_half() -> float:
    """Fort Ross arena is 3.25 km; ISR stays on the inner strait, not the hills."""
    half = geo.ARENA_HALF_M
    return 1100.0 if half > 2000.0 else half


def lawnmower_wp(v: VehicleState, bias: tuple[float, float] | None = None) -> tuple[float, float]:
    """North-south lanes. Optional bias steers ISR onto the cued lane — not an intercept."""
    n, e = ll_to_ne(v.lat, v.lon)
    half = _search_half()
    lane_w = 280.0
    if bias is not None:
        _, be = ll_to_ne(bias[0], bias[1])
        lane = round((be + half) / lane_w)
    else:
        lane = round((e + half) / lane_w)
    lane = int(max(0, min(int(2 * half / lane_w) - 1, lane)))
    target_e = -half + (lane + 0.5) * lane_w
    going_north = lane % 2 == 0
    if going_north and n > half * 0.75:
        target_e = -half + (lane + 1.5) * lane_w
        target_n = half * 0.75
    elif (not going_north) and n < -half * 0.75:
        target_e = -half + (lane + 1.5) * lane_w
        target_n = -half * 0.75
    else:
        target_n = half * 0.8 if going_north else -half * 0.8
    target_e = max(-half * 0.9, min(half * 0.9, target_e))
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
