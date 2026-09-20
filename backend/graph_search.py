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

from flight_policy import (COORDINATED_ALGORITHM, LEGACY_ALGORITHM,
                           normalize_flight_policy)

DEFAULT_WEIGHTS = [4.0, 1.3, 1.0, 1.0, 0.4]
MISSION_VERSION = "tower-first-v2"
SENSOR_MODEL = {
    "name": "synthetic-optical-v2", "boatLengthM": 6.0,
    "conditions": {"clear": {"visibilityM": 7000., "contrast": 1., "falseAlarmProbability": .008},
                   "haze": {"visibilityM": 1800., "contrast": .7, "falseAlarmProbability": .015},
                   "glare": {"visibilityM": 4000., "contrast": .55, "falseAlarmProbability": .025}},
    "minimumConfidence": .45, "confirmationWindowS": 15., "freshnessS": 10., "lostAfterS": 45.,
    "receiverConfirmationHits": 2, "evaluationToleranceM": 150.,
    "calibrated": False,
}


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
    condition: str = "clear"


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
    condition = ("clear", "haze", "glare")[int(np.random.default_rng(seed+7919).integers(0, 3))]
    return Scenario(int(seed), np.asarray(positions), condition)


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


def move_drone(terrain, drone, goal, step, look_at=None):
    node = terrain.node(drone["x"], drone["y"])
    clearance = terrain.profile["assetHeightsM"][drone["id"]]
    route, _ = terrain.path(node, goal, clearance)
    drone["path"] = [{"x":float(terrain.xy[n,0]),"y":float(terrain.xy[n,1])} for n in route]
    if not route:
        return 0.
    next_node = route[1] if len(route)>1 else route[0]
    target = terrain.xy[next_node]
    delta = target-[drone["x"], drone["y"]]
    facing = np.asarray(look_at)-[drone["x"],drone["y"]] if drone["id"]=="quad" and look_at is not None else delta
    desired = math.degrees(math.atan2(facing[0], facing[1])) % 360
    limit = (15 if drone["id"] == "plane" else 45)*step
    drone["heading"] = (drone["heading"]+float(np.clip(angle_delta(desired,drone["heading"]),-limit,limit))) % 360
    distance = min(terrain.profile["speedsMps"][drone["id"]]*step, float(np.linalg.norm(delta)))
    if drone["id"]=="quad":
        # A multirotor can translate independently of body yaw. Its camera is
        # rigidly body-mounted; yaw is bounded above, with no synthetic gimbal.
        direction=delta/max(float(np.linalg.norm(delta)),1e-9)
        nx,ny=drone["x"]+direction[0]*distance,drone["y"]+direction[1]*distance
    else:
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


@dataclass(frozen=True)
class Observation:
    """Sensor output only. No hidden class, truth position, or future trajectory."""
    source: str
    point: tuple[float, float]
    timestamp: float
    sigma_m: float
    confidence: float


def sensor_quality(terrain, pose, kind, point, condition="clear"):
    """Explicit uncalibrated optical assumptions, not a trained image detector."""
    sensor = terrain.profile["sensors"][kind]
    env = SENSOR_MODEL["conditions"][condition]
    dx, dy = np.asarray(point)-[pose["x"], pose["y"]]
    distance = max(1., math.hypot(math.hypot(dx, dy), pose["z"]-1.5))
    focal = sensor.get("width", 1280)/(2*math.tan(math.radians(sensor["hfovDeg"])/2))
    pixels = SENSOR_MODEL["boatLengthM"]*focal/distance
    bearing = math.degrees(math.atan2(dx, dy))
    edge = min(1., abs(angle_delta(bearing, pose["heading"]))/max(1., sensor["hfovDeg"]/2))
    probability = .98*(1-math.exp(-pixels/6))*math.exp(-distance/env["visibilityM"])*env["contrast"]*(1-.3*edge**2)
    sigma = (2+distance*.008+distance/focal*2*(1+min(4., math.hypot(dx,dy)/max(20.,pose["z"])*.03)))/env["contrast"]
    return {"probability": float(np.clip(probability, 0, .98)), "sigmaM": sigma, "projectedPixels": pixels}


def sample_observations(terrain, pose, kind, boat, condition, seed, timestamp, mask):
    """Evaluator-owned sensor simulator: truth stops at this function's output."""
    rng = np.random.default_rng(seed)
    quality = sensor_quality(terrain, pose, kind, boat, condition)
    observations = []
    draw = rng.random()
    noise = rng.normal(0, quality["sigmaM"], 2)
    if bool(terrain.camera_mask(pose, kind, [boat])[0]) and draw < quality["probability"]:
        observations.append(Observation(pose["id"], tuple(boat+noise), timestamp, quality["sigmaM"],
                                        min(.98, .52+.46*quality["probability"])))
    # Rare clutter reports are real inputs to confirmation/gating, not excluded
    # by truth. Their locations are sampled inside this sensor's water footprint.
    if rng.random() < SENSOR_MODEL["conditions"][condition]["falseAlarmProbability"] and mask.any():
        point = terrain.xy[int(rng.choice(terrain.wids[mask]))]+rng.normal(0,25,2)
        observations.append(Observation(pose["id"], tuple(point), timestamp, 40., float(rng.uniform(.45,.85))))
    return observations


