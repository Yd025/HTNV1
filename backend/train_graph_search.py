"""Train and replay a synthetic terrain graph model; never connects to vehicles.

Requires NumPy. Run with --help for bounded budgets and output paths.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import time
from pathlib import Path

import numpy as np

from graph_search import (DEFAULT_WEIGHTS, MISSION_VERSION, SENSOR_MODEL, Terrain, objective, profile_hash, run_episode,
                          scenario, summarize, towers_for, train_motion)

ROOT=Path(__file__).resolve().parents[1]
DEFAULT_DIR=ROOT/"frontend/public/experiments"


def save(path,value):
    path=Path(path)
    path.parent.mkdir(parents=True,exist_ok=True)
    temporary=path.with_suffix(path.suffix+".tmp")
    temporary.write_text(json.dumps(value,allow_nan=False,separators=(",",":")),encoding="utf-8")
    # Windows readers may briefly hold the destination without delete sharing.
    # Keep atomic publication and retry that transient file lock, never the run.
    for attempt in range(8):
        try:
            temporary.replace(path)
            break
        except PermissionError:
            if attempt==7:
                raise
            time.sleep(.01*(attempt+1))


def source_hashes():
    # Git may change CRLF/LF across hosts without changing executable semantics.
    return {name:hashlib.sha256((Path(__file__).parent/name).read_bytes().replace(b"\r\n",b"\n")).hexdigest()
            for name in ("graph_search.py","train_graph_search.py")}


def snap_towers(terrain,values):
    if len(values)!=2:
        raise ValueError("Exactly two towers are required")
    output=[]
    used=[]
    for i,v in enumerate(values):
        point=np.asarray([float(v["x"]),float(v["y"])])
        heading=float(v.get("heading",v.get("headingDeg",0)))
        if not np.isfinite(point).all() or not math.isfinite(heading):
            raise ValueError("Tower coordinates and headings must be finite")
        candidates=sorted(terrain.land,key=lambda n:float(np.sum((terrain.xy[n]-point)**2)))
        node=next((int(n) for n in candidates if all(np.linalg.norm(terrain.xy[n]-terrain.xy[other])>=250 for other in used)),None)
        if node is None: raise ValueError("No separated legal tower position")
        used.append(node)
        output.append({"id":f"tower-{i+1}","x":float(terrain.xy[node,0]),"y":float(terrain.xy[node,1]),"heading":heading%360})
    return towers_for(terrain,output)


def propose_tower_pair(terrain,motion,rng):
    """Greedy training-prior optical opportunity; final selection uses missions.

    This inexpensive proposal is only a candidate, not a global optimum claim.
    It knows sampled terrain and training occupancy, never test boat positions.
    """
    nodes=rng.choice(terrain.land,min(96,len(terrain.land)),replace=False)
    xy=terrain.xy[terrain.wids]
    prior=np.asarray(motion["prior"])
    sensor=terrain.profile["sensors"]["tower"]
    focal=sensor.get("width",1280)/(2*math.tan(math.radians(sensor["hfovDeg"])/2))
    probabilities=[]
    for node in nodes:
        x,y=terrain.xy[node]
        z=terrain.height[node]+terrain.profile["assetHeightsM"]["tower"]
        distance=np.linalg.norm(xy-[x,y],axis=1)
        visible=(distance<=sensor["farClipM"]) & (distance>=abs(z-1.5)/math.tan(math.radians(sensor["vfovDeg"])/2))
        visible &= terrain.los(x,y,z,xy[:,0],xy[:,1],np.full(len(xy),1.5))
        pixels=SENSOR_MODEL["boatLengthM"]*focal/np.maximum(1,distance)
        quality=.98*(1-np.exp(-pixels/6))*np.exp(-distance/4000)*.75
        probabilities.append(visible*quality)
    first=int(np.argmax(np.asarray(probabilities)@prior))
    gains=[float(np.sum(prior*(1-probabilities[first])*p))
           if np.linalg.norm(terrain.xy[node]-terrain.xy[nodes[first]])>=250 else -1.
           for node,p in zip(nodes,probabilities)]
    second=int(np.argmax(gains))
    values=[]
    for index in (first,second):
        point=terrain.xy[nodes[index]]
        weights=prior*probabilities[index]
        center=np.average(xy,axis=0,weights=weights) if weights.sum()>0 else xy.mean(axis=0)
        values.append({"x":float(point[0]),"y":float(point[1]),"heading":math.degrees(math.atan2(*(center-point)))%360})
    return snap_towers(terrain,values)


def evaluate(terrain,config,episodes,motion,horizon,step,record=False,*,capture_preview=False,on_progress=None):
    """Evaluate unchanged missions, optionally recording the first real example.

    Progress observes completed rows only. Recording changes output frames, not
    sensor sampling, planning, random draws, candidate selection or scores.
    """
    rows=[]
    for index,episode in enumerate(episodes):
        rows.append(run_episode(terrain,config,episode,motion,horizon,step,record or (capture_preview and index==0)))
        completed=index+1
        if on_progress and (completed==1 or completed%4==0 or completed==len(episodes)):
            on_progress(summarize(rows),rows[0] if capture_preview else None,completed,len(episodes))
    return summarize(rows),rows


def training_preview(phase,candidate_index,example,episode_total,policy=None):
    """Stable recorded example from the first actually evaluated episode."""
    if example is None:
        return None
    value={"id":f"{phase}:{candidate_index}:{policy or 'candidate'}:{example['seed']}",
           "phase":phase,"candidateIndex":candidate_index,"episodeIndex":0,
           "episodeTotal":episode_total,"replay":example}
    if policy is not None:
        value["policy"]=policy
    return value


def progress_snapshot(completed_rows,evaluating_policy,horizon_s,step_s):
    """Monitoring only: each policy's denominator is its completed missions.

    The caller passes finished episodes, never an active episode or its future
    observations. An unstarted policy has no metric summary and a null curve.
    """
    labels=("baseline","untrained","trained")
    if evaluating_policy not in labels:
        raise ValueError("Unknown evaluating policy")
    rows={label:completed_rows.get(label,[]) for label in labels}
    partial={label:summarize(values) for label,values in rows.items() if values}
    curve=[{"t":t,**{label:(100*sum(row["metrics"]["detectedAt"] is not None and row["metrics"]["detectedAt"]<=t
                                    for row in values)/len(values) if values else None)
                       for label,values in rows.items()}}
           for t in range(0,horizon_s+1,step_s)]
    return {"partialMetrics":partial,"partialDetectionCurve":curve,"evaluatingPolicy":evaluating_policy}


def train(args):
    started=time.perf_counter()
    sources_at_start=source_hashes()
    profile=json.loads(Path(args.profile).read_text(encoding="utf-8"))
    terrain=Terrain(profile)
    protocol={"motionTrajectories":32 if args.quick else 256,"trainEpisodes":8 if args.quick else 24,
              "validationEpisodes":8 if args.quick else 24,"testEpisodes":12 if args.quick else 200,
              "candidates":4 if args.quick else 12,"horizonS":300,"stepS":5,"freshnessS":10,
              "missionVersion":MISSION_VERSION,"placementFrozenBeforeMission":True,"confirmationHits":2,
              "receiverConfirmationHits":2,"confirmationWindowS":15,"lostAfterS":45,
              "evaluationToleranceM":SENSOR_MODEL["evaluationToleranceM"],"conditions":list(SENSOR_MODEL["conditions"])}
    seed=int(args.seed)
    if seed<0 or seed>2**31-1: raise ValueError("Seed must be between0 and2147483647")
    protocol["seedRanges"]={label:[seed+offset,seed+offset+protocol[count]-1]
                            for label,offset,count in (("motion",100000,"motionTrajectories"),("train",200000,"trainEpisodes"),
                                                       ("validation",300000,"validationEpisodes"),("test",400000,"testEpisodes"))}
    h,dt=protocol["horizonS"],protocol["stepS"]
    progress=lambda value:save(args.progress,value) if args.progress else None
    progress({"phase":"motion","seed":seed,"completed":0,"total":protocol["candidates"],"history":[]})
    # Four disjoint whole-episode seed blocks; test is generated after selection.
    motion_episodes=[scenario(terrain,seed+100000+i,h,dt) for i in range(protocol["motionTrajectories"])]
    motion=train_motion(terrain,motion_episodes,h,dt)
    train_episodes=[scenario(terrain,seed+200000+i,h,dt) for i in range(protocol["trainEpisodes"])]
    validation=[scenario(terrain,seed+300000+i,h,dt) for i in range(protocol["validationEpisodes"])]
    baseline_towers=snap_towers(terrain,profile["towerDefaults"])
    baseline={"towers":baseline_towers,"weights":DEFAULT_WEIGHTS,"baseline":True}
    untrained={"towers":baseline_towers,"weights":DEFAULT_WEIGHTS}
    initial={"towers":baseline_towers,"weights":DEFAULT_WEIGHTS}
    rng=np.random.default_rng(seed)
    history=[]
    best_config=initial
    best_score=None
    best_index=None
    for index in range(protocol["candidates"]):
        if index==0: config=initial
        elif index==1:
            config={"towers":propose_tower_pair(terrain,motion,rng),"weights":DEFAULT_WEIGHTS}
        else:
            # Fit tower positions before deployment. Tracking logic is fixed;
            # legacy score weights remain serialized only for compatibility.
            # Every fourth proposal explores globally; the rest refine incumbent.
            values=[]
            for tower in best_config["towers"]:
                if index%4==0:
                    node=int(rng.choice(terrain.land))
                    point=terrain.xy[node]
                else:
                    point=np.asarray([tower["x"],tower["y"]])+rng.normal(0,500 if index<6 else 220,2)
                values.append({"x":float(point[0]),"y":float(point[1]),"heading":float(tower["heading"]+rng.normal(0,35))})
            config={"towers":snap_towers(terrain,values),"weights":DEFAULT_WEIGHTS}
        active_candidate={"index":index,"towers":config["towers"],"weights":config["weights"]}
        progress({"phase":"training","seed":seed,"completed":index,"total":protocol["candidates"],"history":history,
                  "activeCandidate":active_candidate,"candidateCompleted":0,"candidateEpisodes":len(train_episodes),
                  "candidateMetrics":None,"bestCandidate":best_index,"preview":None})
        def training_progress(partial,example,completed,total):
            progress({"phase":"training","seed":seed,"completed":index,"total":protocol["candidates"],"history":history,
                      "activeCandidate":active_candidate,"candidateCompleted":completed,"candidateEpisodes":total,
                      "candidateMetrics":partial,"bestCandidate":best_index,
                      "preview":training_preview("training",index,example,total)})
        score,training_rows=evaluate(terrain,config,train_episodes,motion,h,dt,capture_preview=True,on_progress=training_progress)
        preview=training_preview("training",index,training_rows[0],len(train_episodes))
        accepted=best_score is None or objective(score)<objective(best_score)
        if accepted: best_config,best_score,best_index=config,score,index
        history.append({"index":index,"towers":config["towers"],"weights":config["weights"],"train":score,"accepted":accepted,"preview":preview})
        progress({"phase":"training","seed":seed,"completed":index+1,"total":protocol["candidates"],"history":history,
                  "activeCandidate":active_candidate,"candidateCompleted":len(train_episodes),"candidateEpisodes":len(train_episodes),
                  "candidateMetrics":score,"bestCandidate":best_index,"preview":preview})
        print(f"Candidate{index+1}/{protocol['candidates']}: {score['detectionRate']:.1f}% detected; cappedmean{score['meanCappedS']:.1f}s",flush=True)
    # Initial plus three training finalists; validation decides, never the test.
    finalists={0,*[c["index"] for c in sorted(history,key=lambda c:(objective(c["train"]),c["index"]))[:3]]}
    progress({"phase":"validation","seed":seed,"completed":protocol["candidates"],"total":protocol["candidates"],
              "history":history,"validationCompleted":0,"validationTotal":len(finalists),"bestCandidate":best_index,"preview":None})
    for validation_index,i in enumerate(sorted(finalists)):
        config={"towers":history[i]["towers"],"weights":history[i]["weights"]}
        active_candidate={"index":i,"towers":config["towers"],"weights":config["weights"]}
        progress({"phase":"validation","seed":seed,"completed":protocol["candidates"],"total":protocol["candidates"],"history":history,
                  "validationCompleted":validation_index,"validationTotal":len(finalists),"activeCandidate":active_candidate,
                  "candidateCompleted":0,"candidateEpisodes":len(validation),"candidateMetrics":None,"bestCandidate":best_index,"preview":None})
        def validation_progress(partial,example,completed,total):
            progress({"phase":"validation","seed":seed,"completed":protocol["candidates"],"total":protocol["candidates"],"history":history,
                      "validationCompleted":validation_index,"validationTotal":len(finalists),"activeCandidate":active_candidate,
                      "candidateCompleted":completed,"candidateEpisodes":total,"candidateMetrics":partial,"bestCandidate":best_index,
                      "preview":training_preview("validation",i,example,total)})
        history[i]["validation"],validation_rows=evaluate(terrain,config,validation,motion,h,dt,capture_preview=True,on_progress=validation_progress)
        progress({"phase":"validation","seed":seed,"completed":protocol["candidates"],"total":protocol["candidates"],
                  "history":history,"validationCompleted":validation_index+1,"validationTotal":len(finalists),
                  "activeCandidate":active_candidate,"candidateCompleted":len(validation),"candidateEpisodes":len(validation),
                  "candidateMetrics":history[i]["validation"],"bestCandidate":best_index,
                  "preview":training_preview("validation",i,validation_rows[0],len(validation))})
    winner=min((history[i] for i in finalists),key=lambda c:(objective(c["validation"]),c["index"]))
    selected={"towers":winner["towers"],"weights":winner["weights"]}
    model={"schemaVersion":1,"mode":"synthetic-terrain-graph","missionVersion":MISSION_VERSION,
           "sensorModel":SENSOR_MODEL,"placementFrozen":True,"seed":seed,"profileHash":profile_hash(profile),
           "sourceSha256":sources_at_start,"protocol":protocol,"motion":motion,"trained":selected,"selectedIndex":winner["index"]}
    if source_hashes()!=sources_at_start:
        raise ValueError("Experiment source changed during training; rerun with stable code")
    save(args.model_output,model)
    progress({"phase":"test","seed":seed,"completed":protocol["candidates"],"total":protocol["candidates"],"history":history,
              "testCompleted":0,"testTotal":protocol["testEpisodes"]*3,"bestCandidate":winner["index"],"preview":None,
              **progress_snapshot({},"baseline",h,dt)})
    tests=[scenario(terrain,seed+400000+i,h,dt) for i in range(protocol["testEpisodes"])]
    result_rows={}
    count=0
    for label,config,learned_motion in (("baseline",baseline,None),("untrained",untrained,None),("trained",selected,motion)):
        rows=[]
        candidate_index=winner["index"] if label=="trained" else None
        active_candidate={"index":candidate_index,"towers":config["towers"],"weights":config["weights"]}
        progress({"phase":"test","seed":seed,"completed":protocol["candidates"],"total":protocol["candidates"],"history":history,
                  "testCompleted":count,"testTotal":len(tests)*3,"activeCandidate":active_candidate,
                  "candidateCompleted":0,"candidateEpisodes":len(tests),"candidateMetrics":None,"bestCandidate":winner["index"],"preview":None,
                  **progress_snapshot(result_rows,label,h,dt)})
        for episode_index,episode in enumerate(tests):
            rows.append(run_episode(terrain,config,episode,learned_motion,h,dt,label=="trained" or episode_index==0))
            count+=1
            if len(rows)==1 or count%10==0 or len(rows)==len(tests):
                progress({"phase":"test","seed":seed,"completed":protocol["candidates"],"total":protocol["candidates"],"history":history,
                          "testCompleted":count,"testTotal":len(tests)*3,"activeCandidate":active_candidate,
                          "candidateCompleted":len(rows),"candidateEpisodes":len(tests),"candidateMetrics":summarize(rows),
                          "bestCandidate":winner["index"],"preview":training_preview("test",candidate_index,rows[0],len(tests),label),
                          **progress_snapshot({**result_rows,label:rows},label,h,dt)})
        result_rows[label]=rows
        print(f"{label}: {summarize(rows)}",flush=True)
    metrics={label:summarize(rows) for label,rows in result_rows.items()}
    detection_curve=[{"t":t,**{label:100*sum(r["metrics"]["detectedAt"] is not None and r["metrics"]["detectedAt"]<=t for r in rows)/len(rows)
                                for label,rows in result_rows.items()}} for t in range(0,h+1,dt)]
    delta=np.array([a["metrics"]["meanCappedS"]-b["metrics"]["meanCappedS"] for a,b in zip(result_rows["baseline"],result_rows["trained"])])
    bootstrap=np.random.default_rng(seed+500000).choice(delta,(1000,len(delta)),replace=True).mean(axis=1)
    report={"schemaVersion":1,"mode":"synthetic-terrain-graph","missionVersion":MISSION_VERSION,
            "sensorModel":SENSOR_MODEL,"placementFrozen":True,"seed":seed,"profileHash":profile_hash(profile),
            "sourceSha256":sources_at_start,"protocol":protocol,"trained":selected,"selectedIndex":winner["index"],
            "baseline":{"towers":baseline_towers},"history":history,"metrics":metrics,"detectionCurve":detection_curve,
            "comparison":{"meanSecondsSaved":float(delta.mean()),"pairedBootstrap95S":np.quantile(bootstrap,[.025,.975]).tolist(),
                          "detectionRateGain":metrics["trained"]["detectionRate"]-metrics["baseline"]["detectionRate"],
                          "testUsedForSelection":False},
            "perEpisode":{label:[r["metrics"] for r in rows] for label,rows in result_rows.items()},
            "replays":result_rows["trained"],"modelSummary":{"type":"Training-prior tower placement search; observation-only confirmation, drone dispatch and target tracking",
                          "motionTrajectories":len(motion_episodes),"motionTransitions":motion["trainingTransitions"],"weights":selected["weights"]},
            "policyLabels":{"baseline":"Default towers + systematic aircraft sweep (comparison)",
                            "untrained":"Default towers + tower-first mission","trained":"Selected towers + tower-first mission"},
            "metricDefinitions":{"detectionRate":"Percentage of all missions with a two-frame tower-confirmed estimate within 150 m of evaluator truth; same denominator for every policy. False contact confirmations earn no detection success.",
                                 "contactConfirmationRate":"Percentage of missions in which the observation-only controller confirmed any contact, including clutter; distinct from target detectionRate.",
                                 "handoffRate":"Percentage of all missions with two accepted distinct-time observations by the same aircraft within 15 s after true tower acquisition; both observations and current estimate must match evaluator truth within 150 m. Dispatch alone or a false track earns no success.",
                                 "custodyPct":"Percentage of all mission samples with true receiver-confirmed aircraft evidence no older than 10 s and current estimate within 150 m of evaluator truth.",
                                 "postTowerCustodyPct":"Pooled true-target custody samples divided by samples after true tower acquisition when both towers geometrically lack view of evaluator truth; null if no eligible samples.",
                                 "falseConfirmations":"Mean number of confirmed tower cues per mission more than 150 m from evaluator truth; synthetic scoring threshold, not measured precision.",
                                 "rmseM":"Pooled error over observed and coasting track estimates, versus evaluator-only truth. Predictions stop after 45 seconds without accepted observations."},
            "limitations":["Offline synthetic experiment on source-derived WORLD XY terrain; not live ArcticSim observations or official challenge scores.",
              "Camera HFOV/VFOV/tilt and 1500 m render clipping come from source; render clip is not a verified detection radius. Detection probability depends on assumed 6 m vessel projected size, distance, image-edge angle and clear/haze/glare contrast; localization error grows with range and poor contrast. All sensor response constants and clutter probabilities are uncalibrated assumptions, not trained image recognition.",
              "Terrain is a sampled bilinear grid. LOS and boat routing cannot resolve obstacles below its spacing; boat starts span all connected sampled water nodes, with no rejection by detector outcome.",
              "Aircraft start airborne at source launch XY and maintain assumed 60 m (quad)/120 m (plane) terrain clearance; speeds 10/15 m/s and body-heading-rate limits 45/15 deg/s. The multirotor may translate sideways while its bounded body yaw faces the estimate. Takeoff, acceleration, roll/pitch, climb, wind and loiter remain simplified, not flight dynamics.",
              "Tower bases remain fixed throughout each mission. Tower cameras scan 6 deg/s until a candidate observation, then aim at the observation-derived estimate within source pitch limits; tower slew dynamics are simplified. Quad camera is rigidly body-mounted at source-derived -20 degrees with no independent gimbal aim; the quad pursues a viewing standoff derived from modeled sea height and mount depression. Plane camera remains fixed near -8 degrees.",
              "Towers are selected from training candidates and frozen before test missions. No global-optimality or all-spawn guarantee. Aircraft stand by (plane launch loiter/quad hold), both dispatch only after tower confirmation, and follow estimated target state. Baseline systematic sweep is explicitly a comparison.",
              "A* minimizes weighted 3D grid distance. Motion prior guides placement proposal only; detector and tracking gains are not learned here. Legacy weights are retained in files for compatibility, not optimized or used to claim learned pursuit.",
              "Coverage counts visible sampled water-node centers. Two consistent tower frames confirm a cue. Two distinct-time accepted frames from the same aircraft within 15 s confirm handoff (offline cadence 5 s). Prediction coasts with growing uncertainty and becomes lost after 45 s. Evaluation uses a declared 150 m spatial tolerance to distinguish true target outcomes from clutter; these evaluator-only labels never enter the controller and are not a measured detector accuracy specification.",
              "The learned model uses training trajectories only. Training selects candidates, validation selects the winner, and untouched test results are reported even if they regress."],
            "sources":profile.get("source"),"wallSeconds":time.perf_counter()-started}
    if source_hashes()!=sources_at_start:
        raise ValueError("Experiment source changed during evaluation; rerun with stable code")
    save(args.output,report)
    progress({"phase":"complete","seed":seed,"completed":protocol["candidates"],"total":protocol["candidates"],"history":history,"metrics":metrics,
              "testCompleted":count,"testTotal":len(tests)*3,"bestCandidate":winner["index"],
              "preview":training_preview("test",winner["index"],result_rows["trained"][0],len(tests),"trained"),
              **progress_snapshot(result_rows,"trained",h,dt)})
    return report


def replay(args):
    profile=json.loads(Path(args.profile).read_text(encoding="utf-8"))
    model=json.loads(Path(args.model).read_text(encoding="utf-8"))
    if model.get("missionVersion")!=MISSION_VERSION: raise ValueError("Frozen model predates tower-first missions; retrain before replay")
    if model["profileHash"]!=profile_hash(profile): raise ValueError("Frozen model does not match the terrain profile")
    if model.get("sourceSha256")!=source_hashes(): raise ValueError("Frozen model does not match the experiment source; retrain before replay")
    request=json.loads(Path(args.replay).read_text(encoding="utf-8"))
    seed=int(request.get("seed",model["seed"]+900000))
    if seed<0 or seed>2**31-1: raise ValueError("Seed outside accepted bounds")
    terrain=Terrain(profile)
    config={"towers":snap_towers(terrain,request.get("towers",model["trained"]["towers"])),"weights":model["trained"]["weights"]}
    start=request.get("boatStart")
    if start is not None:
        point=np.array([float(start["x"]),float(start["y"])])
        if not np.isfinite(point).all(): raise ValueError("Boat start must be finite")
        node=int(min(terrain.spawn_ids,key=lambda i:np.sum((terrain.xy[i]-point)**2)))
        start={"x":float(terrain.xy[node,0]),"y":float(terrain.xy[node,1])}
    p=model["protocol"]
    episode=scenario(terrain,seed,p["horizonS"],p["stepS"],start)
    result=run_episode(terrain,config,episode,model["motion"],p["horizonS"],p["stepS"],True)
    result.update(schemaVersion=1,mode="synthetic-terrain-graph",missionVersion=MISSION_VERSION,placementFrozen=True,
                  profileHash=model["profileHash"],boatStart={"x":float(episode.positions[0,0]),"y":float(episode.positions[0,1])})
    save(args.output,result)
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile",default=str(DEFAULT_DIR/"arctic-profile.json"))
    parser.add_argument("--output",default=str(DEFAULT_DIR/"graph-report.json"))
    parser.add_argument("--model-output",default=str(DEFAULT_DIR/"graph-model.json"))
    parser.add_argument("--progress")
    parser.add_argument("--seed",type=int,default=190926)
    parser.add_argument("--quick",action="store_true")
    parser.add_argument("--replay")
    parser.add_argument("--model",default=str(DEFAULT_DIR/"graph-model.json"))
    args=parser.parse_args()
    try:
        replay(args) if args.replay else train(args)
    except (ValueError,KeyError,OSError) as error:
        if args.progress: save(args.progress,{"phase":"error","error":str(error)})
        parser.error(str(error))


if __name__=="__main__": main()
