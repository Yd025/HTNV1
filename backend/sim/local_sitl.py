"""Local hybrid fleet: optional multi-SITL MAVLink + kinematic twins + virtual towers + moving target."""

from __future__ import annotations

import asyncio
import logging
import math
import os
import random
import time

from geo import (
    ARENA_HALF_M,
    ORIGIN_LAT,
    ORIGIN_LON,
    bearing_deg,
    clamp_arena,
    ll_to_ne,
    ne_to_ll,
    wrap_heading,
)
from sim.target import TargetSim
from sim.types import Arena, Command, Detection, TowerMount, VehicleClass, VehicleState

logger = logging.getLogger("overwatch.local_sitl")

SPEED = {"plane": 25.0, "copter": 12.0, "rover": 4.0, "tower": 0.0}
CRUISE_ALT = {"plane": 90.0, "copter": 40.0, "rover": 0.0, "tower": 12.0}


def _fleet_spec() -> list[dict]:
    return [
        {
            "vehicle_id": "plane-1",
            "sysid": 1,
            "vehicle_class": "plane",
            "conn": os.getenv("MAVLINK_PLANE", "tcp:sitl-plane:5760"),
            "north": 200.0,
            "east": -300.0,
        },
        {
            "vehicle_id": "copter-1",
            "sysid": 2,
            "vehicle_class": "copter",
            "conn": os.getenv("MAVLINK_COPTER", "tcp:sitl-copter:5760"),
            "north": -80.0,
            "east": 40.0,
        },
        {
            "vehicle_id": "rover-1",
            "sysid": 3,
            "vehicle_class": "rover",
            "conn": os.getenv("MAVLINK_ROVER", "tcp:sitl-rover:5760"),
            "north": -250.0,
            "east": -80.0,
        },
    ]


class KinematicCraft:
    def __init__(self, spec: dict, arena: Arena | None = None) -> None:
        self.arena = arena
        self.vehicle_id = spec["vehicle_id"]
        self.sysid = spec["sysid"]
        self.vehicle_class: VehicleClass = spec["vehicle_class"]
        self.north = spec["north"]
        self.east = spec["east"]
        self.alt = CRUISE_ALT[self.vehicle_class]
        self.heading = 0.0
        self.cmd: Command | None = None
        self.groundspeed = 0.0

    def apply(self, cmd: Command) -> None:
        self.cmd = cmd

    def step(self, dt: float) -> None:
        if self.vehicle_class == "tower" or self.cmd is None:
            self.groundspeed = 0.0
            return
        if self.cmd.lat is None or self.cmd.lon is None:
            return
        if self.vehicle_class == "copter" and self.cmd.yaw_deg is not None:
            self.heading = wrap_heading(self.cmd.yaw_deg)
        origin = (self.arena.origin_lat, self.arena.origin_lon) if self.arena else (ORIGIN_LAT, ORIGIN_LON)
        tn, te = ll_to_ne(self.cmd.lat, self.cmd.lon, *origin)
        dn, de = tn - self.north, te - self.east
        dist = (dn ** 2 + de ** 2) ** 0.5
        speed = SPEED[self.vehicle_class]
        if dist < 8.0:
            self.groundspeed = 0.0
            if self.cmd.alt is not None and self.vehicle_class != "rover":
                self.alt = self.cmd.alt
            return
        step = min(speed * dt, dist)
        self.north += dn / dist * step
        self.east += de / dist * step
        self.north, self.east = clamp_arena(self.north, self.east, self.arena.half_m if self.arena else ARENA_HALF_M)
        if self.vehicle_class != "copter" or self.cmd.yaw_deg is None:
            self.heading = wrap_heading(math.degrees(math.atan2(de, dn)))
        if self.cmd.alt is not None:
            self.alt += (self.cmd.alt - self.alt) * min(1.0, dt * 0.6)
        if self.vehicle_class == "rover":
            self.alt = 0.0
        self.groundspeed = speed

    def state(self, mavlink: bool) -> VehicleState:
        origin = (self.arena.origin_lat, self.arena.origin_lon) if self.arena else (ORIGIN_LAT, ORIGIN_LON)
        lat, lon = ne_to_ll(self.north, self.east, *origin)
        return VehicleState(
            vehicle_id=self.vehicle_id,
            sysid=self.sysid,
            vehicle_class=self.vehicle_class,
            lat=lat,
            lon=lon,
            alt=self.alt,
            heading=self.heading,
            groundspeed=self.groundspeed,
            mavlink=mavlink,
            alt_msl=self.alt if not mavlink else None,
        )


