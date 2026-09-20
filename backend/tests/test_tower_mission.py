"""Tower-first acquisition, receiver evidence, and observation-boundary proof."""
import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

import numpy as np

from graph_search import (Observation, Scenario, Terrain, TowerMission, angle_delta,
                          move_drone, run_episode, sensor_pose, sensor_quality, summarize)
from test_graph_search import profile
from train_graph_search import replay


def hit(source, t, point=(0., 0.), sigma=8.):
    return Observation(source, point, t, sigma, .9)


class TowerMissionTests(unittest.TestCase):
    def test_only_confirmed_tower_cue_dispatches_and_fresh_receiver_confirms_handoff(self):
        mission=TowerMission()
        self.assertIsNone(mission.update([hit("quad",0)],0))
        self.assertEqual(mission.phase,"tower_watch")
        self.assertIsNone(mission.update([hit("tower-1",5)],5))
        self.assertIsNone(mission.handoff_at)
        mission.update([hit("tower-1",10,(4.,0.))],10)
        self.assertEqual(mission.phase,"dispatch")
        self.assertEqual(mission.acquired_at,10)
        self.assertIsNone(mission.handoff_at)
        self.assertEqual([e["type"] for e in mission.events],["tower_confirmed","swarm_dispatched"])
        mission.update([],15)
        self.assertIsNone(mission.handoff_at)
        mission.update([hit("quad",20,(8.,0.))],20)
        self.assertIsNone(mission.handoff_at)
        self.assertEqual(mission.phase,"dispatch")
        mission.update([hit("quad",25,(10.,0.))],25)
        self.assertEqual(mission.phase,"drone_track")
        self.assertEqual(mission.custodian,"quad")
        self.assertEqual(mission.handoff_at,25)
        self.assertEqual(mission.events[0]["type"],"drone_handoff_confirmed")

    def test_drone_keeps_custody_without_towers_then_coasts_and_is_lost(self):
        mission=TowerMission()
        mission.update([hit("tower-1",0)],0)
        mission.update([hit("tower-1",5)],5)
        mission.update([hit("quad",10)],10)
        mission.update([hit("quad",15)],15)
        mission.update([hit("quad",20,(5.,0.))],20)
        self.assertEqual(mission.phase,"drone_track")
        self.assertEqual(mission.last_tower,5)
        observed_sigma=mission.uncertainty(20)
        mission.update([],35)
        self.assertEqual(mission.phase,"reacquire")
        self.assertIsNone(mission.custodian)
        self.assertGreater(mission.uncertainty(35),observed_sigma)
        self.assertIsNotNone(mission.predict(35))
        self.assertIsNone(mission.update([],70))
        self.assertEqual(mission.phase,"lost")
        self.assertIsNone(mission.uncertainty(70))

    def test_duplicate_stale_future_and_outlier_frames_cannot_confirm_handoff(self):
        mission=TowerMission()
        first=hit("tower-1",0)
        mission.update([first,first,hit("tower-2",0)],0)
        self.assertIsNone(mission.acquired_at)
        mission.update([first],5)
        self.assertIsNone(mission.acquired_at)
        mission.update([hit("tower-1",5)],5)
        mission.update([hit("quad",-20),hit("plane",30),hit("quad",10,(2000.,2000.))],10)
        self.assertIsNone(mission.handoff_at)
        self.assertEqual(mission.phase,"dispatch")
        self.assertGreaterEqual(mission.rejected,4)

    def test_weak_and_nonfinite_reports_never_create_a_track(self):
        mission=TowerMission()
        mission.update([Observation("tower-1",(0,0),0,8,.1),hit("tower-2",0,(float("nan"),0))],0)
        self.assertIsNone(mission.pending)
        self.assertIsNone(mission.acquired_at)

    def test_different_aircraft_single_frames_do_not_fake_receiver_confirmation(self):
        mission=TowerMission()
        mission.update([hit("tower-1",0)],0)
        mission.update([hit("tower-1",5)],5)
        mission.update([hit("quad",10)],10)
        mission.update([hit("plane",15)],15)
        self.assertIsNone(mission.handoff_at)
        mission.update([hit("quad",20)],20)
        self.assertEqual(mission.handoff_at,20)
        self.assertEqual(mission.receiver_confirmed_sources,["quad"])

    def test_sensor_performance_varies_with_range_condition_and_edge(self):
        terrain=Terrain(profile())
        pose={"x":0,"y":0,"z":2.7,"heading":0}
        near=sensor_quality(terrain,pose,"tower",(0,150),"clear")
        far=sensor_quality(terrain,pose,"tower",(0,1200),"clear")
        haze=sensor_quality(terrain,pose,"tower",(0,1200),"haze")
        edge=sensor_quality(terrain,pose,"tower",(600,1039),"clear")
        self.assertGreater(near["probability"],far["probability"])
        self.assertGreater(far["probability"],haze["probability"])
        self.assertGreater(far["probability"],edge["probability"])
        self.assertGreater(haze["sigmaM"],far["sigmaM"])
        self.assertGreater(near["projectedPixels"],far["projectedPixels"])

    def test_quad_camera_is_fixed_to_body_not_independently_aimed_at_track(self):
        terrain=Terrain(profile())
        mission=TowerMission()
        mission.update([hit("tower-1",0,(200.,200.))],0)
        mission.update([hit("tower-1",5,(200.,200.))],5)
        drone={"id":"quad","x":0.,"y":0.,"z":60.,"heading":270.}
        pose=sensor_pose(terrain,drone,mission,5,5)
        self.assertEqual(pose["heading"],drone["heading"])
        self.assertEqual(pose["pitch"],-20.)
        # Yaw changes via the aircraft, bounded to 45 degrees per second;
        # translation may crab west while the body turns toward an east cue.
        drone["heading"]=0.
        moved=move_drone(terrain,drone,terrain.node(-300,0),1,look_at=np.array([300.,0.]))
        self.assertGreater(moved,0.)
        self.assertLess(drone["x"],0.)
        self.assertEqual(angle_delta(drone["heading"],0.),45.)
        pose=sensor_pose(terrain,drone,mission,6,1)
        self.assertEqual(pose["heading"],45.)
        self.assertEqual(pose["pitch"],-20.)

    def test_changed_hidden_route_cannot_change_commands_with_identical_observations(self):
        terrain=Terrain(profile())
        config={"towers":profile()["towerDefaults"]}
        a=Scenario(42,np.tile([0.,0.],(9,1)))
        b=Scenario(42,np.tile([200.,200.],(9,1)))
        def scripted(terrain,pose,kind,boat,condition,seed,t,mask):
            if pose["id"]=="tower-1" and t in (0,5): return [hit("tower-1",t)]
            if pose["id"]=="quad" and t>=15: return [hit("quad",t,(float(t),0))]
            return []
        with patch("graph_search.sample_observations",side_effect=scripted):
            left=run_episode(terrain,config,a,horizon=40,replay=True)
            right=run_episode(terrain,config,b,horizon=40,replay=True)
        self.assertEqual(left["towers"],right["towers"])
        for x,y in zip(left["frames"],right["frames"]):
            for key in ("drones","estimate","phase","custodian","acceptedSources","events"):
                self.assertEqual(x[key],y[key])
        self.assertEqual(left["metrics"]["detectionRate"],100.)
        self.assertEqual(right["metrics"]["detectionRate"],0.)
        self.assertEqual(left["metrics"]["handoffRate"],100.)
        self.assertEqual(right["metrics"]["handoffRate"],0.)
        initial_quad=left["frames"][0]["drones"][1]
        before_cue_quad=left["frames"][1]["drones"][1]
        self.assertEqual((initial_quad["x"],initial_quad["y"]),(before_cue_quad["x"],before_cue_quad["y"]))

    def test_post_tower_custody_pools_eligible_samples_and_none_is_unavailable(self):
        terrain=Terrain(profile())
        config={"towers":profile()["towerDefaults"]}
        with patch("graph_search.sample_observations",return_value=[]):
            row=run_episode(terrain,config,Scenario(1,np.tile([0.,0.],(3,1))),horizon=10)
        self.assertIsNone(summarize([row])["postTowerCustodyPct"])
        a={"metrics":dict(row["metrics"],postTowerSamples=1,postTowerCustodySamples=1)}
        b={"metrics":dict(row["metrics"],postTowerSamples=9,postTowerCustodySamples=0)}
        self.assertEqual(summarize([a,b])["postTowerCustodyPct"],10.)

    def test_false_contact_and_false_drone_handoff_cannot_earn_target_success(self):
        terrain=Terrain(profile())
        config={"towers":profile()["towerDefaults"]}
        episode=Scenario(42,np.tile([-200.,-200.],(5,1)))
        def clutter(terrain,pose,kind,boat,condition,seed,t,mask):
            if pose["id"]=="tower-1" and t in (0,5): return [hit("tower-1",t,(250.,250.))]
            if pose["id"]=="quad" and t>=10: return [hit("quad",t,(250.,250.))]
            return []
        with patch("graph_search.sample_observations",side_effect=clutter):
            result=run_episode(terrain,config,episode,horizon=20,replay=True)
        metric=result["metrics"]
        self.assertEqual(metric["contactConfirmationRate"],100.)
        self.assertEqual(metric["contactHandoffs"],1)
        self.assertEqual(metric["falseConfirmations"],1)
        self.assertEqual(metric["detectionRate"],0.)
        self.assertEqual(metric["handoffRate"],0.)
        self.assertEqual(metric["custodyPct"],0.)
        self.assertIsNone(metric["detectedAt"])
        self.assertTrue(result["frames"][-1]["handoffConfirmed"])
        self.assertFalse(any(f["targetConfirmed"] or f["targetHandoffConfirmed"] or f["targetCustody"] for f in result["frames"]))

    def test_pre_tower_first_saved_model_cannot_replay_new_mission_claims(self):
        with TemporaryDirectory() as directory:
            root=Path(directory)
            terrain_file=root/"profile.json"
            model_file=root/"model.json"
            terrain_file.write_text(json.dumps(profile()),encoding="utf-8")
            model_file.write_text(json.dumps({"schemaVersion":1}),encoding="utf-8")
            with self.assertRaisesRegex(ValueError,"predates tower-first"):
                replay(SimpleNamespace(profile=terrain_file,model=model_file))


if __name__=="__main__": unittest.main()
