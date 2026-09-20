"""Timestamp-aware target-only constant-velocity fusion, independent of truth.

Two position/velocity Kalman filters retain covariance cross terms, so velocity
is learned from elapsed observation times. Sigma is model uncertainty, not
measured error or calibrated detector quality.
"""
from __future__ import annotations

import math
import time
from collections import OrderedDict
from dataclasses import dataclass, field

from geo import ll_to_ne, ne_to_ll
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
    status: str = "tentative"
    last_source_id: str | None = None
    observed_sources: list[str] = field(default_factory=list)
    last_observation_timestamp: float | None = None

    def as_dict(self) -> dict:
        return {
            "lat": self.lat, "lon": self.lon, "vn": self.vn, "ve": self.ve,
            "speed_mps": math.hypot(self.vn, self.ve), "class_hint": self.class_hint,
            "confidence": self.confidence, "age_s": self.age_s, "hits": self.hits,
            "sigma_m": self.sigma_m, "history": self.history[-40:],
            "status": self.status, "last_source_id": self.last_source_id,
            "observed_sources": self.observed_sources,
            "last_observation_timestamp": self.last_observation_timestamp,
        }


class TargetTracker:
    """One vessel track; accept at most one associated box per source/frame.

    ``now`` uses the controller's monotonic clock. Pass ``observation_now`` in
    the detections' Unix clock to account for receipt/capture latency. Legacy
    callers without that bridge treat newly received observations as current;
    timestamps still reject duplicates and out-of-order observations.
    """

    def __init__(self, gate_m: float = 220.0, loss_s: float = 25.0) -> None:
        self.gate_m = gate_m
        self.loss_s = loss_s
        self.track: Track | None = None
        self.accepted_detections: list[Detection] = []
        self.rejected_detections: list[dict[str, str]] = []
        self._t: float | None = None
        self._last_seen: float | None = None
        self._source_stamps: dict[str, float] = {}
        self._cov = [225.0, 0.0, 100.0]
        self._seen: OrderedDict[tuple[str, str], None] = OrderedDict()

    def reset(self) -> None:
        self.track = None
        self._last_seen = None
        self._source_stamps.clear()
        self._cov = [225.0, 0.0, 100.0]
        self.accepted_detections = []
        self.rejected_detections = []
        # Preserve observed IDs: reset must not turn a cached frame into a cue.

    def update(self, detections: list[Detection], now: float | None = None,
               observation_now: float | None = None) -> Track | None:
        if now is None:
            now = time.monotonic()
            observation_now = time.time() if observation_now is None else observation_now
        if not math.isfinite(now) or (self._t is not None and now < self._t):
            raise ValueError("Tracker update clock must be finite and nondecreasing")
        dt = 0.0 if self._t is None else now - self._t
        self._t = now
        self.accepted_detections = []
        self.rejected_detections = []
        if self.track:
            self._predict(dt)
            self.track.age_s = max(0.0, now - self._last_seen) if self._last_seen is not None else 0.0
            self.track.confidence *= math.exp(-dt / 16.0)
            if self.track.age_s > self.loss_s:
                self.reset()

        candidates: list[tuple[Detection, float, tuple[str, str]]] = []
        for det in detections:
            identity = det.observation_id or det.frame_id or repr(det.timestamp)
            key = (det.source_id, identity)
            age = 0.0 if observation_now is None else observation_now - det.timestamp
            reason = None
            if not all(math.isfinite(v) for v in (det.lat, det.lon, det.timestamp, det.confidence)):
                reason = "nonfinite"
            elif not (-90 <= det.lat <= 90 and -180 <= det.lon <= 180 and .2 <= det.confidence <= 1):
                reason = "invalid_or_weak"
            elif det.coordinate_frame != "wgs84" or det.timestamp_basis not in {"capture_unix", "receipt_unix"}:
                reason = "incompatible_reference"
            elif key in self._seen:
                reason = "duplicate"
            elif age > 4.0 or age < -1.0:
                reason = "stale_or_future"
            elif det.timestamp < self._source_stamps.get(det.source_id, -math.inf) - 1e-6:
                reason = "out_of_order"
            if reason:
                self.rejected_detections.append({"source_id": det.source_id, "reason": reason})
                continue
            candidates.append((det, max(0.0, age), key))

        candidates.sort(key=lambda item: (item[0].timestamp, self._distance(item[0]) if self.track else -item[0].confidence))
        frames: set[tuple[str, str]] = set()
        for det, age, key in candidates:
            self._seen[key] = None
            while len(self._seen) > 4096:
                self._seen.popitem(last=False)
            frame = (det.source_id, det.frame_id or repr(det.timestamp))
            if frame in frames:
                continue
            if not self._correct(det, age):
                self.rejected_detections.append({"source_id": det.source_id, "reason": "association_gate"})
                continue
            frames.add(frame)
            self._last_seen = max(self._last_seen if self._last_seen is not None else -math.inf, now - age)
            self._source_stamps[det.source_id] = det.timestamp
            self.accepted_detections.append(det)
        if self.track:
            track = self.track
            track.age_s = max(0.0, now - self._last_seen) if self._last_seen is not None else 0.0
            track.status = "coasting" if track.age_s > 1.5 else ("observed" if track.hits >= 2 else "tentative")
            track.sigma_m = math.sqrt(max(0.0, 2.0 * self._cov[0]))
            track.history.append((track.lat, track.lon))
            track.history = track.history[-80:]
        return self.track

    def _distance(self, det: Detection) -> float:
        if not self.track:
            return 0.0
        n, e = ll_to_ne(det.lat, det.lon)
        tn, te = ll_to_ne(self.track.lat, self.track.lon)
        return math.hypot(n - tn, e - te)

    def _predict(self, dt: float) -> None:
        assert self.track
        n, e = ll_to_ne(self.track.lat, self.track.lon)
        self.track.lat, self.track.lon = ne_to_ll(n + self.track.vn * dt, e + self.track.ve * dt)
        p, cross, velocity = self._cov
        q = 1.5 ** 2  # White acceleration engineering prior, m/s squared.
        self._cov = [p + 2 * dt * cross + dt * dt * velocity + q * dt ** 4 / 4,
                     cross + dt * velocity + q * dt ** 3 / 2,
                     velocity + q * dt * dt]

    def _correct(self, det: Detection, age: float) -> bool:
        # Range-dependent location noise is an engineering prior, not a
        # confidence-to-variance conversion or a calibrated accuracy claim.
        sigma = max(10.0, min(80.0, (det.range_m or 0.0) * .03))
        noise = sigma * sigma + (age * 8.0) ** 2
        if self.track is None:
            self.track = Track(det.lat, det.lon, class_hint=det.class_hint, confidence=det.confidence,
                               hits=1, last_source_id=det.source_id, observed_sources=[det.source_id],
                               last_observation_timestamp=det.timestamp)
            self._cov = [noise, 0.0, 100.0]
            return True
        track = self.track
        n, e = ll_to_ne(det.lat, det.lon)
        tn, te = ll_to_ne(track.lat, track.lon)
        dn, de = n + track.vn * age - tn, e + track.ve * age - te
        p, cross, velocity = self._cov
        innovation_var = p + noise
        if math.hypot(dn, de) > self.gate_m or (dn * dn + de * de) / innovation_var > 16.0:
            return False
        kp, kv = p / innovation_var, cross / innovation_var
        track.lat, track.lon = ne_to_ll(tn + kp * dn, te + kp * de)
        track.vn += kv * dn
        track.ve += kv * de
        self._cov = [max(.01, (1 - kp) * p), (1 - kp) * cross, max(.01, velocity - kv * cross)]
        track.hits += 1
        track.confidence = min(1.0, .4 * track.confidence + .6 * det.confidence)
        track.class_hint = det.class_hint
        track.last_source_id = det.source_id
        track.last_observation_timestamp = max(track.last_observation_timestamp or det.timestamp, det.timestamp)
        track.observed_sources = sorted(set(track.observed_sources) | {det.source_id})
        return True
