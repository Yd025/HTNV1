"""Offline learned search on the source-derived ArcticSim terrain grid.

World XY coordinates, not geographic north/east. Truth is owned by Scenario and
run_episode; BeliefPlanner receives only sensor observations and own poses.
Camera and kinematic approximations are explicit in the generated report.
"""
from __future__ import annotations

import hashlib
import heapq
import json
import math
from dataclasses import dataclass
from pathlib import Path

import numpy as np

DEFAULT_WEIGHTS = [4.0, 1.3, 1.0, 1.0, 0.4]


def angle_delta(a, b):
    return (a - b + 180) % 360 - 180


class Terrain:
    def __init__(self, profile: dict):
        self.profile = profile
        g = profile["grid"]
        self.size, self.cell = int(g["size"]), float(g["cellM"])
        self.xmin, self.ymin = float(g["xMin"]), float(g["yMin"])
        self.height = np.asarray(g["elevations"], dtype=float).reshape(-1)
        self.water = np.asarray(g["water"], dtype=bool).reshape(-1)
        if len(self.height) != self.size ** 2 or len(self.water) != len(self.height):
            raise ValueError("Terrain grid shape does not match its arrays")
        if not np.isfinite(self.height).all():
            raise ValueError("Terrain heights must be finite")
        yy, xx = np.divmod(np.arange(self.size ** 2), self.size)
        self.xy = np.column_stack((self.xmin + xx * self.cell, self.ymin + yy * self.cell))
        self.wids = np.flatnonzero(self.water)
        self.water_neighbors = {int(i): [] for i in self.wids}
        for a, b in g["waterEdges"]:
            if not self.water[a] or not self.water[b]:
                raise ValueError("Water edge touches a non-water node")
            self.water_neighbors[a].append(b)
            self.water_neighbors[b].append(a)
        self.spawn_ids = np.array([i for i in self.wids if self.water_neighbors[int(i)]], dtype=int)
        if not len(self.spawn_ids):
            raise ValueError("Terrain has no connected water route")
        self.land = np.asarray(g["landCandidates"], dtype=int)
        if not len(self.land):
            raise ValueError("Terrain has no legal tower candidates")
        self.air_neighbors = {}
        for i in range(len(self.xy)):
            r, c = divmod(i, self.size)
            self.air_neighbors[i] = [rr * self.size + cc for rr in range(max(0, r-1), min(self.size, r+2))
                                     for cc in range(max(0, c-1), min(self.size, c+2)) if (rr, cc) != (r, c)]
        self._path_cache = {}
        self._edge_cache = {}
        self._footprint_cache = {}
        self._potential_neighbors = {}
        for i in self.wids:
            distance = np.linalg.norm(self.xy[self.wids] - self.xy[i], axis=1)
            self._potential_neighbors[int(i)] = np.flatnonzero(distance <= max(260, self.cell * 2))

    def node(self, x, y):
        c = int(np.clip(round((x-self.xmin)/self.cell), 0, self.size-1))
        r = int(np.clip(round((y-self.ymin)/self.cell), 0, self.size-1))
        return r*self.size+c

    def elevation(self, x, y):
        c = np.clip((np.asarray(x)-self.xmin)/self.cell, 0, self.size-1)
        r = np.clip((np.asarray(y)-self.ymin)/self.cell, 0, self.size-1)
        c0, r0 = np.floor(c).astype(int), np.floor(r).astype(int)
        c1, r1 = np.minimum(c0+1, self.size-1), np.minimum(r0+1, self.size-1)
        u, v = c-c0, r-r0
        return ((1-u)*(1-v)*self.height[r0*self.size+c0] + u*(1-v)*self.height[r0*self.size+c1]
                + (1-u)*v*self.height[r1*self.size+c0] + u*v*self.height[r1*self.size+c1])

    def los(self, x, y, z, tx, ty, tz):
        """Sample every <= half grid cell. Heights between samples are bilinear."""
        tx, ty, tz = np.broadcast_arrays(np.asarray(tx, float), np.asarray(ty, float), np.asarray(tz, float))
        clear = np.ones(tx.shape, dtype=bool)
        distance = np.hypot(tx-x, ty-y)
        steps = max(3, min(100, int(float(np.max(distance, initial=0))/max(10, self.cell/2))+1))
        for f in np.linspace(0, 1, steps+1)[1:-1]:
            ground = self.elevation(x+(tx-x)*f, y+(ty-y)*f)
            clear &= z+(tz-z)*f > ground + 0.2
        return clear

    def camera_mask(self, pose, kind, targets=None):
        sensor = self.profile["sensors"][kind]
        xy = self.xy[self.wids] if targets is None else np.asarray(targets, dtype=float).reshape(-1, 2)
        dx, dy = xy[:, 0]-pose["x"], xy[:, 1]-pose["y"]
        ground = self.elevation(xy[:, 0], xy[:, 1])
        tz = np.maximum(0, ground) + 1.5  # explicit synthetic boat observation point
        dz = tz-pose["z"]
        heading, pitch = math.radians(pose["heading"]), math.radians(pose.get("pitch", sensor.get("pitchDeg", 0)))
        forward_xy = dx*math.sin(heading)+dy*math.cos(heading)
        side = dx*math.cos(heading)-dy*math.sin(heading)
        forward = forward_xy*math.cos(pitch)+dz*math.sin(pitch)
        vertical = dz*math.cos(pitch)-forward_xy*math.sin(pitch)
        # SDF rendering clip values are optical-axis depths, not slant ranges.
        inside = ((forward <= sensor["farClipM"]) & (forward >= sensor.get("nearClipM", .1))
                  & (np.abs(side) <= forward*math.tan(math.radians(sensor["hfovDeg"])/2))
                  & (np.abs(vertical) <= forward*math.tan(math.radians(sensor["vfovDeg"])/2)))
        ids = np.flatnonzero(inside)
        if len(ids):
            inside[ids] &= self.los(pose["x"], pose["y"], pose["z"], xy[ids, 0], xy[ids, 1], tz[ids])
        return inside

    def path(self, start, goal, clearance, algorithm="astar"):
        """Shortest 3D grid path; both endpoints and each edge clear terrain."""
        key = start, goal, clearance, algorithm
        if key in self._path_cache:
            return self._path_cache[key]
        heap = [(0., start)]
        cost, parent = {start: 0.}, {}
        while heap:
            _, node = heapq.heappop(heap)
            if node == goal:
                route = [node]
                while node in parent:
                    node = parent[node]
                    route.append(node)
                route.reverse()
                result = route, cost[goal]
                self._path_cache[key] = result
                return result
            x, y = self.xy[node]
            z = self.height[node]+clearance
            for nxt in self.air_neighbors[node]:
                nx, ny = self.xy[nxt]
                nz = self.height[nxt]+clearance
                # A straight edge can intersect a ridge even if endpoints clear it.
                edge_key = (min(node,nxt),max(node,nxt),clearance)
                if edge_key not in self._edge_cache:
                    self._edge_cache[edge_key] = (math.sqrt((nx-x)**2+(ny-y)**2+(nz-z)**2)
                        if bool(self.los(x,y,z,[nx],[ny],[nz])[0]) else math.inf)
                edge = self._edge_cache[edge_key]
                if not math.isfinite(edge):
                    continue
                candidate = cost[node]+edge
                if candidate < cost.get(nxt, math.inf):
                    cost[nxt], parent[nxt] = candidate, node
                    heuristic = float(np.linalg.norm(self.xy[nxt]-self.xy[goal])) if algorithm == "astar" else 0.
                    heapq.heappush(heap, (candidate+heuristic, nxt))
        return [], math.inf


