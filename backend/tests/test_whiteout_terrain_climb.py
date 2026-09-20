"""Site-specific flight envelope, using cached own telemetry and fake I/O."""
import os
import time
import unittest
from unittest.mock import patch

from sim.types import Command
from sim.whiteout import FORT_ROSS_CLIMB_LOITER, WhiteoutAdapter


class Bridge:
    def __init__(self, **state):
        self.state = dict(lat=71.9958, lon=-94.8393, mode="GUIDED", armed=True,
                          alt=40., alt_msl=116., groundspeed=12., **state)
        self.calls = []
    def is_connected(self): return True
    def snapshot(self): return dict(self.state)
    async def send_goto(self, *args, **kwargs): self.calls.append(("goto", args, kwargs))
    async def send_plane_goto(self, *args): self.calls.append(("plane_goto", args))
    async def rc_override(self, *args): self.calls.append(("rc", args))
    async def set_mode(self, *args): self.calls.append(("mode", args))
    async def arm(self, *args, **kwargs): self.calls.append(("arm", args))
    async def takeoff(self, *args): self.calls.append(("takeoff", args))


class TerrainClimbTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        with patch.dict(os.environ, MISSION_ALGORITHM="coordinated-surveillance-v1"):
            self.adapter = WhiteoutAdapter()
        self.quad = Bridge()
        self.plane = Bridge()
        self.plane.state.update(alt=20., alt_msl=20.)
        self.adapter._bridges = {"quadcopter": self.quad, "fixed-wing": self.plane}

    async def test_quad_climbs_vertically_in_home_frame_before_mission_goto(self):
        goal = Command("quadcopter", "goto", 72., -94.8, 40., yaw_deg=30)
        await self.adapter.send_command(goal)
        self.assertEqual(self.quad.calls[-1], ("goto", (71.9958, -94.8393, 254.), {}))
        self.assertEqual(self.adapter._air["quadcopter"].phase, "climb")
        # Own position drifts: preserve the original hold point during climb.
        self.quad.state.update(lat=71.996, alt=244., alt_msl=320.)
        self.adapter._air["quadcopter"].last_cmd_at = 0
        await self.adapter.send_command(goal)
        self.assertEqual(self.quad.calls[-1][1], (71.9958, -94.8393, 254.))
        self.quad.state.update(alt=254., alt_msl=330.)
        self.adapter._air["quadcopter"].last_cmd_at = 0
        await self.adapter.send_command(goal)
        self.assertEqual(self.quad.calls[-1], ("goto", (72., -94.8, 254.), {"yaw_deg": 30}))
        self.assertEqual(self.adapter._air["quadcopter"].phase, "ready")

    async def test_plane_climbs_over_known_water_before_crossing_the_map(self):
        goal = Command("fixed-wing", "goto", 72., -94.8, 90.)
        self.plane.state.update(alt=0., alt_msl=0., armed=False)
        await self.adapter.send_command(goal)
        self.plane.state.update(alt=20., alt_msl=20., armed=True)
        self.adapter._air["fixed-wing"].last_cmd_at = 0
        await self.adapter.send_command(goal)
        self.assertEqual(self.plane.calls[-1], ("plane_goto", (*FORT_ROSS_CLIMB_LOITER, 330.)))
        self.assertFalse(any(call == ("plane_goto", (72., -94.8, 90.)) for call in self.plane.calls))
        self.plane.state.update(alt=330., alt_msl=330.)
        self.adapter._air["fixed-wing"].last_cmd_at = 0
        await self.adapter.send_command(goal)
        self.assertEqual(self.plane.calls[-1], ("plane_goto", (72., -94.8, 330.)))

    async def test_airborne_restart_climbs_locally_even_with_low_groundspeed(self):
        # Headwind/low groundspeed is not evidence that a 100 m-high plane
        # should revert to manual-throttle FBWA or return across the terrain.
        self.plane.state.update(lat=72.01, lon=-94.81, alt=100., alt_msl=100., groundspeed=.5)
        await self.adapter.send_command(Command("fixed-wing", "goto", 72., -94.8, 90.))
        self.assertEqual(self.plane.calls[-1], ("plane_goto", (72.01, -94.81, 330.)))
        self.assertFalse(any(call == ("mode", ("FBWA",)) for call in self.plane.calls))

    async def test_grounded_quad_takeoff_uses_site_floor(self):
        self.quad.state.update(alt=0., alt_msl=76.)
        await self.adapter.send_command(Command("quadcopter", "goto", 72., -94.8, 40.))
        self.assertEqual(self.quad.calls[-1], ("takeoff", (254.,)))

    async def test_unknown_sea_height_cannot_trigger_aircraft_commands(self):
        self.quad.state.update(alt_msl=None, armed=False)
        await self.adapter.send_command(Command("quadcopter", "goto", 72., -94.8, 40.))
        self.assertEqual(self.quad.calls, [])

    async def test_direct_advance_cannot_hold_an_unknown_position(self):
        self.quad.state.update(lat=None)
        spec = next(s for s in self.adapter._spec if s["vehicle_id"] == "quadcopter")
        self.assertFalse(await self.adapter._advance(spec, self.quad))
        self.assertEqual(self.quad.calls, [])

    async def test_command_throttle_rechecks_current_clearance_arming_and_mode(self):
        air = self.adapter._air["quadcopter"]
        for changed in ({"alt": 244., "alt_msl": 320.}, {"armed": False}, {"mode": "LAND"}):
            self.quad.state.update(alt=254., alt_msl=330., armed=True, mode="GUIDED")
            self.quad.state.update(changed)
            air.phase = "ready"
            air.last_cmd_at = time.monotonic()
            await self.adapter.send_command(Command("quadcopter", "goto", 72., -94.8, 40.))
            self.assertEqual(self.quad.calls, [], changed)

    async def test_explicit_legacy_keeps_original_altitude_and_launch_behavior(self):
        with patch.dict(os.environ, MISSION_ALGORITHM="tower-first-v2", SURVEILLANCE_POLICY_FILE=""):
            legacy = WhiteoutAdapter()
        legacy._bridges["quadcopter"] = self.quad
        await legacy.send_command(Command("quadcopter", "goto", 72., -94.8, 40.))
        self.assertEqual(self.quad.calls[-1], ("goto", (72., -94.8, 40.), {}))


if __name__ == "__main__":
    unittest.main()
