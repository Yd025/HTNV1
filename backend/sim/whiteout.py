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
import logging
import os
import time
from typing import Any

from mavlink_connection import MavlinkBridge
from sim.cameras import FLEET_CAMERAS, grab_jpeg
from sim.detector import detect_jpeg, project_hit
from sim.types import Arena, Command, Detection, TowerMount, VehicleClass, VehicleState

logger = logging.getLogger("overwatch.whiteout")

FORT_ROSS_LAT = 71.991960
FORT_ROSS_LON = -94.822428
FORT_ROSS_HALF_M = 3250.0
HEADING_OFFSET_DEG = -49.8

CRUISE_ALT = {"plane": 90.0, "copter": 40.0, "rover": 0.0, "tower": 0.0}
AIRBORNE_ALT = {"plane": 15.0, "copter": 8.0, "rover": 0.0, "tower": 0.0}


def _host() -> str:
    return os.getenv("ARCTIC_HOST") or ("host.docker.internal" if os.path.exists("/.dockerenv") else "127.0.0.1")


def _fleet_spec() -> list[dict[str, Any]]:
    h = _host()
    spec = [
        {
            "vehicle_id": "quadcopter",
            "vehicle_class": "copter",
            "conn": os.getenv("ARCTIC_QUAD", f"udpout:{h}:14550"),
            "fallback": "",
            "home": (71.995807, -94.839300),
        },
        {
            "vehicle_id": "fixed-wing",
            "vehicle_class": "plane",
            "conn": os.getenv("ARCTIC_PLANE", f"udpout:{h}:14560"),
            "fallback": "",
            "home": (71.998195, -94.841967),
        },
        {
            "vehicle_id": "tower-1",
            "vehicle_class": "tower",
            "conn": os.getenv("ARCTIC_TOWER1", f"udpout:{h}:14580"),
            "fallback": "",
            "home": (71.980671, -94.853711),
        },
        {
            "vehicle_id": "tower-2",
            "vehicle_class": "tower",
            "conn": os.getenv("ARCTIC_TOWER2", f"udpout:{h}:14590"),
            "fallback": "",
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
    __slots__ = ("phase", "last_cmd_at", "takeoff_sent", "arm_tries")

    def __init__(self) -> None:
        self.phase = "boot"
        self.last_cmd_at = 0.0
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
                TowerMount("tower-1", 71.980671, -94.853711, heading=0.0, fov_deg=60.0, range_m=2500.0),
                TowerMount("tower-2", 72.011778, -94.804721, heading=0.0, fov_deg=60.0, range_m=2500.0),
            ],
        )
        self._spec = _fleet_spec()
        self._bridges: dict[str, MavlinkBridge] = {}
        self._air: dict[str, _Air] = {s["vehicle_id"]: _Air() for s in self._spec}
        self._last_ok: dict[str, bool] = {s["vehicle_id"]: False for s in self._spec}
        self._homes = {s["vehicle_id"]: s["home"] for s in self._spec}
        self._poses: dict[str, VehicleState] = {}
        self._attitude: dict[str, tuple[float, float]] = {}
        self._dets: list[Detection] = []
        self._cam_task: asyncio.Task[None] | None = None

    async def connect(self) -> None:
        import geo as geo_mod

        geo_mod.ORIGIN_LAT = FORT_ROSS_LAT
        geo_mod.ORIGIN_LON = FORT_ROSS_LON
        geo_mod.ARENA_HALF_M = FORT_ROSS_HALF_M
        if self._cam_task is None or self._cam_task.done():
            self._cam_task = asyncio.create_task(self._camera_loop(), name="whiteout-cameras")
        await asyncio.gather(*(self._connect_one(s) for s in self._spec))
        await asyncio.sleep(0.4)
        logger.info("WhiteoutAdapter MAVLink fleet host=%s cameras=%s", _host(), len(FLEET_CAMERAS))

    async def close(self) -> None:
        task, self._cam_task = self._cam_task, None
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        bridges, self._bridges = self._bridges, {}
        self._dets = []
        self._poses.clear()
        self._attitude.clear()
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
            if mav_ok:
                await self._drain(bridge)
                snap = bridge.snapshot()
            self._last_ok[vid] = mav_ok
            lat = snap.get("lat") if snap.get("lat") is not None else home_lat
            lon = snap.get("lon") if snap.get("lon") is not None else home_lon
            vclass: VehicleClass = spec["vehicle_class"]
            out.append(
                VehicleState(
                    vehicle_id=vid,
                    sysid=int(snap.get("sysid") or 0),
                    vehicle_class=vclass,
                    lat=float(lat),
                    lon=float(lon),
                    alt=float(snap.get("alt") or (12.0 if vclass == "tower" else 0.0)),
                    heading=float(snap.get("heading") or 0.0),
                    groundspeed=float(snap.get("groundspeed") or 0.0),
                    battery_remaining=float(snap.get("battery_remaining") or 100.0),
                    armed=bool(snap.get("armed")),
                    mode=str(snap.get("mode") or "—"),
                    connected=mav_ok,
                    mavlink=mav_ok,
                    role="cue" if vclass == "tower" else None,
                )
            )
            self._poses[vid] = out[-1]
            if mav_ok:
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
        return [c.as_dict() for c in FLEET_CAMERAS]

    async def send_command(self, command: Command) -> None:
        spec = next((s for s in self._spec if s["vehicle_id"] == command.vehicle_id), None)
        bridge = self._bridges.get(command.vehicle_id)
        if spec is None or bridge is None or not bridge.is_connected():
            return
        ready = await self._advance(spec, bridge)
        vclass: str = spec["vehicle_class"]
        if vclass == "tower":
            if command.type == "look_at" and command.lat is not None and command.lon is not None:
                await bridge.set_roi(command.lat, command.lon, command.alt or 0.0)
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
                return
            except ConnectionError as exc:
                await bridge.close()
                logger.warning("MAVLink %s %s failed: %s", vid, conn_str, exc)
            except BaseException:
                await bridge.close()
                raise
        logger.error("MAVLink %s unreachable — asset will idle", vid)

    async def _camera_loop(self) -> None:
        import httpx

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
        found: list[Detection] = []
        frames = await asyncio.gather(*(grab_jpeg(spec, client) for spec in FLEET_CAMERAS))
        for spec, jpeg in zip(FLEET_CAMERAS, frames, strict=True):
            if not jpeg:
                continue
            hit = await asyncio.to_thread(detect_jpeg, jpeg)
            if hit is None:
                continue
            pose = self._poses.get(spec.vehicle_id)
            if pose is None:
                continue
            roll, pitch = self._attitude.get(spec.vehicle_id, (0.0, 0.0))
            det = project_hit(hit, spec, pose, now, roll_rad=roll, pitch_rad=pitch)
            if det:
                found.append(det)
                logger.info(
                    "camera hit %s conf=%.2f rng=%.0fm lat=%.5f lon=%.5f",
                    spec.vehicle_id,
                    det.confidence,
                    det.range_m or 0.0,
                    det.lat,
                    det.lon,
                )
        self._dets = found

    async def _drain(self, bridge: MavlinkBridge) -> None:
        for _ in range(16):
            sample = await bridge.recv_sample(timeout=0.0)
            if sample is None:
                break

    async def _advance(self, spec: dict[str, Any], bridge: MavlinkBridge) -> bool:
        """One arm/takeoff step. Returns True when GUIDED gotos are legal."""
        vclass: str = spec["vehicle_class"]
        if vclass == "tower":
            return True
        air = self._air[spec["vehicle_id"]]
        now = time.monotonic()
        if now - air.last_cmd_at < 1.8:
            return air.phase == "ready"
        await self._drain(bridge)
        snap = bridge.snapshot()
        mode = str(snap.get("mode") or "").upper()
        armed = bool(snap.get("armed"))
        alt = float(snap.get("alt") or 0.0)
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
            if not any(tag in mode for tag in ("GUIDED", "TAKEOFF", "AUTO", "FBWA")):
                await bridge.set_mode("GUIDED")
                air.last_cmd_at = now
                return False
            if not armed:
                air.arm_tries += 1
                await bridge.arm(True, force=air.arm_tries >= 2)
                air.last_cmd_at = now
                return False
            if alt < need_alt and not air.takeoff_sent:
                await bridge.set_mode("TAKEOFF")
                air.takeoff_sent = True
                air.last_cmd_at = now
                return False
            if alt >= need_alt:
                if "GUIDED" not in mode:
                    await bridge.set_mode("GUIDED")
                    air.last_cmd_at = now
                air.phase = "ready"
                return True
            return False

        # copter
        if "GUIDED" not in mode:
            await bridge.set_mode("GUIDED")
            air.last_cmd_at = now
            return False
        if not armed:
            air.arm_tries += 1
            await bridge.arm(True, force=air.arm_tries >= 2)
            air.last_cmd_at = now
            return False
        if alt < need_alt and not air.takeoff_sent:
            await bridge.takeoff(CRUISE_ALT["copter"])
            air.takeoff_sent = True
            air.last_cmd_at = now
            return False
        if alt >= need_alt:
            air.phase = "ready"
            return True
        return False
