"""Exercise the actual brain, fusion, mission gate and agents without a simulator."""

import os
import unittest
from unittest.mock import patch

from brain import SwarmBrain
from geo import ne_to_ll
from sim.types import Arena, Detection, VehicleState


class MissionAdapter:
    name = "mission-test"
    mode = "synthetic"

    def __init__(self):
        self.observation_now = 1000.0
        self.elapsed_s = 0.0
        self.detections = []
        self.sent = []
        self.offline = set()
        self.target = ne_to_ll(300.0, 100.0)
        self.vehicles = [
            VehicleState("mast-alpha", 1, "tower", *ne_to_ll(500.0, 300.0), alt=12),
            VehicleState("quad-alpha", 2, "copter", *self.target, alt=40),
            VehicleState("hawk-alpha", 3, "plane", *ne_to_ll(-400.0, -300.0), alt=90),
            VehicleState("shore-alpha", 4, "rover", *ne_to_ll(-250.0, 0.0)),
        ]

    async def connect(self):
        pass

    async def close(self):
        pass

    def arena(self):
        origin = ne_to_ll(0.0, 0.0)
        return Arena(*origin, 1500.0)

    async def list_vehicles(self):
        return self.vehicles

    async def poll_detections(self):
        return self.detections

    async def send_command(self, command):
        self.sent.append(command)

    def comms_ok(self, source):
        return source not in self.offline

    def truth_target(self):
        return None

    def detection(self, source, *, stamp=None, observation_id=None, point=None, confidence=.9):
        stamp = self.observation_now if stamp is None else stamp
        return Detection(source, *(point or self.target), "vessel", confidence, stamp,
                         observation_id=observation_id or f"{source}:{stamp}")


class TowerHandoffTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        env = patch.dict(os.environ, {"RUN_LOG_DIR": ""})
        env.start()
        self.addCleanup(env.stop)
        self.adapter = MissionAdapter()
        self.brain = SwarmBrain(self.adapter)
        await self.brain.connect()
        self.addAsyncCleanup(self.brain.close)

    async def tick(self, when, sources=(), detections=None):
        self.adapter.observation_now = float(when)
        self.adapter.elapsed_s = float(when) - 1000.0
        self.adapter.detections = ([self.adapter.detection(s) for s in sources]
                                   if detections is None else detections)
        return await self.brain.tick()

    async def dispatch(self):
        first = await self.tick(1000, ["mast-alpha"])
        self.assertEqual(first["c2"]["phase"], "tower_confirm")
        return await self.tick(1001, ["mast-alpha"])

    async def acquire(self):
        await self.dispatch()
        await self.tick(1002, ["quad-alpha"])
        return await self.tick(1003, ["quad-alpha"])

    async def test_drone_only_contact_and_advisor_cannot_unlock_mission(self):
        self.brain.world.advisor = {"role_bias": {"copter": "track", "plane": "search"}}
        for when in (1000, 1001, 1002):
            state = await self.tick(when, ["quad-alpha", "hawk-alpha"])
            self.assertFalse(state["c2"]["mission_active"])
            self.assertIsNone(state["track"])
            self.assertEqual(state["fleet"]["quad-alpha"]["role"], "reserve")
            self.assertEqual(state["fleet"]["hawk-alpha"]["role"], "reserve")

    async def test_grounded_aircraft_receive_no_takeoff_trigger_before_cue(self):
        for v in self.adapter.vehicles:
            if v.vehicle_class in {"plane", "copter"}:
                v.alt = 0.0
                v.armed = False
        state = await self.tick(1000)
        self.assertFalse(any(c["vehicle_id"] in {"quad-alpha", "hawk-alpha"} for c in state["commands"]))
        self.assertEqual(state["intents"]["hawk-alpha"], "reserve_ground")
        await self.tick(1001, ["mast-alpha"])
        state = await self.tick(1002, ["mast-alpha"])
        self.assertTrue({"quad-alpha", "hawk-alpha"}.issubset({c["vehicle_id"] for c in state["commands"]}))

    async def test_two_fresh_tower_hits_dispatch_distinct_air_roles_without_proximity_custody(self):
        state = await self.dispatch()
        self.assertTrue(state["c2"]["mission_active"])
        self.assertEqual(state["c2"]["phase"], "dispatch")
        self.assertEqual(state["c2"]["handoff"]["state"], "pending")
        self.assertIsNone(state["c2"]["handoff"]["receiver"])
        self.assertEqual(state["fleet"]["quad-alpha"]["role"], "track")
        self.assertEqual(state["fleet"]["hawk-alpha"]["role"], "search")
        goals = {c["vehicle_id"]: (c["lat"], c["lon"], c["alt"]) for c in state["commands"]}
        self.assertNotEqual(goals["quad-alpha"][:2], goals["hawk-alpha"][:2])
        self.assertNotEqual(goals["quad-alpha"][2], goals["hawk-alpha"][2])
        self.assertEqual(state["fleet"]["shore-alpha"]["role"], "reserve")

    async def test_duplicate_and_stale_tower_frames_do_not_confirm(self):
        det = self.adapter.detection("mast-alpha")
        await self.tick(1000, detections=[det])
        state = await self.tick(1001, detections=[det])
        self.assertFalse(state["c2"]["mission_active"])
        stale = self.adapter.detection("mast-alpha", stamp=990, observation_id="stale")
        state = await self.tick(1002, detections=[stale])
        self.assertFalse(state["c2"]["mission_active"])
        # Expired candidates cannot combine with a later isolated sighting.
        state = await self.tick(1008, ["mast-alpha"])
        self.assertFalse(state["c2"]["mission_active"])

    async def test_tower_loss_does_not_end_air_observation_custody(self):
        state = await self.acquire()
        self.assertEqual(state["c2"]["phase"], "air_track")
        self.assertEqual(state["c2"]["handoff"]["evidence"], "receiver_observation")
        for when in (1004, 1005, 1006):
            state = await self.tick(when, ["quad-alpha"])
            self.assertEqual(state["c2"]["custody"], "quad-alpha")
            self.assertEqual(state["c2"]["phase"], "air_track")
            self.assertEqual(state["intents"]["quad-alpha"], "visual_custody")
        self.assertGreater(state["c2"]["tower_observation_age_s"], self.brain.c2.fresh_s)
        self.assertEqual(state["c2"]["metrics"]["successful_handoffs"], 1)

    async def test_receiver_outliers_and_pre_dispatch_frames_cannot_confirm_handoff(self):
        await self.dispatch()
        for when in (1002, 1003):
            det = self.adapter.detection("quad-alpha", stamp=when, point=ne_to_ll(-1200, -1200))
            state = await self.tick(when, detections=[det])
            self.assertNotEqual(state["c2"]["handoff"]["state"], "acquired")
        old = self.adapter.detection("quad-alpha", stamp=1000.5, observation_id="pre-dispatch")
        state = await self.tick(1004, detections=[old])
        self.assertNotEqual(state["c2"]["handoff"]["state"], "acquired")
        self.assertEqual(state["c2"]["metrics"]["successful_handoffs"], 0)

    async def test_observation_gaps_coast_reacquire_and_expire_without_stale_cue(self):
        await self.acquire()
        state = await self.tick(1006)
        self.assertEqual(state["c2"]["phase"], "coasting")
        self.assertIsNone(state["c2"]["custody"])
        state = await self.tick(1010)
        self.assertEqual(state["c2"]["phase"], "reacquire")
        self.assertEqual(state["intents"]["quad-alpha"], "reacquire")
        self.assertEqual(state["intents"]["hawk-alpha"], "forward_reacquire")
        state = await self.tick(1029)
        self.assertEqual(state["c2"]["phase"], "lost")
        self.assertFalse(state["c2"]["mission_active"])
        self.assertIsNone(state["track"])
        self.assertIsNone(self.brain.world.last_cue)
        self.assertEqual(state["c2"]["metrics"]["custody_breaks"], 1)
        state = await self.tick(1030, ["quad-alpha"])
        self.assertFalse(state["c2"]["mission_active"])
        state = await self.tick(1031, ["mast-alpha"])
        self.assertEqual(state["c2"]["phase"], "tower_confirm")
        state = await self.tick(1032, ["mast-alpha"])
        self.assertEqual(state["c2"]["phase"], "dispatch")

    async def test_reacquisition_requires_fresh_observation_and_counts_once(self):
        await self.acquire()
        await self.tick(1010)
        await self.tick(1011, ["quad-alpha"])
        state = await self.tick(1012, ["quad-alpha"])
        self.assertEqual(state["c2"]["phase"], "air_track")
        self.assertEqual(state["c2"]["metrics"]["reacquisitions"], 1)
        state = await self.tick(1013, ["quad-alpha"])
        self.assertEqual(state["c2"]["metrics"]["reacquisitions"], 1)

    async def test_disconnected_receiver_cannot_claim_custody(self):
        await self.dispatch()
        self.adapter.offline.add("quad-alpha")
        await self.tick(1002, ["quad-alpha"])
        state = await self.tick(1003, ["quad-alpha"])
        self.assertNotEqual(state["c2"]["handoff"]["state"], "acquired")
        self.assertFalse(any(c["vehicle_id"] == "quad-alpha" for c in state["commands"]))

    async def test_late_air_frame_cannot_bridge_expired_mission(self):
        await self.acquire()
        state = await self.tick(1030, ["quad-alpha"])
        self.assertEqual(state["c2"]["phase"], "lost")
        self.assertFalse(state["c2"]["mission_active"])
        self.assertIsNone(state["track"])

    async def test_expired_tentative_contact_does_not_block_different_tower_candidate(self):
        await self.tick(1000, ["mast-alpha"])
        self.adapter.target = ne_to_ll(-400, -300)
        state = await self.tick(1008, ["mast-alpha"])
        self.assertEqual(state["c2"]["phase"], "tower_confirm")
        state = await self.tick(1009, ["mast-alpha"])
        self.assertEqual(state["c2"]["phase"], "dispatch")

    async def test_delayed_receiver_can_confirm_without_regressing_evidence_clock(self):
        await self.dispatch()
        await self.tick(1002, ["mast-alpha"])
        delayed = self.adapter.detection("quad-alpha", stamp=1001.5)
        state = await self.tick(1002.2, detections=[delayed])
        self.assertAlmostEqual(state["c2"]["observation_age_s"], .2)
        self.assertEqual(state["track"]["last_observation_timestamp"], 1002)
        delayed = self.adapter.detection("quad-alpha", stamp=1002.1)
        state = await self.tick(1002.4, detections=[delayed])
        self.assertEqual(state["c2"]["phase"], "air_track")
        self.assertEqual(state["c2"]["custody"], "quad-alpha")
        self.assertAlmostEqual(state["c2"]["observation_age_s"], .3)


if __name__ == "__main__":
    unittest.main()
