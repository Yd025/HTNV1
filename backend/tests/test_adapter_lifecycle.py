"""Adapter lifecycle regression checks; no network or simulator is used."""

import asyncio
import os
import threading
import unittest
from unittest.mock import AsyncMock, Mock, patch

from mavlink_connection import MavlinkBridge
from sim.cameras import MjpegTap
from sim.local_sitl import LocalSitlAdapter
from sim.types import Detection
from sim.whiteout import WhiteoutAdapter


class AdapterLifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_local_defaults_to_offline_synthetic_mode(self):
        with patch.dict(os.environ, {}, clear=True):
            adapter = LocalSitlAdapter()
        self.assertEqual(adapter.mode, "synthetic")
        with patch("mavlink_connection.MavlinkBridge", side_effect=AssertionError("network")):
            await adapter.connect()
        self.assertEqual(len(await adapter.list_vehicles()), 5)
        await adapter.close()

    async def test_local_sitl_is_labeled_hybrid(self):
        with patch.dict(os.environ, {"FORCE_KINEMATIC": "0"}):
            adapter = LocalSitlAdapter()
        self.assertEqual(adapter.mode, "hybrid")

    async def test_local_closes_all_bridges_once(self):
        adapter = LocalSitlAdapter()
        bridges = [Mock(close=AsyncMock()), Mock(close=AsyncMock())]
        adapter._bridges = dict(zip(("plane-1", "copter-1"), bridges))
        await adapter.close()
        await adapter.close()
        for bridge in bridges:
            bridge.close.assert_awaited_once()
        self.assertEqual(adapter._bridges, {})
        self.assertFalse(adapter.comms_ok("plane-1"))

    async def test_whiteout_drains_fresh_observations_once(self):
        adapter = WhiteoutAdapter()
        recent = Detection("tower-1", 72.0, -94.0, "vessel", 0.8, 99.0)
        stale = Detection("tower-2", 72.0, -94.0, "vessel", 0.8, 94.0)
        adapter._dets = [recent, stale]
        with patch("sim.whiteout.time.time", return_value=100.0):
            self.assertEqual(await adapter.poll_detections(), [recent])
            self.assertEqual(await adapter.poll_detections(), [])

    async def test_empty_camera_scan_clears_prior_observations(self):
        adapter = WhiteoutAdapter()
        adapter._dets = [Detection("tower-1", 72.0, -94.0, "vessel", 0.8, 99.0)]
        with patch("sim.whiteout.grab_jpeg", new=AsyncMock(return_value=None)):
            await adapter._scan_cameras(Mock())
        self.assertEqual(adapter._dets, [])

    async def test_whiteout_closes_camera_worker_and_bridges(self):
        adapter = WhiteoutAdapter()
        bridge = Mock(close=AsyncMock())
        adapter._bridges = {"tower-1": bridge}
        adapter._last_ok["tower-1"] = True
        task = asyncio.create_task(asyncio.Event().wait())
        adapter._cam_task = task
        await asyncio.sleep(0)
        await adapter.close()
        await adapter.close()
        self.assertEqual(adapter.mode, "live")
        self.assertTrue(task.cancelled())
        self.assertIsNone(adapter._cam_task)
        bridge.close.assert_awaited_once()
        self.assertFalse(adapter.comms_ok("tower-1"))

    async def test_bridge_close_stops_pump_and_closes_transport_once(self):
        bridge = MavlinkBridge()
        connection = Mock()
        bridge.conn = connection
        bridge.connected = True
        task = asyncio.create_task(asyncio.Event().wait())
        bridge._pump_task = task
        await asyncio.sleep(0)
        await bridge.close()
        await bridge.close()
        self.assertTrue(task.cancelled())
        self.assertFalse(bridge.is_connected())
        self.assertIsNone(bridge.conn)
        self.assertIsNone(bridge._pump_task)
        connection.close.assert_called_once()

    async def test_camera_tap_close_stops_streams_and_clears_frames(self):
        tap = MjpegTap()
        task = asyncio.create_task(asyncio.Event().wait())
        tap._tasks["tower-1"] = task
        tap.latest["tower-1"] = b"\xff\xd8frame\xff\xd9"
        await asyncio.sleep(0)
        await tap.close()
        await tap.close()
        self.assertTrue(task.cancelled())
        self.assertEqual(tap._tasks, {})
        self.assertIsNone(tap.get("tower-1"))

    async def test_whiteout_close_cancels_reconnect_before_closing_bridges(self):
        adapter = WhiteoutAdapter()
        started = asyncio.Event()
        late_bridge = Mock(close=AsyncMock())

        async def reconnect():
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                adapter._bridges["tower-1"] = late_bridge

        task = asyncio.create_task(reconnect())
        adapter._reconnect_tasks["tower-1"] = task
        adapter._reconnecting.add("tower-1")
        await started.wait()
        with patch.object(adapter._taps, "close", new=AsyncMock()) as close_taps:
            await adapter.close()
        self.assertTrue(task.cancelled())
        close_taps.assert_awaited_once()
        late_bridge.close.assert_awaited_once()
        self.assertEqual(adapter._reconnect_tasks, {})
        self.assertEqual(adapter._reconnecting, set())
        # Read-only fleet inspection after shutdown must not restart networking.
        with patch.object(adapter, "_reconnect", new=AsyncMock()) as restart:
            await adapter.list_vehicles()
            await asyncio.sleep(0)
        restart.assert_not_awaited()

    async def test_cancelled_connection_attempt_closes_late_transport(self):
        bridge = MavlinkBridge()
        connection = Mock()
        started = threading.Event()
        release = threading.Event()

        def connect_blocking():
            started.set()
            release.wait(timeout=2.0)
            return connection

        with patch.object(bridge, "_connect_blocking", side_effect=connect_blocking):
            task = asyncio.create_task(bridge.connect())
            self.assertTrue(await asyncio.to_thread(started.wait, 1.0))
            task.cancel()
            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await task
        connection.close.assert_called_once()
        self.assertFalse(bridge.is_connected())

    async def test_cleanup_failure_does_not_leave_other_bridges_open(self):
        adapter = LocalSitlAdapter()
        broken = Mock(close=AsyncMock(side_effect=OSError("socket closed")))
        healthy = Mock(close=AsyncMock())
        adapter._bridges = {"plane-1": broken, "copter-1": healthy}
        with self.assertLogs("overwatch.local_sitl", level="WARNING"):
            await adapter.close()
        healthy.close.assert_awaited_once()
        self.assertEqual(adapter._bridges, {})


if __name__ == "__main__":
    unittest.main()
