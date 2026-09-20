"""Uninitialized Arctic position and reconnect-distance regressions."""

import time
import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from mavlink_connection import MavlinkBridge
from metrics import MetricsEngine
from sim.types import Command
from sim.whiteout import WhiteoutAdapter


class WhiteoutPositionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.adapter = WhiteoutAdapter()
        self.adapter._spec = [self.adapter._spec[0]]
        self.vid = "quadcopter"
        self.bridge = MavlinkBridge(vehicle_id=self.vid, expected_system=1)
        self.bridge.conn = Mock(target_system=1, target_component=1)
        self.bridge.connected = True
        self.bridge.last_heartbeat_at = time.monotonic()
        self.adapter._bridges[self.vid] = self.bridge

    async def asyncTearDown(self):
        await self.adapter.close()

    async def test_zero_startup_position_never_enters_planning_perception_or_distance(self):
        self.bridge._state.update(lat=0.0, lon=0.0, alt=0.0)
        metrics = MetricsEngine(self.adapter.arena())
        fleet = await self.adapter.list_vehicles()
        self.assertFalse(fleet[0].connected)
        self.assertTrue(fleet[0].mavlink, "Transport heartbeat can precede a usable position")
        self.assertFalse(self.adapter.comms_ok(self.vid))
        self.assertNotIn(self.vid, self.adapter._poses)
        self.assertNotEqual((fleet[0].lat, fleet[0].lon), (0.0, 0.0))
        metrics.update(fleet, None, None)
        self.assertEqual(metrics.score.cells_seen, 0)
        await self.adapter.send_command(Command(self.vid, "goto", 71.99, -94.82, 40))
        self.assertEqual(self.bridge.conn.mav.mock_calls, [])

        self.bridge._state.update(lat=71.9958, lon=-94.8393, alt=40.0)
        fleet = await self.adapter.list_vehicles()
        self.assertTrue(fleet[0].connected)
        self.assertTrue(self.adapter.comms_ok(self.vid))
        self.assertIn(self.vid, self.adapter._poses)
        metrics.update(fleet, None, None)
        self.assertEqual(metrics.score.meters_flown, 0)
        self.bridge._state["lat"] += .00001
        metrics.update(await self.adapter.list_vehicles(), None, None)
        self.assertGreater(metrics.score.meters_flown, 0)
        self.assertLess(metrics.score.meters_flown, 2)

    async def test_missing_position_after_valid_sample_does_not_count_placeholder_transit(self):
        metrics = MetricsEngine(self.adapter.arena())
        self.bridge._state.update(lat=71.99, lon=-94.82)
        metrics.update(await self.adapter.list_vehicles(), None, None)
        self.bridge._state.update(lat=None, lon=None)
        fleet = await self.adapter.list_vehicles()
        self.assertFalse(fleet[0].connected)
        self.assertNotIn(self.vid, self.adapter._poses)
        metrics.update(fleet, None, None)
        self.bridge._state.update(lat=71.9901, lon=-94.82)
        metrics.update(await self.adapter.list_vehicles(), None, None)
        self.assertEqual(metrics.score.meters_flown, 0)

    async def test_generic_bridge_preserves_valid_zero_coordinates(self):
        self.bridge._ingest_message("GLOBAL_POSITION_INT", SimpleNamespace(
            lat=0, lon=0, relative_alt=0, alt=0, hdg=0))
        self.assertEqual((self.bridge.snapshot()["lat"], self.bridge.snapshot()["lon"]), (0, 0))
        for latitude, longitude in [(0.0, -94.0), (72.0, 0.0)]:
            self.bridge._state.update(lat=latitude, lon=longitude)
            self.assertTrue((await self.adapter.list_vehicles())[0].connected)

    async def test_zero_battery_survives_telemetry_and_unknown_retains_default(self):
        self.bridge._state.update(lat=71.9958, lon=-94.8393, alt=40., battery_remaining=0.)
        self.assertEqual((await self.adapter.list_vehicles())[0].battery_remaining, 0.)
        self.bridge._state["battery_remaining"] = None
        self.assertEqual((await self.adapter.list_vehicles())[0].battery_remaining, 100.)


if __name__ == "__main__":
    unittest.main()
