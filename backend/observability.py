"""Measured control-loop evidence and bounded, off-loop Sentry Logs + Tracing.

The tick only reads clocks and offers compact data. SDK calls run in a worker
thread, using the recorded timestamps so export latency never becomes flight
latency. Full-fidelity algorithm inputs remain in RunRecorder, not Sentry.
"""
from __future__ import annotations

import asyncio
from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timezone
import logging
import math
import os
import time
from typing import Any
import uuid

logger = logging.getLogger("overwatch.observability")


def configure_sentry() -> bool:
    """Used by both API and headless entrypoints; optional for stdlib eval."""
    dsn = os.getenv("SENTRY_DSN", "").strip()
    if not dsn:
        return False
    try:
        import sentry_sdk
        from sentry_sdk.integrations.logging import LoggingIntegration

        rate = float(os.getenv("SENTRY_TRACES_SAMPLE_RATE", "0.1"))
        if not math.isfinite(rate) or not 0 <= rate <= 1:
            raise ValueError("SENTRY_TRACES_SAMPLE_RATE must be between 0 and 1")
        sentry_sdk.init(
            dsn=dsn, environment=os.getenv("SENTRY_ENVIRONMENT", "hackathon"),
            release=os.getenv("SENTRY_RELEASE") or None,
            traces_sample_rate=rate, enable_logs=True,
            profiles_sample_rate=0, send_default_pii=False,
            include_local_variables=False, transport_queue_size=100,
            shutdown_timeout=2,
            # Only explicit structured mission logs enter Logs; existing Python
            # errors and breadcrumbs retain their normal error-monitoring path.
            integrations=[LoggingIntegration(level=logging.INFO, event_level=logging.ERROR,
                                             sentry_logs_level=None)],
        )
        return True
    except Exception as exc:
        # Never print a malformed DSN or credentials from an SDK exception.
        logger.warning("Sentry disabled: configuration failed (%s)", type(exc).__name__)
        return False


def sentry_enabled() -> bool:
    try:
        import sentry_sdk
        client = sentry_sdk.get_client()
        return bool(client.is_active() and client.options.get("enable_logs"))
    except ImportError:
        return False


async def flush_sentry() -> None:
    if sentry_enabled():
        import sentry_sdk
        try:
            await asyncio.to_thread(sentry_sdk.flush, timeout=2)
        except Exception as exc:
            logger.warning("Sentry shutdown flush failed (%s)", type(exc).__name__)


class TickTiming:
    def __init__(self, budget_ms: float) -> None:
        self.started_at = time.time()
        self._start = time.perf_counter()
        self.budget_ms = budget_ms
        self.trace_id = uuid.uuid4().hex
        self.spans: list[dict[str, Any]] = []

    @contextmanager
    def span(self, op: str, name: str | None = None):
        start = time.perf_counter()
        status = "ok"
        try:
            yield
        except BaseException:
            status = "internal_error"
            raise
        finally:
            self.spans.append({"op": op, "name": name or op,
                               "offset_ms": (start - self._start) * 1000,
                               "duration_ms": (time.perf_counter() - start) * 1000,
                               "status": status})

    def snapshot(self) -> dict[str, Any]:
        duration = (time.perf_counter() - self._start) * 1000
        return {"trace_id": self.trace_id, "started_at": self.started_at,
                "duration_ms": duration, "budget_ms": self.budget_ms,
                "over_budget": duration > self.budget_ms,
                "stages": [dict(span) for span in self.spans]}


