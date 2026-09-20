"""WHITEOUT / arctic-sim adapter.

Talks MAVLink to the four official assets on the host (or host.docker.internal
from Compose). Does not invent HTTP /vehicles — that path is not in arctic-sim.

  quadcopter  tcp:5760 / udpout:14550
  fixed-wing  tcp:5770 / udpout:14560
  tower-1     tcp:5790 / udpout:14580
  tower-2     tcp:5800 / udpout:14590

Arm/takeoff is a per-tick state machine so the 10 Hz loop never blocks.
Cameras run on a background grabber; poll_detections() drains each scan once.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import math
import os
import time
from typing import Any
from dataclasses import replace

from geo import bearing_deg, haversine_m
from mavlink_connection import MavlinkBridge
from sim.cameras import FLEET_CAMERAS, MjpegTap, grab_jpeg
from sim.detector import project_hit
from sim.types import Arena, Command, Detection, TowerMount, VehicleClass, VehicleState
from vision.vessel import CameraDetector, DetectorUnavailable

logger = logging.getLogger("overwatch.whiteout")

FORT_ROSS_LAT = 71.991960
FORT_ROSS_LON = -94.822428
FORT_ROSS_HALF_M = 3250.0
HEADING_OFFSET_DEG = -49.8

CRUISE_ALT = {"plane": 90.0, "copter": 40.0, "rover": 0.0, "tower": 0.0}
AIRBORNE_ALT = {"plane": 15.0, "copter": 8.0, "rover": 0.0, "tower": 0.0}
# Camera optical centre AMSL from fort_ross.world pose.z + HEAD_Z (terrain/tower.py).
CAM_ALT_MSL = {"tower-1": 119.5, "tower-2": 229.3}
PITCH_MIN_DEG = -30.0
PITCH_MAX_DEG = 45.0
CAM_FAR_M = 1480.0
# Fort Ross: vessel is ~5° down from either hilltop. Steeper than this
# is the near slope (tower-2 sits 229 m over rock that fills a 60° EO).
SEA_MAX_DOWN_DEG = 8.5


def _wrap180(deg: float) -> float:
    return ((deg + 180.0) % 360.0) - 180.0


def _yaw_pwm(want_true: float) -> int:
    """Open-loop pan: PWM 1000..2000 → pan −π..+π from grid east (world +X)."""
    grid_east_true = (HEADING_OFFSET_DEG + 90.0) % 360.0
    pan = _wrap180(grid_east_true - want_true)
    cmd = max(0.0, min(1.0, pan / 360.0 + 0.5))
    return int(1000 + cmd * 1000)


def _pitch_pwm(pitch_deg: float) -> int:
    """Open-loop tilt: cmd 0 = PITCH_MIN (−30 down), cmd 1 = PITCH_MAX (+45 up)."""
    clamped = max(PITCH_MIN_DEG, min(PITCH_MAX_DEG, pitch_deg))
    cmd = (clamped - PITCH_MIN_DEG) / (PITCH_MAX_DEG - PITCH_MIN_DEG)
    return int(1000 + cmd * 1000)


def _host() -> str:
    return os.getenv("ARCTIC_HOST") or ("host.docker.internal" if os.path.exists("/.dockerenv") else "127.0.0.1")


def _fleet_spec() -> list[dict[str, Any]]:
    h = _host()
    spec = [
        {
            "vehicle_id": "quadcopter",
            "vehicle_class": "copter",
            "conn": os.getenv("ARCTIC_QUAD", f"udpout:{h}:14550"),
            "fallback": f"udpout:{h}:14551",
            "home": (71.995807, -94.839300),
        },
        {
            "vehicle_id": "fixed-wing",
            "vehicle_class": "plane",
            "conn": os.getenv("ARCTIC_PLANE", f"udpout:{h}:14560"),
            "fallback": f"udpout:{h}:14561",
            "home": (71.998195, -94.841967),
            # Strip heading from arctic-sim ASSET_3 `>lat,lon`.
            "takeoff_aim": (71.997790, -94.846245),
        },
        {
            "vehicle_id": "tower-1",
            "vehicle_class": "tower",
            "conn": os.getenv("ARCTIC_TOWER1", f"udpout:{h}:14580"),
            "fallback": f"udpout:{h}:14581",
            "home": (71.980671, -94.853711),
        },
        {
            "vehicle_id": "tower-2",
            "vehicle_class": "tower",
            "conn": os.getenv("ARCTIC_TOWER2", f"udpout:{h}:14590"),
            "fallback": f"udpout:{h}:14591",
            "home": (72.011778, -94.804721),
        },
    ]
    rover = os.getenv("ARCTIC_ROVER", "").strip()
    if rover:
        spec.append(
            {
                "vehicle_id": "rover",
                "vehicle_class": "rover",
                "conn": rover,
                "fallback": f"udpout:{h}:14600",
                "home": (71.991960, -94.822428),
            }
        )
    return spec


class _Air:
    __slots__ = ("phase", "last_cmd_at", "last_takeoff_at", "takeoff_sent", "arm_tries")

    def __init__(self) -> None:
        self.phase = "boot"
        self.last_cmd_at = 0.0
        self.last_takeoff_at = 0.0
        self.takeoff_sent = False
        self.arm_tries = 0


class WhiteoutAdapter:
    """Arctic-sim MAVLink swap. Same Command contract as LocalSitlAdapter."""

    name = "whiteout"
    mode = "live"

    def __init__(self) -> None:
        self._arena = Arena(
            origin_lat=FORT_ROSS_LAT,
            origin_lon=FORT_ROSS_LON,
            half_m=FORT_ROSS_HALF_M,
            heading_offset_deg=HEADING_OFFSET_DEG,
            towers=[
                TowerMount("tower-1", 71.980671, -94.853711, heading=0.0, fov_deg=60.0, range_m=1500.0),
                TowerMount("tower-2", 72.011778, -94.804721, heading=0.0, fov_deg=60.0, range_m=1500.0),
            ],
        )
        self._spec = _fleet_spec()
        self._bridges: dict[str, MavlinkBridge] = {}
        self._air: dict[str, _Air] = {s["vehicle_id"]: _Air() for s in self._spec}
        self._last_ok: dict[str, bool] = {s["vehicle_id"]: False for s in self._spec}
        self._homes = {s["vehicle_id"]: s["home"] for s in self._spec}
        self._poses: dict[str, VehicleState] = {}
        self._attitude: dict[str, tuple[float, float]] = {}
        self._alt_msl: dict[str, float] = {}
        self._dets: list[Detection] = []
        self._cam_task: asyncio.Task[None] | None = None
        self._look: dict[str, tuple[float, float]] = {}
        self._tower_cmd_at: dict[str, float] = {}
        self._tower_manual: set[str] = set()
        self._taps = MjpegTap()
        self._detector = CameraDetector()
        self._frame_ids: dict[str, str] = {}
        self._camera_status: dict[str, dict[str, Any]] = {}
        self._reconnecting: set[str] = set()
        self._reconnect_tasks: dict[str, asyncio.Task[None]] = {}
        self._closed = False

    async def connect(self) -> None:
        # Fail configured model errors before connecting/arming any vehicle.
        await asyncio.to_thread(self._detector.initialize)
        import geo as geo_mod

        self._closed = False
        geo_mod.ORIGIN_LAT = FORT_ROSS_LAT
        geo_mod.ORIGIN_LON = FORT_ROSS_LON
        geo_mod.ARENA_HALF_M = FORT_ROSS_HALF_M
        if self._cam_task is None or self._cam_task.done():
            self._cam_task = asyncio.create_task(self._camera_loop(), name="whiteout-cameras")
        await asyncio.gather(*(self._connect_one(s) for s in self._spec))
        await asyncio.sleep(0.4)
        logger.info("WhiteoutAdapter MAVLink fleet host=%s cameras=%s", _host(), len(FLEET_CAMERAS))

    async def close(self) -> None:
        self._closed = True
        task, self._cam_task = self._cam_task, None
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        reconnect_tasks, self._reconnect_tasks = self._reconnect_tasks, {}
        for reconnect in reconnect_tasks.values():
            reconnect.cancel()
        await asyncio.gather(*reconnect_tasks.values(), return_exceptions=True)
        self._reconnecting.clear()
        await self._taps.close()
        bridges, self._bridges = self._bridges, {}
        self._dets = []
        self._poses.clear()
        self._attitude.clear()
        self._alt_msl.clear()
        self._frame_ids.clear()
        self._look.clear()
        self._tower_cmd_at.clear()
        self._tower_manual.clear()
        for vid in self._last_ok:
            self._last_ok[vid] = False
        self._air = {s["vehicle_id"]: _Air() for s in self._spec}
        results = await asyncio.gather(*(bridge.close() for bridge in bridges.values()), return_exceptions=True)
        for result in results:
            if isinstance(result, Exception):
                logger.warning("WHITEOUT bridge cleanup failed: %s", result)

    def arena(self) -> Arena:
        return self._arena

    async def list_vehicles(self) -> list[VehicleState]:
        out: list[VehicleState] = []
        for spec in self._spec:
            vid = spec["vehicle_id"]
            bridge = self._bridges.get(vid)
            home_lat, home_lon = self._homes[vid]
            snap: dict[str, Any] = {}
            mav_ok = bool(bridge and bridge.is_connected())
            if not self._closed and not mav_ok and vid not in self._reconnecting:
                self._reconnecting.add(vid)
                self._reconnect_tasks[vid] = asyncio.create_task(self._reconnect(spec))
            if mav_ok:
                # The bridge receive worker owns transport reads. Taking its
                # cached snapshot never waits on a command/transport lock.
                snap = bridge.snapshot()
            self._last_ok[vid] = mav_ok
            lat = snap.get("lat") if snap.get("lat") is not None else home_lat
            lon = snap.get("lon") if snap.get("lon") is not None else home_lon
            vclass: VehicleClass = spec["vehicle_class"]
            look = self._look.get(vid)
            if vclass == "tower":
                alt = CAM_ALT_MSL.get(vid, 120.0)
                heading = look[0] if look else float(snap.get("heading") or 0.0)
            else:
                alt = float(snap.get("alt") or 0.0)
                heading = float(snap.get("heading") or 0.0)
            out.append(
                VehicleState(
                    vehicle_id=vid,
                    sysid=int(snap.get("sysid") or 0),
                    vehicle_class=vclass,
                    lat=float(lat),
                    lon=float(lon),
                    alt=alt,
                    heading=heading,
                    groundspeed=float(snap.get("groundspeed") or 0.0),
                    battery_remaining=float(snap.get("battery_remaining") or 100.0),
                    armed=bool(snap.get("armed")),
                    mode=str(snap.get("mode") or "—"),
                    connected=mav_ok,
                    mavlink=mav_ok,
                    role="cue" if vclass == "tower" else None,
                    alt_msl=float(snap["alt_msl"]) if snap.get("alt_msl") is not None else None,
                )
            )
            self._poses[vid] = out[-1]
            if mav_ok:
                if snap.get("alt_msl") is not None:
                    self._alt_msl[vid] = float(snap["alt_msl"])
                self._attitude[vid] = (
                    float(snap.get("roll") or 0.0),
                    float(snap.get("pitch") or 0.0),
                )
        return out

    async def poll_detections(self) -> list[Detection]:
        now = time.time()
        detections, self._dets = self._dets, []
        return [d for d in detections if 0.0 <= now - d.timestamp < 4.0]

    def camera_catalog(self) -> list[dict[str, Any]]:
        return [{**c.as_dict(), "perception": self._detector.status(),
                 "observation": self._camera_status.get(c.vehicle_id, {"state": "waiting_for_frame"}),
                 "projection": "approximate flat sea; receipt-time pose; commanded tower/gimbal attitude"}
                for c in FLEET_CAMERAS]

    async def send_command(self, command: Command) -> None:
        spec = next((s for s in self._spec if s["vehicle_id"] == command.vehicle_id), None)
        bridge = self._bridges.get(command.vehicle_id)
        if spec is None or bridge is None or not bridge.is_connected():
            return
        ready = await self._advance(spec, bridge)
        vclass: str = spec["vehicle_class"]
        if vclass == "tower":
            if command.lat is not None and command.lon is not None:
                await self._slew_tower(command.vehicle_id, bridge, command.lat, command.lon, command.alt or 0.0)
            elif command.type in {"search_sector", "hold"}:
                await bridge.set_mode("SCAN")
            return
        if not ready:
            return
        if command.lat is None or command.lon is None:
            return
        alt = command.alt if command.alt is not None else CRUISE_ALT.get(vclass, 40.0)
        if vclass == "rover":
            alt = 0.0
        if vclass == "plane":
            await bridge.send_plane_goto(command.lat, command.lon, alt)
        elif vclass == "copter" and command.yaw_deg is not None:
            await bridge.send_goto(command.lat, command.lon, alt, yaw_deg=command.yaw_deg)
        else:
            await bridge.send_goto(command.lat, command.lon, alt)

    def comms_ok(self, vehicle_id: str) -> bool:
        return self._last_ok.get(vehicle_id, False)

    def truth_target(self) -> tuple[float, float] | None:
        return None

    async def _connect_one(self, spec: dict[str, Any]) -> None:
        vid = spec["vehicle_id"]
        for conn_str in (spec["conn"], spec.get("fallback")):
            if not conn_str:
                continue
            bridge = MavlinkBridge(conn_str=conn_str, vehicle_id=vid)
            try:
                await bridge.connect(timeout=8.0)
                self._bridges[vid] = bridge
                self._last_ok[vid] = True
                logger.info("MAVLink %s via %s", vid, conn_str)
                if spec["vehicle_class"] in {"copter", "plane"}:
                    await bridge.set_param("ARMING_CHECK", 0)
                    if spec["vehicle_class"] == "copter":
                        await bridge.set_param("FS_CRASH_CHECK", 0)
                    if spec["vehicle_class"] == "plane":
                        await bridge.set_param("TERRAIN_ENABLE", 0)
                        await bridge.set_param("TKOFF_THR_MINACC", 0)
                return
            except ConnectionError as exc:
                await bridge.close()
                logger.warning("MAVLink %s %s failed: %s", vid, conn_str, exc)
            except BaseException:
                await bridge.close()
                raise
        logger.error("MAVLink %s unreachable — asset will idle", vid)

    async def _reconnect(self, spec: dict[str, Any]) -> None:
        try:
            previous = self._bridges.pop(spec["vehicle_id"], None)
            if previous is not None:
                await previous.close()
            await self._connect_one(spec)
        finally:
            self._reconnecting.discard(spec["vehicle_id"])
            self._reconnect_tasks.pop(spec["vehicle_id"], None)

    async def _slew_tower(self, vid: str, bridge: MavlinkBridge, lat: float, lon: float, alt: float) -> None:
        """Open-loop pan/tilt. EKF heading is the mast, not the moving head."""
        now = time.monotonic()
        if now - self._tower_cmd_at.get(vid, 0.0) < 0.70:
            return
        self._tower_cmd_at[vid] = now
        pose = self._poses.get(vid)
        if pose is None:
            return
        if vid not in self._tower_manual:
            await bridge.set_mode("MANUAL")
            self._tower_manual.add(vid)
        want = bearing_deg(pose.lat, pose.lon, lat, lon)
        true_rng = max(40.0, haversine_m(pose.lat, pose.lon, lat, lon))
        cam_alt = CAM_ALT_MSL.get(vid, max(float(pose.alt or 0.0), 80.0))
        want_pitch = math.degrees(math.atan2((alt or 0.0) - cam_alt, true_rng))
        if (alt or 0.0) < 2.0:
            want_pitch = max(want_pitch, -SEA_MAX_DOWN_DEG)
        if vid == "tower-2":
            # Origin/west bearings hit the pad. Ship lane is the south gap
            # (pan ≈ −70°, true ≈ 110°) with the head 8° above the crest.
            if 150.0 <= want <= 260.0:
                want = 110.0
            want_pitch = 8.0
        rng = min(CAM_FAR_M, true_rng)
        yaw = _yaw_pwm(want)
        pitch = _pitch_pwm(want_pitch)
        self._look[vid] = (want, want_pitch)
        # MANUAL writes RC every frame; a one-shot DO_SET_SERVO is overwritten.
        await bridge.rc_override(yaw, pitch)
        await bridge.set_servo(1, yaw)
        await bridge.set_servo(2, pitch)
        logger.info(
            "tower slew %s want=%.0f pitch=%.1f yaw_pwm=%s pitch_pwm=%s rng=%.0f",
            vid, want, want_pitch, yaw, pitch, rng,
        )

    async def _camera_loop(self) -> None:
        import httpx

        self._taps.start(FLEET_CAMERAS)
        timeout = httpx.Timeout(1.6, connect=0.6)
        async with httpx.AsyncClient(timeout=timeout) as client:
            while True:
                try:
                    await self._scan_cameras(client)
                except asyncio.CancelledError:
                    raise
                except Exception:
                    logger.exception("camera scan failed")
                await asyncio.sleep(0.7)

    async def _scan_cameras(self, client: Any) -> None:
        now = time.time()
        self._dets = [det for det in self._dets if 0 <= now - det.timestamp < 4.0][-256:]
        # Fixed sensors provide the initial cue; publish each completed camera
        # immediately instead of holding observations behind slower inference.
        for spec in sorted(FLEET_CAMERAS, key=lambda camera: not camera.vehicle_id.startswith("tower")):
            frame = self._taps.get_frame(spec.vehicle_id)
            if frame is None:
                jpeg = await grab_jpeg(spec, client)
                if not jpeg:
                    continue
                # Snapshot HTTP carries no frame metadata; identical bytes are
                # conservatively one observation until the stream is available.
                frame = (jpeg, time.time(), "snapshot:" + hashlib.sha256(jpeg).hexdigest()[:24])
            jpeg, received_at, frame_id = frame
            if not 0 <= time.time() - received_at <= 4.0:
                self._camera_status[spec.vehicle_id] = {"state": "stale_frame"}
                continue
            if self._frame_ids.get(spec.vehicle_id) == frame_id:
                continue
            self._frame_ids[spec.vehicle_id] = frame_id
            pose = self._poses.get(spec.vehicle_id)
            if pose is None or not self._last_ok.get(spec.vehicle_id, False):
                self._camera_status[spec.vehicle_id] = {"state": "pose_unavailable"}
                continue
            # Freeze own-sensor telemetry before inference yields to the loop.
            alt_msl = CAM_ALT_MSL.get(spec.vehicle_id, self._alt_msl.get(spec.vehicle_id))
            if alt_msl is None:
                self._camera_status[spec.vehicle_id] = {"state": "sea_height_unavailable"}
                continue
            pose = replace(pose, alt=alt_msl)
            look = self._look.get(spec.vehicle_id)
            if look:
                pose = replace(pose, heading=look[0])
                roll, pitch = 0.0, math.radians(look[1])
            else:
                roll, pitch = self._attitude.get(spec.vehicle_id, (0.0, 0.0))
            try:
                hits = await asyncio.to_thread(self._detector.detect_jpeg, jpeg)
            except DetectorUnavailable as exc:
                self._camera_status[spec.vehicle_id] = {"state": "detector_unavailable", "error": str(exc)}
                logger.error("camera detector unavailable: %s", exc)
                continue
            # Inference may finish after the observation freshness budget.
            if time.time() - received_at > 4.0:
                self._camera_status[spec.vehicle_id] = {"state": "inference_too_slow"}
                continue
            projected = 0
            for index, hit in enumerate(hits):
                det = project_hit(hit, spec, pose, received_at, roll_rad=roll, pitch_rad=pitch)
                if det:
                    det.frame_id = frame_id
                    det.observation_id = f"{frame_id}:box:{index}"
                    self._dets.append(det)
                    if len(self._dets) > 256:
                        del self._dets[:-256]
                    projected += 1
            self._camera_status[spec.vehicle_id] = {"state": "observed" if projected else "no_localized_vessel",
                "frame_id": frame_id, "received_at": received_at, "boxes": len(hits), "localized": projected,
                "quality": self._detector.last_frame.get("quality")}

    async def _advance(self, spec: dict[str, Any], bridge: MavlinkBridge) -> bool:
        """One arm/takeoff step. Returns True when GUIDED gotos are legal."""
        vclass: str = spec["vehicle_class"]
        if vclass == "tower":
            return True
        air = self._air[spec["vehicle_id"]]
        now = time.monotonic()
        snap = bridge.snapshot()
        alt_now = float(snap.get("alt") or 0.0)
        # Belly X8: RC override expires in ~3 s. Keep the pusher lit
        # every tick of the ground roll or TAKEOFF/NAV_TAKEOFF never moves.
        if vclass == "plane" and alt_now < AIRBORNE_ALT["plane"] and snap.get("armed"):
            # GUIDED ignores RC throttle (NAV_TAKEOFF ACK 4). FBWA uses the sticks.
            gs_now = float(snap.get("groundspeed") or 0.0)
            pitch_stick = 1620 if gs_now >= 9.0 else 1500
            await bridge.rc_override(1500, pitch_stick, 1900, 1500)
        if now - air.last_cmd_at < 1.8:
            return air.phase == "ready"
        mode = str(snap.get("mode") or "").upper()
        armed = bool(snap.get("armed"))
        alt = alt_now
        need_alt = AIRBORNE_ALT[vclass]

        logger.info(
            "advance %s phase=%s mode=%s armed=%s alt=%.1f",
            spec["vehicle_id"],
            air.phase,
            mode or "?",
            armed,
            alt,
        )

        if vclass == "rover":
            if not armed:
                await bridge.set_mode("GUIDED")
                air.arm_tries += 1
                await bridge.arm(True, force=air.arm_tries >= 2)
                air.last_cmd_at = now
                return False
            air.phase = "ready"
            return True

        if vclass == "plane":
            gs = float(snap.get("groundspeed") or 0.0)
            if not armed:
                await bridge.set_mode("FBWA")
                air.arm_tries += 1
                await bridge.arm(True, force=True)
                air.last_cmd_at = now
                return False
            if alt < need_alt:
                # FBWA rolls the belly; once it has energy, GUIDED holds the climb.
                if alt >= 6.0 and gs >= 8.0:
                    await bridge.rc_override(0, 0, 0, 0)
                    await bridge.set_mode("GUIDED")
                    aim = spec.get("takeoff_aim") or spec.get("home")
                    if aim:
                        await bridge.send_plane_goto(aim[0], aim[1], 60.0)
                    air.last_cmd_at = now
                    return False
                if "FBWA" not in mode:
                    await bridge.set_mode("FBWA")
                    air.last_cmd_at = now
                    return False
                air.takeoff_sent = True
                air.last_cmd_at = now
                return False
            await bridge.rc_override(0, 0, 0, 0)
            if "GUIDED" not in mode:
                await bridge.set_mode("GUIDED")
                air.last_cmd_at = now
            air.phase = "ready"
            return True

        # copter
        if "GUIDED" not in mode:
            await bridge.set_mode("GUIDED")
            air.last_cmd_at = now
            return False
        if not armed:
            air.arm_tries += 1
            await bridge.arm(True, force=True)
            air.last_cmd_at = now
            return False
        if alt < need_alt:
            if not air.takeoff_sent or (now - air.last_takeoff_at) >= 4.0:
                await bridge.takeoff(CRUISE_ALT["copter"])
                air.takeoff_sent = True
                air.last_takeoff_at = now
                air.last_cmd_at = now
            return False
        air.phase = "ready"
        return True
