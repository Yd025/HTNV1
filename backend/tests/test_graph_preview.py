"""Actual evaluated examples and observation-only preview progress."""
import copy
import unittest

from graph_search import Terrain, run_episode, scenario
from train_graph_search import evaluate, snap_towers, training_preview


def small_profile():
    size=5
    water=[True]*(size*size)
    water[0]=water[4]=False
    edges=[]
    for r in range(size):
        for c in range(size):
            a=r*size+c
            for rr,cc in ((r+1,c),(r,c+1)):
                if rr<size and cc<size and water[a] and water[rr*size+cc]: edges.append([a,rr*size+cc])
    sensor={"hfovDeg":60.,"vfovDeg":50.,"farClipM":1500.,"nearClipM":.1,"pitchDeg":0}
    return {"halfM":300.,"grid":{"size":size,"cellM":150.,"xMin":-300.,"yMin":-300.,
             "elevations":[0.]*(size*size),"water":water,"waterEdges":edges,"landCandidates":[0,4]},
            "sensors":{"tower":sensor,"plane":dict(sensor,pitchDeg=-8),"quad":dict(sensor,hfovDeg=114.6,pitchDeg=-45)},
            "assetHeightsM":{"tower":2.7,"plane":120.,"quad":60.},"speedsMps":{"boat":3.,"plane":15.,"quad":10.},
            "towerDefaults":[{"x":-300.,"y":-300.,"heading":0},{"x":300.,"y":-300.,"heading":0}]}


class GraphPreviewTests(unittest.TestCase):
    def test_first_actual_mission_is_recorded_without_changing_any_evaluation_score(self):
        profile=small_profile()
        terrain=Terrain(profile)
        config={"towers":snap_towers(terrain,profile["towerDefaults"])}
        episodes=[scenario(terrain,100+i,10,5) for i in range(9)]
        reference_score,reference_rows=evaluate(terrain,config,episodes,None,10,5)
        snapshots=[]
        def observe(score,example,completed,total):
            snapshots.append(copy.deepcopy({"score":score,"preview":training_preview("training",2,example,total),
                                            "completed":completed,"total":total}))
        actual_score,actual_rows=evaluate(terrain,config,episodes,None,10,5,capture_preview=True,on_progress=observe)
        self.assertEqual(actual_score,reference_score)
        self.assertEqual([r["metrics"] for r in actual_rows],[r["metrics"] for r in reference_rows])
        self.assertEqual([s["completed"] for s in snapshots],[1,4,8,9])
        self.assertTrue(all(s["score"]["episodes"]==s["completed"] for s in snapshots))
        actual_first=run_episode(terrain,config,episodes[0],None,10,5,True)
        self.assertEqual(actual_rows[0],actual_first)
        self.assertTrue(all(row["frames"]==[] for row in actual_rows[1:]))
        self.assertEqual({s["preview"]["id"] for s in snapshots},{"training:2:candidate:100"})
        self.assertTrue(all(s["preview"]["replay"]==actual_first for s in snapshots))
        self.assertEqual(snapshots[0]["preview"]["episodeIndex"],0)
        self.assertEqual(snapshots[0]["preview"]["episodeTotal"],9)
        self.assertEqual(snapshots[0]["preview"]["replay"]["towers"],config["towers"])

    def test_preview_phase_and_policy_identity_do_not_claim_a_different_candidate(self):
        example={"seed":5001,"towers":[],"frames":[{"t":0}],"metrics":{}}
        train=training_preview("training",7,example,24)
        validation=training_preview("validation",7,example,24)
        baseline=training_preview("test",None,example,200,"baseline")
        trained=training_preview("test",7,example,200,"trained")
        self.assertEqual(len({p["id"] for p in (train,validation,baseline,trained)}),4)
        self.assertEqual(baseline["candidateIndex"],None)
        self.assertEqual(baseline["policy"],"baseline")
        self.assertEqual(trained["candidateIndex"],7)
        self.assertIs(training_preview("training",0,None,24),None)

    def test_training_preview_never_evaluates_or_uses_a_held_out_scenario(self):
        profile=small_profile()
        terrain=Terrain(profile)
        config={"towers":snap_towers(terrain,profile["towerDefaults"])}
        training=[scenario(terrain,200000+i,10,5) for i in range(2)]
        snapshots=[]
        evaluate(terrain,config,training,None,10,5,capture_preview=True,
                 on_progress=lambda score,example,completed,total:snapshots.append(training_preview("training",0,example,total)))
        self.assertEqual({p["replay"]["seed"] for p in snapshots},{200000})
        self.assertTrue(all(p["phase"]=="training" for p in snapshots))
        self.assertTrue(all(p["replay"]["frames"][0]["boat"]=={"x":float(training[0].positions[0,0]),"y":float(training[0].positions[0,1])}
                            for p in snapshots))


if __name__=="__main__": unittest.main()
