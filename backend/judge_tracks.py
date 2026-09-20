"""POST the fused boat estimate to ArcticSim's scoring API.

This is not vehicle control. MAVLink still flies the fleet. Judges score the
track we publish at :8010. Failures must never stall the 10 Hz loop.
"""

from __future__ import annotations

import logging
import math
import os
import time
from typing import Any

import httpx

from tracker import Track

logger = logging.getLogger("overwatch.judge_tracks")


def _default_url() -> str:
    explicit = os.getenv("TRACKS_URL", "").strip()
    if explicit in {"0", "off", "false", "disabled"}:
        return ""
    if explicit:
        return explicit
    host = os.getenv("ARCTIC_HOST") or "127.0.0.1"
    return f"http://{host}:8010/api/tracks"


class JudgeTrackPublisher:
    def __init__(self, *, enabled: bool = False, url: str | None = None, name: str | None = None) -> None:
        self.url = (url if url is not None else _default_url()).rstrip("/")
        self.name = (name or os.getenv("TRACK_NAME") or "Sierra One").strip() or "Sierra One"
        self.enabled = bool(enabled and self.url)
        self.min_interval_s = 1.0
        self._last_sent_at = 0.0
        self.status: dict[str, Any] = {
            "enabled": self.enabled,
            "url": self.url or None,
            "name": self.name,
            "state": "idle" if self.enabled else "disabled",
            "created": False,
            "uuid": None,
            "lat": None,
            "lon": None,
            "heading": None,
            "speed": None,
            "age_s": None,
            "error": None,
            "judge_tracks": [],
        }

    def offer(self, active: bool, track: Track | None, now: float | None = None) -> dict[str, Any] | None:
        """Return a payload to POST, or None if this tick should stay quiet."""
        if not self.enabled:
            return None
        if not active or track is None:
            self.status["state"] = "waiting"
            self.status["age_s"] = None
            return None
        stamp = time.monotonic() if now is None else now
        if stamp - self._last_sent_at < self.min_interval_s:
            return None
        speed = math.hypot(track.vn, track.ve)
        heading = (math.degrees(math.atan2(track.ve, track.vn)) + 360.0) % 360.0 if speed > 0.15 else None
        self._last_sent_at = stamp
        return {
            "name": self.name,
            "lat": round(track.lat, 6),
            "lon": round(track.lon, 6),
            "heading": None if heading is None else round(heading, 1),
            "speed": round(speed, 2),
        }

    async def publish(self, payload: dict[str, Any]) -> None:
        if not self.enabled:
            return
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(0.8, connect=0.4)) as client:
                response = await client.post(self.url, json=payload)
                body: Any
                try:
                    body = response.json()
                except ValueError:
                    body = {"text": response.text[:240]}
                if response.status_code >= 400:
                    self.status.update(state="error", error=f"HTTP {response.status_code}", **_echo(payload))
                    logger.warning("judge track POST %s: %s", response.status_code, body)
                    return
                listed = await self._list(client)
                self.status.update(
                    state="updated" if self.status.get("created") or not body.get("created") else "created",
                    created=bool(self.status.get("created") or body.get("created")),
                    uuid=body.get("uuid") or self.status.get("uuid"),
                    error=None,
                    judge_tracks=listed,
                    **_echo(payload),
                )
                if body.get("created"):
                    self.status["state"] = "created"
        except Exception as exc:
            self.status.update(state="error", error=f"{type(exc).__name__}: {exc}", **_echo(payload))
            logger.warning("judge track POST failed: %s", exc)

    async def _list(self, client: httpx.AsyncClient) -> list[dict[str, Any]]:
        try:
            response = await client.get(self.url)
            if response.status_code >= 400:
                return []
            body = response.json()
            if isinstance(body, list):
                return body[:8]
            if isinstance(body, dict):
                tracks = body.get("tracks") or body.get("items") or []
                return tracks[:8] if isinstance(tracks, list) else [body]
        except Exception:
            return []
        return []

    def snapshot(self) -> dict[str, Any]:
        return dict(self.status)


def _echo(payload: dict[str, Any]) -> dict[str, Any]:
    return {key: payload.get(key) for key in ("lat", "lon", "heading", "speed")}