@dataclass(frozen=True)
class Scenario:
    seed: int
    positions: np.ndarray


def scenario(terrain, seed, horizon=300, step=5, start=None):
    rng = np.random.default_rng(seed)
    if start is None:
        node = int(rng.choice(terrain.spawn_ids))
        point = terrain.xy[node].copy()
    else:
        point = np.array([float(start["x"]), float(start["y"])])
        if not np.isfinite(point).all():
            raise ValueError("Boat start must be finite")
        node = terrain.node(*point)
        if node not in terrain.water_neighbors or not terrain.water_neighbors[node]:
            raise ValueError("Boat start must lie on connected sampled water")
        if np.linalg.norm(point-terrain.xy[node]) > terrain.cell*.1:
            raise ValueError("Choose a sampled water node for the boat start")
        point = terrain.xy[node].copy()
    positions = [point.copy()]
    previous = None
    target = node
    for _ in range(int(horizon/step)):
        remaining = terrain.profile["speedsMps"]["boat"]*step
        while remaining > 1e-8:
            if np.linalg.norm(terrain.xy[target]-point) < 1e-6:
                choices = [i for i in terrain.water_neighbors[target] if i != previous] or terrain.water_neighbors[target]
                previous, node = node, target
                target = int(rng.choice(choices))
            delta = terrain.xy[target]-point
            distance = float(np.linalg.norm(delta))
            travel = min(remaining, distance)
            point = point+delta*(travel/max(distance, 1e-9))
            remaining -= travel
        positions.append(point.copy())
    return Scenario(int(seed), np.asarray(positions))


