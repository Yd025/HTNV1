"""MAVLink companion-computer bridge for WHITEOUT.

Responsibility is strictly command + telemetry routing:
  sensor messages in  ->  structured samples
  intercept setpoints  ->  actuation commands out

Do not put Kalman filters, EKF, or other physical estimators in this module.
ArduPilot already runs those on the vehicle; we coordinate the fleet.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any

from pymavlink import mavutil

logger = logging.getLogger("overwatch.mavlink")

MAVLINK_CONNECTION = os.getenv("MAVLINK_CONNECTION", "tcp:sitl:5760")
VEHICLE_ID = os.getenv("VEHICLE_ID", "copter-1")
CONNECT_RETRY_SEC = float(os.getenv("MAVLINK_RETRY_SEC", "3"))

# Ignore velocity/accel/yaw; send only lat/lon/alt (see MAVLink type_mask).
GOTO_TYPE_MASK = 0b0000_111_111_000


def _now() -> datetime:
    return datetime.now(timezone.utc)


class MavlinkBridge:
    """TCP client to ArduPilot SITL (`tcp:sitl:5760` on the overwatch network)."""

    def __init__(self, conn_str: str = MAVLINK_CONNECTION, vehicle_id: str = VEHICLE_ID):
        self.conn_str = conn_str
        self.vehicle_id = vehicle_id
        self.conn: mavutil.mavfile | None = None
        self.connected = False
        self.last_heartbeat_at: float | None = None
        self._state: dict[str, Any] = {
            "vehicle_id": vehicle_id,
            "sysid": None,
            "lat": None,
            "lon": None,
            "alt": None,
            "heading": None,
            "groundspeed": None,
            "roll": None,
            "pitch": None,
            "battery_remaining": None,
            "armed": False,
            "mode": None,
        }
        self._io_lock = asyncio.Lock()
        self._last_gcs_hb = 0.0
        self._pump_task: asyncio.Task[None] | None = None

    def is_connected(self) -> bool:
        return self.connected and self.conn is not None

    def snapshot(self) -> dict[str, Any]:
        return dict(self._state)

    async def connect(self, timeout: float = 30.0) -> None:
        """Retry until SITL accepts the TCP GCS connection."""
        deadline = time.monotonic() + timeout
        last_err: Exception | None = None
        while time.monotonic() < deadline:
            try:
                self.conn = await asyncio.to_thread(self._connect_blocking)
                self.connected = True
                if int(getattr(self.conn, "target_component", 0) or 0) == 0:
                    self.conn.target_component = 1
                if self._pump_task is None or self._pump_task.done():
                    self._pump_task = asyncio.create_task(self._pump(), name=f"mav-pump-{self.vehicle_id}")
                logger.info("MAVLink connected to %s sysid=%s", self.conn_str, self.conn.target_system)
                return
            except Exception as exc:  # noqa: BLE001 — SITL boot is messy
                last_err = exc
                logger.warning("MAVLink connect to %s failed (%s); retrying", self.conn_str, exc)
                await asyncio.sleep(CONNECT_RETRY_SEC)
        raise ConnectionError(f"Could not reach SITL at {self.conn_str}: {last_err}")

    def _connect_blocking(self) -> mavutil.mavfile:
        conn = mavutil.mavlink_connection(self.conn_str, autoreconnect=True)
        # Arctic-sim GCS ports are MAVProxy udpin — client must transmit first.
        if self.conn_str.startswith("udpout"):
            try:
                conn.write(b"\x00")
            except Exception:
                pass
        try:
            conn.mav.heartbeat_send(
                mavutil.mavlink.MAV_TYPE_GCS,
                mavutil.mavlink.MAV_AUTOPILOT_INVALID,
                0, 0, 0,
            )
        except Exception:
            pass
        hb = conn.wait_heartbeat(timeout=5)
        if hb is None and int(getattr(conn, "target_system", 0) or 0) == 0:
            try:
                conn.close()
            except Exception:
                pass
            raise ConnectionError(f"no HEARTBEAT on {self.conn_str}")
        self._seed_from_conn(conn)
        try:
            conn.mav.request_data_stream_send(
                conn.target_system,
                conn.target_component,
                mavutil.mavlink.MAV_DATA_STREAM_ALL,
                4,
                1,
            )
        except Exception:
            logger.warning("request_data_stream failed on %s", self.conn_str)
        # Prefer SET_MESSAGE_INTERVAL — request_data_stream is ignored by some SITL builds.
        for msgid, hz in (
            (mavutil.mavlink.MAVLINK_MSG_ID_HEARTBEAT, 2),
            (mavutil.mavlink.MAVLINK_MSG_ID_GLOBAL_POSITION_INT, 4),
            (mavutil.mavlink.MAVLINK_MSG_ID_VFR_HUD, 4),
            (mavutil.mavlink.MAVLINK_MSG_ID_SYS_STATUS, 1),
        ):
            try:
                conn.mav.command_long_send(
                    conn.target_system,
                    conn.target_component,
                    mavutil.mavlink.MAV_CMD_SET_MESSAGE_INTERVAL,
                    0,
                    msgid,
                    int(1_000_000 / hz),
                    0, 0, 0, 0, 0,
                )
            except Exception:
                break
        return conn

    async def _pump(self) -> None:
        while self.connected and self.conn is not None:
            try:
                await self.recv_sample(timeout=0.2)
            except asyncio.CancelledError:
                raise
            except Exception:
                await asyncio.sleep(0.2)

    def _maybe_gcs_heartbeat(self) -> None:
        if self.conn is None:
            return
        now = time.monotonic()
        if now - self._last_gcs_hb < 1.0:
            return
        try:
            self.conn.mav.heartbeat_send(
                mavutil.mavlink.MAV_TYPE_GCS,
                mavutil.mavlink.MAV_AUTOPILOT_INVALID,
                0, 0, 0,
            )
            self._last_gcs_hb = now
        except Exception:
            pass

    def _seed_from_conn(self, conn: mavutil.mavfile) -> None:
        self._state["sysid"] = conn.target_system
        self._state["mode"] = getattr(conn, "flightmode", None) or self._state["mode"]
        hb = getattr(conn, "messages", {}).get("HEARTBEAT")
        if hb is not None:
            self._state["armed"] = bool(hb.base_mode & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED)
            self._state["mode"] = self._decode_mode(conn, hb)

    async def recv_sample(self, timeout: float = 1.0) -> dict[str, Any] | None:
        """Pull the next interesting message and fold it into the routed sample."""
        if self.conn is None:
            return None
        async with self._io_lock:
            self._maybe_gcs_heartbeat()
            if timeout <= 0:
                msg = await asyncio.to_thread(self.conn.recv_match, blocking=False)
            else:
                msg = await asyncio.to_thread(self.conn.recv_match, blocking=True, timeout=timeout)
        if msg is None:
            return None
        msg_type = msg.get_type()
        if msg_type == "BAD_DATA":
            return None
        self._ingest_message(msg_type, msg)
        sample = self.snapshot()
        sample["timestamp"] = _now()
        sample["msg_type"] = msg_type
        sample["payload"] = _safe_to_dict(msg)
        return sample

    def _ingest_message(self, msg_type: str, msg: Any) -> None:
        if msg_type == "HEARTBEAT":
            self.last_heartbeat_at = time.monotonic()
            self._state["sysid"] = getattr(self.conn, "target_system", None)
            self._state["armed"] = bool(msg.base_mode & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED)
            self._state["mode"] = self._decode_mode(self.conn, msg) if self.conn else str(msg.custom_mode)
        elif msg_type == "COMMAND_ACK":
            logger.info(
                "ACK %s result=%s on %s",
                getattr(msg, "command", "?"),
                getattr(msg, "result", "?"),
                self.vehicle_id,
            )
        elif msg_type == "STATUSTEXT":
            text = getattr(msg, "text", "") or ""
            if text:
                logger.info("STATUSTEXT %s: %s", self.vehicle_id, text)
        elif msg_type == "GLOBAL_POSITION_INT":
            self._state["lat"] = msg.lat / 1e7
            self._state["lon"] = msg.lon / 1e7
            self._state["alt"] = msg.relative_alt / 1000.0
            self._state["heading"] = (msg.hdg / 100.0) if msg.hdg != 65535 else self._state["heading"]
        elif msg_type == "VFR_HUD":
            self._state["groundspeed"] = float(msg.groundspeed)
            self._state["heading"] = float(msg.heading)
            # VFR_HUD.alt is often AMSL. Prefer GLOBAL_POSITION_INT.relative_alt.
            if self._state["alt"] is None and getattr(msg, "alt", None) is not None:
                self._state["alt"] = float(msg.alt)
        elif msg_type == "ATTITUDE":
            self._state["roll"] = float(msg.roll)
            self._state["pitch"] = float(msg.pitch)
        elif msg_type == "SYS_STATUS":
            self._state["battery_remaining"] = float(msg.battery_remaining)

    async def apply_actuation(self, commands: list[dict[str, Any]]) -> None:
        """Translate fused intercept intents into MAVLink setpoints. No estimation."""
        if self.conn is None:
            logger.warning("Dropping actuation; MAVLink is down")
            return
        for cmd in commands:
            kind = cmd.get("type", "goto")
            if kind in {"goto", "intercept"}:
                await self.send_goto(
                    lat=float(cmd["lat"]),
                    lon=float(cmd["lon"]),
                    alt=float(cmd.get("alt", 40.0)),
                )
            elif kind == "loiter":
                await self.send_goto(
                    lat=float(cmd["lat"]),
                    lon=float(cmd["lon"]),
                    alt=float(cmd.get("alt", 40.0)),
                )
            else:
                logger.info("Unknown actuation type=%s cmd=%s", kind, cmd)

    async def send_goto(self, lat: float, lon: float, alt: float) -> None:
        if self.conn is None:
            return

        def _send() -> None:
            assert self.conn is not None
            self.conn.mav.set_position_target_global_int_send(
                0,
                self.conn.target_system,
                self.conn.target_component,
                mavutil.mavlink.MAV_FRAME_GLOBAL_RELATIVE_ALT_INT,
                GOTO_TYPE_MASK,
                int(lat * 1e7),
                int(lon * 1e7),
                float(alt),
                0, 0, 0,
                0, 0, 0,
                0, 0,
            )

        async with self._io_lock:
            await asyncio.to_thread(_send)
        logger.info("Actuation goto lat=%.6f lon=%.6f alt=%.1f", lat, lon, alt)

    async def set_mode(self, mode: str) -> None:
        if self.conn is None:
            return

        def _set() -> None:
            assert self.conn is not None
            mapping = self.conn.mode_mapping() or {}
            key = next((k for k in mapping if k.upper() == mode.upper()), None)
            if key is None:
                self.conn.set_mode(mode)
                return
            mode_id = mapping[key]
            try:
                self.conn.set_mode(mode_id)
            except Exception:
                pass
            self.conn.mav.command_long_send(
                self.conn.target_system,
                self.conn.target_component,
                mavutil.mavlink.MAV_CMD_DO_SET_MODE,
                0,
                mavutil.mavlink.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED,
                float(mode_id),
                0, 0, 0, 0, 0,
            )

        async with self._io_lock:
            await asyncio.to_thread(_set)
        logger.info("Mode %s on %s", mode, self.vehicle_id)

    async def arm(self, armed: bool = True, force: bool = False) -> None:
        if self.conn is None:
            return

        def _arm() -> None:
            assert self.conn is not None
            # 21196 = ArduPilot magic force-arm. Gazebo EKF/mag often refuses otherwise.
            self.conn.mav.command_long_send(
                self.conn.target_system,
                self.conn.target_component,
                mavutil.mavlink.MAV_CMD_COMPONENT_ARM_DISARM,
                0,
                1.0 if armed else 0.0,
                21196.0 if (armed and force) else 0.0,
                0, 0, 0, 0, 0,
            )

        async with self._io_lock:
            await asyncio.to_thread(_arm)
        logger.info("Arm=%s force=%s on %s", armed, force, self.vehicle_id)

    async def takeoff(self, alt: float, pitch_deg: float = 0.0) -> None:
        if self.conn is None:
            return

        def _to() -> None:
            assert self.conn is not None
            self.conn.mav.command_long_send(
                self.conn.target_system,
                self.conn.target_component,
                mavutil.mavlink.MAV_CMD_NAV_TAKEOFF,
                0,
                float(pitch_deg),
                0, 0, 0, 0, 0,
                float(alt),
            )

        async with self._io_lock:
            await asyncio.to_thread(_to)
        logger.info("Takeoff %.0fm pitch=%.0f on %s", alt, pitch_deg, self.vehicle_id)

    async def set_servo(self, channel: int, pwm: int) -> None:
        if self.conn is None:
            return

        def _sv() -> None:
            assert self.conn is not None
            self.conn.mav.command_long_send(
                self.conn.target_system,
                self.conn.target_component,
                mavutil.mavlink.MAV_CMD_DO_SET_SERVO,
                0,
                float(channel),
                float(max(1000, min(2000, int(pwm)))),
                0, 0, 0, 0, 0,
            )

        async with self._io_lock:
            await asyncio.to_thread(_sv)

    async def rc_override(self, chan1: int = 0, chan2: int = 0, chan3: int = 0, chan4: int = 0) -> None:
        """Hold MANUAL sticks. 0 means 'release that channel'."""
        if self.conn is None:
            return

        def _rc() -> None:
            assert self.conn is not None
            self.conn.mav.rc_channels_override_send(
                self.conn.target_system,
                self.conn.target_component,
                int(chan1),
                int(chan2),
                int(chan3),
                int(chan4),
                0, 0, 0, 0,
            )

        async with self._io_lock:
            await asyncio.to_thread(_rc)

    async def set_param(self, name: str, value: float) -> None:
        if self.conn is None:
            return

        def _p() -> None:
            assert self.conn is not None
            self.conn.mav.param_set_send(
                self.conn.target_system,
                self.conn.target_component,
                name.encode("ascii"),
                float(value),
                mavutil.mavlink.MAV_PARAM_TYPE_REAL32,
            )

        async with self._io_lock:
            await asyncio.to_thread(_p)
        logger.info("PARAM %s=%s on %s", name, value, self.vehicle_id)

    async def set_roi(self, lat: float, lon: float, alt: float = 0.0) -> None:
        if self.conn is None:
            return

        def _roi() -> None:
            assert self.conn is not None
            self.conn.mav.command_long_send(
                self.conn.target_system,
                self.conn.target_component,
                mavutil.mavlink.MAV_CMD_DO_SET_ROI,
                0,
                mavutil.mavlink.MAV_ROI_LOCATION,
                0, 0, 0,
                float(lat),
                float(lon),
                float(alt),
            )

        async with self._io_lock:
            await asyncio.to_thread(_roi)

    async def reconnect_forever(self, on_status: Callable[[bool], None] | None = None) -> None:
        while True:
            if self.is_connected():
                await asyncio.sleep(2)
                continue
            try:
                await self.connect(timeout=60)
                if on_status:
                    on_status(True)
            except ConnectionError:
                if on_status:
                    on_status(False)
                await asyncio.sleep(CONNECT_RETRY_SEC)


    def _decode_mode(self, conn: mavutil.mavfile | None, msg: Any) -> str:
        flightmode = getattr(conn, "flightmode", None) if conn is not None else None
        if flightmode and str(flightmode) not in {"", "None"}:
            return str(flightmode)
        mapping = (conn.mode_mapping() if conn is not None else None) or {}
        inv = {int(v): k for k, v in mapping.items()}
        return inv.get(int(getattr(msg, "custom_mode", 0)), str(getattr(msg, "custom_mode", "")))


def _safe_to_dict(msg: Any) -> dict[str, Any]:
    try:
        raw = msg.to_dict()
    except Exception:
        return {"type": getattr(msg, "get_type", lambda: "unknown")()}
    clean: dict[str, Any] = {}
    for key, value in raw.items():
        if isinstance(value, (str, int, float, bool)) or value is None:
            clean[key] = value
        else:
            clean[key] = str(value)
    return clean