class MissionObserver:
    def __init__(self, run_id: str, mode: str, adapter: str, *, queue_size: int = 128) -> None:
        self.tags = {"run.id": run_id, "run.mode": mode, "adapter": adapter,
                     "run.scenario": os.getenv("RUN_SCENARIO", "unspecified")}
        self._queue: asyncio.Queue[dict | None] = asyncio.Queue(maxsize=queue_size)
        self._task: asyncio.Task | None = None
        self._closed = False
        self.dropped = self.export_errors = self.processed = 0
        self._counts: Counter = Counter()
        self._max_ms = 0.0
        self._window_start: float | None = None
        self._last: dict | None = None
        self._slowest: dict | None = None
        self._last_failure: dict | None = None
        self._present = False

    def start(self) -> None:
        if sentry_enabled() and self._task is None and not self._closed:
            self._task = asyncio.create_task(self._drain(), name="sentry-mission-export")

    @property
    def status(self) -> dict:
        return {"enabled": self._task is not None, "closed": self._closed,
                "queue_depth": self._queue.qsize(), "dropped_ticks": self.dropped,
                "export_errors": self.export_errors, "processed_ticks": self.processed}

    def offer(self, state: dict, timing: dict, error: str | None = None) -> None:
        if self._task is None or self._closed:
            return
        track = state.get("track") or {}
        observations = state.get("observations") or {}
        # Scalar allowlist: no camera bytes, model prompts, raw IDs or histories.
        attributes = {**self.tags, "tick.sequence": state.get("run", {}).get("sequence", 0),
                      "tick.trace_id": timing["trace_id"],
                      "tick.duration_ms": timing["duration_ms"],
                      "tick.budget_ms": timing["budget_ms"],
                      "evaluation.truth_available": bool(state.get("run", {}).get("evaluation_truth_available")),
                      "track.present": bool(track), "export.dropped_ticks": self.dropped,
                      "recording.enabled": bool(state.get("recording", {}).get("enabled")),
                      "recording.dropped_records": state.get("recording", {}).get("dropped_records", 0)}
        if observations.get("latest_age_s") is not None:
            attributes["observations.latest_age_s"] = observations["latest_age_s"]
        roles = Counter(v.get("role", "unassigned") for v in state.get("fleet", {}).values())
        attributes.update({f"fleet.role.{role}": count for role, count in roles.items()})
        for key in ("lat", "lon", "vn", "ve", "age_s", "sigma_m", "confidence", "hits"):
            if key in track:
                attributes[f"track.{key}"] = track[key]
        for key, value in (state.get("scores") or {}).items():
            if isinstance(value, (int, float)) and math.isfinite(value):
                attributes[f"score.{key}"] = value
        counts = Counter({"ticks": 1, "over_budget": int(timing["over_budget"]),
                          "observations.received": observations.get("received", 0),
                          "observations.forwarded": observations.get("forwarded", 0)})
        counts.update(f"rejected.{item['reason']}" for item in observations.get("rejected", []))
        counts.update(f"commands.{item['status']}" for item in state.get("command_outcomes", []))
        for item in state.get("command_outcomes", []):
            if item["status"] == "dispatch_error":
                attributes["dispatch.error"] = item.get("error", "unknown")
                attributes["dispatch.vehicle_id"] = item["vehicle_id"]
        if error:
            attributes["tick.error"] = error
            counts["tick_errors"] += 1
        event = {"attributes": attributes, "counts": counts, "timing": timing}
        try:
            self._queue.put_nowait(event)
        except asyncio.QueueFull:
            self.dropped += 1

    async def _drain(self) -> None:
        while True:
            event = await self._queue.get()
            try:
                if event is None:
                    await asyncio.to_thread(self._flush_summary)
                else:
                    await asyncio.to_thread(self._export, event)
                    self.processed += 1
            except Exception:
                # Optional telemetry failures cannot terminate the controller.
                self.export_errors += 1
            finally:
                self._queue.task_done()
            if event is None:
                return

    def _export(self, event: dict) -> None:
        import sentry_sdk

        timing, attrs = event["timing"], event["attributes"]
        started = timing["started_at"]
        with sentry_sdk.start_transaction(op="bt.tick", name="swarm_tick",
                                          trace_id=timing["trace_id"],
                                          start_timestamp=_utc(started)) as transaction:
            for key, value in self.tags.items():
                transaction.set_tag(key, value)
            for key, value in attrs.items():
                transaction.set_data(key, value)
            for stage in timing["stages"]:
                span = transaction.start_child(op=stage["op"], name=stage["name"],
                                               start_timestamp=_utc(started + stage["offset_ms"] / 1000))
                span.set_status(stage["status"])
                span.finish(end_timestamp=_utc(started + (stage["offset_ms"] + stage["duration_ms"]) / 1000))
            transaction.set_status("internal_error" if "tick.error" in attrs else "ok")
            self._counts.update(event["counts"])
            if self._slowest is None or timing["duration_ms"] > self._max_ms:
                self._slowest = event
            if "tick.error" in attrs or "dispatch.error" in attrs:
                self._last_failure = event
            self._max_ms = max(self._max_ms, timing["duration_ms"])
            self._last = event
            if self._window_start is None:
                self._window_start = started
            present = attrs["track.present"] if "tick.error" not in attrs else self._present
            transition = present != self._present
            if transition:
                self._counts["estimate.acquired" if present else "estimate.expired"] += 1
            self._present = present
            if started - self._window_start >= 1.0 or transition:
                self._flush_summary()
            # Preserve measured timestamps rather than timing the SDK worker.
            transaction.finish(end_timestamp=_utc(started + timing["duration_ms"] / 1000))

    def _flush_summary(self) -> None:
        if not self._last or not self._counts:
            return
        from sentry_sdk import logger as sentry_logger

        attrs = {**self._last["attributes"], **{f"window.{k}": v for k, v in self._counts.items()},
                 "event.name": "mission.window", "window.max_tick_ms": self._max_ms,
                 "window.started_at": self._window_start,
                 "export.dropped_ticks": self.dropped, "export.errors": self.export_errors}
        if self._slowest:
            attrs["window.slowest_trace_id"] = self._slowest["timing"]["trace_id"]
            attrs["window.slowest_sequence"] = self._slowest["attributes"]["tick.sequence"]
        if self._last_failure:
            failure = self._last_failure["attributes"]
            attrs["window.last_error_trace_id"] = failure["tick.trace_id"]
            attrs["window.last_error_type"] = failure.get("tick.error", failure.get("dispatch.error"))
        warn = self._counts["over_budget"] or self._counts["tick_errors"] or self._counts["commands.dispatch_error"]
        emit = sentry_logger.warning if warn else sentry_logger.info
        emit("Mission tracking and control window", attributes=attrs)
        self._counts.clear()
        self._max_ms = 0.0
        self._window_start = None
        self._slowest = self._last_failure = None

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        if self._task:
            async def drain() -> None:
                await self._queue.put(None)
                await self._task
            try:
                await asyncio.wait_for(drain(), timeout=2)
            except TimeoutError:
                self.dropped += self._queue.qsize()
                self._task.cancel()
                await asyncio.gather(self._task, return_exceptions=True)


def _utc(seconds: float) -> datetime:
    return datetime.fromtimestamp(seconds, tz=timezone.utc)
