"""Observation-only coordinated patrols using portable trained policy knobs.

Routes are regenerated in the connected adapter's geographic arena. Graph XY
coordinates, learned tower sites and synthetic detector probabilities are never
loaded into the flight controller. This is a geometric route generator, not a
terrain-clearance or calibrated camera visibility certificate.
"""
from __future__ import annotations

import json
import hashlib
import math
import os
from pathlib import Path

from behaviors.trees import CRUISE_ALT
from flight_policy import COORDINATED_ALGORITHM, LEGACY_ALGORITHM, normalize_flight_policy
from geo import bearing_deg, haversine_m, ll_to_ne, ne_to_ll
from plane_shadow import PlaneShadow
from sim.types import Arena, VehicleState


def load_runtime_policy() -> dict:
    """Validate configuration before an adapter can connect or send commands."""
    requested = os.getenv("MISSION_ALGORITHM", "").strip()
    filename = os.getenv("SURVEILLANCE_POLICY_FILE", "").strip()
    artifact = None
    artifact_bytes = None
    policy = None
    algorithm = requested or LEGACY_ALGORITHM
    if filename:
        artifact_bytes = Path(filename).read_bytes()
        artifact = json.loads(artifact_bytes)
        if not isinstance(artifact, dict):
            raise ValueError("SURVEILLANCE_POLICY_FILE must contain a JSON object")
        # Training artifacts have a trained block; portable exports use root.
        selected = artifact.get("trained", artifact)
        if not isinstance(selected, dict):
            raise ValueError("Surveillance trained policy must be an object")
        artifact_algorithm = selected.get("algorithm", artifact.get("algorithm"))
        if artifact_algorithm != COORDINATED_ALGORITHM:
            raise ValueError("Surveillance policy must name coordinated-surveillance-v1")
        if requested and requested != artifact_algorithm:
            raise ValueError("MISSION_ALGORITHM conflicts with SURVEILLANCE_POLICY_FILE")
        if "flightPolicy" not in selected:
            raise ValueError("Surveillance policy is missing flightPolicy")
        policy = normalize_flight_policy(selected["flightPolicy"])
        algorithm = artifact_algorithm
    if algorithm not in {LEGACY_ALGORITHM, COORDINATED_ALGORITHM}:
        raise ValueError(f"Unknown MISSION_ALGORITHM: {algorithm}")
    return {
        "algorithm": algorithm,
        "flightPolicy": policy or normalize_flight_policy(),
        "policy_file": str(Path(filename).resolve()) if filename else None,
        "policy_sha256": hashlib.sha256(artifact_bytes).hexdigest() if artifact_bytes is not None else None,
        "source_profile_hash": artifact.get("profileHash") if artifact else None,
        "applied_sections": ["flightPolicy"] if filename else [],
        "coordinate_frame": "adapter arena axes rotated into geographic north/east; routes regenerated",
        "terrain_validated": False,
        "sensor_model_applied": False,
    }


def arena_for(world) -> Arena:
    if world.arena is not None:
        return world.arena
    import geo
    return Arena(geo.ORIGIN_LAT, geo.ORIGIN_LON, geo.ARENA_HALF_M)


def bounded_ll(world, north: float, east: float) -> tuple[float, float]:
    """Clamp in the physical arena's rotated square, not a true-NE square."""
    arena = arena_for(world)
    half = arena.half_m * .88
    x, y = ne_to_arena_xy(world, north, east)
    n, e = arena_xy_to_ne(world, max(-half, min(half, x)), max(-half, min(half, y)))
    return ne_to_ll(n, e, arena.origin_lat, arena.origin_lon)


def arena_xy_to_ne(world, x: float, y: float) -> tuple[float, float]:
    angle = math.radians(arena_for(world).heading_offset_deg)
    return y * math.cos(angle) - x * math.sin(angle), y * math.sin(angle) + x * math.cos(angle)


def ne_to_arena_xy(world, north: float, east: float) -> tuple[float, float]:
    angle = math.radians(arena_for(world).heading_offset_deg)
    return east * math.cos(angle) - north * math.sin(angle), north * math.cos(angle) + east * math.sin(angle)


def point_ne(world, lat: float, lon: float) -> tuple[float, float]:
    """True geographic N/E, matching the track's vn/ve velocity components."""
    arena = arena_for(world)
    return ll_to_ne(lat, lon, arena.origin_lat, arena.origin_lon)