def train_motion(terrain, episodes, horizon=300, step=5):
    """Maximum-likelihood occupancy and transitions with explicit pseudocounts."""
    mapping = {int(node): i for i, node in enumerate(terrain.wids)}
    prior = np.ones(len(mapping), dtype=float)
    counts = {(i, i): 1.0 for i in range(len(mapping))}
    for node, neighbors in terrain.water_neighbors.items():
        for other in neighbors:
            counts[(mapping[node], mapping[other])] = .05
    observations = 0
    for episode in episodes:
        nodes = [mapping[terrain.node(*point)] for point in episode.positions]
        prior[nodes[0]] += 1
        for a, b in zip(nodes, nodes[1:]):
            counts[(a, b)] = counts.get((a, b), .05)+1
            observations += 1
    totals = np.zeros(len(mapping))
    for (a, _), count in counts.items():
        totals[a] += count
    transitions = [[a, b, count/totals[a]] for (a, b), count in sorted(counts.items())]
    return {"prior": (prior/prior.sum()).tolist(), "transitions": transitions,
            "trainingTrajectories": len(episodes), "trainingTransitions": observations, "stepS": step}


def towers_for(terrain, values):
    towers = []
    for index, value in enumerate(values):
        x, y = float(value["x"]), float(value["y"])
        if not math.isfinite(x+y) or max(abs(x), abs(y)) > terrain.profile["halfM"]:
            raise ValueError("Tower outside terrain")
        node = terrain.node(x, y)
        if terrain.water[node]:
            raise ValueError("Tower must be on sampled land")
        towers.append({"id": value.get("id", f"tower-{index+1}"), "x": x, "y": y,
                       "z": float(terrain.elevation(x, y))+terrain.profile["assetHeightsM"]["tower"],
                       "heading": float(value.get("heading", value.get("headingDeg", 0))) % 360,
                       "pitch": 0.0})
    if len(towers) != 2 or len({t["id"] for t in towers}) != 2:
        raise ValueError("Exactly two distinct towers are required")
    return towers


