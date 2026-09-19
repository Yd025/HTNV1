import asyncio
import json
import tempfile
import threading
import unittest
from unittest.mock import patch

from recording import MAX_MANIFEST_BYTES, RunRecorder


class RecordingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)

    async def test_roundtrip_snapshots_mutable_inputs_and_finalizes(self):
        recorder = RunRecorder({"run_id": "roundtrip"}, self.temp.name)
        await recorder.start()
        record = {"sequence": 0, "nested": [1]}
        self.assertTrue(recorder.offer(record))
        record["nested"].append(2)
        await recorder.close()
        await recorder.close()
        manifest = json.loads((recorder.path / "manifest.json").read_text())
        ticks = json.loads((recorder.path / "ticks.jsonl").read_text())
        self.assertTrue(manifest["complete"])
        self.assertEqual(manifest["tick_count"], 1)
        self.assertEqual(ticks["nested"], [1])
        self.assertTrue(recorder.status["complete"])
        self.assertFalse(recorder.offer({}))

    async def test_queue_overflow_is_explicit_and_invalidates_run(self):
        recorder = RunRecorder({"run_id": "overflow"}, self.temp.name, queue_size=1)
        await recorder.start()
        # No await between offers: worker cannot drain the queue in this turn.
        self.assertTrue(recorder.offer({"sequence": 0}))
        self.assertFalse(recorder.offer({"sequence": 1}))
        await recorder.close()
        manifest = json.loads((recorder.path / "manifest.json").read_text())
        self.assertFalse(manifest["complete"])
        self.assertEqual(recorder.status["dropped_records"], 1)

    async def test_byte_budget_bounds_file_and_stops_recording(self):
        limit = MAX_MANIFEST_BYTES + 64
        recorder = RunRecorder({"run_id": "full"}, self.temp.name, max_bytes=limit)
        await recorder.start()
        self.assertTrue(recorder.offer({"sequence": 0}))
        self.assertFalse(recorder.offer({"data": "x" * 100}))
        self.assertFalse(recorder.offer({"sequence": 1}))
        await recorder.close()
        self.assertEqual(recorder.status["state"], "full")
        self.assertFalse(recorder.status["complete"])
        self.assertLessEqual(sum(p.stat().st_size for p in recorder.path.iterdir()), limit)

    async def test_offer_never_writes_to_disk_and_disk_failure_is_reported(self):
        recorder = RunRecorder({"run_id": "disk-error"}, self.temp.name)
        await recorder.start()
        with patch.object(recorder, "_write", side_effect=OSError("disk unavailable")) as write:
            self.assertTrue(recorder.offer({"sequence": 0}))
            write.assert_not_called()
            await recorder.close()
        self.assertFalse(recorder.status["complete"])
        self.assertIn("disk unavailable", recorder.status["error"])
        self.assertFalse(json.loads((recorder.path / "manifest.json").read_text())["complete"])

    async def test_nonfinite_json_and_unsafe_run_names_fail_closed(self):
        with self.assertRaises(ValueError):
            RunRecorder({"run_id": "../escape"}, self.temp.name)
        recorder = RunRecorder({"run_id": "nan"}, self.temp.name)
        await recorder.start()
        self.assertFalse(recorder.offer({"confidence": float("nan")}))
        await recorder.close()
        self.assertEqual(recorder.status["state"], "error")
        self.assertFalse(recorder.status["complete"])

    async def test_partial_tick_invalidates_entire_run(self):
        recorder = RunRecorder({"run_id": "partial"}, self.temp.name)
        await recorder.start()
        self.assertTrue(recorder.offer({"sequence": 0}))
        recorder.invalidate("tick failed after partial dispatch")
        self.assertFalse(recorder.offer({"sequence": 1}))
        await recorder.close()
        self.assertFalse(json.loads((recorder.path / "manifest.json").read_text())["complete"])
        self.assertIn("partial dispatch", recorder.status["error"])

    async def test_cancelled_start_closes_late_open_and_marks_incomplete(self):
        recorder = RunRecorder({"run_id": "cancelled"}, self.temp.name)
        entered, release = threading.Event(), threading.Event()
        original_open = recorder._open

        def delayed_open():
            entered.set()
            release.wait(timeout=2)
            original_open()

        with patch.object(recorder, "_open", side_effect=delayed_open):
            task = asyncio.create_task(recorder.start())
            self.assertTrue(await asyncio.to_thread(entered.wait, 1))
            task.cancel()
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertIsNone(recorder._file)
        self.assertFalse(recorder.status["complete"])
        self.assertFalse(json.loads((recorder.path / "manifest.json").read_text())["complete"])


if __name__ == "__main__":
    unittest.main()
