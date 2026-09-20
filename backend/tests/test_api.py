"""Lifecycle and optional-consumer checks; no simulator or provider is contacted."""

from __future__ import annotations

import asyncio
import importlib
import time
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

import main
from brain import SwarmBrain
from sim.types import Arena, Detection, VehicleState


class FakeAdapter:
    name = "test-local"
    mode = "synthetic"

    def __init__(self, *, fail_connect: bool = False, wait_connect: bool = False):
        self.connects = 0
        self.closes = 0
        self.polls = 0
        self.commands = []
        self.fail_connect = fail_connect
        self.wait_connect = wait_connect

    async def connect(self):
        self.connects += 1
        if self.fail_connect:
            raise ConnectionError("fixture unavailable")
        if self.wait_connect:
            await asyncio.Event().wait()

    async def close(self):
        self.closes += 1

    def arena(self):
        return Arena(74.6973, -94.8297, 1500)

    async def list_vehicles(self):
        return [VehicleState("plane-1", 1, "plane", 74.6973, -94.8297, alt=90)]

    async def poll_detections(self):
        self.polls += 1
        return []

    async def send_command(self, command):
        self.commands.append(command)

    def comms_ok(self, _vehicle_id):
        return True

    def truth_target(self):
        return None


class PausedBrain(SwarmBrain):
    """Run the real controller once, then freeze it to detect HTTP side effects."""

    async def run_forever(self, on_state=None):
        await self.connect()
        on_state(await self.tick())
        await asyncio.Event().wait()


def wait_for_health(client, expected):
    deadline = time.monotonic() + 2
    while time.monotonic() < deadline:
        health = client.get("/health").json()
        if health["backend"] == expected:
            return health
        time.sleep(0.005)
    raise AssertionError(f"backend never reached {expected}: {health}")


