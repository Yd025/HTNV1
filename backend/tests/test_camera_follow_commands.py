"""Verified MAVLink wire forms and fixed-camera following; fake transports only."""

import math
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from agents.base import PlatformAgent
from agents.copter import CopterAgent
from behaviors.trees import camera_follow_wp
from geo import bearing_deg, haversine_m, ne_to_ll
from mavlink_connection import MavlinkBridge
from sim.cameras import QUAD_CAMERA_PITCH_DEG
from sim.types import Command, VehicleState
from sim.whiteout import TAKEOFF_RETRY_S, WhiteoutAdapter
from tracker import Track
from world import WorldModel


class WireCommandTests(unittest.IsolatedAsyncioTestCase):
    async def test_copter_position_mask_and_optional_yaw_radians(self):
        bridge = MavlinkBridge()
        bridge.conn = Mock(target_system=4, target_component=1)
        await bridge.send_goto(71.99, -94.82, 40)
        args = bridge.conn.mav.set_position_target_global_int_send.call_args.args
        self.assertEqual(args[3], 6)
        self.assertEqual(args[4], 3576)
        self.assertEqual(args[5:8], (719900000, -948200000, 40.0))
        await bridge.send_goto(71.99, -94.82, 40, yaw_deg=90)
        args = bridge.conn.mav.set_position_target_global_int_send.call_args.args
        self.assertEqual(args[4], 2552)
        self.assertAlmostEqual(args[14], math.pi / 2)
        self.assertEqual(args[15], 0)

    async def test_plane_uses_supported_guided_waypoint_with_correct_lat_lon_order(self):
        bridge = MavlinkBridge()
        bridge.conn = Mock(target_system=7, target_component=1)
        await bridge.send_plane_goto(71.99, -94.82, 90)
        args = bridge.conn.mav.mission_item_int_send.call_args.args
        self.assertEqual(args[:7], (7, 1, 0, 6, 16, 2, 0))
        self.assertEqual(args[11:14], (719900000, -948200000, 90.0))
        bridge.conn.mav.set_position_target_global_int_send.assert_not_called()

    async def test_whiteout_ground_to_air_paths_and_follow_commands_without_tower(self):
        class Bridge:
            def __init__(self):
                self.state = {"alt": 0, "armed": False, "mode": "MANUAL", "groundspeed": 0}
                self.calls = []
            def is_connected(self): return True
            def snapshot(self): return dict(self.state)
            async def set_mode(self, *args): self.calls.append(("mode", args))
            async def arm(self, *args, **kwargs): self.calls.append(("arm", args))
            async def rc_override(self, *args): self.calls.append(("rc", args))
            async def takeoff(self, *args, **kwargs): self.calls.append(("takeoff", args, kwargs))
            async def send_goto(self, *args, **kwargs): self.calls.append(("copter_goto", args, kwargs))
            async def send_plane_goto(self, *args): self.calls.append(("plane_goto", args))
        adapter = WhiteoutAdapter()
        clock = [100.0]
        bridges = {name: Bridge() for name in ("quadcopter", "fixed-wing")}
        adapter._bridges = bridges
        targets = {"quadcopter": Command("quadcopter", "goto", 71.99, -94.82, 40, yaw_deg=45),
                   "fixed-wing": Command("fixed-wing", "search_sector", 71.992, -94.825, 90)}
        schedules = {
            "quadcopter": [{}, {"mode": "GUIDED"}, {"mode": "GUIDED", "armed": True, "lat": 71.995, "lon": -94.84},
                           {"mode": "GUIDED", "armed": True, "alt": 20, "lat": 71.995, "lon": -94.84}],
            "fixed-wing": [{}, {"mode": "TAKEOFF", "armed": True, "lat": 71.996, "lon": -94.838},
                           {"mode": "TAKEOFF", "armed": True, "alt": 1, "lat": 71.996, "lon": -94.838},
                           {"mode": "TAKEOFF", "armed": True, "alt": 20, "lat": 71.996, "lon": -94.838}],
        }
        with patch("sim.whiteout.time", SimpleNamespace(monotonic=lambda: clock[0])):
            for tick in range(4):
                for name, bridge in bridges.items():
                    bridge.state.update(schedules[name][tick])
                    await adapter.send_command(targets[name])
                clock[0] += 2
            for name, bridge in bridges.items():
                self.assertEqual(adapter._air[name].phase, "ready")
                clock[0] += 2
                await adapter.send_command(targets[name])
                expected = "plane_goto" if name == "fixed-wing" else "copter_goto"
                self.assertEqual(bridge.calls[-1][0], expected)
                self.assertEqual(bridge.calls[-1][1], (targets[name].lat, targets[name].lon, targets[name].alt))
            self.assertEqual(bridges["quadcopter"].calls[-1][2], {"yaw_deg": 45})
            self.assertEqual(sum(1 for call in bridges["quadcopter"].calls if call[0] == "takeoff"), 1)
            # ArduPlane rejects NAV_TAKEOFF outside AUTO; TAKEOFF mode flies the climb.
            self.assertFalse(any(call[0] == "takeoff" for call in bridges["fixed-wing"].calls))
            self.assertFalse(any(call[0] == "rc" for call in bridges["fixed-wing"].calls))
            self.assertTrue(any(call[0] == "mode" and call[1][0] == "TAKEOFF" for call in bridges["fixed-wing"].calls))

    async def test_grounded_aircraft_launch_once_per_retry_window(self):
        class Bridge:
            def __init__(self, vehicle_id, mode):
                self.vehicle_id = vehicle_id
                self.state = {"mode": mode, "armed": True, "alt": 0, "lat": 71.995, "lon": -94.84}
                self.calls = []
            def is_connected(self): return True
            def snapshot(self): return dict(self.state)
            async def set_mode(self, *args): self.calls.append(("mode", args))
            async def arm(self, *args, **kwargs): self.calls.append(("arm", args))
            async def rc_override(self, *args): self.calls.append(("rc", args))
            async def takeoff(self, *args, **kwargs): self.calls.append(("takeoff", args, kwargs))
            async def send_goto(self, *args, **kwargs): self.calls.append(("copter_goto", args, kwargs))
            async def send_plane_goto(self, *args): self.calls.append(("plane_goto", args))
        adapter = WhiteoutAdapter()
        clock = [50.0]
        bridges = {"quadcopter": Bridge("quadcopter", "GUIDED"), "fixed-wing": Bridge("fixed-wing", "TAKEOFF")}
        adapter._bridges = bridges
        dummy = {"quadcopter": Command("quadcopter", "goto", 71.99, -94.82, 40),
                 "fixed-wing": Command("fixed-wing", "search_sector", 71.992, -94.825, 90)}
        with patch("sim.whiteout.time", SimpleNamespace(monotonic=lambda: clock[0])):
            for _ in range(6):
                for name, bridge in bridges.items():
                    await adapter.send_command(dummy[name])
                clock[0] += 2
            self.assertEqual(sum(1 for c in bridges["quadcopter"].calls if c[0] == "takeoff"), 1)
            takeoff_modes = [c for c in bridges["fixed-wing"].calls if c[0] == "mode" and c[1][0] == "TAKEOFF"]
            self.assertEqual(len(takeoff_modes), 1)
            copter_gotos = [call for call in bridges["quadcopter"].calls if call[0] == "copter_goto"]
            self.assertEqual(len(copter_gotos), 1)
            self.assertEqual(copter_gotos[0][1][2], 40)
            # Grounded means the launch failed; nothing may be prosecuted yet.
            self.assertFalse(any(call[0] == "plane_goto" for call in bridges["fixed-wing"].calls))
            self.assertFalse(any(call[0] == "rc" for call in bridges["fixed-wing"].calls))

            # Past the retry window a still-grounded aircraft starts over.
            clock[0] += TAKEOFF_RETRY_S
            for _ in range(3):
                for name in bridges:
                    await adapter.send_command(dummy[name])
                clock[0] += 2
        self.assertEqual(sum(1 for c in bridges["quadcopter"].calls if c[0] == "takeoff"), 2)
        self.assertEqual(len([c for c in bridges["fixed-wing"].calls if c[0] == "mode" and c[1][0] == "TAKEOFF"]), 2)

    async def test_tick_actuation_advances_aircraft_without_a_mission_command(self):
        class Bridge:
            def __init__(self):
                self.state = {"mode": "MANUAL", "armed": False, "alt": 0}
                self.calls = []
            def is_connected(self): return True
            def snapshot(self): return dict(self.state)
            async def set_mode(self, *args): self.calls.append(("mode", args))
            async def arm(self, *args, **kwargs): self.calls.append(("arm", args))
            async def rc_override(self, *args): self.calls.append(("rc", args))
            async def takeoff(self, *args, **kwargs): self.calls.append(("takeoff", args, kwargs))
            async def send_goto(self, *args, **kwargs): self.calls.append(("copter_goto", args, kwargs))
            async def send_plane_goto(self, *args): self.calls.append(("plane_goto", args))
        adapter = WhiteoutAdapter()
        adapter._bridges = {"quadcopter": Bridge(), "fixed-wing": Bridge(), "tower-1": Bridge()}
        await adapter.tick_actuation()
        self.assertTrue(any(call[0] == "mode" and call[1][0] == "GUIDED" for call in adapter._bridges["quadcopter"].calls))
        self.assertTrue(any(call[0] == "arm" for call in adapter._bridges["fixed-wing"].calls))
        self.assertEqual(adapter._bridges["tower-1"].calls, [])