class PatrolRoute:
    """Persistent waypoints, advanced by aircraft position, not wall-clock luck."""
    def __init__(self) -> None:
        self.points: list[tuple[float, float]] = []
        self.index = 0

    def waypoint(self, me: VehicleState, world) -> tuple[float, float]:
        if not self.points:
            self.points = self._build(me, world)
            self.index = int(world.flight_policy["routePhase"] * len(self.points)) % len(self.points)
        reach = 110.0 if me.vehicle_class == "plane" else 35.0
        if haversine_m(me.lat, me.lon, *self.points[self.index]) < reach:
            self.index = (self.index + 1) % len(self.points)
        return self.points[self.index]

    def _build(self, me: VehicleState, world) -> list[tuple[float, float]]:
        half = arena_for(world).half_m * .78
        policy = world.flight_policy
        if me.vehicle_class == "plane":
            # Nominal forward camera footprint (-8 deg, 69 deg HFOV). This
            # bounds lane separation without pretending the image detects a
            # ship. Actual mount/attitude/terrain are handled by observations.
            height = me.alt_msl if me.alt_msl is not None and me.alt_msl > 5 else CRUISE_ALT["plane"]
            nominal_width = 2 * height / math.sin(math.radians(8)) * math.tan(math.radians(34.5))
            spacing = min(policy["laneSpacingM"], max(200.0, nominal_width * .65))
            lanes = max(2, min(36, math.ceil(2 * half / spacing)))
            points = []
            for lane in range(lanes):
                east = -half + (lane + .5) * 2 * half / lanes
                start, finish = (-half, half) if lane % 2 == 0 else (half, -half)
                points.extend([arena_xy_to_ne(world, east, start), arena_xy_to_ne(world, east, finish)])
        else:
            # Choose a local patch with less tower/plane overlap. Candidate
            # ranking uses ownship and known tower geometry, never target truth.
            hn, he = point_ne(world, me.lat, me.lon)
            radius = min(policy["quadSearchRadiusM"], half * .55)
            peers = [v for v in world.vehicles.values() if v.vehicle_class in {"tower", "plane"}]
            centers = [(max(-half + radius, min(half - radius, hn + dn * radius)),
                        max(-half + radius, min(half - radius, he + de * radius)))
                       for dn, de in ((1, 1), (1, -1), (-1, 1), (-1, -1))]
            def score(center):
                nn, ee = center
                distances = [math.hypot(nn - point_ne(world, v.lat, v.lon)[0],
                                        ee - point_ne(world, v.lat, v.lon)[1]) for v in peers]
                return min(distances) if distances else -math.hypot(nn - hn, ee - he)
            cn, ce = max(centers, key=score)
            points = [(cn + dn * radius, ce + de * radius)
                      for dn, de in ((1, 1), (1, -1), (-1, -1), (-1, 1))]
        return [bounded_ll(world, north, east) for north, east in points]


def support_waypoint(world, me: VehicleState, shadow: PlaneShadow) -> tuple[float, float] | None:
    """Moving offset passes, with a camera-derived blind-zone standoff."""
    track = world.track
    n, e = point_ne(world, track.lat, track.lon)
    mn, meast = point_ne(world, me.lat, me.lon)
    height = me.alt_msl if me.alt_msl is not None else (None if me.mavlink else me.alt)
    if height is None or not math.isfinite(height) or height <= 5.:
        return None  # no live home-relative altitude substituted for sea height
    # Source skywalker_x8 fixed mount. Current body pitch/roll are not in the
    # adapter contract; camera-backed reports remain the authority for custody.
    sensor = {"pitchDeg": -8.021409, "hfovDeg": 68.984119,
              "vfovDeg": 42.261117, "farClipM": 1500.}
    x, y = shadow.waypoint((meast, mn), me.heading, max(15., me.groundspeed), height,
                          (e, n), (track.ve, track.vn), world.flight_policy, sensor)
    return bounded_ll(world, y, x)


def coordinated_reacquire(world, me: VehicleState) -> tuple[float, float]:
    track = world.track
    n, e = point_ne(world, track.lat, track.lon)
    width = world.flight_policy["reacquireWidthM"]
    radius = min(arena_for(world).half_m * .5, width + 2 * track.sigma_m + track.age_s * 6.)
    phase = int((world.observation_now or 0) / 12.) % 4
    if me.vehicle_class == "plane":
        phase = (phase + 2) % 4
    dn, de = ((1, 1), (1, -1), (-1, -1), (-1, 1))[phase]
    return bounded_ll(world, n + dn * radius, e + de * radius)


def follow_waypoint(world, me: VehicleState) -> tuple[float, float] | None:
    """Camera-height-aware quad follow; no home-relative/MSL substitution live."""
    height = me.alt_msl if me.alt_msl is not None else (None if me.mavlink else me.alt)
    if height is None or not math.isfinite(height) or height < 0:
        return None
    track = world.track
    n, e = point_ne(world, track.lat, track.lon)
    mn, meast = point_ne(world, me.lat, me.lon)
    speed = math.hypot(track.vn, track.ve)
    distance = math.hypot(n - mn, e - meast)
    un, ue = ((track.vn / speed, track.ve / speed) if speed > .5 else
              ((n - mn) / distance, (e - meast) / distance) if distance > 1. else (1., 0.))
    reach = max(80., min(1000., height / math.tan(math.radians(20))))
    lead = min(8., world.flight_policy["lookaheadS"])
    return bounded_ll(world, n + track.vn * lead - un * reach, e + track.ve * lead - ue * reach)


def patrol_yaw(me: VehicleState, goal: tuple[float, float]) -> float:
    # The quad's fixed camera follows body yaw. Face the next search leg.
    return bearing_deg(me.lat, me.lon, *goal)


def reserve_waypoint(world, me: VehicleState, center: tuple[float, float]) -> tuple[float, float]:
    n, e = point_ne(world, me.lat, me.lon)
    cn, ce = point_ne(world, *center)
    angle = math.atan2(e - ce, n - cn) + math.pi / 3.
    return bounded_ll(world, cn + 160. * math.cos(angle), ce + 160. * math.sin(angle))
