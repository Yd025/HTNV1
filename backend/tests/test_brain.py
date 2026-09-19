import asyncio
import os
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from brain import SwarmBrain
from evidence import ObservationGate
from sim.adapter import build_adapter
from sim.types import Arena, Command, Detection, VehicleState


class FakeAdapter:
    name = "camera-test"
    mode = "live"

    def __init__(self):
        self.sent = []
        self.closed = False
        self.detection = Detection("tower-1", 74.6973, -94.8297, "vessel", .9, time.time(), observation_id="frame:1")

    async def connect(self):
        pass

    async def close(self):
        self.closed = True

    def arena(self):
        return Arena(74.6973, -94.8297, 1500)

    async def list_vehicles(self):
        return [VehicleState("tower-1", 1, "tower", 74.6973, -94.8297)]

    async def poll_detections(self):
        return [self.detection]

    async def send_command(self, command):
        self.sent.append(command.as_dict())

    def truth_target(self):
        return None

    def comms_ok(self, vehicle_id):
        return True


class BrainTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.env = patch.dict(os.environ, {"RUN_LOG_DIR": ""})
        self.env.start()
        self.adapter = FakeAdapter()
        self.brain = SwarmBrain(self.adapter)
        await self.brain.connect()
        self.brain.squad = SimpleNamespace(
            tick=lambda *_: SimpleNamespace(command=Command("tower-1", "hold"), calls=[]), intents=lambda: {})

    async def asyncTearDown(self):
        await self.brain.close()
        self.env.stop()

    async def test_camera_observation_reaches_existing_tracker_once(self):
        first = await self.brain.tick()
        second = await self.brain.tick()
        self.assertEqual(first["track"]["hits"], 1)
        self.assertEqual(second["track"]["hits"], 1)
        self.assertEqual(second["detections"], [])
        self.assertEqual(second["observations"]["rejected"][0]["reason"], "duplicate")
        self.assertEqual(first["detections"][0]["observation_id"], "frame:1")

    async def test_no_truth_means_no_measured_accuracy(self):
        state = await self.brain.tick()
        self.assertIsNone(state["scores"]["tracking"])
        self.assertIsNone(state["scores"]["track_error_m"])
        self.assertFalse(state["run"]["evaluation_truth_available"])
        self.assertIsNotNone(state["track"]["sigma_m"])

    async def test_command_suppression_refresh_and_change(self):
        await self.brain.tick()
        first_id = self.adapter.sent[-1]["command_id"]
        await self.brain.tick()
        self.assertEqual(len(self.adapter.sent), 1)
        self.assertEqual(self.brain.command_outcomes[0]["status"], "suppressed")
        signature, sent_at, command_id = self.brain._sent["tower-1"]
        self.brain._sent["tower-1"] = (signature, sent_at - 2, command_id)
        await self.brain.tick()
        self.assertEqual(len(self.adapter.sent), 2)
        self.assertEqual(self.adapter.sent[-1]["command_id"], first_id)
        self.brain.squad.tick = lambda *_: SimpleNamespace(command=Command("tower-1", "hold", alt=20), calls=[])
        await self.brain.tick()
        self.assertEqual(len(self.adapter.sent), 3)
        self.assertNotEqual(self.adapter.sent[-1]["command_id"], first_id)

    async def test_failed_dispatch_retries_with_same_identity(self):
        attempts = []
        async def fail(command):
            attempts.append(command.command_id)
            raise ConnectionError("offline")
        self.adapter.send_command = fail
        await self.brain.tick()
        await self.brain.tick()
        self.assertEqual(attempts[0], attempts[1])
        self.assertEqual(self.brain.score.commands_issued, 0)
        self.assertEqual(self.brain.command_outcomes[0]["status"], "dispatch_error")

    async def test_snapshots_are_reads_and_shutdown_cleans_adapter(self):
        state = await self.brain.tick()
        count = len(self.adapter.sent)
        for _ in range(10):
            self.assertEqual(self.brain.snapshot()["run"]["sequence"], state["run"]["sequence"])
        self.assertEqual(len(self.adapter.sent), count)
        await self.brain.close()
        await self.brain.close()
        self.assertTrue(self.adapter.closed)
        self.assertFalse(self.brain.connected)
        with self.assertRaises(RuntimeError):
            await self.brain.connect()

    async def test_cancelled_controller_closes_adapter(self):
        task = asyncio.create_task(self.brain.run_forever())
        await asyncio.sleep(.02)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(self.adapter.closed)

    def test_unknown_adapter_never_silently_falls_back(self):
        with self.assertRaises(ValueError):
            build_adapter("whietout")


class EvidenceTests(unittest.TestCase):
    def detection(self, **kwargs):
        values = dict(source_id="camera", lat=74., lon=-94., class_hint="vessel", confidence=.8, timestamp=100.)
        values.update(kwargs)
        return Detection(**values)

    def test_legacy_timestamp_identity_survives_new_objects(self):
        gate = ObservationGate()
        first, _ = gate.filter([self.detection()], 100., "live")
        second, rejected = gate.filter([self.detection()], 101., "live")
        self.assertEqual(len(first), 1)
        self.assertEqual(second, [])
        self.assertEqual(rejected[0]["reason"], "duplicate")

    def test_invalid_stale_and_wrong_clock_never_reach_tracker(self):
        gate = ObservationGate()
        observations = [self.detection(timestamp=90), self.detection(lat=float("nan")),
                        self.detection(timestamp_basis="monotonic"), self.detection(coordinate_frame="polar_xy"),
                        self.detection(timestamp=110)]
        accepted, rejected = gate.filter(observations, 100., "live")
        self.assertFalse(accepted)
        self.assertEqual({x["reason"] for x in rejected}, {"stale", "invalid_measurement", "incompatible_clock", "incompatible_coordinates", "future_timestamp"})

    def test_dedup_memory_is_bounded(self):
        gate = ObservationGate(capacity=3)
        gate.filter([self.detection(observation_id=str(n)) for n in range(10)], 100., "synthetic")
        self.assertEqual(len(gate.seen), 3)


if __name__ == "__main__":
    unittest.main()