class CameraFollowTests(unittest.TestCase):
    def test_follow_standoff_uses_sea_height_and_body_yaw_faces_estimate(self):
        target = Track(*ne_to_ll(400, 200), confidence=.9, hits=4)
        vehicle = VehicleState("quadcopter", 2, "copter", *ne_to_ll(0, 200),
                               alt=40, alt_msl=116, mavlink=True)
        goal = camera_follow_wp(target, vehicle)
        distance = haversine_m(*goal, target.lat, target.lon)
        self.assertAlmostEqual(distance, 116 / math.tan(math.radians(-QUAD_CAMERA_PITCH_DEG)), delta=1)
        self.assertGreater(distance, 250, "40m relative to a hilltop is not camera height above sea")
        world = WorldModel(track=target, mission_active=True, phase="dispatch")
        decision = CopterAgent("quadcopter", "copter").decide(vehicle, world)
        self.assertAlmostEqual(decision.command.yaw_deg, bearing_deg(vehicle.lat, vehicle.lon, target.lat, target.lon))
        self.assertEqual((decision.command.lat, decision.command.lon), goal)
        self.assertEqual(decision.command.alt, 40, "Flight altitude stays home-relative")

    def test_live_standoff_waits_for_sea_height_instead_of_guessing(self):
        target = Track(*ne_to_ll(400, 200), confidence=.9, hits=4)
        vehicle = VehicleState("quadcopter", 2, "copter", *ne_to_ll(0, 200), alt=40, mavlink=True)
        self.assertIsNone(camera_follow_wp(target, vehicle))

    def test_setpoint_hysteresis_preserves_heading_and_altitude_changes(self):
        agent = PlatformAgent("quadcopter", "copter")
        first = Command("quadcopter", "goto", 72, -94, 40, yaw_deg=0)
        second = Command("quadcopter", "goto", 72, -94, 40, yaw_deg=30)
        third = Command("quadcopter", "goto", 72, -94, 50, yaw_deg=30)
        self.assertIs(agent.hold_setpoint(first), first)
        self.assertIs(agent.hold_setpoint(second), second)
        self.assertIs(agent.hold_setpoint(third), third)


if __name__ == "__main__":
    unittest.main()
