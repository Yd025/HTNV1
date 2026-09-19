"""WHITEOUT adapter — fill from Saturday 10:30 workshop (PSE 2324/2328).

Until Dominion publishes the live contract this talks to WHITEOUT_URL if set,
otherwise returns empty fleet so the brain stays up. See docs/SATURDAY_WORKSHOP.md.
"""

from __future__ import annotations

import logging
import os
from typing import Any

import httpx

from geo import ARENA_HALF_M, ORIGIN_LAT, ORIGIN_LON, ne_to_ll
from sim.types import Arena, Command, Detection, TowerMount, VehicleState

logger = logging.getLogger("overwatch.whiteout")

WHITEOUT_URL = os.getenv("WHITEOUT_URL", "").rstrip("/")
WHITEOUT_TOKEN = os.getenv("WHITEOUT_TOKEN", "")
WHITEOUT_TIMEOUT = float(os.getenv("WHITEOUT_TIMEOUT", "2.0"))


def _headers() -> dict[str, str]:
    if not WHITEOUT_TOKEN:
        return {}
    return {"Authorization": f"Bearer {WHITEOUT_TOKEN}"}


class WhiteoutAdapter:
    """Saturday swap target. Do not hardcode tcp:sitl:5760 here."""

    name = "whiteout"

    def __init__(self, base_url: str | None = None) -> None:
        self.base = (base_url or WHITEOUT_URL).rstrip("/")
        self._arena = Arena(
            origin_lat=ORIGIN_LAT,
            origin_lon=ORIGIN_LON,
            half_m=ARENA_HALF_M,
            towers=[
                TowerMount("tower-ne", *ne_to_ll(900, 900), heading=225.0),
                TowerMount("tower-sw", *ne_to_ll(-900, -900), heading=45.0),
            ],
        )
        self._last_ok: dict[str, bool] = {}
        self._client: httpx.AsyncClient | None = None

    async def connect(self) -> None:
        if not self.base:
            logger.warning("WHITEOUT_URL unset — WhiteoutAdapter is a stub until the workshop")
            return
        self._client = httpx.AsyncClient(timeout=WHITEOUT_TIMEOUT, headers=_headers())
        logger.info("WhiteoutAdapter pointing at %s", self.base)

    def arena(self) -> Arena:
        return self._arena

    async def list_vehicles(self) -> list[VehicleState]:
        # SATURDAY: GET {base}/vehicles  (confirm path in workshop)
        data = await self._get("/vehicles")
        if not data:
            return []
        items = data if isinstance(data, list) else data.get("vehicles", [])
        out: list[VehicleState] = []
        for raw in items:
            out.append(_parse_vehicle(raw))
        return out

    async def poll_detections(self) -> list[Detection]:
        # SATURDAY: GET {base}/detections  or parse MAVLink LANDING_TARGET / ADSB / custom
        data = await self._get("/detections")
        if not data:
            return []
        items = data if isinstance(data, list) else data.get("detections", [])
        return [_parse_detection(raw) for raw in items]

    async def send_command(self, command: Command) -> None:
        # SATURDAY: POST {base}/command  or MAVLink SET_POSITION_TARGET_GLOBAL_INT
        if not self._client or not self.base:
            return
        try:
            await self._client.post(f"{self.base}/command", json=command.as_dict())
        except Exception:
            logger.exception("whiteout send_command failed")

    def comms_ok(self, vehicle_id: str) -> bool:
        return self._last_ok.get(vehicle_id, True)

    def truth_target(self) -> tuple[float, float] | None:
        # SATURDAY: only if they publish truth for scoring. Leave None otherwise.
        return None

    async def _get(self, path: str) -> Any:
        if not self._client or not self.base:
            return None
        try:
            resp = await self._client.get(f"{self.base}{path}")
            resp.raise_for_status()
            self._last_ok["link"] = True
            return resp.json()
        except Exception as exc:
            logger.warning("whiteout GET %s failed: %s", path, exc)
            self._last_ok["link"] = False
            return None


def _parse_vehicle(raw: dict[str, Any]) -> VehicleState:
    return VehicleState(
        vehicle_id=str(raw.get("id") or raw.get("vehicle_id")),
        sysid=int(raw.get("sysid") or raw.get("system_id") or 0),
        vehicle_class=raw.get("class") or raw.get("vehicle_class") or "copter",  # type: ignore[arg-type]
        lat=float(raw["lat"]),
        lon=float(raw["lon"]),
        alt=float(raw.get("alt") or 0.0),
        heading=float(raw.get("heading") or 0.0),
        groundspeed=float(raw.get("groundspeed") or 0.0),
        battery_remaining=float(raw.get("battery_remaining") or 100.0),
        armed=bool(raw.get("armed", True)),
        mode=str(raw.get("mode") or "GUIDED"),
        mavlink=True,
    )


def _parse_detection(raw: dict[str, Any]) -> Detection:
    import time

    lat = raw.get("lat")
    lon = raw.get("lon")
    if lat is None and "north" in raw:
        from geo import ne_to_ll

        lat, lon = ne_to_ll(float(raw["north"]), float(raw["east"]))
    return Detection(
        source_id=str(raw.get("source_id") or raw.get("sensor_id") or "unknown"),
        lat=float(lat),
        lon=float(lon),
        class_hint=str(raw.get("class_hint") or raw.get("cls") or "unknown"),
        confidence=float(raw.get("confidence") or 0.5),
        timestamp=float(raw.get("timestamp") or time.time()),
        bearing=raw.get("bearing"),
        range_m=raw.get("range_m") or raw.get("range"),
    )
