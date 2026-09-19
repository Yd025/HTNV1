"""Arctic-sim MJPEG cameras. Render lives on the Gazebo host, ports 8600+10*slot."""

from __future__ import annotations

import os
from dataclasses import dataclass

import httpx


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
