"""Lost-link regression checks with fake transports; no vehicle commands."""

import asyncio
import os
import time
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from pymavlink import mavutil

from mavlink_connection import MavlinkBridge
from sim.types import Detection, VehicleState
from sim.whiteout import WhiteoutAdapter, _fleet_spec


def heartbeat(*, system=1, component=1, kind=mavutil.mavlink.MAV_TYPE_QUADROTOR):
    return SimpleNamespace(type=kind, base_mode=0, custom_mode=0,
                           get_srcSystem=lambda: system, get_srcComponent=lambda: component)


class HeartbeatFreshnessTests(unittest.IsolatedAsyncioTestCase):
    async def test_first_foreign_heartbeat_cannot_select_wrong_vehicle(self):
        bridge = MavlinkBridge(expected_system=1)
        connection = Mock(target_system=0, target_component=0, flightmode="GUIDED")
        connection.wait_heartbeat.side_effect = [heartbeat(system=4), heartbeat(system=1)]
        with patch("mavlink_connection.mavutil.mavlink_connection", return_value=connection):
            with patch.object(bridge, "_pump", new=AsyncMock()):
                await bridge.connect()
        self.assertEqual(connection.wait_heartbeat.call_count, 2)
        self.assertEqual(connection.target_system, 1)
        self.assertEqual(bridge.snapshot()["sysid"], 1)
        self.assertTrue(bridge.is_connected())
        await bridge.close()

    async def test_foreign_position_and_attitude_cannot_contaminate_snapshot(self):
        bridge = MavlinkBridge(expected_system=1)
        bridge.conn = Mock(target_system=1, target_component=1)
        bridge.connected = True
        bridge.last_heartbeat_at = time.monotonic()
        bridge._state.update(lat=71.99, lon=-94.82, roll=.1, pitch=.2)
        for msg_type, fields in [
            ("GLOBAL_POSITION_INT", dict(lat=120000000, lon=340000000, alt=2000, relative_alt=3000, hdg=1200)),
            ("ATTITUDE", dict(roll=2.0, pitch=3.0)),
        ]:
            for system, component in [(4, 1), (1, 191)]:
                message = SimpleNamespace(get_type=lambda: msg_type,
                    get_srcSystem=lambda: system, get_srcComponent=lambda: component, **fields)
                bridge.conn.recv_match.return_value = message
                self.assertIsNone(await bridge.recv_sample(timeout=0))
        state = bridge.snapshot()
        self.assertEqual((state["lat"], state["lon"], state["roll"], state["pitch"]), (71.99, -94.82, .1, .2))
        await bridge.close()

    async def test_endpoint_override_keeps_explicit_fleet_identity(self):
        with patch.dict(os.environ, {"ARCTIC_QUAD": "udpout:example:15550"}, clear=True):
            specs = {spec["vehicle_id"]: spec for spec in _fleet_spec()}
        self.assertEqual({vid: spec["sysid"] for vid, spec in specs.items()},
                         {"quadcopter": 1, "fixed-wing": 2, "tower-1": 4, "tower-2": 5})
        self.assertEqual(specs["quadcopter"]["conn"], "udpout:example:15550")
        with patch.dict(os.environ, {"ARCTIC_QUAD_SYSID": "11"}, clear=True):
            self.assertEqual(_fleet_spec()[0]["sysid"], 11)
        with patch.dict(os.environ, {"ARCTIC_ROVER": "udpout:127.0.0.1:14600"}, clear=True):
            self.assertEqual(_fleet_spec()[-1]["sysid"], 6)

    async def test_connect_seeds_only_vehicle_heartbeat(self):
        bridge = MavlinkBridge(conn_str="udpout:127.0.0.1:14550")
        vehicle_hb = heartbeat()
        connection = Mock(target_system=1, target_component=1, flightmode="GUIDED",
                          messages={"HEARTBEAT": vehicle_hb})
        connection.wait_heartbeat.side_effect = [heartbeat(kind=mavutil.mavlink.MAV_TYPE_GCS), vehicle_hb]
        with patch("mavlink_connection.mavutil.mavlink_connection", return_value=connection):
            with patch.object(bridge, "_pump", new=AsyncMock()):
                await bridge.connect()
        self.assertEqual(connection.wait_heartbeat.call_count, 2)
        self.assertTrue(bridge.is_connected())
        self.assertIsNotNone(bridge.last_heartbeat_at)
        await bridge.close()

    async def test_missing_or_stale_heartbeat_blocks_all_command_forms(self):
        bridge = MavlinkBridge()
        bridge.conn = Mock(target_system=1, target_component=1)
        bridge.connected = True
        self.assertFalse(bridge.is_connected())
        bridge.last_heartbeat_at = time.monotonic() - 60
        self.assertFalse(bridge.is_connected())
        await bridge.send_goto(72, -94, 40)
        await bridge.send_plane_goto(72, -94, 90)
        await bridge.set_mode("GUIDED")
        await bridge.arm()
        await bridge.takeoff(40)
        await bridge.set_servo(1, 1500)
        await bridge.rc_override(1500)
        await bridge.set_param("TEST", 1)
        await bridge.set_roi(72, -94)
        self.assertEqual(bridge.conn.mav.mock_calls, [])
        await bridge.close()

    async def test_known_system_without_current_heartbeat_fails_startup(self):
        bridge = MavlinkBridge()
        connection = Mock(target_system=1, target_component=1)
        connection.wait_heartbeat.return_value = None
        with patch("mavlink_connection.mavutil.mavlink_connection", return_value=connection):
            with self.assertRaisesRegex(ConnectionError, "HEARTBEAT"):
                bridge._connect_blocking()
        connection.close.assert_called_once()
        self.assertIsNone(bridge.last_heartbeat_at)

    async def test_foreign_and_gcs_heartbeats_do_not_revive_link(self):
        bridge = MavlinkBridge()
        bridge.conn = Mock(target_system=1, target_component=1, flightmode="GUIDED")
        bridge.connected = True
        old = time.monotonic() - 60
        bridge.last_heartbeat_at = old
        for hb in [heartbeat(kind=mavutil.mavlink.MAV_TYPE_GCS), heartbeat(system=2), heartbeat(component=191)]:
            bridge._ingest_message("HEARTBEAT", hb)
            self.assertEqual(bridge.last_heartbeat_at, old)
            self.assertFalse(bridge.is_connected())
        bridge._ingest_message("HEARTBEAT", heartbeat())
        self.assertTrue(bridge.is_connected())
        await bridge.close()

    async def test_command_rechecks_freshness_after_waiting_for_lock(self):
        bridge = MavlinkBridge()
        bridge.conn = Mock(target_system=1, target_component=1)
        bridge.connected = True
        bridge.last_heartbeat_at = time.monotonic()
        await bridge._io_lock.acquire()
        command = asyncio.create_task(bridge.send_goto(72, -94, 40))
        await asyncio.sleep(0)
        bridge.last_heartbeat_at -= 60
        bridge._io_lock.release()
        await command
        bridge.conn.mav.set_position_target_global_int_send.assert_not_called()
        await bridge.close()

    async def test_receive_error_marks_transport_disconnected(self):
        bridge = MavlinkBridge()
        bridge.conn = Mock()
        bridge.connected = True
        bridge.last_heartbeat_at = time.monotonic()
        with patch.object(bridge, "recv_sample", new=AsyncMock(side_effect=OSError("lost transport"))):
            with self.assertLogs("overwatch.mavlink", level="WARNING"):
                await asyncio.wait_for(bridge._pump(), timeout=.5)
        self.assertFalse(bridge.is_connected())
        await bridge.close()

    async def test_send_error_marks_transport_disconnected(self):
        bridge = MavlinkBridge()
        bridge.conn = Mock()
        bridge.connected = True
        bridge.last_heartbeat_at = time.monotonic()
        bridge.conn.mav.set_position_target_global_int_send.side_effect = OSError("lost transport")
        with self.assertRaises(OSError):
            await bridge.send_goto(72, -94, 40)
        self.assertFalse(bridge.is_connected())
        await bridge.close()

    async def test_lost_link_clears_sensor_cache_and_reconnects_once(self):
        adapter = WhiteoutAdapter()
        adapter._spec = [adapter._spec[0]]
        vid = adapter._spec[0]["vehicle_id"]
        bridge = MavlinkBridge(vehicle_id=vid)
        bridge.conn = Mock()
        bridge.connected = True
        bridge.last_heartbeat_at = time.monotonic() - 60
        adapter._bridges[vid] = bridge
        adapter._last_ok[vid] = True
        adapter._poses[vid] = VehicleState(vid, 1, "copter", 72, -94, 40)
        adapter._attitude[vid] = (0, 0)
        adapter._alt_msl[vid] = 100
        adapter._look[vid] = (90, -10)
        adapter._tower_manual.add(vid)
        adapter._dets = [Detection(vid, 72, -94, "vessel", .9, time.time())]
        started = asyncio.Event()

        async def reconnect(_spec):
            started.set()
            await asyncio.Event().wait()

        with patch.object(adapter, "_connect_one", new=AsyncMock(side_effect=reconnect)) as connect:
            vehicles = await adapter.list_vehicles()
            await asyncio.wait_for(started.wait(), timeout=1)
            await adapter.list_vehicles()
            self.assertFalse(vehicles[0].connected)
            self.assertNotIn(vid, adapter._poses)
            self.assertNotIn(vid, adapter._alt_msl)
            self.assertNotIn(vid, adapter._attitude)
            self.assertNotIn(vid, adapter._look)
            self.assertNotIn(vid, adapter._tower_manual)
            self.assertEqual(await adapter.poll_detections(), [])
            connect.assert_awaited_once()
        await adapter.close()

    async def test_link_loss_during_inference_rejects_frozen_pose(self):
        adapter = WhiteoutAdapter()
        vid = "tower-1"
        connection = Mock(is_connected=Mock(return_value=True), close=AsyncMock())
        adapter._bridges[vid] = connection
        adapter._poses[vid] = VehicleState(vid, 1, "tower", 72, -94, 119.5)
        adapter._taps._receive(vid, b"frame")

        def detect(_jpeg):
            connection.is_connected.return_value = False
            return [Mock()]

        with patch.object(adapter._detector, "detect_jpeg", side_effect=detect):
            with patch("sim.whiteout.grab_jpeg", new=AsyncMock(return_value=None)):
                with patch("sim.whiteout.project_hit") as project:
                    await adapter._scan_cameras(Mock())
        project.assert_not_called()
        self.assertEqual(await adapter.poll_detections(), [])
        self.assertEqual(adapter._camera_status[vid]["state"], "pose_unavailable")
        await adapter.close()


if __name__ == "__main__":
    unittest.main()
