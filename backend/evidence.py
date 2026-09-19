"""Input validation and bounded receipt deduplication before target fusion.

This does not select a target association; that remains the tracker's job.
Legacy observations receive an ID from the source's receipt timestamp. Camera
owners should supply a stable observation/frame ID at acquisition instead.
"""
from __future__ import annotations

import hashlib
import math
from collections import OrderedDict

from sim.types import Detection


class ObservationGate:
    def __init__(self, max_age_s: float = 4.0, capacity: int = 4096) -> None:
        self.max_age_s = max_age_s
        self.capacity = capacity
        self.seen: OrderedDict[tuple[str, str], float] = OrderedDict()

    def filter(self, detections: list[Detection], now: float, provenance: str):
        accepted: list[Detection] = []
        rejected: list[dict] = []
        for detection in detections:
            if not detection.observation_id:
                identity = f"{detection.source_id}:{detection.frame_id or repr(detection.timestamp)}"
                detection.observation_id = hashlib.sha256(identity.encode()).hexdigest()[:24]
            if detection.provenance is None:
                detection.provenance = provenance
            reason = self._reason(detection, now)
            key = (detection.source_id, detection.observation_id)
            if reason is None and key in self.seen:
                reason = "duplicate"
            if reason:
                rejected.append({"observation_id": detection.observation_id, "source_id": detection.source_id, "reason": reason})
                continue
            self.seen[key] = now
            accepted.append(detection)
            while len(self.seen) > self.capacity:
                self.seen.popitem(last=False)
        # Keep IDs at least as long as the accepted observation-age window.
        while self.seen and now - next(iter(self.seen.values())) > self.max_age_s * 2:
            self.seen.popitem(last=False)
        return accepted, rejected

    def _reason(self, detection: Detection, now: float) -> str | None:
        values = (detection.lat, detection.lon, detection.confidence, detection.timestamp)
        if not detection.source_id or not all(isinstance(v, (float, int)) and math.isfinite(v) for v in values):
            return "invalid_measurement"
        if not (-90 <= detection.lat <= 90 and -180 <= detection.lon <= 180 and 0 <= detection.confidence <= 1):
            return "invalid_measurement"
        if detection.coordinate_frame != "wgs84":
            return "incompatible_coordinates"
        if detection.timestamp_basis not in {"receipt_unix", "capture_unix"}:
            return "incompatible_clock"
        age = now - detection.timestamp
        if age > self.max_age_s:
            return "stale"
        if age < -1.0:
            return "future_timestamp"
        return None
