"""Observation-driven tower confirmation, air dispatch and custody lifecycle."""

from __future__ import annotations

import time
from collections import OrderedDict
from typing import Any

from allocator import assign_roles
from geo import haversine_m
from sim.types import Detection, Role, VehicleState
from tracker import Track
from world import WorldModel

PHASE_INTENT = {
    "tower_scan": "Placed towers scan; aircraft remain in reserve.",
    "tower_confirm": "Tower contact is tentative; await a second fresh observation.",
    "dispatch": "Confirmed tower cue: quad closes for tracking; plane covers the forward corridor.",
    "air_track": "Aircraft observations maintain custody independently of tower visibility.",
    "coasting": "Sightings paused; predict with increasing uncertainty, without claiming custody.",
    "reacquire": "Search separate sectors around the last predicted contact.",
    "lost": "Contact expired; aircraft return to reserve and towers must confirm a new cue.",
}


class MissionCommand:
    # These are engineering starting values, not calibrated sensor probabilities.
    confirmation_hits = 2
    confirmation_window_s = 6.0
    fresh_s = 2.0
    reacquire_s = 6.0
    lost_s = 25.0
    min_confidence = 0.35

    def __init__(self) -> None:
        self.phase = "tower_scan"
        self.active = False
        self.custody: str | None = None
        self.handoff: dict[str, Any] = {
            "state": "idle", "cue_source": None, "receiver": None,
            "evidence": None, "cue_at": None, "acquired_at": None,
            "lat": None, "lon": None,
        }
        self.metrics = {"confirmed_tower_cues": 0, "successful_handoffs": 0,
                        "reacquisitions": 0, "custody_breaks": 0}
        self._tower_hits: list[Detection] = []
        self._air_hits: dict[str, list[Detection]] = {}
        self._seen: OrderedDict[tuple[str, str], float] = OrderedDict()
        self._source_times: dict[str, float] = {}
        self._last_tower_at: float | None = None
        self._last_tower_source: str | None = None
        self._last_air_at: dict[str, float] = {}
        self._last_observed_at: float | None = None
        self._now = 0.0
        self._ever_acquired = False

    def tick(self, vehicles: list[VehicleState], track: Track | None,
             advisor: dict | None, world: WorldModel) -> dict[str, Role]:
        now = world.observation_now if world.observation_now is not None else time.time()
        self._now = now
        self.expire_if_stale(now, world)
        classes = {v.vehicle_id: v.vehicle_class for v in vehicles}
        # An estimator may reject an otherwise fresh observation as another
        # contact. Such observations must never prove this track's handoff.
        observations = world.accepted_detections
        if observations is None:
            observations = world.detections
        fresh = self._fresh(observations, classes, world, now)
        self._tower_hits = [d for d in self._tower_hits if now - d.timestamp <= self.confirmation_window_s]
        for source in list(self._air_hits):
            self._air_hits[source] = [d for d in self._air_hits[source]
                                      if now - d.timestamp <= self.confirmation_window_s]
        was_active = self.active
        for det in fresh:
            kind = classes[det.source_id]
            if kind == "tower":
                if self._last_tower_at is None or det.timestamp > self._last_tower_at:
                    self._last_tower_at = det.timestamp
                    self._last_tower_source = det.source_id
                if not self.active:
                    if self._tower_hits:
                        previous = self._tower_hits[-1]
                        distance = haversine_m(previous.lat, previous.lon, det.lat, det.lon)
                        gate = 120.0 + 20.0 * max(0.0, det.timestamp - previous.timestamp)
                        if distance > gate:
                            self._tower_hits.clear()
                    self._tower_hits.append(det)
                    self._tower_hits = self._tower_hits[-32:]
                    if self._confirmed(self._tower_hits):
                        self._authorize(det, world)
                if self.active:
                    self._last_observed_at = max(self._last_observed_at if self._last_observed_at is not None else det.timestamp, det.timestamp)
                    world.last_cue = (det.lat, det.lon)
            elif kind in {"plane", "copter"} and self.active:
                # Only images captured/received AFTER dispatch can acknowledge
                # the handoff. A pre-existing drone frame does not qualify.
                if det.timestamp <= self.handoff["cue_at"]:
                    continue
                hits = self._air_hits.setdefault(det.source_id, [])
                hits.append(det)
                self._air_hits[det.source_id] = hits[-32:]
                self._last_air_at[det.source_id] = det.timestamp
                self._last_observed_at = max(self._last_observed_at if self._last_observed_at is not None else det.timestamp, det.timestamp)

        previous_custody = self.custody
        self.custody = None
        qualified_air = [source for source, hits in self._air_hits.items()
                         if self._confirmed(hits) and now - hits[-1].timestamp <= self.fresh_s
                         and world.comms.get(source, True)]
        # Prefer the close-tracking quad when both sensors have fresh custody.
        qualified_air.sort(key=lambda source: (classes.get(source) != "copter",
                                               -self._last_air_at[source], source))
        tower_fresh = self._last_tower_at is not None and now - self._last_tower_at <= self.fresh_s
        age = float("inf") if self._last_observed_at is None else now - self._last_observed_at
        if self.active and (age >= self.lost_s or track is None):
            self.active = False
            self.phase = "lost"
            self.handoff.update(state="lost", receiver=None, evidence=None)
            self._tower_hits.clear()
            self._air_hits.clear()
            self._last_air_at.clear()
            world.last_cue = None
        elif self.active and qualified_air:
            receiver = qualified_air[0]
            self.custody = receiver
            self.phase = "air_track"
            if self.handoff["state"] != "acquired":
                key = "reacquisitions" if self._ever_acquired else "successful_handoffs"
                self.metrics[key] += 1
                self._ever_acquired = True
                self.handoff["acquired_at"] = self._last_air_at[receiver]
                world.post("c2", "all", "acquired", {"receiver": receiver, "evidence": "receiver_observation"})
            self.handoff.update(state="acquired", receiver=receiver, evidence="receiver_observation")
        elif self.active:
            self.custody = self._last_tower_source if tower_fresh else None
            self.phase = "dispatch" if tower_fresh else "coasting" if age < self.reacquire_s else "reacquire"
            self.handoff.update(state="pending" if tower_fresh else "reacquiring", receiver=None, evidence=None)
        elif self._tower_hits:
            self.phase = "tower_confirm"
        elif self.phase != "lost":
            self.phase = "tower_scan"

        if previous_custody and classes.get(previous_custody) in {"plane", "copter"} and not qualified_air:
            self.metrics["custody_breaks"] += 1
        world.mission_active = self.active
        world.custody_source = self.custody
        if world.phase != self.phase:
            world.post("c2", "all", "handoff", {"from": world.phase, "to": self.phase,
                                                 "intent": PHASE_INTENT[self.phase]})
        world.phase = self.phase
        if was_active and not self.active:
            world.accepted_detections = []
        return assign_roles(vehicles, track, advisor, mission_active=self.active)

    def expire_if_stale(self, now: float, world: WorldModel) -> bool:
        """Expire BEFORE accepting a late aircraft frame as a new target.

        The brain calls this before fusion too, so a frame after the complete
        loss horizon cannot silently create a new drone-initiated mission.
        """
        if not self.active or self._last_observed_at is None or now - self._last_observed_at < self.lost_s:
            return False
        if self.custody and self.custody in self._last_air_at:
            self.metrics["custody_breaks"] += 1
        self.active = False
        self.custody = None
        self.phase = "lost"
        self.handoff.update(state="lost", receiver=None, evidence=None)
        self._tower_hits.clear()
        self._air_hits.clear()
        self._last_air_at.clear()
        world.last_cue = None
        world.mission_active = False
        world.custody_source = None
        return True

    def _authorize(self, det: Detection, world: WorldModel) -> None:
        self.active = True
        self._ever_acquired = False
        self._air_hits.clear()
        self._last_air_at.clear()
        self.metrics["confirmed_tower_cues"] += 1
        self.handoff.update(state="pending", cue_source=det.source_id, cue_at=det.timestamp,
                            receiver=None, evidence=None, acquired_at=None, lat=det.lat, lon=det.lon)
        world.post("c2", "aircraft", "cue", {"from": det.source_id, "lat": det.lat, "lon": det.lon,
                                              "confirmation_hits": len(self._tower_hits)})

    def _confirmed(self, hits: list[Detection]) -> bool:
        return len(hits) >= self.confirmation_hits and hits[-1].timestamp > hits[0].timestamp

    def _fresh(self, observations: list[Detection], classes: dict[str, str],
               world: WorldModel, now: float) -> list[Detection]:
        result = []
        for det in sorted(observations, key=lambda d: (d.timestamp, d.source_id)):
            if (det.source_id not in classes or not world.comms.get(det.source_id, True)
                    or not 0.0 <= now - det.timestamp <= self.fresh_s
                    or det.confidence < self.min_confidence):
                continue
            key = (det.source_id, det.observation_id or det.frame_id or repr(det.timestamp))
            if key in self._seen or det.timestamp <= self._source_times.get(det.source_id, float("-inf")):
                continue
            self._seen[key] = now
            self._source_times[det.source_id] = det.timestamp
            result.append(det)
        while self._seen and (len(self._seen) > 2048 or now - next(iter(self._seen.values())) > self.lost_s):
            self._seen.popitem(last=False)
        self._source_times = {source: stamp for source, stamp in self._source_times.items()
                              if source in classes and now - stamp <= self.lost_s}
        return result

    def snapshot(self) -> dict[str, Any]:
        return {
            "phase": self.phase, "intent": PHASE_INTENT[self.phase],
            "mission_active": self.active, "custody": self.custody,
            "handoff": dict(self.handoff),
            "tower_confirmation": {"hits": len(self._tower_hits), "required_hits": self.confirmation_hits,
                                   "window_s": self.confirmation_window_s},
            "observation_age_s": None if self._last_observed_at is None else round(max(0.0, self._now - self._last_observed_at), 2),
            "tower_observation_age_s": None if self._last_tower_at is None else round(max(0.0, self._now - self._last_tower_at), 2),
            "air_observation_age_s": {source: round(max(0.0, self._now - stamp), 2)
                                      for source, stamp in self._last_air_at.items()},
            "metrics": dict(self.metrics),
            "thresholds": {"fresh_s": self.fresh_s, "reacquire_s": self.reacquire_s, "lost_s": self.lost_s},
        }