class TowerMission:
    """Two-hit tower confirmation, receiver-confirmed dispatch, coast and loss.

    update accepts timestamped observations only. No simulator truth or sensor
    success flags are available to its association, estimate, or mission state.
    """
    def __init__(self, any_sensor=False):
        self.any_sensor = any_sensor
        self.phase = "search" if any_sensor else "tower_watch"
        self.acquired_source = None
        self.tower_confirmed_at = None
        self.point = None
        self.velocity = np.zeros(2)
        self.last_observed = -math.inf
        self.last_tower = -math.inf
        self.last_drone = -math.inf
        self.sigma = 0.
        self.pending = None
        self.acquired_at = None
        self.handoff_at = None
        self.custodian = None
        self.events = []
        self.accepted = []
        self.rejected = 0
        self.handoffs = 0
        self.reacquisitions = 0
        self.losses = 0
        self._seen = set()
        self._pending_candidates = []
        self.drone_pending = {}
        self.receiver_confirmed_sources = []

    def predict(self, now):
        if self.point is None or now-self.last_observed > SENSOR_MODEL["lostAfterS"]:
            return None
        return self.point+self.velocity*max(0., now-self.last_observed)

    def uncertainty(self, now):
        return None if self.predict(now) is None else math.hypot(self.sigma, 3.*max(0.,now-self.last_observed))

    def aim_point(self, now):
        prediction = self.predict(now)
        if prediction is not None:
            return prediction
        if self.pending and now-self.pending.timestamp <= SENSOR_MODEL["confirmationWindowS"]:
            return np.asarray(self.pending.point)
        return None

    def update(self, observations, now):
        self.events, self.accepted, self.receiver_confirmed_sources = [], [], []
        considered, observed_frames = set(), set()
        if self.any_sensor:
            self._pending_candidates = [candidate for candidate in self._pending_candidates
                                        if now-candidate.timestamp <= SENSOR_MODEL["confirmationWindowS"]+SENSOR_MODEL["freshnessS"]]
        if self.point is not None and now-self.last_observed > SENSOR_MODEL["lostAfterS"]:
            self.point = None
            self.pending = None
            self._pending_candidates = []
            self.drone_pending = {}
            self.custodian = None
            self.phase = "lost"
            self.losses += 1
            self.events.append({"type":"track_lost", "t":now})
        for obs in sorted(observations, key=lambda o:(o.timestamp, o.source, -o.confidence)):
            identity = (obs.source, obs.timestamp)
            if (identity in self._seen or obs.timestamp > now or now-obs.timestamp > SENSOR_MODEL["freshnessS"]
                    or obs.confidence < SENSOR_MODEL["minimumConfidence"] or not np.isfinite(obs.point).all()
                    or not math.isfinite(obs.sigma_m) or obs.sigma_m <= 0):
                self.rejected += 1
                continue
            if self.any_sensor:
                # A camera may report clutter and a genuine return in one frame.
                # Rejected candidates must not hide another compatible return.
                candidate_id = (identity, tuple(obs.point), obs.sigma_m, obs.confidence)
                if candidate_id in considered:
                    self.rejected += 1
                    continue
                considered.add(candidate_id)
                observed_frames.add(identity)
            else:
                self._seen.add(identity)
            is_tower = obs.source.startswith("tower-")
            point = np.asarray(obs.point)
            if self.point is None:
                if not is_tower and not self.any_sensor:
                    continue
                prior = self.pending
                if self.any_sensor:
                    # Keep a bounded set of independent cues so unrelated clutter
                    # cannot replace the only copy of earlier matching evidence.
                    compatible = [candidate for candidate in self._pending_candidates
                                  if 0 < obs.timestamp-candidate.timestamp <= SENSOR_MODEL["confirmationWindowS"]
                                  and np.linalg.norm(point-candidate.point)
                                  <= 40+6*(obs.timestamp-candidate.timestamp)+3*math.hypot(obs.sigma_m,candidate.sigma_m)]
                    prior = min(compatible, key=lambda candidate: np.linalg.norm(point-candidate.point)
                                / (40+6*(obs.timestamp-candidate.timestamp)+3*math.hypot(obs.sigma_m,candidate.sigma_m)),
                                default=None)
                if (prior is None or obs.timestamp-prior.timestamp > SENSOR_MODEL["confirmationWindowS"]
                        or np.linalg.norm(point-prior.point) > 40+6*max(0,obs.timestamp-prior.timestamp)+3*math.hypot(obs.sigma_m,prior.sigma_m)):
                    self.pending = obs
                    if self.any_sensor:
                        self._pending_candidates = (self._pending_candidates+[obs])[-32:]
                    continue
                # Separate frames are required; a command/ACK is never evidence.
                if obs.timestamp <= prior.timestamp:
                    continue
                self.point = point.copy()
                if self.any_sensor:
                    self._pending_candidates = []
                dt = obs.timestamp-prior.timestamp
                velocity = (point-np.asarray(prior.point))/dt
                speed = np.linalg.norm(velocity)
                self.velocity = velocity*min(1.,6/max(speed,1e-9))
                self.sigma = obs.sigma_m
                self.last_observed = obs.timestamp
                self.phase = "dispatch"
                self.acquired_at = now if self.acquired_at is None else self.acquired_at
                self.acquired_source = obs.source
                tower_confirmation = is_tower and prior.source.startswith("tower-")
                if tower_confirmation:
                    self.tower_confirmed_at = now
                elif self.any_sensor and prior.source == obs.source:
                    self.drone_pending[obs.source] = prior
                self.events.extend([{"type":"tower_confirmed" if tower_confirmation else "sensor_confirmed", "t":now, "source":obs.source},
                                    {"type":"swarm_dispatched", "t":now, "receivers":["plane","quad"]}])
            else:
                prediction = self.predict(obs.timestamp)
                if prediction is None or obs.timestamp < self.last_observed:
                    self.rejected += 1
                    continue
                residual = point-prediction
                gate = 30+3*math.hypot(self.uncertainty(obs.timestamp) or 0,obs.sigma_m)
                if np.linalg.norm(residual) > gate:
                    self.rejected += 1
                    continue
                dt = max(0.,obs.timestamp-self.last_observed)
                prior_variance = (self.uncertainty(obs.timestamp) or self.sigma)**2
                gain = float(np.clip(prior_variance/(prior_variance+obs.sigma_m**2),.2,.9))
                self.point = prediction+gain*residual
                if dt > 0:
                    self.velocity += .18*residual/dt
                    speed = np.linalg.norm(self.velocity)
                    self.velocity *= min(1.,6/max(speed,1e-9))
                self.sigma = max(2.,math.sqrt((1-gain)*prior_variance))
                self.last_observed = obs.timestamp
            if self.any_sensor:
                self._seen.add(identity)
            self.accepted.append(obs)
            if is_tower:
                self.last_tower = obs.timestamp
                if now-self.last_drone > SENSOR_MODEL["freshnessS"]:
                    self.custodian = obs.source
            else:
                prior = self.drone_pending.get(obs.source)
                self.drone_pending[obs.source] = obs
                if prior is None or not 0 < obs.timestamp-prior.timestamp <= SENSOR_MODEL["confirmationWindowS"]:
                    continue
                self.receiver_confirmed_sources.append(obs.source)
                if self.handoff_at is None:
                    self.handoff_at = now
                    self.handoffs += 1
                    self.events.append({"type":"drone_handoff_confirmed", "t":now, "source":obs.source})
                elif self.phase == "reacquire" and now-self.last_drone > SENSOR_MODEL["freshnessS"]:
                    self.reacquisitions += 1
                    self.events.append({"type":"drone_reacquired", "t":now, "source":obs.source})
                self.last_drone = obs.timestamp
                self.custodian = obs.source
        if self.any_sensor:
            # Close every examined frame after all candidates were considered.
            # Neither rejected frames nor pending cues can be replayed next tick.
            self._seen.update(observed_frames)
        if self.point is not None:
            if now-self.last_drone <= SENSOR_MODEL["freshnessS"]:
                self.phase = "drone_track"
            elif now-self.last_observed > SENSOR_MODEL["freshnessS"] or self.handoff_at is not None:
                self.phase = "reacquire"
            else:
                self.phase = "dispatch"
            if now-self.last_observed > SENSOR_MODEL["freshnessS"]:
                self.custodian = None
        return self.predict(now)


