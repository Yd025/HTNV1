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

from graph_search import (DEFAULT_WEIGHTS, Terrain, objective, profile_hash, run_episode,
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
              "candidates":4 if args.quick else 12,"horizonS":300,"stepS":5,"freshnessS":10}
    seed=int(args.seed)
    if seed<0 or seed>2**31-1: raise ValueError("Seed must be between0 and2147483647")
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
        else:
            # Actual policy parameters and tower positions are jointly fitted.
            # Every fourth proposal explores globally; the rest refine incumbent.
            values=[]
            for tower in best_config["towers"]:
                if index%4==0:
                    node=int(rng.choice(terrain.land))
                    point=terrain.xy[node]
                else:
                    point=np.asarray([tower["x"],tower["y"]])+rng.normal(0,500 if index<6 else 220,2)
                values.append({"x":float(point[0]),"y":float(point[1]),"heading":float(tower["heading"]+rng.normal(0,35))})
            config={"towers":snap_towers(terrain,values),"weights":np.clip(np.asarray(best_config["weights"])*np.exp(rng.normal(0,.35,5)),.05,15).tolist()}
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
    model={"schemaVersion":1,"mode":"synthetic-terrain-graph","seed":seed,"profileHash":profile_hash(profile),
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
    report={"schemaVersion":1,"mode":"synthetic-terrain-graph","seed":seed,"profileHash":profile_hash(profile),
            "sourceSha256":sources_at_start,"protocol":protocol,"trained":selected,"selectedIndex":winner["index"],
            "baseline":{"towers":baseline_towers},"history":history,"metrics":metrics,"detectionCurve":detection_curve,
            "comparison":{"meanSecondsSaved":float(delta.mean()),"pairedBootstrap95S":np.quantile(bootstrap,[.025,.975]).tolist(),
                          "detectionRateGain":metrics["trained"]["detectionRate"]-metrics["baseline"]["detectionRate"],
                          "testUsedForSelection":False},
            "perEpisode":{label:[r["metrics"] for r in rows] for label,rows in result_rows.items()},
            "replays":result_rows["trained"],"modelSummary":{"type":"Maximum-likelihood sparse water-motion model plus fitted5-feature node scoring",
                          "motionTrajectories":len(motion_episodes),"motionTransitions":motion["trainingTransitions"],"weights":selected["weights"]},
            "limitations":["Offline synthetic experiment on source-derived WORLD XY terrain; not live ArcticSim observations or official challenge scores.",
              "Camera HFOV/VFOV/tilt and1500m render clipping come from source; render clip is not a verified detection radius. Synthetic detector probability0.9 and15m Gaussian coordinate noise are assumptions.",
              "Terrain is a sampled bilinear grid. LOS and boat routing cannot resolve obstacles below its spacing; boat starts span all connected sampled water nodes, with no rejection by detector outcome.",
              "Aircraft start airborne at source launch XY and maintain assumed 60m (quad)/120m (plane) terrain clearance; speeds 10/15m/s and heading-rate limits 45/15deg/s. Takeoff, turns, climb and loiter are simplified, not flight dynamics.",
              "Towers remain fixed during each mission and scan6deg/s at zero pitch. Tower relocation is an offline placement candidate, never a response to hidden boat truth.",
              "A* minimizes weighted3D grid distance to the selected node. Learned goal choice and tower placement have no global-optimality or all-spawn detection guarantee.",
              "Coverage counts visible sampled water-node centers cumulatively. Custody/availability count samples with observations no older than10s; RMSE uses noisy observation-derived estimates versus evaluator-only truth.",
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
    result.update(schemaVersion=1,mode="synthetic-terrain-graph",profileHash=model["profileHash"],boatStart={"x":float(episode.positions[0,0]),"y":float(episode.positions[0,1])})
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
