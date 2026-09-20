import { buildSurveillanceRoutes, DEFAULT_FLIGHT_POLICY, FLIGHT_ALGORITHM, LEGACY_FLIGHT_ALGORITHM, normalizeFlightPolicy, observePosition, planPlaneShadow, surveillanceTarget, type FlightPolicy, type SearchPoint, type SurveillanceRole, type SurveillanceState } from './surveillance';

/** Coordinates use Three.js X/Z; heading zero points toward +Z. */
export type WorldData = {
  algorithm?: typeof FLIGHT_ALGORITHM;
  flightPolicy?: FlightPolicy;
  size: number;
  half: number;
  heights: number[];
  waterLevel: number;
  towers: { id: string; x: number; z: number; height: number; heading: number; range: number }[];
  spawn: { x: number; z: number; heading: number };
  source: string;
};

/** Positive steer turns right; negative throttle brakes without reversing. */
export type InputState = { throttle: number; steer: number };
export type AircraftState = {
  id: string;
  x: number;
  z: number;
  heading: number;
  altitude: number;
  speed: number;
  detecting: boolean;
  mode: "patrol" | "pursuit" | "searching";
  patrolIndex: number;
  searchPhase: number;
  role?: SurveillanceRole;
  target?: SearchPoint;
};
export type DroneState = AircraftState & { tagProgress: number; distanceToBoat: number };
export type BoostPickup = { id: number; x: number; z: number };
type AircraftLaunch = Pick<AircraftState, "id" | "x" | "z" | "heading" | "altitude" | "patrolIndex">;
export type GameState = {
  /** Frozen v3 pursuit stays available for saved recordings. */
  planeTracking: 'point-pursuit' | 'observation-shadowing';
  algorithm: typeof FLIGHT_ALGORITHM | typeof LEGACY_FLIGHT_ALGORITHM;
  flightPolicy: FlightPolicy;
  surveillance: SurveillanceState;
  initialSurveillanceRoutes: SurveillanceState['routes'];
  status: "ready" | "playing" | "paused" | "caught";
  /** Retain the original camera model only when replaying earlier recordings. */
  aircraftSpotting: "forward-camera" | "overhead";
  /** Active real seconds, used for the survival score and capture duration. */
  time: number;
  /** Accelerated seconds, used for movement, radar, search, and difficulty. */
  simulationTime: number;
  boat: {
    x: number; z: number; heading: number; speed: number; roll: number; pitch: number;
    /** World-space momentum persists as the hull turns. Speed is its magnitude. */
    velocityX: number; velocityZ: number; yawRate: number; rudder: number; enginePower: number;
  };
  drones: DroneState[];
  plane: AircraftState;
  towers: (WorldData["towers"][number] & { detecting: boolean; baseHeading: number })[];
  detected: boolean;
  alert: "clear" | "detected" | "searching" | "tagging";
  tagProgress: number;
  distanceToDrone: number;
  lastKnown: { x: number; z: number } | null;
  lostFor: number;
  collision: boolean;
  sectorX: number;
  sectorZ: number;
  /** Zero is the original map; each new downriver patrol is a harder loop. */
  loop: number;
  loopStartProgress: number;
  nextLoopProgress: number;
  patrolOrigin: { x: number; z: number };
  patrolStartedAt: number;
  distanceTraveled: number;
  /** Active real seconds, unaffected by pause or the simulation pace. */
  boostRemaining: number;
  pickups: BoostPickup[];
  /** Internal simulation data; retained on the mutable state for deterministic replay. */
  accumulator: number;
  collisionFor: number;
  initialBoat: { x: number; z: number; heading: number };
  initialDrones: AircraftLaunch[];
  initialPlane: AircraftLaunch;
  initialTowers: WorldData["towers"];
  initialPatrolPoints: { x: number; z: number }[];
  patrolPoints: { x: number; z: number }[];
  randomState: number;
  initialRandomState: number;
  initialPickups: BoostPickup[];
  nextPickupId: number;
  nextPickupAt: number;
};

export const GAME_RULES = {
  pace: 2,
  maxSpeed: 60,
  boatMass: 900,
  engineThrust: 36000,
  waterLinearDrag: 72,
  waterQuadraticDrag: 8.8,
  lateralWaterDamping: 3.6,
  brakeDeceleration: 42,
  rudderResponse: 6,
  yawResponse: 3.8,
  engineResponse: 4.5,
  turnDrag: 0.22,
  // The escape course always progresses downriver; steering cannot become a U-turn.
  maxCourseDeviation: (75 * Math.PI) / 180,
  // Camera HFOVs from ArcticSim, page 18. Ranges and speeds are game tuning.
  radarFov: (60 * Math.PI) / 180,
  droneFov: (114.6 * Math.PI) / 180,
  droneVision: 600,
  droneMaxSpeed: 84,
  droneDetectedSpeed: 96,
  droneAcceleration: 19,
  droneDetectedAcceleration: 30,
  planeFov: (69 * Math.PI) / 180,
  planeVision: 1100,
  planeSpeed: 100,
  overheadSpottingRadius: 65,
  tagRadius: 65,
  tagSeconds: 2,
  graceSeconds: 6,
  boatRadius: 21,
  boostDuration: 4,
  boostMultiplier: 1.65,
  pickupRadius: 45,
  maxPickups: 4,
  loopLength: 6500,
  droneDifficultyPerLoop: 0.03,
  maxDroneDifficulty: 0.3,
} as const;

export const SIMULATION_STEP = 1 / 60;
const STEP = SIMULATION_STEP;
const TAU = Math.PI * 2;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const angleDifference = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const approach = (a: number, b: number, amount: number) => a + clamp(b - a, -amount, amount);
const restingBoat = () => ({ speed: 0, roll: 0, pitch: 0, velocityX: 0, velocityZ: 0, yawRate: 0, rudder: 0, enginePower: 0 });