def sensor_pose(terrain, asset, mission, now, step):
    pose = dict(asset)
    aim = mission.aim_point(now)
    if asset["id"].startswith("tower-"):
        if aim is None:
            pose["heading"] = (asset["heading"]+now*6)%360
        else:
            dx,dy = aim-[asset["x"],asset["y"]]
            pose["heading"] = math.degrees(math.atan2(dx,dy))%360
            limits = terrain.profile["sensors"]["tower"]
            pose["pitch"] = float(np.clip(math.degrees(math.atan2(1.5-asset["z"],math.hypot(dx,dy))),
                                           limits.get("pitchMinDeg",-30),limits.get("pitchMaxDeg",45)))
    elif asset["id"] in ("quad","plane"):
        sensor=terrain.profile["sensors"][asset["id"]]
        pose["heading"]=(asset["heading"]+sensor.get("yawOffsetDeg",0))%360
        pose["pitch"]=sensor["pitchDeg"]
    return pose


def mission_goal(terrain, drone, mission, now, launch):
    point = mission.predict(now)
    if point is None:
        if drone["id"] == "quad":
            return None  # standby/hold; fixed-wing instead maintains a launch loiter
        angle = math.radians(now*8)
        point = np.asarray(launch)+150*np.array([math.sin(angle),math.cos(angle)])
    else:
        lead = min(20.,np.linalg.norm(point-[drone["x"],drone["y"]])/terrain.profile["speedsMps"][drone["id"]])
        point = point+mission.velocity*lead
        if mission.phase == "reacquire":
            radius = min(350.,mission.uncertainty(now) or 100.)
            angle = math.radians(now*9+(180 if drone["id"]=="quad" else 0))
            point = point+radius*np.array([math.sin(angle),math.cos(angle)])
        if drone["id"] == "plane" and mission.phase != "reacquire":
            # Wide supporting orbit; quad provides close custody. Both are cued.
            angle = math.radians(now*3)
            point = point+250*np.array([math.sin(angle),math.cos(angle)])
        elif drone["id"] == "quad":
            # Place the target near the fixed camera's boresight on the sea
            # plane; use actual sea height rather than clearance over terrain.
            pitch=abs(terrain.profile["sensors"]["quad"]["pitchDeg"])
            standoff=max(1.,drone["z"]-1.5)/math.tan(math.radians(max(1.,pitch)))
            away=np.asarray([drone["x"],drone["y"]])-point
            direction=away/max(float(np.linalg.norm(away)),1e-9) if np.linalg.norm(away)>1e-6 else np.array([0.,-1.])
            point = point+direction*standoff
    return terrain.node(*point)


