"""Focused geometry, fitted-model and observation-boundary regression tests."""
import copy
import inspect
import math
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

from graph_search import (BeliefPlanner, Terrain, Scenario, run_episode, scenario,
                          train_motion, towers_for, move_drone, angle_delta)
from train_graph_search import snap_towers, source_hashes


def profile():
    size=7
    water=[True]*(size*size)
    water[0]=water[6]=False
    edges=[]
    for r in range(size):
        for c in range(size):
            a=r*size+c
            for rr,cc in ((r+1,c),(r,c+1)):
                if rr<size and cc<size and water[a] and water[rr*size+cc]: edges.append([a,rr*size+cc])
    sensor={"hfovDeg":60.,"vfovDeg":50.,"farClipM":1500.,"nearClipM":.1,"pitchDeg":0}
    return {"schemaVersion":1,"halfM":300.,"grid":{"size":size,"cellM":100.,"xMin":-300.,"yMin":-300.,
             "elevations":[0.]*(size*size),"water":water,"waterEdges":edges,"landCandidates":[0,6]},
            "sensors":{"tower":sensor,"plane":dict(sensor,pitchDeg=-8),"quad":dict(sensor,hfovDeg=114.6,pitchDeg=-20,mountType="fixed")},
            "assetHeightsM":{"tower":2.7,"plane":120.,"quad":60.},"speedsMps":{"boat":3.,"plane":15.,"quad":10.},
            "towerDefaults":[{"x":-300.,"y":-300.,"heading":0},{"x":300.,"y":-300.,"heading":0}]}