class APILifecycleTests(unittest.TestCase):
    def setUp(self):
        self.disable_db = patch("main.db.enabled", return_value=False)
        self.disable_db.start()
        self.log_env = patch.dict("os.environ", {"RUN_LOG_DIR": ""})
        self.log_env.start()

    def tearDown(self):
        self.disable_db.stop()
        self.log_env.stop()

    def test_import_does_not_build_or_connect_an_adapter(self):
        with patch("brain.build_adapter", side_effect=AssertionError("import constructed adapter")):
            importlib.reload(main)
        self.assertFalse(hasattr(main, "hub"))

    def test_read_routes_and_websocket_do_not_poll_or_actuate(self):
        adapter = FakeAdapter()
        brain = PausedBrain(adapter)
        with patch("main.SwarmBrain", return_value=brain), TestClient(main.app) as client:
            health = wait_for_health(client, "ok")
            self.assertTrue(health["deployed"])
            before = (adapter.polls, len(adapter.commands))
            self.assertGreater(before[1], 0)
            for _ in range(3):
                self.assertEqual(client.get("/telemetry/latest").json()["type"], "state")
                self.assertEqual(client.get("/strategy/latest").json(), {"status": "none"})
                self.assertEqual(client.get("/cameras").json(), [])
                self.assertEqual(client.get("/cameras/quadcopter/snapshot.jpg").status_code, 404)
                self.assertFalse(client.get("/health").json()["postgres"])
            with client.websocket_connect("/ws/telemetry") as websocket:
                self.assertEqual(websocket.receive_json()["type"], "state")
            self.assertEqual((adapter.polls, len(adapter.commands)), before)
            hub = main.app.state.hub
        self.assertEqual(adapter.closes, 1)
        self.assertFalse(hub.tasks)
        self.assertFalse(hub.clients)
        self.assertIsNone(main.app.state.hub)

    def test_restart_creates_fresh_brain_world_and_hub(self):
        created = []

        def factory():
            brain = PausedBrain(FakeAdapter())
            created.append(brain)
            return brain

        hubs = []
        with patch("main.SwarmBrain", side_effect=factory):
            for _ in range(2):
                with TestClient(main.app) as client:
                    wait_for_health(client, "ok")
                    hubs.append(main.app.state.hub)
        self.assertIsNot(hubs[0], hubs[1])
        self.assertIsNot(created[0].world, created[1].world)
        self.assertEqual([brain.adapter.connects for brain in created], [1, 1])
        self.assertEqual([brain.adapter.closes for brain in created], [1, 1])

    def test_warming_failed_and_stale_are_not_deployed(self):
        for adapter, expected in ((FakeAdapter(wait_connect=True), "warming"), (FakeAdapter(fail_connect=True), "failed")):
            with self.subTest(expected=expected):
                with patch("main.SwarmBrain", return_value=PausedBrain(adapter)), TestClient(main.app) as client:
                    health = wait_for_health(client, expected)
                    self.assertFalse(health["deployed"])
                    self.assertEqual(client.get("/telemetry/latest").json()["status"], expected)
                    self.assertEqual(client.post("/strategy/run").status_code, 503)
                self.assertEqual(adapter.closes, 1)
        with patch("main.SwarmBrain", return_value=PausedBrain(FakeAdapter())), TestClient(main.app) as client:
            wait_for_health(client, "ok")
            main.app.state.hub.last_state_at -= main.STATE_STALE_S + 1
            self.assertEqual(client.get("/health").json()["backend"], "stale")
            self.assertFalse(client.get("/telemetry/latest").json()["deployed"])

    def test_replay_completion_and_advisor_guard(self):
        brain = PausedBrain(FakeAdapter())
        brain.mode = "replay"
        # Test only API policy; the replay adapter/controller path has separate tests.
        async def run(on_state):
            brain.connected = True
            on_state({"type": "state", "fleet": {}, "deployed": True})
            brain.completed = True
        brain.run_forever = run
        with (
            patch("main.db.enabled", return_value=True),
            patch("main.db.init_pool", AsyncMock()) as init_db,
            patch("main.SwarmBrain", return_value=brain),
            TestClient(main.app) as client,
        ):
            self.assertFalse(wait_for_health(client, "complete")["deployed"])
            self.assertEqual(client.get("/health").json()["database_status"], "disabled")
            self.assertEqual(client.post("/strategy/run").status_code, 409)
            with client.websocket_connect("/ws/telemetry") as websocket:
                last = websocket.receive_json()
            self.assertEqual(last["status"], "complete")
            self.assertFalse(last["deployed"])
            init_db.assert_not_called()

    def test_running_websocket_receives_terminal_status_and_recorder_result(self):
        for fail, expected in ((False, "complete"), (True, "failed")):
            with self.subTest(expected=expected):
                brain = PausedBrain(FakeAdapter())
                release = None

                async def run(on_state):
                    nonlocal release
                    release = asyncio.Event()
                    brain.connected = True
                    on_state({"type": "state", "fleet": {}, "deployed": True, "run": {"run_id": "fixture-run"}})
                    await release.wait()
                    if fail:
                        raise RuntimeError("fixture runtime failed")
                    brain.completed = True
                    brain.recorder = SimpleNamespace(
                        status={"enabled": True, "closed": True, "dropped": 2},
                        close=AsyncMock(),
                    )

                brain.run_forever = run
                with patch("main.SwarmBrain", return_value=brain), TestClient(main.app) as client:
                    wait_for_health(client, "ok")
                    with client.websocket_connect("/ws/telemetry") as websocket:
                        self.assertTrue(websocket.receive_json()["deployed"])
                        client.portal.call(release.set)
                        terminal = websocket.receive_json()
                    self.assertEqual(terminal["status"], expected)
                    self.assertFalse(terminal["deployed"])
                    health = client.get("/health").json()
                    self.assertEqual(health["run"]["run_id"], "fixture-run")
                    if not fail:
                        self.assertEqual(terminal["recording"]["dropped"], 2)
                        self.assertTrue(health["recording"]["closed"])

    def test_optional_database_failure_does_not_prevent_startup(self):
        with (
            patch("main.db.enabled", return_value=True),
            patch("main.db.init_pool", AsyncMock(side_effect=ConnectionError("fixture db offline"))),
            patch("main.db.close_pool", AsyncMock()),
            patch("main.SwarmBrain", return_value=PausedBrain(FakeAdapter())),
            TestClient(main.app) as client,
        ):
            health = wait_for_health(client, "ok")
            self.assertTrue(health["deployed"])
            deadline = time.monotonic() + 1
            while time.monotonic() < deadline and health["database_status"] != "unavailable":
                health = client.get("/health").json()
            self.assertEqual(health["database_status"], "unavailable")

    def test_camera_measurement_reaches_real_tracker_and_websocket(self):
        class CameraFixtureAdapter(FakeAdapter):
            mode = "live"

            async def list_vehicles(self):
                return [VehicleState("tower-1", 1, "tower", 74.6973, -94.8297, alt=120)]

            def camera_catalog(self):
                return [{"vehicle_id": "tower-1", "label": "test camera"}]

            async def poll_detections(self):
                self.polls += 1
                return [Detection(
                    "tower-1", 74.6975, -94.8295, "vessel", 0.85, time.time(),
                    observation_id="camera-fixture:1", frame_id="fixture-frame:1",
                    provenance="camera-fixture",
                )]

        adapter = CameraFixtureAdapter()
        brain = PausedBrain(adapter)
        with patch("main.SwarmBrain", return_value=brain), TestClient(main.app) as client:
            wait_for_health(client, "ok")
            with client.websocket_connect("/ws/telemetry") as websocket:
                state = websocket.receive_json()
            self.assertEqual(state["observations"]["forwarded"], 1)
            self.assertEqual(state["detections"][0]["observation_id"], "camera-fixture:1")
            self.assertAlmostEqual(state["track"]["lat"], 74.6975)
            self.assertAlmostEqual(state["track"]["lon"], -94.8295)
            self.assertEqual(state["c2"]["phase"], "tower_confirm")
            self.assertFalse(state["c2"]["mission_active"])
            self.assertIsNone(state["truth"])
            before = (adapter.polls, len(adapter.commands))
            with patch("sim.cameras.grab_jpeg", AsyncMock(return_value=b"\xff\xd8fixture")):
                response = client.get("/cameras/tower-1/snapshot.jpg")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers["content-type"], "image/jpeg")
            self.assertEqual((adapter.polls, len(adapter.commands)), before)

    def test_real_local_kinematic_lifespan_stream_and_cleanup(self):
        with patch.dict("os.environ", {"ADAPTER": "local", "FORCE_KINEMATIC": "1"}), TestClient(main.app) as client:
            self.assertTrue(wait_for_health(client, "ok")["deployed"])
            hub = main.app.state.hub
            with client.websocket_connect("/ws/telemetry") as websocket:
                first = websocket.receive_json()
                second = websocket.receive_json()
            self.assertEqual(first["run"]["mode"], "synthetic")
            self.assertTrue(first["run"]["evaluation_truth_available"])
            self.assertEqual(len(first["fleet"]), 5)
            self.assertGreater(second["run"]["sequence"], first["run"]["sequence"])
            self.assertEqual(client.get("/cameras").json(), [])
        self.assertFalse(hub.brain.connected)
        self.assertTrue(hub.brain._closed)
        self.assertFalse(hub.tasks)


