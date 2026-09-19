"""Target-only track fusion. Not a vehicle EKF — ArduPilot already estimates own-ship."""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field

from geo import ORIGIN_LAT, ORIGIN_LON, ll_to_ne, ne_to_ll
from sim.types import Detection


@dataclass
class Track:
    lat: float
    lon: float
    vn: float = 0.0
    ve: float = 0.0
    class_hint: str = "unknown"
    confidence: float = 0.0
    age_s: float = 0.0
    hits: int = 0
    sigma_m: float = 80.0
    history: list[tuple[float, float]] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "lat": self.lat,
            "lon": self.lon,
            "vn": self.vn,
            "ve": self.ve,
            "speed_mps": math.hypot(self.vn, self.ve),
            "class_hint": self.class_hint,
            "confidence": self.confidence,
            "age_s": self.age_s,
            "hits": self.hits,
            "sigma_m": self.sigma_m,
            "history": self.history[-40:],
        }


class TargetTracker:
    """Constant-velocity 4-state filter on the contact (n, e, vn, ve)."""

    def __init__(self, gate_m: float = 220.0) -> None:
        self.gate_m = gate_m
        self.track: Track | None = None
        self._t = time.monotonic()
        self._pn = self._pe = 40.0
        self._pvn = self._pve = 8.0

    def update(self, detections: list[Detection], now: float | None = None) -> Track | None:
        now = now or time.monotonic()
        dt = max(0.01, min(1.0, now - self._t))
        self._t = now
        if self.track:
            self._predict(dt)
            self.track.age_s += dt
            self.track.confidence *= 0.985
        associated = self._associate(detections)
        if associated:
            self._correct(associated)
        if self.track and self.track.age_s > 25.0 and self.track.confidence < 0.15:
            self.track = None
        return self.track

    def _predict(self, dt: float) -> None:
        assert self.track
        n, e = ll_to_ne(self.track.lat, self.track.lon)
        n += self.track.vn * dt
        e += self.track.ve * dt
        self.track.lat, self.track.lon = ne_to_ll(n, e)
        self._pn += abs(self.track.vn) * dt * 0.2 + 2.0 * dt
        self._pe += abs(self.track.ve) * dt * 0.2 + 2.0 * dt
        self.track.sigma_m = math.hypot(self._pn, self._pe) ** 0.5 * 6.0
        self.track.history.append((self.track.lat, self.track.lon))

    def _associate(self, detections: list[Detection]) -> Detection | None:
        if not detections:
            return None
        if self.track is None:
            return max(detections, key=lambda d: d.confidence)
        tn, te = ll_to_ne(self.track.lat, self.track.lon)
        best: Detection | None = None
        best_d = self.gate_m
        for d in detections:
            n, e = ll_to_ne(d.lat, d.lon)
            dist = math.hypot(n - tn, e - te)
            if dist < best_d:
                best_d = dist
                best = d
        return best

    def _correct(self, det: Detection) -> None:
        n, e = ll_to_ne(det.lat, det.lon)
        if self.track is None:
            self.track = Track(lat=det.lat, lon=det.lon, class_hint=det.class_hint, confidence=det.confidence, hits=1)
            self._pn = self._pe = 25.0
            return
        tn, te = ll_to_ne(self.track.lat, self.track.lon)
        kn = self._pn / (self._pn + 18.0)
        ke = self._pe / (self._pe + 18.0)
        nn = tn + kn * (n - tn)
        ee = te + ke * (e - te)
        dt = 0.2
        self.track.vn = 0.7 * self.track.vn + 0.3 * (nn - tn) / dt
        self.track.ve = 0.7 * self.track.ve + 0.3 * (ee - te) / dt
        self.track.lat, self.track.lon = ne_to_ll(nn, ee)
        self._pn *= 1.0 - kn
        self._pe *= 1.0 - ke
        self.track.hits += 1
        self.track.age_s = 0.0
        self.track.confidence = min(1.0, 0.4 * self.track.confidence + 0.6 * det.confidence)
        self.track.class_hint = det.class_hint
        self.track.sigma_m = math.hypot(self._pn, self._pe) ** 0.5 * 8.0
        self.track.history.append((self.track.lat, self.track.lon))
