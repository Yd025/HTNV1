"""Arctic-sim MJPEG cameras. Render lives on the Gazebo host, ports 8600+10*slot."""

from __future__ import annotations

import asyncio
import logging
import os
from dataclasses import dataclass

import httpx

logger = logging.getLogger("overwatch.cameras")


def _host() -> str:
    return os.getenv("ARCTIC_HOST") or ("host.docker.internal" if os.path.exists("/.dockerenv") else "127.0.0.1")


@dataclass(frozen=True)
class CameraSpec:
    vehicle_id: str
    port: int
    hfov_rad: float
    pitch_bias_deg: float
    label: str

    def snapshot_url(self, host: str | None = None) -> str:
        return f"http://{host or _host()}:{self.port}/snapshot.jpg"

    def stream_url(self, host: str | None = None) -> str:
        return f"http://{host or _host()}:{self.port}/stream"

    def as_dict(self) -> dict[str, object]:
        return {
            "vehicle_id": self.vehicle_id,
            "port": self.port,
            "label": self.label,
            "snapshot": f"/cameras/{self.vehicle_id}/snapshot.jpg",
            "stream": self.stream_url(),
        }


# Official four-asset heat. Ports = 8600 + 10 * slot.
FLEET_CAMERAS: tuple[CameraSpec, ...] = (
    CameraSpec("quadcopter", 8600, hfov_rad=2.0, pitch_bias_deg=0.0, label="quad gimbal"),
    CameraSpec("fixed-wing", 8610, hfov_rad=1.204, pitch_bias_deg=-8.0, label="plane FPV"),
    CameraSpec("tower-1", 8630, hfov_rad=1.047, pitch_bias_deg=0.0, label="tower-1 EO"),
    CameraSpec("tower-2", 8640, hfov_rad=1.047, pitch_bias_deg=0.0, label="tower-2 EO"),
)


def spec_for(vehicle_id: str) -> CameraSpec | None:
    return next((c for c in FLEET_CAMERAS if c.vehicle_id == vehicle_id), None)


async def grab_jpeg(spec: CameraSpec, client: httpx.AsyncClient) -> bytes | None:
    try:
        resp = await client.get(spec.snapshot_url())
        if resp.status_code == 200 and resp.content[:2] == b"\xff\xd8":
            return resp.content
    except httpx.HTTPError:
        return None
    return None


class MjpegTap:
    """Hold /stream open so CameraStreamPlugin keeps encoding live frames.

    Snapshot-only grabs increment clients for a few milliseconds. The plugin
    then returns the last JPEG immediately and almost never encodes a new one,
    so every tower looks like a frozen sky.
    """

    def __init__(self) -> None:
        self.latest: dict[str, bytes] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}

    def start(self, specs: tuple[CameraSpec, ...] | list[CameraSpec]) -> None:
        for spec in specs:
            task = self._tasks.get(spec.vehicle_id)
            if task is None or task.done():
                self._tasks[spec.vehicle_id] = asyncio.create_task(
                    self._pump(spec), name=f"mjpeg-{spec.vehicle_id}"
                )

    def get(self, vehicle_id: str) -> bytes | None:
        jpeg = self.latest.get(vehicle_id)
        if jpeg and jpeg[:2] == b"\xff\xd8":
            return jpeg
        return None

    async def _pump(self, spec: CameraSpec) -> None:
        timeout = httpx.Timeout(None, connect=2.0)
        while True:
            try:
                async with httpx.AsyncClient(timeout=timeout) as client:
                    async with client.stream("GET", spec.stream_url()) as resp:
                        buf = bytearray()
                        async for chunk in resp.aiter_bytes():
                            buf.extend(chunk)
                            while True:
                                start = buf.find(b"\xff\xd8")
                                end = buf.find(b"\xff\xd9", start + 2) if start >= 0 else -1
                                if start < 0 or end < 0:
                                    if len(buf) > 2_000_000:
                                        del buf[:-8000]
                                    break
                                self.latest[spec.vehicle_id] = bytes(buf[start : end + 2])
                                del buf[: end + 2]
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                logger.warning("mjpeg %s dropped: %s", spec.vehicle_id, exc)
                await asyncio.sleep(1.2)