class CoordinatedPlanner(BeliefPlanner):
    """Water patrol and camera-aware pursuit using only observations/own poses."""
    def __init__(self, terrain, policy, launch, motion=None, weights=None):
        super().__init__(terrain, motion, weights)
        self.policy, self.launch = policy, launch
        from plane_shadow import PlaneShadow
        self.patrol, self.visited = {}, {"plane": set(), "quad": set()}
        self.plane_shadow = PlaneShadow()
        self.water_index = {int(node): i for i, node in enumerate(terrain.wids)}
        for kind in ("plane", "quad"):
            ids = terrain.wids
            if kind == "quad":
                near = np.linalg.norm(terrain.xy[ids]-launch[kind], axis=1) <= policy["quadSearchRadiusM"]
                if near.any():
                    ids = ids[near]
            spacing = policy["laneSpacingM"]*(.6 if kind == "quad" else 1.)
            bands = np.floor((terrain.xy[ids, 0]-terrain.xmin)/spacing).astype(int)
            route = []
            for band in np.unique(bands):
                nodes = ids[bands == band]
                order = sorted(map(int, nodes), key=lambda node: terrain.xy[node, 1])
                # Two separated ends of each water lane; plane and quad start
                # from opposite ends, with an explicit overlap cost below.
                ends = [order[0], order[-1]]
                route.extend(ends[::-1] if (band+(kind == "quad")) % 2 else ends)
            route = list(dict.fromkeys(route))
            phase = int(policy["routePhase"]*max(0, len(route)-1))
            self.patrol[kind] = route[phase:]+route[:phase]

    def observe(self, masks, measurements, step):
        # A missed synthetic optical frame is weak negative evidence. Preserve
        # mass outside actual camera footprints; no omniscient clearing.
        before = self.belief.copy()
        super().observe(masks, measurements, step)
        if not measurements:
            self.belief = .65*before+.35*self.belief
            self.belief /= self.belief.sum()
        # run_episode supplies tower, tower, plane, quad masks. Advance search
        # from own-camera coverage, including distant route cells seen en route.
        for kind, mask in zip(("plane", "quad"), masks[2:]):
            self.visited[kind].update(node for node in self.patrol[kind]
                                      if mask[self.water_index[node]])

    def patrol_goal(self, drone, other_goal=None):
        kind = drone["id"]
        if self.goals.get(kind) in self.visited[kind]:
            self.goals.pop(kind, None)
        route = self.patrol[kind]
        current = np.array([drone["x"], drone["y"]])
        old = self.goals.get(kind)
        if old is not None and np.linalg.norm(self.terrain.xy[old]-current) > max(90., self.terrain.cell*.6):
            return old
        if old is not None:
            self.visited[kind].add(old)
        candidates = [node for node in route if node not in self.visited[kind]]
        if not candidates:
            self.visited[kind].clear()
            candidates = route
        def score(node):
            i = self.water_index[node]
            distance = np.linalg.norm(self.terrain.xy[node]-current)
            overlap = (math.exp(-float(np.sum((self.terrain.xy[node]-self.terrain.xy[other_goal])**2))/(2*500**2))
                       if other_goal is not None else 0.)
            route_bias = 1-route.index(node)/max(1, len(route))
            return self.belief[i]*len(self.belief)+.6*self.age[i]+.4*route_bias-distance/3500-2*overlap
        goal = max(candidates, key=score)
        self.goals[kind] = goal
        return goal

    def mission_goal(self, drone, mission, now, other_goal=None):
        point = mission.predict(now)
        kind = drone["id"]
        provisional = False
        if point is None and mission.pending is not None and mission.pending.source == kind:
            # Keep the discovering camera on its own recent sighting while a
            # later frame verifies it. This cue is not a confirmed track and
            # never changes confirmation, handoff or evaluator evidence.
            point = mission.aim_point(now)
            provisional = point is not None
        if point is None:
            if kind == "plane":
                self.plane_shadow.reset()
            drone["missionRole"] = "wide_search" if kind == "plane" else "gap_search"
            return self.patrol_goal(drone, other_goal)
        velocity = np.zeros(2) if provisional else mission.velocity
        lead = min(self.policy["lookaheadS"], np.linalg.norm(point-[drone["x"], drone["y"]])/self.terrain.profile["speedsMps"][kind])
        point = point+velocity*lead
        searching_contact = (mission.phase == "reacquire"
                             and now-mission.last_observed > SENSOR_MODEL["freshnessS"])
        if searching_contact:
            width = min(self.policy["reacquireWidthM"], mission.uncertainty(now) or 50.)
            angle = math.radians(now*7+(180 if kind == "quad" else 0))
            point = point+width*np.array([math.sin(angle), math.cos(angle)])
            drone["missionRole"] = "reacquire"
        else:
            drone["missionRole"] = "support_pass" if kind == "plane" else "visual_track"
        if kind == "quad":
            pitch = abs(self.terrain.profile["sensors"][kind]["pitchDeg"])
            standoff = (drone["z"]-1.5)/math.tan(math.radians(max(5., pitch)))
            away = np.array([drone["x"], drone["y"]])-point
            away = away/max(float(np.linalg.norm(away)), 1e-9) if np.linalg.norm(away) > 1 else np.array([0., -1.])
            point = point+away*standoff
        else:
            # Use the current estimate here: PlaneShadow applies its own
            # bounded lead. Double-leading would put the real contact behind
            # the chosen camera footprint when the learned horizon is long.
            estimate = point - velocity*lead
            point = self.plane_shadow.waypoint(
                (drone["x"], drone["y"]), drone["heading"], self.terrain.profile["speedsMps"][kind],
                drone["z"], estimate, velocity, self.policy, self.terrain.profile["sensors"][kind])
            if not searching_contact:
                drone["missionRole"] = "support_pass" if self.plane_shadow.phase == "observe" else "support_reposition"
            self.goals[kind] = self.terrain.node(*point)
            if provisional:
                drone["missionRole"] = "verify_contact"
            # Heading waypoints remain continuous: snapping them to a coarse
            # terrain cell would defeat the camera margin on close passes.
            return point
        self.goals[kind] = self.terrain.node(*point)
        if provisional:
            drone["missionRole"] = "verify_contact"
        # Keep the camera viewing distance continuous. Snapping a following
        # position to the terrain grid introduces up to half a cell of error
        # on each axis; the grid index remains available for overlap costs.
        return self.goals[kind] if provisional else point


