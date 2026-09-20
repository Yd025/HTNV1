"""Search-policy runtime checks use local kinematics only, without networking."""

import json
import os
from pathlib import Path
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

import geo
from behaviors.trees import hold_wp
from brain import SwarmBrain
from geo import ne_to_ll
from search_experiment import default_policy
from sim.adapter import build_adapter
from sim.local_sitl import LocalSitlAdapter
from sim.types import Detection


class SearchRuntimeTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        geometry = patch.multiple("geo", ORIGIN_LAT=geo.ORIGIN_LAT, ORIGIN_LON=geo.ORIGIN_LON,
                                  ARENA_HALF_M=geo.ARENA_HALF_M)
        geometry.start()
        self.addCleanup(geometry.stop)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.policy_path = Path(temporary.name) / "search-policy.json"
        self.policy = default_policy()
        self.policy["algorithm"] = "belief_greedy"
        self.policy["planner"]["detection_probability"] = 1.0
        self.policy["observation_period_s"] = 1.0
        origin = self.policy["arena"]["origin_lat"], self.policy["arena"]["origin_lon"]
        for tower, position in zip(self.policy["arena"]["towers"], ((600, 200), (-600, -200))):
            tower["lat"], tower["lon"] = ne_to_ll(*position, *origin)
            tower["heading"] = 123.0
        self.write_policy()
        env = patch.dict(os.environ, {"SEARCH_POLICY_FILE": str(self.policy_path),
                                      "FORCE_KINEMATIC": "1", "RUN_LOG_DIR": ""})
        env.start()
        self.addCleanup(env.stop)
        self.clock = 100.0
        clock = patch("sim.local_sitl.time", SimpleNamespace(monotonic=lambda: self.clock, time=time.time))
        clock.start()
        self.addCleanup(clock.stop)

    def write_policy(self):
        self.policy_path.write_text(json.dumps(self.policy), encoding="utf-8")

    async def make_adapter(self):
        adapter = LocalSitlAdapter()
        self.addAsyncCleanup(adapter.close)
        await adapter.connect()
        return adapter

    async def test_learned_mounts_and_planner_load_into_existing_adapter(self):
        adapter = LocalSitlAdapter()
        brain = SwarmBrain(adapter)
        self.addAsyncCleanup(brain.close)
        await brain.connect()
        self.assertEqual(brain.search_planner.algorithm, "belief_greedy")
        mounts = {mount.vehicle_id: mount for mount in adapter.arena().towers}
        for expected in self.policy["arena"]["towers"]:
            mount = mounts[expected["vehicle_id"]]
            self.assertEqual((mount.lat, mount.lon, mount.heading),
                             (expected["lat"], expected["lon"], expected["heading"]))
        self.assertTrue(all(craft.arena is adapter.arena() for craft in adapter._kin.values()))

    async def test_policy_arena_aligns_existing_geo_hold_and_map(self):
        geo.ORIGIN_LAT, geo.ORIGIN_LON, geo.ARENA_HALF_M = 72.0, -95.0, 3250.0
        self.policy["arena"].update(origin_lat=68.2, origin_lon=-105.5, half_m=1200.0)
        for tower, position in zip(self.policy["arena"]["towers"], ((600, 200), (-600, -200))):
            tower["lat"], tower["lon"] = ne_to_ll(*position, 68.2, -105.5)
        self.write_policy()
        adapter = LocalSitlAdapter()
        brain = SwarmBrain(adapter)
        self.addAsyncCleanup(brain.close)
        await brain.connect()
        self.assertEqual((geo.ORIGIN_LAT, geo.ORIGIN_LON, geo.ARENA_HALF_M), (68.2, -105.5, 1200.0))
        self.assertEqual(hold_wp("copter"), ne_to_ll(-80, 40, 68.2, -105.5))
        craft = adapter._kin["copter-1"].state(False)
        north, east = geo.ll_to_ne(craft.lat, craft.lon)
        self.assertAlmostEqual(north, -80)
        self.assertAlmostEqual(east, 40)
        self.assertEqual((brain.metrics.grid.origin_lat, brain.metrics.grid.origin_lon, brain.metrics.grid.half),
                         (68.2, -105.5, 1200.0))
        snapshot = brain.snapshot()
        self.assertEqual((snapshot["arena"]["origin_lat"], snapshot["arena"]["origin_lon"],
                          snapshot["arena"]["half_m"]), (68.2, -105.5, 1200.0))

    async def test_observations_follow_policy_epochs_and_connect_resets_clock(self):
        self.policy["observation_period_s"] = 0.5
        self.write_policy()
        adapter = await self.make_adapter()
        adapter._target.detections_for = Mock(return_value=[])
        adapter._search_rng = Mock(random=Mock(return_value=0.0), seed=Mock())
        for offset, expected_time, expected_calls in ((0, 0, 1), (.1, 0, 1), (.49, 0, 1),
                                                       (.5, .5, 2), (.99, .5, 2), (1, 1, 3), (3.2, 3, 4)):
            self.clock = 100 + offset
            self.assertEqual(await adapter.poll_detections(), [])
            self.assertEqual(adapter.search_sample_time_s, expected_time)
            self.assertEqual(adapter._target.detections_for.call_count, expected_calls)
            # All five source draws occur even when no source sees a target.
            self.assertEqual(adapter._search_rng.random.call_count, expected_calls * 5)
        await adapter.connect()
        self.assertIsNone(adapter.search_sample_time_s)
        await adapter.poll_detections()
        self.assertEqual(adapter.search_sample_time_s, 0)
        self.assertEqual(adapter._target.detections_for.call_count, 5)
        adapter._search_rng.seed.assert_called_once_with(2026)

    async def test_default_policy_cadence_fallback_is_one_second(self):
        self.policy.pop("observation_period_s")
        self.write_policy()
        adapter = await self.make_adapter()
        adapter._target.detections_for = Mock(return_value=[])
        await adapter.poll_detections()
        self.clock += .9
        await adapter.poll_detections()
        self.assertEqual(adapter._target.detections_for.call_count, 1)
        self.clock += .1
        await adapter.poll_detections()
        self.assertEqual(adapter._target.detections_for.call_count, 2)

    async def test_brain_updates_once_per_sample_and_caches_commands(self):
        adapter = LocalSitlAdapter()
        adapter._target.detections_for = Mock(return_value=[])
        adapter.send_command = AsyncMock(wraps=adapter.send_command)
        brain = SwarmBrain(adapter)
        self.addAsyncCleanup(brain.close)
        await brain.connect()
        with patch.object(brain.search_planner, "commands", wraps=brain.search_planner.commands) as commands:
            await brain.tick()
            self.assertEqual(commands.call_count, 1)
            self.assertEqual(commands.call_args.args[1], 0)
            tower_ids = {t.vehicle_id for t in adapter.arena().towers}
            tower_dispatches = lambda: sum(call.args[0].vehicle_id in tower_ids for call in adapter.send_command.await_args_list)
            dispatched = tower_dispatches()
            belief = brain.search_planner.belief
            self.clock += .1
            await brain.tick()
            self.clock += .8
            await brain.tick()
            self.assertEqual(commands.call_count, 1)
            self.assertEqual(brain.search_planner.belief, belief)
            self.assertEqual(tower_dispatches(), dispatched)
            # Legacy search policies may steer towers; aircraft patrol until a
            # visual confirm, they do not sit in reserve.
            self.assertTrue(all(v.role == "search" for v in brain.world.vehicles.values()
                                if v.vehicle_class in {"plane", "copter"}))
            self.clock += .1
            await brain.tick()
            self.assertEqual(commands.call_count, 2)
            self.assertEqual(commands.call_args.args[1], 1)

    async def test_first_detection_exits_planner_even_after_cue_clears(self):
        adapter = LocalSitlAdapter()
        adapter._target.detections_for = Mock(return_value=[])
        brain = SwarmBrain(adapter)
        self.addAsyncCleanup(brain.close)
        await brain.connect()
        with patch.object(brain.search_planner, "commands", wraps=brain.search_planner.commands) as commands:
            await brain.tick()
            self.clock += 1
            mount = adapter.arena().towers[0]
            adapter._target.detections_for.return_value = [
                Detection(mount.vehicle_id, mount.lat, mount.lon, "vessel", .9, time.time())]
            await brain.tick()
            self.assertEqual(commands.call_count, 1)
            self.assertTrue(brain._search_detected)
            self.assertEqual(brain._search_commands, {})
            adapter._target.detections_for.return_value = []
            brain.world.last_cue = None
            brain.world.track = None
            self.clock += 1
            with patch.object(brain.tracker, "update", return_value=None):
                await brain.tick()
            self.assertEqual(commands.call_count, 1)

    async def test_absent_policy_preserves_each_poll_observations(self):
        with patch.dict(os.environ, {"SEARCH_POLICY_FILE": ""}):
            adapter = await self.make_adapter()
        adapter._target.detections_for = Mock(return_value=[])
        await adapter.poll_detections()
        await adapter.poll_detections()
        self.assertEqual(adapter._target.detections_for.call_count, 2)
        self.assertIsNone(adapter.search_sample_time_s)

    async def test_live_and_hybrid_adapters_reject_synthetic_policy(self):
        with patch.dict(os.environ, {"FORCE_KINEMATIC": "0"}):
            with self.assertRaisesRegex(ValueError, "FORCE_KINEMATIC"):
                LocalSitlAdapter()
        with self.assertRaisesRegex(ValueError, "local synthetic"):
            build_adapter("whiteout")
        for mode in ("live", "hybrid"):
            adapter = SimpleNamespace(name="local", mode=mode, search_policy=self.policy,
                                      connect=AsyncMock())
            brain = SwarmBrain(adapter)
            with self.assertRaisesRegex(ValueError, "local synthetic"):
                await brain.connect()
            adapter.connect.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