export function getDroneTopSpeed(loop: number, detected = false): number {
  return (detected ? GAME_RULES.droneDetectedSpeed : GAME_RULES.droneMaxSpeed)
    * (1 + Math.min(GAME_RULES.maxDroneDifficulty, Math.max(0, loop) * GAME_RULES.droneDifficultyPerLoop));
}

function riverCenter(progress: number): number {
  return 210 * Math.sin(progress / 1550) + 110 * Math.sin(progress / 670);
}

function coursePoint(world: WorldData, progress: number, across = riverCenter(progress)): { x: number; z: number } {
  const forwardX = Math.sin(world.spawn.heading), forwardZ = Math.cos(world.spawn.heading);
  return { x: world.spawn.x + forwardX * progress + forwardZ * across, z: world.spawn.z + forwardZ * progress - forwardX * across };
}

/** Bilinear terrain sampling; points outside the playable world are impassable. */
export function sampleHeight(world: WorldData, x: number, z: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(z) || Math.abs(x) > world.half || Math.abs(z) > world.half) return Infinity;
  const gx = ((x + world.half) / (world.half * 2)) * (world.size - 1);
  const gz = ((z + world.half) / (world.half * 2)) * (world.size - 1);
  const ix = Math.min(world.size - 2, Math.floor(gx));
  const iz = Math.min(world.size - 2, Math.floor(gz));
  const tx = gx - ix;
  const tz = gz - iz;
  const a = world.heights[iz * world.size + ix];
  const b = world.heights[iz * world.size + ix + 1];
  const c = world.heights[(iz + 1) * world.size + ix];
  const d = world.heights[(iz + 1) * world.size + ix + 1];
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

export function getSector(world: WorldData, x: number, z: number): { sectorX: number; sectorZ: number } {
  return { sectorX: Math.floor((x + world.half) / (world.half * 2)), sectorZ: Math.floor((z + world.half) / (world.half * 2)) };
}

/** One continuous terrain function: sector changes never move the boat or repeat a map. */
export function sampleRiverHeight(world: WorldData, x: number, z: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return Infinity;
  const edge = Math.max(Math.abs(x), Math.abs(z));
  const blendWidth = Math.min(500, world.half * 0.16);
  if (edge <= world.half - blendWidth) return sampleHeight(world, x, z);
  const forwardX = Math.sin(world.spawn.heading), forwardZ = Math.cos(world.spawn.heading);
  const dx = x - world.spawn.x, dz = z - world.spawn.z;
  const along = dx * forwardX + dz * forwardZ;
  const across = dx * forwardZ - dz * forwardX;
  // The main channel stays wide enough for the forward-only course. Longer
  // waves shape its banks, while smaller raised patches form coastal islands.
  const center = riverCenter(along);
  const width = 650 + 95 * Math.sin(along / 1180) + 45 * Math.cos(along / 470);
  const bank = Math.abs(across - center) - width;
  const relief = 18 * Math.sin(x / 180) * Math.cos(z / 210) + 12 * Math.sin((x + z) / 340);
  const islands = 50 * Math.pow(Math.max(0, Math.sin(along / 190) * Math.cos(across / 150)), 4)
    * clamp((Math.abs(across - center) - 330) / 180, 0, 1);
  const river = world.waterLevel + clamp(bank * 0.16 + relief + islands, -24, 210);
  if (edge >= world.half) return river;
  const t = clamp((edge - (world.half - blendWidth)) / blendWidth, 0, 1);
  const blend = t * t * (3 - 2 * t);
  return sampleHeight(world, x, z) * (1 - blend) + river * blend;
}

export function isNavigable(world: WorldData, x: number, z: number): boolean {
  return sampleRiverHeight(world, x, z) <= world.waterLevel;
}

function boatFits(world: WorldData, x: number, z: number, heading: number): boolean {
  if (!isNavigable(world, x, z)) return false;
  for (let i = 0; i < 8; i++) {
    const angle = (i / 8) * TAU;
    if (!isNavigable(world, x + Math.sin(angle) * GAME_RULES.boatRadius, z + Math.cos(angle) * GAME_RULES.boatRadius)) return false;
  }
  // The bow is slightly longer than the hull's collision radius.
  return isNavigable(world, x + Math.sin(heading) * 31, z + Math.cos(heading) * 31)
    && isNavigable(world, x - Math.sin(heading) * 31, z - Math.cos(heading) * 31);
}

/** Terrain is the only opaque geometry; altitude is an absolute world Y coordinate. */
export function hasLineOfSight(world: WorldData, ax: number, az: number, ay: number, bx: number, bz: number, by: number): boolean {
  const distance = Math.hypot(bx - ax, bz - az);
  const spacing = Math.min(30, (world.half * 2) / (world.size - 1) / 2);
  const samples = Math.max(2, Math.ceil(distance / spacing));
  for (let i = 1; i < samples; i++) {
    const t = i / samples;
    if (sampleRiverHeight(world, ax + (bx - ax) * t, az + (bz - az) * t) > ay + (by - ay) * t) return false;
  }
  return true;
}

function random(state: Pick<GameState, "randomState">): number {
  state.randomState = (Math.imul(state.randomState, 1664525) + 1013904223) >>> 0;
  return state.randomState / 0x100000000;
}

function spawnPickup(state: GameState, world: WorldData, first = false): void {
  if (state.pickups.length >= GAME_RULES.maxPickups) return;
  const heading = state.boat.heading;
  const forwardX = Math.sin(heading), forwardZ = Math.cos(heading);
  for (let attempt = 0; attempt < 24; attempt++) {
    const ahead = first ? 360 + random(state) * 90 : 400 + random(state) * 420;
    const sideways = (random(state) - 0.5) * (first ? 40 : 360);
    const x = state.boat.x + forwardX * ahead + forwardZ * sideways;
    const z = state.boat.z + forwardZ * ahead - forwardX * sideways;
    if (!boatFits(world, x, z, heading)
      || state.pickups.some((pickup) => Math.hypot(pickup.x - x, pickup.z - z) < 150)) continue;
    state.pickups.push({ id: state.nextPickupId++, x, z });
    return;
  }
}