def move_surveillance_drone(terrain, drone, goal, step, look_at=None):
    """Bounded body turns; fixed-wing keeps its configured forward airspeed.

    Terrain following remains a kinematic simplification (no climb dynamics).
    Substeps prevent a coarse 5 s planner step from teleporting around a turn.
    """
    kind = drone["id"]
    clearance = terrain.profile["assetHeightsM"][kind]
    target = terrain.xy[goal] if isinstance(goal, (int, np.integer)) else np.asarray(goal, dtype=float)
    start = np.array([drone["x"], drone["y"]])
    drone["path"] = [{"x":float(start[0]), "y":float(start[1])}, {"x":float(target[0]), "y":float(target[1])}]
    traveled = 0.
    subdivisions = max(1, math.ceil(step))
    dt = step/subdivisions
    for _ in range(subdivisions):
        current = np.array([drone["x"], drone["y"]])
        delta = target-current
        speed = terrain.profile["speedsMps"][kind]
        facing = np.asarray(look_at)-current if kind == "quad" and look_at is not None else delta
        # A fixed wing cannot stop at its waypoint; turn back toward the arena
        # before the boundary using the available heading-rate turn radius.
        margin = min(terrain.profile["halfM"]*.45, max(100., speed/math.radians(15)*2))
        if kind == "plane" and np.max(np.abs(current)) > terrain.profile["halfM"]-margin:
            facing = -current
        if np.linalg.norm(facing) < 1:
            facing = np.array([math.sin(math.radians(drone["heading"]+70)), math.cos(math.radians(drone["heading"]+70))])
        desired = math.degrees(math.atan2(facing[0], facing[1])) % 360
        rate = 15 if kind == "plane" else 45
        drone["heading"] = (drone["heading"]+float(np.clip(angle_delta(desired, drone["heading"]), -rate*dt, rate*dt))) % 360
        if kind == "plane":
            direction = np.array([math.sin(math.radians(drone["heading"])), math.cos(math.radians(drone["heading"]))])
            move = speed*dt
        else:
            direction = delta/max(float(np.linalg.norm(delta)), 1e-9)
            move = min(speed*dt, float(np.linalg.norm(delta)))
        point = np.clip(current+direction*move, -terrain.profile["halfM"], terrain.profile["halfM"])
        # Check intermediate ridge height as well as the destination cell.
        samples = current[None,:]+np.linspace(0.,1.,5)[:,None]*(point-current)[None,:]
        altitude = float(np.max(terrain.elevation(samples[:,0], samples[:,1])))+clearance
        traveled += float(np.linalg.norm(point-current))
        drone.update(x=float(point[0]), y=float(point[1]), z=altitude,
                     goal={"x":float(target[0]), "y":float(target[1])})
    return traveled