class StubBrain:
    def __init__(self):
        self.world = SimpleNamespace(advisor={}, post=lambda *args: None)
        self.close = AsyncMock()
        self.connected = True
        self.completed = False
        self.last_error = None


class SlowSocket:
    def __init__(self, slow=False):
        self.slow = slow
        self.started = asyncio.Event()
        self.sent = []
        self.closed = False

    async def send_json(self, payload):
        self.started.set()
        if self.slow:
            await asyncio.Event().wait()
        self.sent.append(payload)

    async def close(self):
        self.closed = True


class ConsumerIsolationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.brain_patch = patch("main.SwarmBrain", StubBrain)
        self.brain_patch.start()
        self.hub = main.Hub()

    async def asyncTearDown(self):
        with patch("main.db.close_pool", AsyncMock()):
            await self.hub.close()
        self.brain_patch.stop()

    async def test_disconnect_scope_cancellation_awaits_websocket_cleanup(self):
        disconnect = asyncio.Event()
        closing = asyncio.Event()
        release_close = asyncio.Event()
        scope_ready = asyncio.Event()
        scopes = []

        class DisconnectSocket(SlowSocket):
            app = SimpleNamespace(state=SimpleNamespace(hub=self.hub))

            async def accept(self):
                pass

            async def receive_text(self):
                await disconnect.wait()
                raise main.WebSocketDisconnect()

            async def close(self):
                closing.set()
                await release_close.wait()
                self.closed = True

        socket = DisconnectSocket()

        async def endpoint():
            with main.anyio.CancelScope() as scope:
                scopes.append(scope)
                scope_ready.set()
                await main.ws_telemetry(socket)

        task = asyncio.create_task(endpoint())
        try:
            await asyncio.wait_for(scope_ready.wait(), 1)
            await asyncio.wait_for(socket.started.wait(), 1)
            disconnect.set()
            await asyncio.wait_for(closing.wait(), 1)
            # Starlette cancels its endpoint scope as soon as disconnect arrives.
            scopes[0].cancel()
            await asyncio.sleep(0)
            self.assertFalse(task.done(), "endpoint abandoned its socket cleanup")
            release_close.set()
            await asyncio.wait_for(task, 1)
            self.assertTrue(socket.closed)
            self.assertFalse(self.hub.clients)
            self.assertFalse(self.hub.tasks)
        finally:
            release_close.set()
            if not task.done():
                task.cancel()
            await asyncio.gather(task, return_exceptions=True)

    async def test_slow_database_and_socket_cannot_block_state_publish(self):
        slow = SlowSocket(slow=True)
        fast = SlowSocket()
        for socket in (slow, fast):
            queue = asyncio.Queue(maxsize=1)
            self.hub.clients[socket] = queue
            self.hub.start_task(self.hub.send_states(socket, queue), "test-socket")
        db_started = asyncio.Event()

        async def slow_ingest(_state):
            db_started.set()
            await asyncio.Event().wait()

        with (
            patch("main.db.init_pool", AsyncMock()),
            patch("main.db.ensure_schema", AsyncMock()),
            patch("main.db.close_pool", AsyncMock()),
            patch("main._ingest_state", side_effect=slow_ingest),
            patch("main.WS_TIMEOUT_S", 0.05),
            patch("main.DB_TIMEOUT_S", 0.05),
        ):
            self.hub.start_task(main._database_loop(self.hub), "test-db")
            self.hub.publish({"sequence": 0})
            await asyncio.wait_for(db_started.wait(), 1)
            await asyncio.wait_for(slow.started.wait(), 1)
            for number in range(1, 501):
                self.hub._last_db = float("-inf")
                self.hub.publish({"sequence": number})
            self.assertEqual(self.hub.latest["sequence"], 500)
            self.assertEqual(self.hub.db_queue.qsize(), 1)
            self.assertTrue(all(queue.qsize() <= 1 for queue in self.hub.clients.values()))
            await asyncio.sleep(0.08)
            self.assertEqual(fast.sent[-1]["sequence"], 500)
            self.assertTrue(slow.closed)
            self.assertNotIn(slow, self.hub.clients)
            self.assertEqual(self.hub.database_status, "unavailable")

    async def test_status_watcher_reports_tick_failure_stall_and_recovery_once(self):
        adapter = FakeAdapter()
        original_list = adapter.list_vehicles
        fault = None

        async def list_vehicles():
            if fault == "failed":
                raise ConnectionError("fixture tick failed")
            if fault == "stalled":
                await asyncio.Event().wait()
            return await original_list()

        adapter.list_vehicles = list_vehicles
        self.hub.brain = SwarmBrain(adapter)
        queue = asyncio.Queue(maxsize=1)
        self.hub.clients[object()] = queue
        with (
            patch.dict("os.environ", {"RUN_LOG_DIR": ""}),
            patch("brain.logger.exception"),
        ):
            self.hub.brain_task = self.hub.start_task(main._brain_loop(self.hub), "test-brain")
            self.hub.start_task(main._status_loop(self.hub), "test-status")
            first = await asyncio.wait_for(queue.get(), 1)
            self.assertEqual(first["status"], "ok")
            self.assertTrue(first["deployed"])

            fault = "failed"
            failed = await asyncio.wait_for(queue.get(), 1)
            self.assertEqual(failed["status"], "failed")
            self.assertFalse(failed["deployed"])
            await asyncio.sleep(0.3)
            self.assertTrue(queue.empty(), "unchanged failure must not repeat status frames")
            self.assertTrue(first["deployed"], "published snapshots must remain unchanged")

            fault = None
            recovered = await asyncio.wait_for(queue.get(), 1)
            self.assertEqual(recovered["status"], "ok")
            self.assertTrue(recovered["deployed"])

            fault = "stalled"
            self.hub.last_state_at -= main.STATE_STALE_S + 1
            stale = await asyncio.wait_for(queue.get(), 1)
            self.assertEqual(stale["status"], "stale")
            self.assertFalse(stale["deployed"])

    async def test_manual_and_background_advisor_share_one_truth_free_request(self):
        self.hub.latest = {
            "fleet": {"p": {"lat": 74, "lon": -94, "truth": "nested-secret"}},
            "track": {"lat": 75, "lon": -95, "truth": "nested-secret"},
            "truth": {"lat": 80}, "scores": {"track_error_m": 123},
        }
        started = asyncio.Event()
        release = asyncio.Event()
        calls = []

        async def advise(snapshot):
            calls.append(snapshot)
            started.set()
            await release.wait()
            return {"role_bias": {"plane": "search"}, "rationale": "test"}

        self.hub.dag = SimpleNamespace(advise=advise)
        background = asyncio.create_task(self.hub.advise())
        await started.wait()
        manual = asyncio.create_task(self.hub.advise())
        await asyncio.sleep(0)
        release.set()
        results = await asyncio.gather(background, manual)
        self.assertEqual(results[0], results[1])
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0], {"fleet": {"p": {"lat": 74, "lon": -94}}, "track": {"lat": 75, "lon": -95}})

    async def test_advisor_timeout_and_cancelled_caller_are_cleaned_up(self):
        started = asyncio.Event()

        async def advise(_snapshot):
            started.set()
            await asyncio.Event().wait()

        self.hub.dag = SimpleNamespace(advise=advise)
        with patch("main.ADVISOR_TIMEOUT_S", 0.02):
            with self.assertRaises(TimeoutError):
                await self.hub.advise()
        self.assertEqual(self.hub.advisor_status, "unavailable")
        started.clear()
        caller = asyncio.create_task(self.hub.advise())
        await started.wait()
        caller.cancel()
        await asyncio.gather(caller, return_exceptions=True)
        self.assertFalse(self.hub.advice_task.done())
        with patch("main.db.close_pool", AsyncMock()):
            await self.hub.close()
        self.assertTrue(self.hub.advice_task.cancelled())
        self.assertFalse(self.hub.tasks)


if __name__ == "__main__":
    unittest.main()
