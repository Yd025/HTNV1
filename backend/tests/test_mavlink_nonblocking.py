"""Receive-worker regressions; fake transports only, no simulator commands."""

import asyncio
import time
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from mavlink_connection import MavlinkBridge
from sim.whiteout import CAM_ALT_MSL, WhiteoutAdapter


class NonblockingMavlinkTests(unittest.IsolatedAsyncioTestCase):
    async def test_receive_worker_updates_pose_without_blocking_command_lock(self):
        loop = asyncio.get_running_loop()
        idle = asyncio.Event()
        position = SimpleNamespace(
            get_type=lambda: "GLOBAL_POSITION_INT",
            to_dict=lambda: {},
            get_srcSystem=lambda: 1, get_srcComponent=lambda: 1,
            lat=719959000, lon=-948391000, relative_alt=42000, hdg=12500,
        )
        pending = [position]
        receive_calls = []

        def receive(*, blocking, timeout=None):
            receive_calls.append((blocking, timeout))
            if pending:
                return pending.pop()
            loop.call_soon_threadsafe(idle.set)
            return None

        connection = Mock(target_system=1, target_component=1)
        connection.recv_match.side_effect = receive
        bridge = MavlinkBridge(vehicle_id="quadcopter")
        bridge.conn = connection
        bridge.connected = True
        bridge.last_heartbeat_at = time.monotonic()
        bridge._pump_task = asyncio.create_task(bridge._pump())
        try:
            await asyncio.wait_for(idle.wait(), timeout=1.0)
            await asyncio.wait_for(bridge.send_goto(71.99, -94.83, 40.0), timeout=1.0)
            self.assertEqual(bridge.snapshot()["lat"], 71.9959)
            self.assertEqual(bridge.snapshot()["alt"], 42.0)
            connection.mav.set_position_target_global_int_send.assert_called_once()
            self.assertTrue(receive_calls)
            self.assertTrue(all(not blocking and timeout is None for blocking, timeout in receive_calls))
        finally:
            await bridge.close()

    async def test_fleet_read_does_not_wait_on_transport_locks(self):
        adapter = WhiteoutAdapter()
        bridges = []
        for spec in adapter._spec:
            bridge = MavlinkBridge(vehicle_id=spec["vehicle_id"])
            bridge.conn = Mock()
            bridge.connected = True
            bridge.last_heartbeat_at = time.monotonic()
            bridge._state.update(lat=71.99, lon=-94.83, alt=25.0)
            await bridge._io_lock.acquire()
            bridges.append(bridge)
            adapter._bridges[spec["vehicle_id"]] = bridge
        try:
            fleet = await asyncio.wait_for(adapter.list_vehicles(), timeout=0.5)
            self.assertEqual(len(fleet), len(bridges))
            self.assertTrue(all(vehicle.connected for vehicle in fleet))
            for vehicle in fleet:
                self.assertEqual(vehicle.alt, CAM_ALT_MSL.get(vehicle.vehicle_id, 25.0))
            for bridge in bridges:
                bridge.conn.recv_match.assert_not_called()
        finally:
            for bridge in bridges:
                bridge._io_lock.release()
            await adapter.close()

    async def test_airborne_readiness_uses_latest_cached_pose(self):
        adapter = WhiteoutAdapter()
        spec = next(spec for spec in adapter._spec if spec["vehicle_id"] == "quadcopter")
        bridge = MavlinkBridge(vehicle_id="quadcopter")
        bridge.conn = Mock()
        bridge.connected = True
        bridge.last_heartbeat_at = time.monotonic()
        bridge._state.update(mode="GUIDED", armed=True, alt=20.0)
        await bridge._io_lock.acquire()
        try:
            ready = await asyncio.wait_for(adapter._advance(spec, bridge), timeout=0.5)
            self.assertTrue(ready)
            self.assertEqual(adapter._air["quadcopter"].phase, "ready")
            bridge.conn.recv_match.assert_not_called()
        finally:
            bridge._io_lock.release()
            await bridge.close()


if __name__ == "__main__":
    unittest.main()