def run_episode(terrain, config, episode, motion=None, horizon=300, step=5, replay=False):
    algorithm = config.get("algorithm", LEGACY_ALGORITHM)
    if algorithm not in (LEGACY_ALGORITHM, COORDINATED_ALGORITHM):
        raise ValueError("Unknown surveillance algorithm")
    coordinated = algorithm == COORDINATED_ALGORITHM
    policy = normalize_flight_policy(config.get("flightPolicy")) if coordinated else None
    planner = BeliefPlanner(terrain, motion, config.get("weights"), config.get("baseline",False))
    mission = TowerMission(any_sensor=coordinated)
    towers = towers_for(terrain,config["towers"])
    launch = terrain.profile.get("launchPoints") or {asset["sensor"]:asset for asset in terrain.profile.get("assets",[]) if asset["sensor"] in ("plane","quad")}
    drones, launch_xy = [], {}
    for kind, fallback in (("plane",(-150.,0.)),("quad",(150.,0.))):
        p = launch.get(kind,{"x":fallback[0],"y":fallback[1]})
        x,y = float(p["x"]),float(p["y"])
        launch_xy[kind] = (x,y)
        drones.append({"id":kind,"x":x,"y":y,"z":float(terrain.elevation(x,y))+terrain.profile["assetHeightsM"][kind],"heading":0.,"path":[]})
    if coordinated:
        planner = CoordinatedPlanner(terrain, policy, launch_xy, motion, config.get("weights"))
    seen = np.zeros(len(terrain.wids),dtype=bool)
    distance, custody, estimate_count, error_sum = 0.,0,0,0.
    flight_distance = {"plane": 0., "quad": 0.}
    any_custody, longest_gap, gap_started = 0, 0., None
    post_tower_samples, post_tower_custody, false_confirmations, accepted_count = 0,0,0,0
    contributions = {p["id"]:0 for p in towers+drones}
    frames, events = [], []
    first_hit = None
    target_confirmed_at, target_handoff_at, tower_confirmed_at = None, None, None
    last_true_drone = -math.inf
    true_drone_hits = {}
    for tick,t in enumerate(range(0,horizon+1,step)):
        boat = episode.positions[tick]  # evaluator-only; never passed to planner/mission
        masks, observations, sources = [],[],[]
        positions = [sensor_pose(terrain,p,mission,t,step) for p in towers+drones]
        for sid,asset in enumerate(positions):
            kind = "tower" if sid<2 else asset["id"]
            mask = terrain.camera_mask(asset,kind)
            masks.append(mask)
            seen |= mask
            sampled = sample_observations(terrain,asset,kind,boat,episode.condition,
                                          episode.seed*65537+tick*17+sid,t,mask)
            observations.extend(sampled)
            if sampled:
                sources.append(asset["id"])
                contributions[asset["id"]]+=len(sampled)
                if first_hit is None:
                    first_hit=t
        planner.observe(masks,[o.point for o in observations],step)
        estimate = mission.update(observations,t)
        accepted_count += len(mission.accepted)
        events.extend(mission.events)
        # Scoring only: this truth comparison cannot influence mission decisions.
        estimate_is_target = bool(estimate is not None and np.linalg.norm(estimate-boat)<=SENSOR_MODEL["evaluationToleranceM"])
        for event in mission.events:
            if event["type"] in ("tower_confirmed", "sensor_confirmed"):
                if estimate_is_target and target_confirmed_at is None:
                    target_confirmed_at=t
                elif not estimate_is_target:
                    false_confirmations+=1
                if event["type"] == "tower_confirmed" and estimate_is_target and tower_confirmed_at is None:
                    tower_confirmed_at=t
        for observation in mission.accepted:
            if observation.source in ("plane","quad") and target_confirmed_at is not None:
                if np.linalg.norm(np.asarray(observation.point)-boat)<=SENSOR_MODEL["evaluationToleranceM"]:
                    prior_true=true_drone_hits.get(observation.source,-math.inf)
                    true_drone_hits[observation.source]=observation.timestamp
                    if (observation.source in mission.receiver_confirmed_sources and estimate_is_target
                            and 0<observation.timestamp-prior_true<=SENSOR_MODEL["confirmationWindowS"]):
                        last_true_drone=observation.timestamp
                        if target_handoff_at is None:
                            target_handoff_at=t
                else:
                    true_drone_hits.pop(observation.source,None)
        if coordinated:
            # Preserve first-frame evaluator evidence for an aircraft-origin
            # acquisition. This label is never supplied to mission/planner.
            for observation in observations:
                if observation.source in ("plane", "quad") and np.linalg.norm(np.asarray(observation.point)-boat)<=SENSOR_MODEL["evaluationToleranceM"]:
                    true_drone_hits[observation.source] = observation.timestamp
        if estimate is not None:
            estimate_count+=1
            error_sum+=float(np.sum((estimate-boat)**2))
        fresh_drone = bool(t-last_true_drone<=SENSOR_MODEL["freshnessS"] and estimate_is_target)
        custody += int(fresh_drone)
        fresh_any = bool(estimate_is_target and t-mission.last_observed <= SENSOR_MODEL["freshnessS"])
        any_custody += int(fresh_any)
        if target_confirmed_at is not None:
            if fresh_any:
                if gap_started is not None:
                    longest_gap = max(longest_gap, t-gap_started)
                gap_started = None
            elif gap_started is None:
                gap_started = t-step
            if gap_started is not None:
                longest_gap = max(longest_gap, t-gap_started)
        tower_visible = bool(any(terrain.camera_mask(p,"tower",[boat])[0] for p in positions[:2]))
        if target_confirmed_at is not None and not tower_visible:
            post_tower_samples+=1
            post_tower_custody+=int(fresh_drone)
        if replay:
            for drone,pose in zip(drones,positions[2:]):
                drone["cameraHeading"],drone["cameraPitch"] = pose["heading"],pose.get("pitch",terrain.profile["sensors"][drone["id"]].get("pitchDeg",0))
                if not coordinated:
                    drone["missionRole"] = ("wide_follow" if drone["id"]=="plane" else "close_follow") if mission.predict(t) is not None else ("standby_loiter" if drone["id"]=="plane" else "standby")
                else:
                    drone.setdefault("missionRole", "wide_search" if drone["id"] == "plane" else "gap_search")
            frames.append({"t":t,"boat":{"x":float(boat[0]),"y":float(boat[1])},"drones":[dict(d) for d in drones],
                           "sources":sources,"coveragePct":float(seen.mean()*100),"phase":mission.phase,
                           "custodian":mission.custodian,"events":list(mission.events),"uncertaintyM":mission.uncertainty(t),
                           "towerConfirmed":mission.tower_confirmed_at is not None,"handoffConfirmed":mission.handoff_at is not None,
                           "anySensorCustody":fresh_any,
                           "targetConfirmed":target_confirmed_at is not None,"targetHandoffConfirmed":target_handoff_at is not None,
                           "targetCustody":fresh_drone,"receiverConfirmedSources":list(mission.receiver_confirmed_sources),
                           "towerVisible":tower_visible,
                           "observationAgeS":None if estimate is None else t-mission.last_observed,
                           "acceptedSources":sorted({o.source for o in mission.accepted}),
                           "observations":[{"source":o.source,"x":float(o.point[0]),"y":float(o.point[1]),"sigmaM":o.sigma_m,
                                            "confidence":o.confidence,"timestamp":o.timestamp,"accepted":o in mission.accepted} for o in observations],
                           "estimate":None if estimate is None else {"x":float(estimate[0]),"y":float(estimate[1])},
                           "trackingSource":mission.custodian if mission.custodian in [o.source for o in mission.accepted] else None,
                           "towerHeadings":[p["heading"] for p in positions[:2]],"towerPitches":[p.get("pitch",0.) for p in positions[:2]]})
        if t<horizon:
            for drone in drones:
                if coordinated:
                    other = "quad" if drone["id"] == "plane" else "plane"
                    goal = planner.mission_goal(drone, mission, t, planner.goals.get(other))
                elif config.get("baseline"):
                    goal=planner.goals.get(drone["id"])
                    if goal is None or np.linalg.norm(terrain.xy[goal]-[drone["x"],drone["y"]])<terrain.cell*.3:
                        goal=planner.goal(drone)
                else:
                    goal=mission_goal(terrain,drone,mission,t,launch_xy[drone["id"]])
                if goal is not None:
                    move = move_surveillance_drone if coordinated else move_drone
                    look_at = mission.predict(t+step) if not config.get("baseline") else None
                    if (coordinated and look_at is None and mission.pending is not None
                            and mission.pending.source == drone["id"]):
                        look_at = mission.aim_point(t+step)
                    moved = move(terrain,drone,goal,step,
                                 look_at=look_at)
                    distance += moved
                    flight_distance[drone["id"]] += moved
                else:
                    drone["path"]=[]
    samples=int(horizon/step)+1
    found=target_confirmed_at
    metrics={"seed":episode.seed,"detectedAt":found,"detectionRate":100. if found is not None else 0.,"meanCappedS":found if found is not None else horizon,
             "p90CappedS":found if found is not None else horizon,"coveragePct":float(seen.mean()*100),"custodyPct":custody/samples*100,
             "rmseM":math.sqrt(error_sum/estimate_count) if estimate_count else None,"estimateAvailabilityPct":estimate_count/samples*100,
             "distanceM":distance,"handoffs":int(target_handoff_at is not None),"contactHandoffs":mission.handoffs,"bySource":contributions,"estimateSamples":estimate_count,"squaredErrorSum":error_sum,
             "towerDetectedAt":tower_confirmed_at,"towerAcquisitionRate":100. if tower_confirmed_at is not None else 0.,"firstRawHitAt":first_hit,
             "longestGapS":longest_gap if found is not None else float(horizon),"anySensorCustodyPct":100*any_custody/samples,
             "flightDistanceByAssetM":flight_distance,
             "contactConfirmedAt":mission.acquired_at,"contactConfirmationRate":100. if mission.acquired_at is not None else 0.,
             "handoffAt":target_handoff_at,"handoffRate":100. if target_handoff_at is not None else 0.,
             "handoffDelayS":None if target_handoff_at is None else target_handoff_at-found,
             "handoffCappedS":horizon if target_handoff_at is None else target_handoff_at-found,
             "postTowerCustodyPct":100*post_tower_custody/post_tower_samples if post_tower_samples else None,
             "postTowerSamples":post_tower_samples,"postTowerCustodySamples":post_tower_custody,
             "falseConfirmations":false_confirmations,"rejectedObservations":mission.rejected,"acceptedObservations":accepted_count,
             "losses":mission.losses,"reacquisitions":mission.reacquisitions,"condition":episode.condition}
    return {"seed":episode.seed,"missionVersion":algorithm,"algorithm":algorithm,"flightPolicy":policy,
            "policy":COORDINATED_ALGORITHM if coordinated else ("systematic-sweep" if config.get("baseline") else "tower-first"),
            "condition":episode.condition,"towers":towers,"frames":frames,"events":events,"metrics":metrics}


