"""Replay recorded adapter inputs through the existing SimAdapter contract."""
from __future__ import annotations

import asyncio
from collections import deque
from dataclasses import fields
import hashlib
import json
import math
from pathlib import Path
import time
from typing import Any, BinaryIO

from recording import MAX_LINE_BYTES, MAX_MANIFEST_BYTES, SCHEMA, SCHEMA_VERSION, RecordingError
from sim.types import Arena, Command, Detection, TowerMount, VehicleState


def _number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise RecordingError(f"{label} must be a finite number")
    return float(value)


def _json(payload: bytes) -> Any:
    def invalid(value: str) -> None:
        raise RecordingError(f"non-finite JSON number: {value}")
    try:
        return json.loads(payload, parse_constant=invalid,
                          parse_float=lambda value: _number(float(value), "JSON number"))
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise RecordingError(f"invalid recording JSON: {exc}") from exc


def _coordinates(item: dict[str, Any], label: str) -> None:
    lat = _number(item.get("lat"), f"{label}.lat")
    lon = _number(item.get("lon"), f"{label}.lon")
    if not -90 <= lat <= 90 or not -180 <= lon <= 180:
        raise RecordingError(f"invalid {label} coordinates")


class ReplayAdapter:
    """Validated, streaming replay. Commands are captured, never transmitted.

    A streaming preflight verifies the whole bounded recording before yielding
    inputs. Only one frame is retained. Runtime reads are also validated so a
    changed/truncated file fails closed. Timestamps share one constant rebase.
    """

    name = "replay"
    mode = "replay"

    def __init__(self, path: str | Path, *, pace: bool = True,
                 max_bytes: int = 512 * 1024 * 1024) -> None:
        candidate = Path(path)
        self.path = candidate.parent if candidate.name in {"manifest.json", "ticks.jsonl"} else candidate
        self.pace = pace
        self.max_bytes = max_bytes
        self.manifest: dict[str, Any] = {}
        self.current_frame: dict[str, Any] | None = None
        self.captured_commands: deque[dict[str, Any]] = deque(maxlen=1024)
        self.elapsed_s = 0.0
        self.eof = False
        self._stream: BinaryIO | None = None
        self._arena: Arena | None = None
        self._count = self._next_sequence = 0
        self._first_elapsed = self._first_recorded_at = 0.0
        self._start_mono: float | None = None
        self._timestamp_offset = 0.0
        self._detections_polled = False

    @property
    def status(self) -> dict[str, Any]:
        return {"mode": "replay", "source_mode": self.manifest.get("mode"),
                "source": self.manifest.get("source"), "run_id": self.manifest.get("run_id"),
                "elapsed_s": self.elapsed_s, "frame": self._next_sequence,
                "total_frames": self._count, "eof": self.eof}

    @property
    def current_advisor(self) -> dict[str, Any] | None:
        advisor = self.current_frame.get("advisor") if self.current_frame else None
        return dict(advisor) if advisor is not None else None

    @property
    def observation_now(self) -> float:
        """Recorded receipt clock, so delayed/unpaced replay preserves freshness."""
        return self.current_frame["recorded_at"] + self._timestamp_offset if self.current_frame else time.time()

    def _validate_frame(self, frame: Any, sequence: int, previous_elapsed: float) -> None:
        if not isinstance(frame, dict) or type(frame.get("sequence")) is not int or frame["sequence"] != sequence:
            raise RecordingError(f"missing or out-of-order tick {sequence}")
        elapsed = _number(frame.get("elapsed_s"), "elapsed_s")
        if elapsed < 0 or elapsed < previous_elapsed:
            raise RecordingError("tick elapsed time is negative or moves backwards")
        _number(frame.get("recorded_at"), "recorded_at")
        for name in ("vehicles", "detections", "accepted", "rejected", "commands", "outcomes"):
            if not isinstance(frame.get(name), list):
                raise RecordingError(f"tick {sequence} lacks {name} evidence")
        comms = frame.get("comms")
        if not isinstance(comms, dict):
            raise RecordingError("tick lacks recorded communications state")
        if frame.get("advisor") is not None and not isinstance(frame["advisor"], dict):
            raise RecordingError("invalid recorded advisor input")
        vehicle_ids: set[str] = set()
        try:
            for item in frame["vehicles"]:
                if not isinstance(item, dict):
                    raise RecordingError("invalid vehicle record")
                _coordinates(item, "vehicle")
                vehicle = VehicleState(**item)
                if not isinstance(vehicle.vehicle_id, str) or not vehicle.vehicle_id or vehicle.vehicle_id in vehicle_ids:
                    raise RecordingError("missing or duplicate vehicle identity")
                if vehicle.vehicle_class not in {"plane", "copter", "rover", "tower"}:
                    raise RecordingError("unknown vehicle class")
                vehicle_ids.add(vehicle.vehicle_id)
                if type(comms.get(vehicle.vehicle_id)) is not bool:
                    raise RecordingError("missing vehicle communications state")
            for item in frame["detections"]:
                if not isinstance(item, dict):
                    raise RecordingError("invalid detection record")
                # Out-of-range finite measurements are raw evidence too: let
                # the same brain input gate reject them again during replay.
                _number(item.get("lat"), "detection.lat")
                _number(item.get("lon"), "detection.lon")
                _number(item.get("timestamp"), "detection.timestamp")
                _number(item.get("confidence"), "detection.confidence")
                detection = Detection(**item)
                if not isinstance(detection.source_id, str):
                    raise RecordingError("invalid detection source type")
            truth = frame.get("evaluation_truth")
            if truth is not None:
                if isinstance(truth, dict):
                    _coordinates(truth, "evaluation_truth")
                elif isinstance(truth, list) and len(truth) == 2:
                    _coordinates({"lat": truth[0], "lon": truth[1]}, "evaluation_truth")
                else:
                    raise RecordingError("invalid evaluation truth")
        except (TypeError, KeyError) as exc:
            raise RecordingError(f"invalid adapter input: {exc}") from exc

    def _read_frame(self, stream: BinaryIO) -> tuple[bytes, Any] | None:
        line = stream.readline(MAX_LINE_BYTES + 1)
        if not line:
            return None
        if len(line) > MAX_LINE_BYTES or not line.endswith(b"\n"):
            raise RecordingError("oversized or truncated recording tick")
        return line, _json(line)

    def _open_validated(self) -> None:
        try:
            with (self.path / "manifest.json").open("rb") as manifest_file:
                payload = manifest_file.read(MAX_MANIFEST_BYTES + 1)
            if len(payload) > MAX_MANIFEST_BYTES:
                raise RecordingError("manifest exceeds size limit")
            manifest = _json(payload)
            if not isinstance(manifest, dict) or manifest.get("schema") != SCHEMA or manifest.get("version") != SCHEMA_VERSION:
                raise RecordingError("unsupported recording schema or version")
            recording = manifest.get("recording", {})
            if manifest.get("complete") is not True or not isinstance(recording, dict) or recording.get("dropped_records") != 0 or recording.get("error"):
                raise RecordingError("recording is incomplete or lost evidence")
            if not manifest.get("run_id") or not manifest.get("mode") or "source" not in manifest or "settings" not in manifest or not isinstance(manifest.get("time_convention"), dict):
                raise RecordingError("recording lacks provenance/settings/clock convention")
            arena_data = dict(manifest["arena"])
            arena_data["towers"] = [TowerMount(**tower) for tower in arena_data.get("towers", [])]
            self._arena = Arena(**arena_data)
            _coordinates({"lat": self._arena.origin_lat, "lon": self._arena.origin_lon}, "arena")
            if _number(self._arena.half_m, "arena.half_m") <= 0:
                raise RecordingError("arena extent must be positive")
            stream = (self.path / "ticks.jsonl").open("rb")
            try:
                if stream.seek(0, 2) > self.max_bytes:
                    raise RecordingError("recording exceeds replay byte limit")
                stream.seek(0)
                digest = hashlib.sha256()
                count = size = 0
                previous_elapsed = -1.0
                while (entry := self._read_frame(stream)) is not None:
                    line, frame = entry
                    self._validate_frame(frame, count, previous_elapsed)
                    if count == 0:
                        self._first_elapsed = frame["elapsed_s"]
                        self._first_recorded_at = frame["recorded_at"]
                    previous_elapsed = frame["elapsed_s"]
                    digest.update(line)
                    size += len(line)
                    if size > self.max_bytes:
                        raise RecordingError("recording exceeds replay byte limit")
                    count += 1
                if not count or count != manifest.get("tick_count") or size != manifest.get("tick_bytes") or digest.hexdigest() != manifest.get("sha256"):
                    raise RecordingError("recording integrity/count mismatch or empty run")
                stream.seek(0)
                self.manifest, self._stream, self._count = manifest, stream, count
            except BaseException:
                stream.close()
                raise
        except (OSError, KeyError, TypeError) as exc:
            raise RecordingError(f"cannot open replay: {exc}") from exc

    async def connect(self) -> None:
        await self.close()
        self.current_frame = None
        self._next_sequence = 0
        self.elapsed_s = 0.0
        self.eof = False
        self._start_mono = None
        self.captured_commands.clear()
        opening = asyncio.create_task(asyncio.to_thread(self._open_validated))
        try:
            await asyncio.shield(opening)
        except asyncio.CancelledError:
            try:
                await opening
            except Exception:
                pass
            await self.close()
            raise

    def arena(self) -> Arena:
        if self._arena is None:
            raise RuntimeError("replay is not connected")
        return self._arena

    async def list_vehicles(self) -> list[VehicleState]:
        if self._stream is None:
            raise RuntimeError("replay is not connected")
        if self._next_sequence >= self._count:
            self.eof = True
            raise StopAsyncIteration("replay complete")
        entry = await asyncio.to_thread(self._read_frame, self._stream)
        if entry is None:
            raise RecordingError("recording truncated after validation")
        _, frame = entry
        self._validate_frame(frame, self._next_sequence, self.elapsed_s)
        if self._start_mono is None:
            self._start_mono = time.monotonic()
            self._timestamp_offset = time.time() - self._first_recorded_at
        if self.pace:
            delay = frame["elapsed_s"] - self._first_elapsed - (time.monotonic() - self._start_mono)
            if delay > 0:
                await asyncio.sleep(delay)
        self.current_frame = frame
        self.elapsed_s = frame["elapsed_s"]
        self._next_sequence += 1
        self._detections_polled = False
        return [VehicleState(**item) for item in frame["vehicles"]]

    async def poll_detections(self) -> list[Detection]:
        if self.current_frame is None or self._detections_polled:
            return []
        self._detections_polled = True
        detections = []
        known_fields = {item.name for item in fields(Detection)}
        for raw in self.current_frame["detections"]:
            item = dict(raw)
            item["timestamp"] += self._timestamp_offset
            # Receipt fields are wall time; capture clocks retain their provenance.
            for key in ("received_at", "receipt_timestamp"):
                if key in known_fields and item.get(key) is not None:
                    item[key] += self._timestamp_offset
            detections.append(Detection(**item))
        return detections

    async def send_command(self, command: Command) -> None:
        if self.current_frame is None or self.eof:
            raise RuntimeError("replay has no active frame")
        self.captured_commands.append({"sequence": self.current_frame["sequence"],
                                       "elapsed_s": self.elapsed_s, "command": command.as_dict()})

    def comms_ok(self, vehicle_id: str) -> bool:
        return bool(self.current_frame and self.current_frame["comms"].get(vehicle_id, False))

    def truth_target(self) -> tuple[float, float] | None:
        truth = self.current_frame.get("evaluation_truth") if self.current_frame else None
        if truth is None:
            return None
        return (truth["lat"], truth["lon"]) if isinstance(truth, dict) else (truth[0], truth[1])

    async def close(self) -> None:
        if self._stream is not None:
            stream, self._stream = self._stream, None
            await asyncio.to_thread(stream.close)