/** Replace the bounded patrol, while retaining continuous boat/world coordinates. */
function beginNextPatrol(state: GameState, world: WorldData, progress: number): void {
  state.loop++;
  state.loopStartProgress = progress;
  state.nextLoopProgress = progress + GAME_RULES.loopLength;
  state.patrolOrigin = coursePoint(world, progress + GAME_RULES.loopLength / 2);
  state.patrolStartedAt = state.simulationTime;
  state.lastKnown = null;
  state.lostFor = 0;
  state.detected = false;
  state.tagProgress = 0;
  state.alert = "clear";

  // These routes depend only on the river and the section's fixed start. The
  // patrol never consults hidden boat motion to choose its search waypoints.
  state.patrolPoints = [300, 1100, 2100, 3200, 4300, 5400, 6150].map((ahead, i) => {
    const along = progress + ahead;
    const across = riverCenter(along) + (i % 2 ? 180 : -180);
    const candidate = coursePoint(world, along, across);
    return isNavigable(world, candidate.x, candidate.z) ? candidate : coursePoint(world, along);
  });

  state.towers = Array.from({ length: 2 }, (_, i) => {
    const along = progress + 1550 + i * 3200;
    const side = i === 0 ? -1 : 1;
    let location = coursePoint(world, along, riverCenter(along) + side * 1300);
    let channel = coursePoint(world, along);
    // Choose the first usable bank with a clear sightline across the channel,
    // instead of translating towers onto arbitrary water or behind a ridge.
    search: for (let shift = 0; shift <= 300; shift += 75) {
      const target = coursePoint(world, along + shift);
      for (let offset = 400; offset <= 1400; offset += 20) {
        const point = coursePoint(world, along + shift, riverCenter(along + shift) + side * offset);
        const height = sampleRiverHeight(world, point.x, point.z);
        if (height > world.waterLevel + 4 && hasLineOfSight(world, point.x, point.z, height + 55, target.x, target.z, world.waterLevel + 5)) {
          location = point;
          channel = target;
          break search;
        }
      }
    }
    const heading = Math.atan2(channel.x - location.x, channel.z - location.z);
    return {
      id: state.initialTowers[i]?.id ?? `tower-${i + 1}`,
      ...location, height: sampleRiverHeight(world, location.x, location.z),
      heading, baseHeading: heading, range: 1500, detecting: false,
    };
  });
  const launch = (ahead: number, across: number, patrolIndex: number, altitude: number) => {
    const point = coursePoint(world, progress + ahead, riverCenter(progress + ahead) + across);
    const target = state.patrolPoints[patrolIndex];
    return {
      ...point, patrolIndex, heading: Math.atan2(target.x - point.x, target.z - point.z),
      altitude: Math.max(world.waterLevel + altitude, sampleRiverHeight(world, point.x, point.z) + 70),
      detecting: false, mode: "patrol" as const, searchPhase: 0,
    };
  };
  state.drones.forEach((drone, i) => {
    Object.assign(drone, launch(1450 + i * 1100, i === 0 ? -240 : 240, i === 0 ? 0 : 2, 105 + i * 15), {
      speed: 0, tagProgress: 0,
    });
    drone.distanceToBoat = Math.hypot(drone.x - state.boat.x, drone.z - state.boat.z);
  });
  Object.assign(state.plane, launch(3400, 0, 3, 235), { speed: GAME_RULES.planeSpeed });
  if (state.algorithm === FLIGHT_ALGORITHM) {
    state.surveillance = { routes: buildSurveillanceRoutes(state.patrolPoints, [...state.drones, state.plane], state.towers, state.flightPolicy, world.spawn.heading), observation: null, leadDroneId: null };
    for (const aircraft of [...state.drones, state.plane]) { aircraft.patrolIndex = 0; aircraft.target = undefined; aircraft.role = aircraft.id === 'P1' ? 'broad-search' : 'gap-search'; }
  }
  state.distanceToDrone = Math.min(...state.drones.map((drone) => drone.distanceToBoat));
}

