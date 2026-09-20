"""Exercise actual Sentry envelopes offline; no sponsor credentials or network."""
import asyncio
from datetime import datetime
import json
import os
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import sentry_sdk
from sentry_sdk.transport import Transport

from brain import SwarmBrain
from observability import MissionObserver, TickTiming, configure_sentry
from test_brain import FakeAdapter
from test_tower_handoff import MissionAdapter
from sim.types import Command


class MemoryTransport(Transport):
    def __init__(self):
        super().__init__()
        self.envelopes = []

    def capture_envelope(self, envelope):
        self.envelopes.append(envelope)

    def items(self, kind):
        return [json.loads(item.get_bytes()) for envelope in self.envelopes
                for item in envelope.items if item.headers["type"] == kind]


class ObservabilityTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.previous = sentry_sdk.get_client()
        self.transport = MemoryTransport()
        sentry_sdk.init(dsn="https://public@example.invalid/1", transport=self.transport,
                        default_integrations=False, traces_sample_rate=1, enable_logs=True)
        self.client = sentry_sdk.get_client()
        self.env = patch.dict(os.environ, {"RUN_LOG_DIR": ""})
        self.env.start()

    async def asyncTearDown(self):
        self.client.close()
        sentry_sdk.get_global_scope().set_client(self.previous)
        self.env.stop()

    async def test_real_brain_records_correlated_trace_and_logs_without_truth(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {"RUN_LOG_DIR": directory}):
            brain = SwarmBrain(FakeAdapter())
            try:
                await brain.connect()
                first = await brain.tick()
                second = await brain.tick()  # same frame: duplicate rejection
            finally:
                await brain.close()
            sentry_sdk.flush()
            records = [json.loads(line) for line in (Path(directory) / brain.run_id / "ticks.jsonl").read_text().splitlines()]
            self.assertEqual(records[0]["diagnostics"]["trace_id"], first["diagnostics"]["trace_id"])
            self.assertTrue(json.loads((Path(directory) / brain.run_id / "manifest.json").read_text())["complete"])
        transactions = self.transport.items("transaction")
        self.assertEqual(len(transactions), 2)
        transaction = transactions[0]
        self.assertEqual(transaction["contexts"]["trace"]["trace_id"], first["diagnostics"]["trace_id"])
        self.assertEqual(transaction["tags"]["run.id"], brain.run_id)
        self.assertTrue({"track.update", "adapter.detections", "roles.assign", "metrics.update"}
                        <= {span["op"] for span in transaction["spans"]})
        logs = [item for batch in self.transport.items("log") for item in batch["items"]]
        self.assertGreaterEqual(len(logs), 1)
        attributes = [{key: value["value"] for key, value in item["attributes"].items()} for item in logs]
        self.assertEqual(sum(item.get("window.rejected.duplicate", 0) for item in attributes), 1)
        self.assertEqual(sum(item["window.ticks"] for item in attributes), 2)
        self.assertTrue(all(item["run.id"] == brain.run_id for item in attributes))
        self.assertTrue(all(item["evaluation.truth_available"] is False for item in attributes))
        self.assertTrue(all("score.track_error_m" not in item for item in attributes))
        self.assertIn("track.lat", attributes[0])
        self.assertEqual(brain.observer.status["export_errors"], 0)
        self.assertEqual(second["observations"]["rejected"][0]["reason"], "duplicate")

    async def test_slow_export_does_not_block_tick_and_overflow_is_visible(self):
        brain = SwarmBrain(FakeAdapter())
        brain.observer = MissionObserver(brain.run_id, brain.mode, brain.adapter.name, queue_size=1)
        entered, release = threading.Event(), threading.Event()

        def blocked(_event):
            entered.set()
            release.wait(3)

        with patch.object(brain.observer, "_export", side_effect=blocked):
            try:
                await brain.connect()
                await brain.tick()
                self.assertTrue(await asyncio.to_thread(entered.wait, 1))
                # Both ticks finish while the exporter remains blocked.
                await asyncio.wait_for(brain.tick(), .5)
                await asyncio.wait_for(brain.tick(), .5)
                self.assertEqual(brain.observer.dropped, 1)
            finally:
                release.set()
                await brain.close()

    async def test_export_failure_isolated_from_controller(self):
        brain = SwarmBrain(FakeAdapter())
        with patch.object(brain.observer, "_export", side_effect=RuntimeError("transport failed")):
            try:
                await brain.connect()
                await brain.tick()
                await brain.observer._queue.join()
                self.assertEqual(brain.observer.export_errors, 1)
                self.assertEqual((await brain.tick())["type"], "state")
            finally:
                await brain.close()

    async def test_trace_uses_measured_time_and_dispatch_error_span(self):
        adapter = FakeAdapter()
        async def fail(_command):
            await asyncio.sleep(.12)
            raise ConnectionError("fixture")
        adapter.send_command = fail
        brain = SwarmBrain(adapter)
        brain.squad = SimpleNamespace(
            tick=lambda *_: SimpleNamespace(command=Command("tower-1", "hold"), calls=[]), intents=lambda: {})
        try:
            await brain.connect()
            state = await brain.tick()
        finally:
            await brain.close()
        sentry_sdk.flush()
        trace = self.transport.items("transaction")[0]
        self.assertTrue(state["diagnostics"]["over_budget"])
        sends = [span for span in trace["spans"] if span["op"] == "adapter.send"]
        self.assertEqual(sends[0]["status"], "internal_error")
        logs = [item for batch in self.transport.items("log") for item in batch["items"]]
        self.assertTrue(any(item["level"] == "warn" for item in logs))
        warning = next(item for item in logs if item["level"] == "warn")
        self.assertEqual(warning["attributes"]["window.last_error_type"]["value"], "ConnectionError")
        self.assertEqual(warning["attributes"]["window.slowest_trace_id"]["value"], state["diagnostics"]["trace_id"])
        self.assertAlmostEqual((datetime.fromisoformat(trace["timestamp"]) - datetime.fromisoformat(trace["start_timestamp"])).total_seconds(),
                               state["diagnostics"]["duration_ms"] / 1000, places=5)

    async def test_logs_survive_zero_trace_sampling(self):
        self.client.options["traces_sample_rate"] = 0
        brain = SwarmBrain(FakeAdapter())
        try:
            await brain.connect()
            await brain.tick()
        finally:
            await brain.close()
        sentry_sdk.flush()
        self.assertEqual(self.transport.items("transaction"), [])
        self.assertTrue(self.transport.items("log"))

    async def test_config_disables_invalid_sample_rate_without_crashing(self):
        with patch.dict(os.environ, {"SENTRY_DSN": "invalid", "SENTRY_TRACES_SAMPLE_RATE": "nan"}):
            with patch("sentry_sdk.init") as init:
                self.assertFalse(configure_sentry())
                init.assert_not_called()

    async def test_entrypoint_configuration_enables_both_products(self):
        initialize = sentry_sdk.init
        def offline_init(**options):
            return initialize(transport=self.transport, default_integrations=False, **options)
        with patch.dict(os.environ, {"SENTRY_DSN": "https://public@example.invalid/1",
                                      "SENTRY_TRACES_SAMPLE_RATE": "1"}):
            with patch("sentry_sdk.init", side_effect=offline_init):
                self.assertTrue(configure_sentry())
        configured = sentry_sdk.get_client()
        try:
            brain = SwarmBrain(FakeAdapter())
            try:
                await brain.connect()
                await brain.tick()
            finally:
                await brain.close()
            sentry_sdk.flush()
            self.assertTrue(self.transport.items("transaction"))
            self.assertTrue(self.transport.items("log"))
        finally:
            configured.close()
            sentry_sdk.get_global_scope().set_client(self.client)

    async def test_local_timing_does_not_call_sdk(self):
        with patch("sentry_sdk.start_transaction", side_effect=AssertionError("SDK on tick")):
            timing = TickTiming(100)
            with timing.span("track.update"):
                pass
            self.assertEqual(timing.snapshot()["stages"][0]["op"], "track.update")

    async def test_measured_controller_keeps_the_confirmed_tower_gate(self):
        adapter = MissionAdapter()
        for vehicle in adapter.vehicles:
            if vehicle.vehicle_class in {"plane", "copter"}:
                vehicle.alt = 0
                vehicle.armed = False
        brain = SwarmBrain(adapter)
        try:
            await brain.connect()
            for when, source in ((1000, "quad-alpha"), (1001, "mast-alpha"), (1002, "mast-alpha")):
                adapter.observation_now = float(when)
                adapter.elapsed_s = float(when - 1000)
                adapter.detections = [adapter.detection(source)]
                state = await brain.tick()
                if when < 1002:
                    self.assertFalse(state["c2"]["mission_active"])
                    self.assertFalse(any(command["vehicle_id"] in {"quad-alpha", "hawk-alpha"}
                                         for command in state["commands"]))
                else:
                    self.assertTrue(state["c2"]["mission_active"])
                    self.assertEqual(state["c2"]["phase"], "dispatch")
                    self.assertEqual(state["c2"]["handoff"]["state"], "pending")
                self.assertTrue({"track.update", "roles.assign", "agent.decide"}
                                <= {stage["op"] for stage in state["diagnostics"]["stages"]})
        finally:
            await brain.close()
        self.assertEqual(brain.observer.status["processed_ticks"], 3)

    async def test_yaw_only_change_dispatches_with_new_identity_and_a_measured_span(self):
        adapter = FakeAdapter()
        brain = SwarmBrain(adapter)
        yaw = 10
        brain.squad = SimpleNamespace(tick=lambda *_: SimpleNamespace(
            command=Command("tower-1", "hold", yaw_deg=yaw), calls=[]), intents=lambda: {})
        try:
            await brain.connect()
            first = await brain.tick()
            unchanged = await brain.tick()
            yaw = 30
            changed = await brain.tick()
        finally:
            await brain.close()
        self.assertEqual(len(adapter.sent), 2)
        self.assertEqual(unchanged["command_outcomes"][0]["status"], "suppressed")
        self.assertNotEqual(first["commands"][0]["command_id"], changed["commands"][0]["command_id"])
        self.assertEqual(changed["commands"][0]["yaw_deg"], 30)
        self.assertIn("adapter.send", {stage["op"] for stage in changed["diagnostics"]["stages"]})


if __name__ == "__main__":
    unittest.main()