def summarize(rows):
    metrics=[r["metrics"] for r in rows]
    times=sorted(m["meanCappedS"] for m in metrics)
    count=sum(m["estimateSamples"] for m in metrics)
    fields=("detectionRate","meanCappedS","coveragePct","custodyPct","estimateAvailabilityPct","distanceM","handoffs")
    result={key:float(np.mean([m[key] for m in metrics])) for key in fields}
    result.update(episodes=len(metrics),p90CappedS=times[math.ceil(.9*len(times))-1],
                  rmseM=math.sqrt(sum(m["squaredErrorSum"] for m in metrics)/count) if count else None,
                  bySource={sid:sum(m["bySource"].get(sid,0) for m in metrics) for sid in metrics[0]["bySource"]})
    for key in ("longestGapS", "anySensorCustodyPct"):
        if all(key in m for m in metrics):
            result[key] = float(np.mean([m[key] for m in metrics]))
    if all("flightDistanceByAssetM" in m for m in metrics):
        result["flightDistanceByAssetM"] = {kind:float(np.mean([m["flightDistanceByAssetM"][kind] for m in metrics])) for kind in ("plane", "quad")}
    if all("towerAcquisitionRate" in m for m in metrics):
        for key in ("towerAcquisitionRate","contactConfirmationRate","contactHandoffs","handoffRate","handoffCappedS","falseConfirmations","rejectedObservations","acceptedObservations","losses","reacquisitions"):
            if all(key in m for m in metrics):
                result[key]=float(np.mean([m[key] for m in metrics]))
        delays=[m["handoffDelayS"] for m in metrics if m["handoffDelayS"] is not None]
        samples=sum(m["postTowerSamples"] for m in metrics)
        custody=sum(m["postTowerCustodySamples"] for m in metrics)
        result.update(handoffDelayS=float(np.mean(delays)) if delays else None,
                      postTowerSamples=samples,postTowerCustodySamples=custody,
                      postTowerCustodyPct=100*custody/samples if samples else None,
                      conditionEpisodes={c:sum(m["condition"]==c for m in metrics) for c in SENSOR_MODEL["conditions"]})
    return result