class LocalSitlAdapter:
    name = "local"

    def __init__(self) -> None:
        self._arena = Arena(
            origin_lat=ORIGIN_LAT,
            origin_lon=ORIGIN_LON,
            half_m=ARENA_HALF_M,
            towers=[
                TowerMount("tower-ne", *ne_to_ll(900, 900), heading=225.0),
                TowerMount("tower-sw", *ne_to_ll(-900, -900), heading=45.0),
            ],
        )
        self._force_kinematic = os.getenv("FORCE_KINEMATIC", "1") == "1"
        self.search_policy: dict | None = None
        policy_path = os.getenv("SEARCH_POLICY_FILE", "").strip()
        if policy_path:
            if not self._force_kinematic:
                raise ValueError("SEARCH_POLICY_FILE is supported only with FORCE_KINEMATIC=1")
            from search_experiment import arena_for, load_policy
            self.search_policy = load_policy(policy_path)
            self._arena = arena_for(self.search_policy)
        self._kin: dict[str, KinematicCraft] = {s["vehicle_id"]: KinematicCraft(s, self._arena) for s in _fleet_spec()}
        self._bridges: dict = {}
        self._target = TargetSim(origin_lat=self._arena.origin_lat, origin_lon=self._arena.origin_lon, half_m=self._arena.half_m)
        self._search_rng = random.Random(2026)
        self._last_tick = time.monotonic()
        self._search_started_s = self._last_tick
        self._search_sample_index: int | None = None
        self.search_sample_time_s: float | None = None
        self._comms = {vid: True for vid in self._kin}
        for tw in self._arena.towers:
            self._comms[tw.vehicle_id] = True

    @property
    def mode(self) -> str:
        # Even with real own-vehicle telemetry, target detections are synthetic.
        return "synthetic" if self._force_kinematic else "hybrid"

    async def connect(self) -> None:
        if self.search_policy:
            # Existing tracker, metrics and post-detection maneuvers resolve
            # default coordinates through geo, as in the Whiteout adapter.
            import geo as geo_mod
            geo_mod.ORIGIN_LAT = self._arena.origin_lat
            geo_mod.ORIGIN_LON = self._arena.origin_lon
            geo_mod.ARENA_HALF_M = self._arena.half_m
            self._search_started_s = time.monotonic()
            self._search_sample_index = None
            self.search_sample_time_s = None
            self._search_rng.seed(2026)
        for vid in self._comms:
            self._comms[vid] = True
        if self._force_kinematic:
            logger.info("LocalSitlAdapter kinematic-only (FORCE_KINEMATIC=1)")
            return
        from mavlink_connection import MavlinkBridge

        for spec in _fleet_spec():
            bridge = MavlinkBridge(conn_str=spec["conn"], vehicle_id=spec["vehicle_id"])
            self._bridges[spec["vehicle_id"]] = bridge
            try:
                await bridge.connect(timeout=8.0)
            except ConnectionError:
                logger.warning("SITL %s not up yet; using kinematic twin", spec["vehicle_id"])

    async def close(self) -> None:
        bridges, self._bridges = self._bridges, {}
        for vid in self._comms:
            self._comms[vid] = False
        for craft in self._kin.values():
            craft.cmd = None
        results = await asyncio.gather(*(bridge.close() for bridge in bridges.values()), return_exceptions=True)
        for result in results:
            if isinstance(result, Exception):
                logger.warning("SITL bridge cleanup failed: %s", result)

    def arena(self) -> Arena:
        return self._arena

    async def list_vehicles(self) -> list[VehicleState]:
        self._advance_target()
        dt = min(0.2, time.monotonic() - self._last_tick)
        vehicles: list[VehicleState] = []
        for spec in _fleet_spec():
            vid = spec["vehicle_id"]
            kin = self._kin[vid]
            bridge = self._bridges.get(vid)
            mav_ok = bool(bridge and bridge.is_connected())
            if mav_ok:
                await self._drain_mav(bridge)
                snap = bridge.snapshot()
                if snap.get("lat") is not None:
                    kin.north, kin.east = ll_to_ne(float(snap["lat"]), float(snap["lon"]), self._arena.origin_lat, self._arena.origin_lon)
                    kin.alt = float(snap.get("alt") or kin.alt)
                    kin.heading = float(snap.get("heading") or kin.heading)
                    kin.groundspeed = float(snap.get("groundspeed") or 0.0)
                    st = kin.state(True)
                    st.battery_remaining = float(snap.get("battery_remaining") or 100.0)
                    st.armed = bool(snap.get("armed"))
                    st.mode = str(snap.get("mode") or "GUIDED")
                    st.alt_msl = float(snap["alt_msl"]) if snap.get("alt_msl") is not None else None
                    st.sysid = int(snap.get("sysid") or spec["sysid"])
                    vehicles.append(st)
                    continue
            kin.step(dt)
            vehicles.append(kin.state(False))
        for tw in self._arena.towers:
            vehicles.append(
                VehicleState(
                    vehicle_id=tw.vehicle_id,
                    sysid=10 + len(vehicles),
                    vehicle_class="tower",
                    lat=tw.lat,
                    lon=tw.lon,
                    alt=12.0,
                    heading=tw.heading,
                    role="cue",
                )
            )
        self._last_tick = time.monotonic()
        return vehicles

    async def poll_detections(self) -> list[Detection]:
        if self.search_policy:
            period = float(self.search_policy.get("observation_period_s", 1.0))
            elapsed = max(0.0, time.monotonic() - self._search_started_s)
            sample_index = math.floor((elapsed + 1e-9) / period)
            if self._search_sample_index is not None and sample_index <= self._search_sample_index:
                return []
            # Sample current poses once at the next available epoch. Delayed
            # ticks do not fabricate observations for any skipped epochs.
            self._search_sample_index = sample_index
            self.search_sample_time_s = sample_index * period
        vehicles = [self._kin[s["vehicle_id"]].state(False) for s in _fleet_spec()]
        detections = self._target.detections_for(vehicles, self._arena.towers, time.time())
        if self.search_policy:
            probability = self.search_policy["planner"]["detection_probability"]
            source_ids = sorted([*self._kin, *(t.vehicle_id for t in self._arena.towers)])
            draws = {source_id: self._search_rng.random() for source_id in source_ids}
            for detection in detections:
                detection.observation_id = f"local-search:{self._search_sample_index}:{detection.source_id}"
            return [d for d in detections if draws[d.source_id] < probability]
        return detections

    async def send_command(self, command: Command) -> None:
        if command.type == "look_at" and command.lat is not None and command.lon is not None:
            for tw in self._arena.towers:
                if tw.vehicle_id == command.vehicle_id:
                    tw.heading = wrap_heading(bearing_deg(tw.lat, tw.lon, command.lat, command.lon))
                    return
        kin = self._kin.get(command.vehicle_id)
        if kin:
            kin.apply(command)
        bridge = self._bridges.get(command.vehicle_id)
        if bridge and bridge.is_connected() and command.lat is not None and command.lon is not None:
            alt = command.alt if command.alt is not None else CRUISE_ALT.get(kin.vehicle_class if kin else "copter", 40.0)
            if kin and kin.vehicle_class == "plane":
                await bridge.send_plane_goto(command.lat, command.lon, alt)
            elif kin and kin.vehicle_class == "copter" and command.yaw_deg is not None:
                await bridge.send_goto(command.lat, command.lon, alt, yaw_deg=command.yaw_deg)
            else:
                await bridge.send_goto(command.lat, command.lon, alt)

    def comms_ok(self, vehicle_id: str) -> bool:
        return self._comms.get(vehicle_id, True)

    def truth_target(self) -> tuple[float, float] | None:
        return self._target.latlon()

    def set_profile(self, profile: str) -> None:
        self._target.reset(profile)

    async def _drain_mav(self, bridge) -> None:
        for _ in range(8):
            sample = await bridge.recv_sample(timeout=0.05)
            if sample is None:
                break

    def _advance_target(self) -> None:
        now = time.monotonic()
        dt = min(0.25, now - getattr(self, "_target_t", now))
        self._target.step(dt)
        self._target_t = now
