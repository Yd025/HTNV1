"""Bounded JSONL evidence logging; the control tick never waits for disk I/O."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
from pathlib import Path
import time
from typing import Any, BinaryIO
import uuid

SCHEMA = "overwatch.run"
SCHEMA_VERSION = 1
MAX_LINE_BYTES = 1024 * 1024
MAX_MANIFEST_BYTES = 16 * 1024


class RecordingError(ValueError):
    """A run cannot safely be recorded or replayed."""


class RunRecorder:
    """Single-event-loop producer with a bounded queue and background disk writes.

    The byte limit includes a reserved manifest budget. Any lost record makes
    the entire run incomplete; replay refuses it instead of hiding gaps.
    """

    def __init__(self, manifest: dict[str, Any], directory: str | Path,
                 max_bytes: int = 64 * 1024 * 1024, queue_size: int = 256) -> None:
        if max_bytes <= MAX_MANIFEST_BYTES or queue_size < 1:
            raise ValueError("recording requires a positive queue and >16 KiB byte budget")
        self.manifest = dict(manifest)
        run_id = str(self.manifest.get("run_id") or uuid.uuid4())
        if not run_id or run_id in {".", ".."} or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_." for c in run_id):
            raise ValueError("run_id must be a safe directory name")
        self.path = Path(directory) / run_id
        self.manifest.update({
            "schema": SCHEMA, "version": SCHEMA_VERSION, "run_id": run_id,
            "started_at": self.manifest.get("started_at", time.time()),
            "time_convention": {
                "recorded_at": "unix_seconds", "elapsed_s": "monotonic_run_seconds",
                "detection_timestamp": "unix_seconds; receipt approximation unless provenance says otherwise",
                "replay": "constant wall-clock rebase; original elapsed intervals",
            },
            "complete": False,
        })
        self.max_bytes = max_bytes
        self._queue: asyncio.Queue[bytes | None] = asyncio.Queue(maxsize=queue_size)
        self._worker_task: asyncio.Task[None] | None = None
        self._file: BinaryIO | None = None
        self._hash = hashlib.sha256()
        self._offered = self._written = self._bytes_offered = self._bytes_written = 0
        self._drops = 0
        self._error: str | None = None
        self._full = self._closed = self._closing = False

    @property
    def status(self) -> dict[str, Any]:
        return {
            "enabled": True, "run_id": self.manifest["run_id"], "path": str(self.path),
            "state": "error" if self._error else "full" if self._full else "closed" if self._closed else "recording" if self._worker_task else "pending",
            "accepted_records": self._offered, "written_records": self._written,
            "dropped_records": self._drops, "bytes_written": self._bytes_written,
            "max_bytes": self.max_bytes, "queue_depth": self._queue.qsize(),
            "complete": self._closed and not (self._error or self._drops), "error": self._error,
        }

    def _save_manifest(self, final: bool = False) -> None:
        data = dict(self.manifest)
        data.update({"complete": final and not (self._error or self._drops),
                     "recording": self.status, "tick_count": self._written,
                     "tick_bytes": self._bytes_written, "sha256": self._hash.hexdigest()})
        if final:
            data["closed_at"] = time.time()
        payload = json.dumps(data, allow_nan=False, indent=2).encode("utf-8")
        if len(payload) > MAX_MANIFEST_BYTES:
            raise RecordingError("manifest exceeds the reserved 16 KiB budget")
        pending = self.path / "manifest.tmp"
        with pending.open("wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        pending.replace(self.path / "manifest.json")

    def _open(self) -> None:
        self.path.mkdir(parents=True, exist_ok=False)
        self._save_manifest()
        self._file = (self.path / "ticks.jsonl").open("xb")

    async def start(self) -> None:
        if self._worker_task or self._closed:
            raise RuntimeError("recorder may only start once")
        opening = asyncio.create_task(asyncio.to_thread(self._open))
        try:
            await asyncio.shield(opening)
        except asyncio.CancelledError:
            # to_thread cannot stop an open already in progress. Join it before
            # cleanup, otherwise a late handle can escape shutdown.
            try:
                await opening
            except Exception:
                pass
            self._error = "start cancelled"
            self._closed = True
            if self._file is not None:
                await asyncio.to_thread(self._finish)
            raise
        except Exception as exc:
            self._error = f"start: {type(exc).__name__}: {exc}"
            raise
        self._worker_task = asyncio.create_task(self._drain(), name="run-recorder")

    def invalidate(self, reason: str) -> None:
        """Mark missing/partial control evidence without doing disk I/O."""
        if not self._closed:
            self._error = f"invalidated: {reason}"[:1024]

    def offer(self, record: dict[str, Any]) -> bool:
        """Snapshot an event and enqueue it without filesystem operations or awaits."""
        if not self._worker_task or self._closed or self._closing:
            return False
        if self._error or self._full:
            self._drops += 1
            return False
        try:
            payload = (json.dumps(record, allow_nan=False, separators=(",", ":")) + "\n").encode("utf-8")
        except (TypeError, ValueError) as exc:
            self._error = f"serialize: {exc}"
            self._drops += 1
            return False
        if len(payload) > MAX_LINE_BYTES or self._bytes_offered + len(payload) + MAX_MANIFEST_BYTES > self.max_bytes:
            self._full = True
            self._drops += 1
            return False
        try:
            self._queue.put_nowait(payload)
        except asyncio.QueueFull:
            self._drops += 1
            return False
        self._offered += 1
        self._bytes_offered += len(payload)
        return True

    def _write(self, payload: bytes) -> None:
        assert self._file is not None
        written = self._file.write(payload)
        if written != len(payload):
            raise OSError("short recording write")
        self._hash.update(payload)
        self._bytes_written += len(payload)
        self._written += 1

    async def _drain(self) -> None:
        while True:
            payload = await self._queue.get()
            try:
                if payload is None:
                    return
                if self._error:
                    self._drops += 1
                    continue
                try:
                    await asyncio.to_thread(self._write, payload)
                except Exception as exc:
                    self._error = f"write: {type(exc).__name__}: {exc}"
                    self._drops += 1
            finally:
                self._queue.task_done()

    def _finish(self) -> None:
        try:
            if self._file is not None:
                self._file.flush()
                os.fsync(self._file.fileno())
        except Exception as exc:
            self._error = f"flush: {type(exc).__name__}: {exc}"
        finally:
            if self._file is not None:
                self._file.close()
                self._file = None
        self._closed = True
        try:
            self._save_manifest(final=True)
        except Exception as exc:
            # The initial manifest remains incomplete if finalization fails.
            self._error = f"manifest: {type(exc).__name__}: {exc}"

    async def close(self) -> None:
        if self._closed:
            return
        self._closing = True
        if self._worker_task:
            await self._queue.put(None)
            await self._worker_task
            await asyncio.to_thread(self._finish)
        else:
            self._closed = True