def objective(score, algorithm=LEGACY_ALGORITHM):
    if algorithm == COORDINATED_ALGORITHM:
        # All-mission rates avoid rewarding easy-only episodes. Delays/outages
        # use capped misses; flight cost cannot overwhelm successful custody.
        return (2*(100-score["detectionRate"])+1.2*(100-score.get("anySensorCustodyPct",score["custodyPct"]))
                +.8*(100-score["custodyPct"])+.2*score.get("longestGapS",300.)
                +.15*score["meanCappedS"]+.002*score["distanceM"]+100*score.get("falseConfirmations",0.),
                score.get("rmseM") or 0., score["distanceM"])
    # Tower acquisition is the first priority. Within that priority, prefer
    # confirmed drone handoff/custody, fewer false cues, shorter delays and error.
    acquisition=score.get("towerAcquisitionRate",score["detectionRate"])
    false=score.get("falseConfirmations",0.)
    service=(-score.get("handoffRate",0.)-.5*score["custodyPct"]
             -.25*(score.get("postTowerCustodyPct") or 0.)+.05*score.get("handoffCappedS",300.)
             +.05*score["meanCappedS"]+.02*(score.get("rmseM") or 0.)+100*false)
    return -acquisition+100*false,service,score["distanceM"]


def profile_hash(profile):
    return hashlib.sha256(json.dumps(profile,sort_keys=True,separators=(",",":")).encode()).hexdigest()