class BeliefPlanner:
    """No Scenario, hidden boat position, future route or evaluation metrics input."""
    def __init__(self, terrain, motion=None, weights=None, baseline=False):
        self.terrain, self.baseline = terrain, baseline
        n = len(terrain.wids)
        self.belief = np.array(motion["prior"] if motion else [1/n]*n, dtype=float)
        self.weights = np.array(weights or DEFAULT_WEIGHTS)
        self.seen = np.zeros(n, dtype=bool)
        self.age = np.zeros(n)
        self.motion = motion
        if motion:
            t = np.asarray(motion["transitions"])
            self.src, self.dst, self.prob = t[:,0].astype(int), t[:,1].astype(int), t[:,2]
        self.goals, self.routes = {}, {}
        self.cursor = {"plane": 0, "quad": 0}
        # Distinct systematic partitions; baseline uses the same air route solver.
        ordered = sorted(map(int, terrain.wids), key=lambda i: (i//terrain.size, (i % terrain.size)*(-1 if i//terrain.size % 2 else 1)))
        self.sweep = {"plane": ordered[::2], "quad": ordered[1::2]}

    def observe(self, masks, measurements, step):
        if self.motion:
            self.belief = np.bincount(self.dst, weights=self.belief[self.src]*self.prob, minlength=len(self.belief))
        self.age = np.minimum(1., self.age+step/120)
        for mask in masks:
            self.seen |= mask
            self.age[mask] = 0
            self.belief[mask] *= .1
        if measurements:
            point = np.mean(measurements, axis=0)
            dist2 = np.sum((self.terrain.xy[self.terrain.wids]-point)**2, axis=1)
            self.belief += np.exp(-dist2/(2*100**2))
        total = self.belief.sum()
        self.belief = self.belief/total if total > 1e-15 else np.ones(len(self.belief))/len(self.belief)

    def goal(self, drone, other_goal=None):
        kind = drone["id"]
        if self.baseline:
            route = self.sweep[kind]
            if not route:
                return self.terrain.node(drone["x"], drone["y"])
            if kind not in self.goals:
                self.cursor[kind] = min(range(len(route)), key=lambda i: np.linalg.norm(self.terrain.xy[route[i]]-[drone["x"],drone["y"]]))
            else:
                self.cursor[kind] = (self.cursor[kind]+1) % len(route)
            result = route[self.cursor[kind]]
        else:
            current = np.array([drone["x"], drone["y"]])
            distances = np.linalg.norm(self.terrain.xy[self.terrain.wids]-current, axis=1)
            # All sampled water nodes are candidates; cheap aggregate features.
            raw = self.belief*len(self.belief) + .8*(~self.seen) + .2*self.age - distances/6000
            ids = np.argsort(-raw, kind="stable")[:24]
            best, result = -math.inf, int(self.terrain.wids[ids[0]])
            for j in ids:
                node = int(self.terrain.wids[j])
                nearby = self.terrain._potential_neighbors[node]
                mass = self.belief[nearby].sum()*len(self.belief)/max(1,len(nearby))
                novel = 1-self.seen[nearby].mean()
                age = self.age[nearby].mean()
                travel = distances[j]/self.terrain.profile["speedsMps"][kind]/300
                overlap = 0 if other_goal is None else math.exp(-float(np.sum((self.terrain.xy[node]-self.terrain.xy[other_goal])**2))/(2*450**2))
                features = np.array([mass, novel, -travel, -overlap, age])
                score = float(self.weights @ features)
                if score > best:
                    best, result = score, node
        self.goals[kind] = result
        return result


def move_drone(terrain, drone, goal, step):
    node = terrain.node(drone["x"], drone["y"])
    clearance = terrain.profile["assetHeightsM"][drone["id"]]
    route, _ = terrain.path(node, goal, clearance)
    drone["path"] = [{"x":float(terrain.xy[n,0]),"y":float(terrain.xy[n,1])} for n in route]
    if not route:
        return 0.
    next_node = route[1] if len(route)>1 else route[0]
    target = terrain.xy[next_node]
    delta = target-[drone["x"], drone["y"]]
    desired = math.degrees(math.atan2(delta[0], delta[1])) % 360
    limit = (15 if drone["id"] == "plane" else 45)*step
    drone["heading"] = (drone["heading"]+float(np.clip(angle_delta(desired,drone["heading"]),-limit,limit))) % 360
    distance = min(terrain.profile["speedsMps"][drone["id"]]*step, float(np.linalg.norm(delta)))
    rad = math.radians(drone["heading"])
    nx, ny = drone["x"]+math.sin(rad)*distance, drone["y"]+math.cos(rad)*distance
    half = terrain.profile["halfM"]
    nx, ny = float(np.clip(nx,-half,half)), float(np.clip(ny,-half,half))
    nz = float(terrain.elevation(nx,ny))+clearance
    if not bool(terrain.los(drone["x"],drone["y"],drone["z"],[nx],[ny],[nz])[0]):
        return 0.
    actual = math.hypot(nx-drone["x"],ny-drone["y"])
    drone.update(x=nx,y=ny,z=nz,goal={"x":float(terrain.xy[goal,0]),"y":float(terrain.xy[goal,1])})
    return actual


def run_episode(terrain, config, episode, motion=None, horizon=300, step=5, replay=False):
    planner = BeliefPlanner(terrain, motion, config.get("weights"), config.get("baseline",False))
    towers = towers_for(terrain,config["towers"])
    # Same launch points for every compared policy; never conditioned on spawn.
    launch = terrain.profile.get("launchPoints") or {asset["sensor"]:asset for asset in terrain.profile.get("assets",[]) if asset["sensor"] in ("plane","quad")}
    drones = []
    for kind, fallback in (("plane",(-150.,0.)),("quad",(150.,0.))):
        p = launch.get(kind,{"x":fallback[0],"y":fallback[1]})
        x,y = float(p["x"]),float(p["y"])
        drones.append({"id":kind,"x":x,"y":y,"z":float(terrain.elevation(x,y))+terrain.profile["assetHeightsM"][kind],"heading":0.})
    seen = np.zeros(len(terrain.wids),dtype=bool)
    found, distance, custody, estimate_count, error_sum, handoffs = None,0.,0,0,0.,0
    contributions = {p["id"]:0 for p in towers+drones}
    last_source, last_obs_t, last_point, velocity = None,-math.inf,None,np.zeros(2)
    frames=[]
    for tick,t in enumerate(range(0,horizon+1,step)):
        boat = episode.positions[tick]
        masks, measurements, sources = [],[],[]
        positions = [dict(p,heading=(p["heading"]+t*6)%360) for p in towers]+drones
        for asset_index,asset in enumerate(positions):
            kind = "tower" if asset_index<2 else asset["id"]
            mask = terrain.camera_mask(asset,kind)
            masks.append(mask)
            seen |= mask
            # Common per-episode/tick/source observation noise across policies.
            sid = [p["id"] for p in towers+drones].index(asset["id"])
            rng=np.random.default_rng(episode.seed*65537+tick*17+sid)
            if bool(terrain.camera_mask(asset,kind,[boat])[0]) and rng.random()<.9:
                sources.append(asset["id"])
                measurements.append(boat+rng.normal(0,15,2))
                contributions[asset["id"]]+=1
        planner.observe(masks,measurements,step)
        estimate=None
        tracking=None
        if sources:
            if found is None: found=t
            # A sensor observation, not hidden truth, selects the nearest source.
            point=np.mean(measurements,axis=0)
            source=min(sources,key=lambda s:(math.hypot(next(p["x"] for p in positions if p["id"]==s)-point[0],next(p["y"] for p in positions if p["id"]==s)-point[1]),s))
            if last_source is not None and source != last_source: handoffs+=1
            if last_point is not None and t>last_obs_t:
                velocity=(point-last_point)/(t-last_obs_t)
                speed=float(np.linalg.norm(velocity))
                if speed>6: velocity*=6/speed
            last_point,last_obs_t,last_source=point,t,source
            tracking=source
        if t-last_obs_t<=10 and last_point is not None:
            estimate=last_point+velocity*(t-last_obs_t)
            custody+=1
            estimate_count+=1
            error_sum+=float(np.sum((estimate-boat)**2))
        if replay:
            frames.append({"t":t,"boat":{"x":float(boat[0]),"y":float(boat[1])},"drones":[dict(d) for d in drones],
                           "sources":sources,"coveragePct":float(seen.mean()*100),
                           "estimate":None if estimate is None else {"x":float(estimate[0]),"y":float(estimate[1])},
                           "trackingSource":tracking,"towerHeadings":[p["heading"] for p in positions[:2]]})
        if t<horizon:
            for drone in drones:
                previous=planner.goals.get(drone["id"])
                reached=previous is not None and np.linalg.norm(terrain.xy[previous]-[drone["x"],drone["y"]])<terrain.cell*.3
                if previous is None or reached or (not config.get("baseline") and t%30==0):
                    other=planner.goals.get("quad" if drone["id"]=="plane" else "plane")
                    previous=planner.goal(drone,other)
                distance+=move_drone(terrain,drone,previous,step)
    samples=int(horizon/step)+1
    metrics={"seed":episode.seed,"detectedAt":found,"detectionRate":100. if found is not None else 0.,"meanCappedS":found if found is not None else horizon,
             "p90CappedS":found if found is not None else horizon,"coveragePct":float(seen.mean()*100),"custodyPct":custody/samples*100,
             "rmseM":math.sqrt(error_sum/estimate_count) if estimate_count else None,"estimateAvailabilityPct":estimate_count/samples*100,
             "distanceM":distance,"handoffs":handoffs,"bySource":contributions,"estimateSamples":estimate_count,"squaredErrorSum":error_sum}
    return {"seed":episode.seed,"towers":towers,"frames":frames,"metrics":metrics}


def summarize(rows):
    metrics=[r["metrics"] for r in rows]
    times=sorted(m["meanCappedS"] for m in metrics)
    count=sum(m["estimateSamples"] for m in metrics)
    fields=("detectionRate","meanCappedS","coveragePct","custodyPct","estimateAvailabilityPct","distanceM","handoffs")
    result={key:float(np.mean([m[key] for m in metrics])) for key in fields}
    result.update(episodes=len(metrics),p90CappedS=times[math.ceil(.9*len(times))-1],
                  rmseM=math.sqrt(sum(m["squaredErrorSum"] for m in metrics)/count) if count else None,
                  bySource={sid:sum(m["bySource"].get(sid,0) for m in metrics) for sid in metrics[0]["bySource"]})
    return result


def objective(score):
    return -score["detectionRate"],score["meanCappedS"],-score["custodyPct"],score["distanceM"]


def profile_hash(profile):
    return hashlib.sha256(json.dumps(profile,sort_keys=True,separators=(",",":")).encode()).hexdigest()