export function createGame(world: WorldData, seed = 0x51a7, settings: { aircraftSpotting?: GameState["aircraftSpotting"]; algorithm?: GameState['algorithm']; flightPolicy?: Partial<FlightPolicy>; planeTracking?: GameState['planeTracking'] } = {}): GameState {
  const aircraftSpotting = settings.aircraftSpotting ?? "overhead";
  const algorithm = settings.algorithm ?? world.algorithm ?? FLIGHT_ALGORITHM;
  const flightPolicy = normalizeFlightPolicy(settings.flightPolicy ?? world.flightPolicy ?? DEFAULT_FLIGHT_POLICY);
  const spawn = { ...world.spawn };
  const limit = world.half - 160;
  // Select a distant starting patrol location. Later pursuit only uses observations.
  const options = Array.from({ length: 8 }, (_, i) => {
    const angle = spawn.heading + Math.PI + (i / 8) * TAU;
    return { x: clamp(spawn.x + Math.sin(angle) * 1350, -limit, limit), z: clamp(spawn.z + Math.cos(angle) * 1350, -limit, limit) };
  });
  options.sort((a, b) => Math.hypot(b.x - spawn.x, b.z - spawn.z) - Math.hypot(a.x - spawn.x, a.z - spawn.z));
  // A fixed route covers navigable terrain without targeting an unobserved boat.
  // Earlier recordings retain their original route through the ship's spawn.
  const candidates: { x: number; z: number }[] = [];
  const divisions = Math.max(2, Math.ceil(world.half * 2 / (algorithm === FLIGHT_ALGORITHM ? flightPolicy.laneSpacingM : 500)));
  const spacing = world.half * 2 / divisions;
  for (let row = 0; row < divisions; row++) for (let col = 0; col < divisions; col++) {
    const x = -world.half + (col + 0.5) * spacing;
    const z = -world.half + (row + 0.5) * spacing;
    if (isNavigable(world, x, z) && Math.hypot(x - spawn.x, z - spawn.z) > 200) candidates.push({ x, z });
  }
  const patrolPoints: { x: number; z: number }[] = aircraftSpotting === "forward-camera" ? [{ x: spawn.x, z: spawn.z }] : [];
  while (candidates.length) {
    const previous = patrolPoints[patrolPoints.length - 1] ?? options[0];
    let closest = 0;
    for (let i = 1; i < candidates.length; i++) {
      if (Math.hypot(candidates[i].x - previous.x, candidates[i].z - previous.z) < Math.hypot(candidates[closest].x - previous.x, candidates[closest].z - previous.z)) closest = i;
    }
    patrolPoints.push(candidates.splice(closest, 1)[0]);
  }
  if (!patrolPoints.length) patrolPoints.push({ ...options[0] });
  const launch = (id: string, point: { x: number; z: number }, patrolIndex: number, altitude: number): AircraftLaunch => {
    if (aircraftSpotting === "overhead") {
      patrolIndex = patrolPoints.reduce((best, target, i, points) =>
        Math.hypot(target.x - point.x, target.z - point.z) < Math.hypot(points[best].x - point.x, points[best].z - point.z) ? i : best, 0);
    }
    return {
      id, ...point, patrolIndex,
      heading: Math.atan2(patrolPoints[patrolIndex].x - point.x, patrolPoints[patrolIndex].z - point.z),
      altitude: Math.max(world.waterLevel + altitude, sampleRiverHeight(world, point.x, point.z) + 70),
    };
  };
  const secondPosition = options.reduce((best, point) =>
    Math.hypot(point.x - options[0].x, point.z - options[0].z) > Math.hypot(best.x - options[0].x, best.z - options[0].z) ? point : best, options[1]);
  const initialDrones = [
    launch("D1", options[0], 0, 105),
    launch("D2", secondPosition, Math.floor(patrolPoints.length / 2), 120),
  ];
  const planePosition = options.reduce((best, point) => {
    const separation = (candidate: { x: number; z: number }) => Math.min(
      Math.hypot(candidate.x - options[0].x, candidate.z - options[0].z),
      Math.hypot(candidate.x - secondPosition.x, candidate.z - secondPosition.z));
    return separation(point) > separation(best) ? point : best;
  }, options[1]);
  const initialPlane = launch("P1", planePosition, 0, 235);
  const resetAircraft = (initial: AircraftLaunch): AircraftState => ({ ...initial, speed: 0, detecting: false, mode: "patrol", searchPhase: 0,
    ...(algorithm === FLIGHT_ALGORITHM ? { patrolIndex: 0, role: initial.id === 'P1' ? 'broad-search' : 'gap-search', target: undefined } : {}) });
  const drones = initialDrones.map((initial) => ({ ...resetAircraft(initial), tagProgress: 0, distanceToBoat: Math.hypot(initial.x - spawn.x, initial.z - spawn.z) }));
  const routes = algorithm === FLIGHT_ALGORITHM ? buildSurveillanceRoutes(patrolPoints, [...initialDrones, initialPlane], world.towers, flightPolicy, world.spawn.heading) : {};
  const state: GameState = {
    algorithm, flightPolicy, planeTracking: settings.planeTracking ?? 'observation-shadowing', surveillance: { routes, observation: null, leadDroneId: null },
    initialSurveillanceRoutes: structuredClone(routes),
    status: "ready", aircraftSpotting, time: 0, simulationTime: 0,
    boat: { ...spawn, ...restingBoat() },
    drones, plane: { ...resetAircraft(initialPlane), speed: GAME_RULES.planeSpeed },
    towers: world.towers.map((tower) => ({ ...tower, baseHeading: tower.heading, detecting: false })),
    detected: false, alert: "clear", tagProgress: 0,
    distanceToDrone: Math.min(...drones.map((drone) => drone.distanceToBoat)),
    lastKnown: null, lostFor: 0, collision: false,
    ...getSector(world, spawn.x, spawn.z), loop: 0, loopStartProgress: 0, nextLoopProgress: Infinity,
    patrolOrigin: { x: 0, z: 0 }, patrolStartedAt: 0, distanceTraveled: 0, boostRemaining: 0, pickups: [],
    accumulator: 0, collisionFor: 0,
    initialBoat: spawn, initialDrones, initialPlane, patrolPoints,
    initialTowers: world.towers.map((tower) => ({ ...tower })),
    initialPatrolPoints: patrolPoints.map((point) => ({ ...point })),
    randomState: seed >>> 0, initialRandomState: seed >>> 0, initialPickups: [], nextPickupId: 1, nextPickupAt: 7,
  };
  spawnPickup(state, world, true);
  state.initialPickups = state.pickups.map((pickup) => ({ ...pickup }));
  state.initialRandomState = state.randomState;
  return state;
}