class GraphSearchTests(unittest.TestCase):
    def test_astar_matches_dijkstra_and_routes_around_costly_ridge(self):
        p=profile()
        p["grid"]["elevations"][24]=500
        terrain=Terrain(p)
        route,cost=terrain.path(21,27,20,"astar")
        _,reference=terrain.path(21,27,20,"dijkstra")
        self.assertAlmostEqual(cost,reference,places=8)
        self.assertNotIn(24,route)
        self.assertEqual((route[0],route[-1]),(21,27))
        for a,b in zip(route,route[1:]): self.assertIn(b,terrain.air_neighbors[a])

    def test_camera_respects_horizontal_vertical_clip_and_terrain_occlusion(self):
        p=profile()
        terrain=Terrain(p)
        pose={"x":0.,"y":-200.,"z":20.,"heading":0.,"pitch":0.}
        self.assertTrue(terrain.camera_mask(pose,"tower",[[0,200]])[0])
        self.assertFalse(terrain.camera_mask(pose,"tower",[[300,-200]])[0])
        self.assertFalse(terrain.camera_mask(pose,"tower",[[0,-250]])[0])
        self.assertFalse(terrain.camera_mask(pose,"tower",[[0,2000]])[0])
        self.assertFalse(terrain.camera_mask(dict(pose,pitch=45),"tower",[[0,200]])[0])
        # A far clipping plane admits wide-angle points whose slant range is
        # greater than1500m while their positive optical depth remains smaller.
        self.assertTrue(terrain.camera_mask(dict(pose,x=0,y=0,pitch=0),"quad",[[1300,1400]])[0])
        p["grid"]["elevations"][24]=100
        blocked=Terrain(p)
        self.assertFalse(blocked.camera_mask(pose,"tower",[[0,200]])[0])

    def test_water_scenarios_are_seeded_full_graph_and_speed_bounded(self):
        terrain=Terrain(profile())
        a,b=scenario(terrain,13),scenario(terrain,13)
        np.testing.assert_array_equal(a.positions,b.positions)
        self.assertFalse(np.array_equal(a.positions,scenario(terrain,14).positions))
        self.assertTrue(np.all(np.linalg.norm(np.diff(a.positions,axis=0),axis=1)<=15.00001))
        self.assertTrue(all(terrain.water[terrain.node(*point)] for point in a.positions))
        starts={terrain.node(*scenario(terrain,seed,5,5).positions[0]) for seed in range(250)}
        self.assertGreater(len(starts),40)

    def test_motion_model_is_fitted_normalized_and_different_training_changes_predictions(self):
        terrain=Terrain(profile())
        episodes=[scenario(terrain,s,30,5) for s in range(8)]
        model=train_motion(terrain,episodes,30,5)
        self.assertEqual(model["trainingTransitions"],48)
        self.assertAlmostEqual(sum(model["prior"]),1)
        rows={}
        for source,dest,p in model["transitions"]:
            self.assertGreaterEqual(p,0)
            rows[source]=rows.get(source,0)+p
        self.assertTrue(all(abs(total-1)<1e-10 for total in rows.values()))
        other=train_motion(terrain,[scenario(terrain,900,30,5)]*8,30,5)
        self.assertNotEqual(model["prior"],other["prior"])
        self.assertNotEqual(model["transitions"],other["transitions"])

    def test_runtime_planner_depends_on_observations_not_unseen_route(self):
        terrain=Terrain(profile())
        model=train_motion(terrain,[scenario(terrain,23,30,5)],30,5)
        a,b=BeliefPlanner(terrain,model),BeliefPlanner(terrain,model)
        pose={"id":"plane","x":0.,"y":0.,"z":120.,"heading":0.}
        empty=np.zeros(len(terrain.wids),dtype=bool)
        for _ in range(4):
            # Generating or changing a hidden evaluation route is not an input.
            scenario(terrain,876)
            a.observe([empty],[],5)
            b.observe([empty],[],5)
            self.assertEqual(a.goal(pose),b.goal(pose))
            np.testing.assert_array_equal(a.belief,b.belief)
        self.assertEqual(set(inspect.signature(BeliefPlanner.observe).parameters),{"self","masks","measurements","step"})
        before=a.belief.copy()
        a.observe([np.ones(len(terrain.wids),dtype=bool)],[[200.,200.]],5)
        self.assertFalse(np.allclose(before,a.belief))

    def test_replay_has_four_assets_paths_and_observation_derived_estimates(self):
        p=profile()
        terrain=Terrain(p)
        config={"towers":snap_towers(terrain,p["towerDefaults"])}
        episode=scenario(terrain,8,30,5)
        first=run_episode(terrain,config,episode,horizon=30,step=5,replay=True)
        second=run_episode(terrain,config,episode,horizon=30,step=5,replay=True)
        self.assertEqual(first,second)
        self.assertEqual(len(first["frames"]),7)
        self.assertEqual(set(first["metrics"]["bySource"]),{"tower-1","tower-2","plane","quad"})
        seen_observation=False
        previous_towers=first["towers"]
        for frame in first["frames"]:
            self.assertEqual({d["id"] for d in frame["drones"]},{"plane","quad"})
            self.assertEqual(len(frame["towerHeadings"]),2)
            seen_observation|=bool(frame["sources"])
            if frame["estimate"] is not None: self.assertTrue(seen_observation)
            if frame["trackingSource"] is not None: self.assertIn(frame["trackingSource"],frame["sources"])
        self.assertEqual(first["towers"],previous_towers)
        self.assertIn("path",first["frames"][-1]["drones"][0])

    def test_tower_edits_snap_to_land_with_separation_and_bad_inputs_fail(self):
        terrain=Terrain(profile())
        towers=snap_towers(terrain,[{"x":0,"y":0},{"x":0,"y":0}])
        self.assertGreaterEqual(math.hypot(towers[0]["x"]-towers[1]["x"],towers[0]["y"]-towers[1]["y"]),250)
        self.assertTrue(all(not terrain.water[terrain.node(t["x"],t["y"])] for t in towers))
        with self.assertRaises(ValueError): snap_towers(terrain,[{"x":float("nan"),"y":0}]*2)
        with self.assertRaises(ValueError): scenario(terrain,1,start={"x":-300,"y":-300})
        with self.assertRaises(ValueError): towers_for(terrain,[{"x":0,"y":0}]*2)

    def test_aircraft_motion_bounds_heading_rate_and_horizontal_speed(self):
        terrain=Terrain(profile())
        for kind,rate,speed in (("plane",15,15),("quad",45,10)):
            drone={"id":kind,"x":0.,"y":0.,"z":terrain.profile["assetHeightsM"][kind],"heading":0.}
            moved=move_drone(terrain,drone,0,1)
            self.assertLessEqual(abs(angle_delta(drone["heading"],0)),rate)
            self.assertLessEqual(moved,speed+1e-9)
            self.assertLessEqual(math.hypot(drone["x"],drone["y"]),speed+1e-9)
            self.assertGreater(float(drone["z"]),float(terrain.elevation(drone["x"],drone["y"])))

    def test_source_fingerprints_are_portable_across_git_line_endings(self):
        contents={"graph_search.py":b"graph\nsource\n","train_graph_search.py":b"training\nsource\n"}
        with patch.object(Path,"read_bytes",autospec=True,side_effect=lambda path:contents[path.name]):
            lf=source_hashes()
        with patch.object(Path,"read_bytes",autospec=True,side_effect=lambda path:contents[path.name].replace(b"\n",b"\r\n")):
            crlf=source_hashes()
        self.assertEqual(lf,crlf)


if __name__=="__main__": unittest.main()
