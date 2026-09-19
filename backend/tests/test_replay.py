import asyncio
from dataclasses import asdict
import json
import os
import tempfile
import threading
import time
import unittest
from unittest.mock import AsyncMock, patch

from recording import RecordingError, RunRecorder
from replay import ReplayAdapter
from sim.types import Arena, Command, Detection, TowerMount, VehicleState


class ReplayTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.arena = Arena(74.0, -94.0, 1000, towers=[TowerMount("tower", 74.0, -94.0, 90)])

    def frame(self, sequence=0, elapsed=0.0):
        stamp = 1000.0 + elapsed
        detection = Detection("camera-1", 74.0, -94.0, "vessel", 0.9, stamp - 0.25,
                              observation_id=f"camera-1:{sequence}", frame_id=str(sequence),
                              provenance="test-camera")
        return {"sequence": sequence, "elapsed_s": elapsed, "recorded_at": stamp,
                "vehicles": [VehicleState("plane", 1, "plane", 74.0, -94.0).as_dict()],
                "detections": [detection.as_dict()], "comms": {"plane": sequence == 0},
                "accepted": [detection.observation_id], "rejected": [],
                "commands": [], "outcomes": [], "evaluation_truth": [74.01, -94.01],
                "advisor": {"role_bias": {"plane": "search"}}}

    async def record(self, frames=None):
        recorder = RunRecorder({"mode": "synthetic", "source": "local", "settings": {},
                                "arena": asdict(self.arena)}, self.temp.name)
        await recorder.start()
        for frame in frames if frames is not None else [self.frame(), self.frame(1, 0.1)]:
            self.assertTrue(recorder.offer(frame))
        await recorder.close()
        return recorder.path

    async def test_same_adapter_contract_preserves_inputs_and_captures_commands(self):
        replay = ReplayAdapter(await self.record(), pace=False)
        self.addAsyncCleanup(replay.close)
        await replay.connect()
        self.assertEqual(replay.mode, "replay")
        self.assertEqual(replay.arena(), self.arena)
        self.assertEqual(replay.manifest["source"], "local")
        self.assertEqual(await replay.poll_detections(), [])
        vehicles = await replay.list_vehicles()
        self.assertEqual(vehicles[0].vehicle_id, "plane")
        detections = await replay.poll_detections()
        self.assertEqual(detections[0].observation_id, "camera-1:0")
        self.assertEqual(detections[0].provenance, "test-camera")
        self.assertAlmostEqual(time.time() - detections[0].timestamp, 0.25, delta=0.1)
        self.assertEqual(await replay.poll_detections(), [])
        self.assertTrue(replay.comms_ok("plane"))
        self.assertFalse(replay.comms_ok("unknown"))
        self.assertEqual(replay.truth_target(), (74.01, -94.01))
        self.assertEqual(replay.current_advisor, {"role_bias": {"plane": "search"}})
        await replay.send_command(Command("plane", "hold"))
        self.assertEqual(replay.captured_commands[-1]["command"]["type"], "hold")
        self.assertEqual(replay.captured_commands.maxlen, 1024)
        await replay.list_vehicles()
        next_detections = await replay.poll_detections()
        self.assertAlmostEqual(next_detections[0].timestamp - detections[0].timestamp, 0.1, delta=0.000001)
        self.assertFalse(replay.comms_ok("plane"))
        self.assertEqual(replay.elapsed_s, 0.1)
        with self.assertRaises(StopAsyncIteration):
            await replay.list_vehicles()
        self.assertTrue(replay.eof)

    async def test_recorded_pacing_uses_elapsed_offsets(self):
        replay = ReplayAdapter(await self.record([self.frame(0, 2.0), self.frame(1, 2.4)]))
        self.addAsyncCleanup(replay.close)
        await replay.connect()
        with patch("replay.asyncio.sleep", new_callable=AsyncMock) as sleep:
            await replay.list_vehicles()
            await replay.list_vehicles()
            sleep.assert_awaited_once()
            self.assertAlmostEqual(sleep.await_args.args[0], 0.4, delta=0.05)

    async def test_rejected_measurements_remain_available_to_same_input_gate(self):
        frame = self.frame()
        frame["detections"][0]["lat"] = 99.0
        frame["accepted"] = []
        frame["rejected"] = [{"observation_id": "camera-1:0", "reason": "invalid_measurement"}]
        replay = ReplayAdapter(await self.record([frame]), pace=False)
        self.addAsyncCleanup(replay.close)
        await replay.connect()
        await replay.list_vehicles()
        detections = await replay.poll_detections()
        self.assertEqual(detections[0].lat, 99.0)
        self.assertEqual(replay.current_frame["rejected"], frame["rejected"])

    async def test_receipt_clock_preserves_freshness_in_unpaced_replay(self):
        replay = ReplayAdapter(await self.record([self.frame(0), self.frame(1, 50)]), pace=False)
        self.addAsyncCleanup(replay.close)
        await replay.connect()
        await replay.list_vehicles()
        first_now = replay.observation_now
        await replay.list_vehicles()
        detection = (await replay.poll_detections())[0]
        self.assertAlmostEqual(replay.observation_now - first_now, 50)
        self.assertAlmostEqual(replay.observation_now - detection.timestamp, 0.25)

    async def test_default_local_brain_records_and_replays_without_advisor(self):
        from brain import SwarmBrain
        from sim.local_sitl import LocalSitlAdapter

        with patch.dict(os.environ, {"RUN_LOG_DIR": self.temp.name, "FORCE_KINEMATIC": "1"}):
            original = SwarmBrain(LocalSitlAdapter())
            self.addAsyncCleanup(original.close)
            await original.connect()
            source_state = await original.tick()
            path = original.recorder.path
            await original.close()
        with patch.dict(os.environ, {"RUN_LOG_DIR": ""}):
            replayed = SwarmBrain(ReplayAdapter(path, pace=False))
            self.addAsyncCleanup(replayed.close)
            await replayed.connect()
            replay_state = await replayed.tick()
            self.assertIsNone(replay_state["advisor"])
            self.assertEqual(replay_state["run"]["mode"], "replay")
            self.assertEqual(set(replay_state["fleet"]), set(source_state["fleet"]))
            self.assertEqual(replay_state["observations"]["forwarded"], source_state["observations"]["forwarded"])
            self.assertEqual(replay_state["truth"], source_state["truth"])

    async def test_incomplete_and_corrupt_runs_are_rejected_before_inputs(self):
        path = await self.record()
        manifest_path = path / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["complete"] = False
        manifest_path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(RecordingError, "incomplete"):
            await ReplayAdapter(path).connect()
        manifest["complete"] = True
        manifest_path.write_text(json.dumps(manifest))
        ticks_path = path / "ticks.jsonl"
        ticks_path.write_bytes(ticks_path.read_bytes()[:-2])
        with self.assertRaisesRegex(RecordingError, "truncated"):
            await ReplayAdapter(path).connect()

    async def test_frame_gaps_invalid_schema_and_missing_inputs_fail_closed(self):
        path = await self.record([self.frame(0), self.frame(2, 0.2)])
        with self.assertRaisesRegex(RecordingError, "out-of-order"):
            await ReplayAdapter(path).connect()
        missing = self.frame()
        del missing["comms"]
        path = await self.record([missing])
        with self.assertRaisesRegex(RecordingError, "communications"):
            await ReplayAdapter(path).connect()
        path = await self.record()
        manifest_path = path / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        manifest["version"] = 999
        manifest_path.write_text(json.dumps(manifest))
        with self.assertRaisesRegex(RecordingError, "schema"):
            await ReplayAdapter(path).connect()

    async def test_integrity_mismatch_rejected_even_with_parseable_json(self):
        path = await self.record()
        ticks_path = path / "ticks.jsonl"
        ticks_path.write_bytes(ticks_path.read_bytes().replace(b"test-camera", b"fake-camera"))
        with self.assertRaisesRegex(RecordingError, "integrity"):
            await ReplayAdapter(path).connect()

    async def test_cancelled_connect_closes_late_replay_handle(self):
        replay = ReplayAdapter(await self.record())
        entered, release = threading.Event(), threading.Event()
        original_open = replay._open_validated

        def delayed_open():
            entered.set()
            release.wait(timeout=2)
            original_open()

        with patch.object(replay, "_open_validated", side_effect=delayed_open):
            task = asyncio.create_task(replay.connect())
            self.assertTrue(await asyncio.to_thread(entered.wait, 1))
            task.cancel()
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertIsNone(replay._stream)


if __name__ == "__main__":
    unittest.main()