export function startGame(state: GameState): void {
  Object.assign(state.boat, state.initialBoat, restingBoat());
  state.drones.forEach((drone, i) => Object.assign(drone, state.initialDrones[i], {
    speed: 0, detecting: false, mode: "patrol", searchPhase: 0, tagProgress: 0,
    distanceToBoat: Math.hypot(state.initialDrones[i].x - state.boat.x, state.initialDrones[i].z - state.boat.z),
  }));
  Object.assign(state.plane, state.initialPlane, { speed: GAME_RULES.planeSpeed, detecting: false, mode: "patrol", searchPhase: 0 });
  state.towers = state.initialTowers.map((tower) => ({ ...tower, baseHeading: tower.heading, detecting: false }));
  state.patrolPoints = state.initialPatrolPoints.map((point) => ({ ...point }));
  state.surveillance = { routes: structuredClone(state.initialSurveillanceRoutes), observation: null, leadDroneId: null };
  if (state.algorithm === FLIGHT_ALGORITHM) for (const aircraft of [...state.drones, state.plane]) {
    aircraft.patrolIndex = 0; aircraft.target = undefined;
    aircraft.role = aircraft.id === 'P1' ? 'broad-search' : 'gap-search';
  }
  Object.assign(state, {
    status: "playing", time: 0, simulationTime: 0, detected: false, alert: "clear", tagProgress: 0,
    distanceToDrone: Math.min(...state.drones.map((drone) => drone.distanceToBoat)),
    lastKnown: null, lostFor: 0, collision: false, accumulator: 0, collisionFor: 0,
    sectorX: 0, sectorZ: 0, loop: 0, loopStartProgress: 0, nextLoopProgress: Infinity,
    patrolOrigin: { x: 0, z: 0 }, patrolStartedAt: 0, distanceTraveled: 0, boostRemaining: 0,
    pickups: state.initialPickups.map((pickup) => ({ ...pickup })), randomState: state.initialRandomState,
    nextPickupId: state.initialPickups.length + 1, nextPickupAt: 7,
  });
}

export function togglePause(state: GameState): void {
  if (state.status === "playing") state.status = "paused";
  else if (state.status === "paused") state.status = "playing";
  state.accumulator = 0;
}

/** Arcade hydrodynamics in the fixed simulation clock: thrust, drag, rudder and momentum. */
function moveBoat(state: GameState, world: WorldData, throttle: number, steer: number): void {
  const boat = state.boat;
  const previousSpeed = Math.hypot(boat.velocityX, boat.velocityZ);
  const previousHeading = boat.heading;
  const boost = state.boostRemaining > 0 ? GAME_RULES.boostMultiplier : 1;
  const topSpeed = GAME_RULES.maxSpeed * boost;
  boat.enginePower += (Math.max(0, throttle) - boat.enginePower) * (1 - Math.exp(-GAME_RULES.engineResponse * STEP));
  boat.rudder += (steer - boat.rudder) * (1 - Math.exp(-GAME_RULES.rudderResponse * STEP));
  // A little prop/rudder authority remains at rest so a grounded boat can steer free.
  const steeringPower = 0.28 + Math.min(previousSpeed / 30, 1) * 0.72;
  const desiredYaw = -boat.rudder * steeringPower * 0.95;
  boat.yawRate += (desiredYaw - boat.yawRate) * (1 - Math.exp(-GAME_RULES.yawResponse * STEP));
  const unconstrainedHeading = boat.heading + boat.yawRate * STEP;
  boat.heading = clamp(unconstrainedHeading,
    state.initialBoat.heading - GAME_RULES.maxCourseDeviation,
    state.initialBoat.heading + GAME_RULES.maxCourseDeviation);
  if (boat.heading !== unconstrainedHeading) boat.yawRate = 0;
  // Rotating the long bow must not put it through a bank even while stationary.
  if (!boatFits(world, boat.x, boat.z, boat.heading) && boatFits(world, boat.x, boat.z, previousHeading)) {
    boat.heading = previousHeading;
    boat.yawRate = 0;
  }

  const forwardX = Math.sin(boat.heading), forwardZ = Math.cos(boat.heading);
  let forwardSpeed = Math.max(0, boat.velocityX * forwardX + boat.velocityZ * forwardZ);
  let sidewaysSpeed = boat.velocityX * forwardZ - boat.velocityZ * forwardX;
  // At full power, thrust balances the linear + quadratic resistance at 60 m/s.
  // Boost adds thrust (with the same hull drag), rather than teleporting velocity.
  const boostThrust = GAME_RULES.waterLinearDrag * topSpeed + GAME_RULES.waterQuadraticDrag * topSpeed * topSpeed;
  const thrust = (throttle < 0 ? 0 : boat.enginePower) * (boost > 1 ? boostThrust : GAME_RULES.engineThrust);
  const drag = GAME_RULES.waterLinearDrag * forwardSpeed + GAME_RULES.waterQuadraticDrag * forwardSpeed * forwardSpeed;
  forwardSpeed = Math.max(0, forwardSpeed + ((thrust - drag) / GAME_RULES.boatMass
    - Math.max(0, -throttle) * GAME_RULES.brakeDeceleration
    - Math.abs(boat.yawRate) * forwardSpeed * GAME_RULES.turnDrag) * STEP);
  sidewaysSpeed *= Math.exp(-(GAME_RULES.lateralWaterDamping + Math.max(0, -throttle) * 5) * STEP);
  sidewaysSpeed = clamp(sidewaysSpeed, -forwardSpeed * 0.34, forwardSpeed * 0.34);
  boat.velocityX = forwardX * forwardSpeed + forwardZ * sidewaysSpeed;
  boat.velocityZ = forwardZ * forwardSpeed - forwardX * sidewaysSpeed;
  const speed = Math.hypot(boat.velocityX, boat.velocityZ);
  // Let surplus boost momentum decay naturally; new thrust cannot exceed its cap.
  const speedCap = Math.min(GAME_RULES.maxSpeed * GAME_RULES.boostMultiplier, Math.max(topSpeed, previousSpeed));
  if (speed > speedCap) { boat.velocityX *= speedCap / speed; boat.velocityZ *= speedCap / speed; }
  const courseX = Math.sin(state.initialBoat.heading), courseZ = Math.cos(state.initialBoat.heading);
  const progressSpeed = boat.velocityX * courseX + boat.velocityZ * courseZ;
  if (progressSpeed < 0) { boat.velocityX -= progressSpeed * courseX; boat.velocityZ -= progressSpeed * courseZ; }
  if (Math.hypot(boat.velocityX, boat.velocityZ) < 0.015 && boat.enginePower < 0.001) {
    boat.velocityX = 0; boat.velocityZ = 0;
  }

  state.collisionFor = Math.max(0, state.collisionFor - STEP);
  const canMove = (vx: number, vz: number) => vx * courseX + vz * courseZ >= -1e-10
    && boatFits(world, boat.x + vx * STEP * 0.5, boat.z + vz * STEP * 0.5, boat.heading)
    && boatFits(world, boat.x + vx * STEP, boat.z + vz * STEP, boat.heading);
  if (!canMove(boat.velocityX, boat.velocityZ)) {
    if (Math.hypot(boat.velocityX, boat.velocityZ) > 0.05) state.collisionFor = 0.4;
    // Scrubbing along a bank loses momentum; each candidate still checks the
    // complete hull and bow. Never nudge the boat onto land to free it.
    const slideX = boat.velocityX * 0.45, slideZ = boat.velocityZ * 0.45;
    const canSlideX = canMove(slideX, 0), canSlideZ = canMove(0, slideZ);
    if (canSlideX && (!canSlideZ || Math.abs(slideX) > Math.abs(slideZ))) {
      boat.velocityX = slideX; boat.velocityZ = 0;
    } else if (canSlideZ) {
      boat.velocityX = 0; boat.velocityZ = slideZ;
    } else { boat.velocityX = 0; boat.velocityZ = 0; }
    boat.yawRate *= 0.5;
  }
  boat.x += boat.velocityX * STEP;
  boat.z += boat.velocityZ * STEP;
  boat.speed = Math.hypot(boat.velocityX, boat.velocityZ);
  state.distanceTraveled += boat.speed * STEP;
  state.collision = state.collisionFor > 0;
  const appliedYaw = (boat.heading - previousHeading) / STEP;
  const targetRoll = appliedYaw * (boat.speed / GAME_RULES.maxSpeed) * 0.16;
  const acceleration = (boat.speed - previousSpeed) / STEP;
  const targetPitch = clamp(acceleration / 40 * 0.075 + boat.speed / GAME_RULES.maxSpeed * 0.018, -0.1, 0.12);
  boat.roll += (targetRoll - boat.roll) * (1 - Math.exp(-STEP * 5));
  boat.pitch += (targetPitch - boat.pitch) * (1 - Math.exp(-STEP * 3));
}

function tick(state: GameState, world: WorldData, input: InputState): void {
  const realStep = STEP / GAME_RULES.pace;
  state.time += realStep;
  state.simulationTime += STEP;
  const boat = state.boat;
  const throttle = clamp(Number.isFinite(input.throttle) ? input.throttle : 0, -1, 1);
  const steer = clamp(Number.isFinite(input.steer) ? input.steer : 0, -1, 1);
  state.boostRemaining = Math.max(0, state.boostRemaining - realStep);
  moveBoat(state, world, throttle, steer);

  Object.assign(state, getSector(world, boat.x, boat.z));
  const forwardX = Math.sin(state.initialBoat.heading), forwardZ = Math.cos(state.initialBoat.heading);
  const progress = (boat.x - state.initialBoat.x) * forwardX + (boat.z - state.initialBoat.z) * forwardZ;
  // Only the first crossing uses the original square. Afterwards a monotonically
  // advancing course threshold prevents boundary jitter from respawning patrols.
  if (state.loop === 0 ? progress > 0 && (Math.abs(boat.x) >= world.half || Math.abs(boat.z) >= world.half)
    : progress >= state.nextLoopProgress) beginNextPatrol(state, world, progress);
  state.pickups = state.pickups.filter((pickup) => {
    const dx = pickup.x - boat.x, dz = pickup.z - boat.z;
    if (Math.hypot(dx, dz) <= GAME_RULES.pickupRadius) {
      state.boostRemaining = GAME_RULES.boostDuration;
      return false;
    }
    return dx * forwardX + dz * forwardZ > -180 && Math.hypot(dx, dz) < 2200;
  });
  if (state.time >= state.nextPickupAt) {
    spawnPickup(state, world);
    state.nextPickupAt = state.time + 6 + random(state) * 4;
  }

  const patrolTime = state.simulationTime - state.patrolStartedAt;
  const active = patrolTime >= GAME_RULES.graceSeconds;
  let towerSeesBoat = false;
  state.towers.forEach((tower, i) => {
    tower.heading = tower.baseHeading + Math.sin(patrolTime * 0.27 + i * 1.7) * 1.08;
    const dx = boat.x - tower.x;
    const dz = boat.z - tower.z;
    tower.detecting = active && Math.hypot(dx, dz) <= tower.range
      && Math.abs(angleDifference(Math.atan2(dx, dz), tower.heading)) <= GAME_RULES.radarFov / 2
      && hasLineOfSight(world, tower.x, tower.z, tower.height + 55, boat.x, boat.z, world.waterLevel + 5);
    towerSeesBoat ||= tower.detecting;
  });
  const overheadSpotting = state.aircraftSpotting === "overhead";
  const aircraftSeeBoat = (aircraft: AircraftState, range: number, fov: number) => active
    && Math.hypot(aircraft.x - boat.x, aircraft.z - boat.z) <= (overheadSpotting ? GAME_RULES.overheadSpottingRadius : range)
    && (overheadSpotting || Math.abs(angleDifference(Math.atan2(boat.x - aircraft.x, boat.z - aircraft.z), aircraft.heading)) <= fov / 2)
    && hasLineOfSight(world, aircraft.x, aircraft.z, aircraft.altitude, boat.x, boat.z, world.waterLevel + 5);
  // New runs require a clear downward observation directly over the ship.
  // The forward camera cone remains available for deterministic older replays.
  for (const drone of state.drones) drone.detecting = aircraftSeeBoat(drone, GAME_RULES.droneVision, GAME_RULES.droneFov);
  state.plane.detecting = aircraftSeeBoat(state.plane, GAME_RULES.planeVision, GAME_RULES.planeFov);
  state.detected = towerSeesBoat || state.drones.some((drone) => drone.detecting) || state.plane.detecting;
  if (state.detected) {
    if (state.algorithm === FLIGHT_ALGORITHM) {
      state.surveillance.observation = observePosition(state.surveillance.observation, boat, state.simulationTime, GAME_RULES.maxSpeed * GAME_RULES.boostMultiplier);
      const lead = state.drones.find((drone) => drone.id === state.surveillance.leadDroneId);
      const seeing = state.drones.find((drone) => drone.detecting);
      if (!lead || (!lead.detecting && seeing)) state.surveillance.leadDroneId = (seeing ?? state.drones.reduce((best, drone) =>
        Math.hypot(drone.x - boat.x, drone.z - boat.z) < Math.hypot(best.x - boat.x, best.z - boat.z) ? drone : best)).id;
    }
    state.lastKnown = { x: boat.x, z: boat.z };
    state.lostFor = 0;
    for (const aircraft of [...state.drones, state.plane]) aircraft.searchPhase = 0;
  } else if (state.lastKnown) {
    state.lostFor += STEP;
    if (state.lostFor >= 45) {
      state.surveillance.observation = null;
      state.surveillance.leadDroneId = null;
      state.lastKnown = null;
      state.lostFor = 0;
      // Resume the terrain-defined route near the last search, without consulting
      // the boat's hidden position.
      for (const aircraft of [...state.drones, state.plane]) {
        const route = state.algorithm === FLIGHT_ALGORITHM ? state.surveillance.routes[aircraft.id] : state.patrolPoints;
        aircraft.patrolIndex = route.reduce((best, point, i, points) =>
          Math.hypot(point.x - aircraft.x, point.z - aircraft.z) < Math.hypot(points[best].x - aircraft.x, points[best].z - aircraft.z) ? i : best, 0);
      }
    }
  }

  const patrolTarget = (aircraft: AircraftState, reach: number) => {
    const route = state.algorithm === FLIGHT_ALGORITHM ? state.surveillance.routes[aircraft.id] : state.patrolPoints;
    aircraft.patrolIndex %= route.length;
    let waypoint = route[aircraft.patrolIndex];
    if (Math.hypot(aircraft.x - waypoint.x, aircraft.z - waypoint.z) < reach) {
      aircraft.patrolIndex = (aircraft.patrolIndex + 1) % route.length;
      waypoint = route[aircraft.patrolIndex];
    }
    return waypoint;
  };
  const limit = state.loop === 0 ? world.half - 80 : GAME_RULES.loopLength / 2 + 450;
  const minX = state.patrolOrigin.x - limit, maxX = state.patrolOrigin.x + limit;
  const minZ = state.patrolOrigin.z - limit, maxZ = state.patrolOrigin.z + limit;
  const moveAircraft = (aircraft: AircraftState, target: { x: number; z: number }, turnRate: number, altitude: number, plannedRate?: number) => {
    const desiredHeading = Math.atan2(clamp(target.x, minX, maxX) - aircraft.x, clamp(target.z, minZ, maxZ) - aircraft.z);
    aircraft.heading += plannedRate === undefined ? clamp(angleDifference(desiredHeading, aircraft.heading), -STEP * turnRate, STEP * turnRate)
      : STEP * clamp(plannedRate, -turnRate, turnRate);
    aircraft.x = clamp(aircraft.x + Math.sin(aircraft.heading) * aircraft.speed * STEP, minX, maxX);
    aircraft.z = clamp(aircraft.z + Math.cos(aircraft.heading) * aircraft.speed * STEP, minZ, maxZ);
    const ground = sampleRiverHeight(world, aircraft.x, aircraft.z);
    aircraft.altitude = Math.max(ground + 30, aircraft.altitude + (Math.max(world.waterLevel + altitude, ground + 70) - aircraft.altitude) * (1 - Math.exp(-STEP * 1.8)));
    aircraft.mode = state.lastKnown ? state.detected ? "pursuit" : "searching" : "patrol";
  };

  state.drones.forEach((drone, i) => {
    let target: { x: number; z: number };
    if (state.algorithm === FLIGHT_ALGORITHM && state.surveillance.observation) {
      drone.role = state.detected ? (state.surveillance.leadDroneId === drone.id ? 'track' : 'forward-support') : 'reacquire';
      target = surveillanceTarget(state.surveillance.observation, state.flightPolicy, state.simulationTime, drone.role, i, world.spawn.heading);
    } else if (state.lastKnown) {
      const searchDistance = Math.hypot(drone.x - state.lastKnown.x, drone.z - state.lastKnown.z);
      if (!state.detected && searchDistance < 200) drone.searchPhase += STEP * 0.65;
      const orbit = drone.searchPhase > 0 ? 150 : 0;
      target = {
        x: state.lastKnown.x + Math.sin(drone.searchPhase + i * Math.PI) * orbit,
        z: state.lastKnown.z + Math.cos(drone.searchPhase + i * Math.PI) * orbit,
      };
    } else { target = patrolTarget(drone, 100); if (state.algorithm === FLIGHT_ALGORITHM) drone.role = 'gap-search'; }
    if (state.algorithm === FLIGHT_ALGORITHM) drone.target = { ...target };
    const chaseSpeed = getDroneTopSpeed(state.loop, state.detected);
    const difficulty = getDroneTopSpeed(state.loop) / GAME_RULES.droneMaxSpeed;
    // Boat velocity and distance may influence pursuit only while a sensor has
    // an actual observation. Hidden movement never changes the search flight.
    let desiredSpeed = (state.lastKnown ? 53 : Math.min(70, 38 + patrolTime * 0.07)) * difficulty;
    if (state.detected) {
      const observed = state.surveillance.observation;
      const observedDistance = state.algorithm === FLIGHT_ALGORITHM ? Math.hypot(drone.x - target.x, drone.z - target.z) : Math.hypot(drone.x - boat.x, drone.z - boat.z);
      const observedSpeed = state.algorithm === FLIGHT_ALGORITHM && observed ? Math.hypot(observed.vx, observed.vz) : Math.abs(boat.speed);
      const approachSpeed = Math.max(18, observedSpeed + Math.max(0, observedDistance - 25) * 0.65);
      desiredSpeed = Math.min(chaseSpeed, approachSpeed);
    }
    const acceleration = (state.detected ? GAME_RULES.droneDetectedAcceleration : GAME_RULES.droneAcceleration)
      * (1 + Math.min(0.2, state.loop * 0.02));
    drone.speed = approach(drone.speed, desiredSpeed, STEP * acceleration);
    moveAircraft(drone, target, 1.2, 105 + i * 15);
    drone.distanceToBoat = Math.hypot(drone.x - boat.x, drone.z - boat.z);
    const tagging = active && drone.distanceToBoat < GAME_RULES.tagRadius
      && hasLineOfSight(world, drone.x, drone.z, drone.altitude, boat.x, boat.z, world.waterLevel + 5);
    // Each drone owns its uninterrupted lock. Taking turns nearby cannot add
    // two partial locks into a capture, and the scouting plane cannot tag.
    drone.tagProgress = tagging ? Math.min(1, drone.tagProgress + realStep / GAME_RULES.tagSeconds) : 0;
  });

  const plane = state.plane;
  let planeTarget: { x: number; z: number };
  let plannedRate: number | undefined;
  if (state.algorithm === FLIGHT_ALGORITHM && state.surveillance.observation) {
    // Continue observation passes until a quad has its own visual contact;
    // only then hand over and fly ahead to support the next gap.
    plane.role = !state.detected ? 'reacquire' : state.drones.some((drone) => drone.detecting) ? 'forward-support' : 'track';
    if (state.planeTracking === 'observation-shadowing') {
      // Quads own close pursuit. The plane keeps its own useful view through
      // repeat passes instead of abandoning the boat for a point far ahead.
      // Even a fresh quad report is a cue, not proof that the plane sees it.
      if (!state.surveillance.planePlan || state.simulationTime - state.surveillance.planePlan.at >= 1) {
        state.surveillance.planePlan = planPlaneShadow(plane, state.surveillance.observation, state.flightPolicy, state.simulationTime,
          { speed: GAME_RULES.planeSpeed, turnRate: 0.43, viewRadius: GAME_RULES.overheadSpottingRadius, minX, maxX, minZ, maxZ });
      }
      planeTarget = state.surveillance.planePlan.target;
      plannedRate = state.surveillance.planePlan.turnRate;
    } else planeTarget = surveillanceTarget(state.surveillance.observation, state.flightPolicy, state.simulationTime, plane.role, 2, world.spawn.heading);
  } else if (state.lastKnown) {
    // Fixed-wing aircraft cannot hover: a bounded turn produces repeated passes
    // and a circling search around the last observation. It must obtain a new
    // observation on each pass before reporting the boat's updated position.
    if (!state.detected && Math.hypot(plane.x - state.lastKnown.x, plane.z - state.lastKnown.z) < 500) plane.searchPhase += STEP * 0.35;
    const orbit = plane.searchPhase > 0 ? 260 : 0;
    planeTarget = { x: state.lastKnown.x + Math.sin(plane.searchPhase) * orbit, z: state.lastKnown.z + Math.cos(plane.searchPhase) * orbit };
  } else { planeTarget = patrolTarget(plane, 300); state.surveillance.planePlan = undefined; if (state.algorithm === FLIGHT_ALGORITHM) plane.role = 'broad-search'; }
  if (state.algorithm === FLIGHT_ALGORITHM) plane.target = { ...planeTarget };
  plane.speed = GAME_RULES.planeSpeed;
  moveAircraft(plane, planeTarget, 0.43, 235, plannedRate);

  state.distanceToDrone = Math.min(...state.drones.map((drone) => drone.distanceToBoat));
  state.tagProgress = Math.max(...state.drones.map((drone) => drone.tagProgress));
  state.alert = state.tagProgress > 0 ? "tagging" : state.detected ? "detected" : state.lastKnown ? "searching" : "clear";
  if (state.tagProgress >= 1 - 1e-10) { state.tagProgress = 1; state.status = "caught"; }
}

/** Speed up simulation using more fixed ticks, retaining collision precision and real-time tagging. */
export function stepGame(state: GameState, world: WorldData, input: InputState, dt: number, onBeforeTick?: () => void): void {
  if (state.status !== "playing" || !Number.isFinite(dt) || dt <= 0) return;
  // A background-tab resume never advances the game by the elapsed wall time.
  if (dt > 0.5) { state.accumulator = 0; return; }
  state.accumulator += Math.min(dt, 0.1) * GAME_RULES.pace;
  while (state.accumulator + 1e-10 >= STEP && state.status === "playing") {
    state.accumulator -= STEP;
    onBeforeTick?.();
    tick(state, world, input);
  }
  state.accumulator = Math.max(0, state.accumulator);
}

export function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(total / 60).toString().padStart(2, "0")}:${(total % 60).toString().padStart(2, "0")}`;
}
