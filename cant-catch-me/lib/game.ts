/** Coordinates use Three.js X/Z; heading zero points toward +Z. */
export type WorldData = {
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
};
export type DroneState = AircraftState & { tagProgress: number; distanceToBoat: number };
export type BoostPickup = { id: number; x: number; z: number };
type AircraftLaunch = Pick<AircraftState, "id" | "x" | "z" | "heading" | "altitude" | "patrolIndex">;
export type GameState = {
  status: "ready" | "playing" | "paused" | "caught";
  /** Active real seconds, used for the survival score and capture duration. */
  time: number;
  /** Accelerated seconds, used for movement, radar, search, and difficulty. */
  simulationTime: number;
  boat: { x: number; z: number; heading: number; speed: number; roll: number };
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
  /** Leaving the original patrol area permanently ends this run's pursuit. */
  escaped: boolean;
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
  // The escape course always progresses downriver; steering cannot become a U-turn.
  maxCourseDeviation: (75 * Math.PI) / 180,
  // Camera HFOVs from ArcticSim, page 18. Ranges and speeds are game tuning.
  radarFov: (60 * Math.PI) / 180,
  droneFov: (114.6 * Math.PI) / 180,
  droneVision: 600,
  droneMaxSpeed: 84,
  planeFov: (69 * Math.PI) / 180,
  planeVision: 1100,
  planeSpeed: 100,
  tagRadius: 65,
  tagSeconds: 2,
  graceSeconds: 6,
  boatRadius: 21,
  boostDuration: 4,
  boostMultiplier: 1.65,
  pickupRadius: 45,
  maxPickups: 4,
} as const;

export const SIMULATION_STEP = 1 / 60;
const STEP = SIMULATION_STEP;
const TAU = Math.PI * 2;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const angleDifference = (a: number, b: number) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const approach = (a: number, b: number, amount: number) => a + clamp(b - a, -amount, amount);

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
  const center = 210 * Math.sin(along / 1550) + 110 * Math.sin(along / 670);
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

export function createGame(world: WorldData, seed = 0x51a7): GameState {
  const spawn = { ...world.spawn };
  const limit = world.half - 160;
  // Select a distant starting patrol location. Later pursuit only uses observations.
  const options = Array.from({ length: 8 }, (_, i) => {
    const angle = spawn.heading + Math.PI + (i / 8) * TAU;
    return { x: clamp(spawn.x + Math.sin(angle) * 1350, -limit, limit), z: clamp(spawn.z + Math.cos(angle) * 1350, -limit, limit) };
  });
  options.sort((a, b) => Math.hypot(b.x - spawn.x, b.z - spawn.z) - Math.hypot(a.x - spawn.x, a.z - spawn.z));
  // A fixed route covers the channel, including its launch area. It is generated
  // from terrain alone and never changes in response to an unobserved boat.
  const candidates: { x: number; z: number }[] = [];
  const divisions = Math.max(2, Math.ceil(world.half * 2 / 500));
  const spacing = world.half * 2 / divisions;
  for (let row = 0; row < divisions; row++) for (let col = 0; col < divisions; col++) {
    const x = -world.half + (col + 0.5) * spacing;
    const z = -world.half + (row + 0.5) * spacing;
    if (isNavigable(world, x, z) && Math.hypot(x - spawn.x, z - spawn.z) > 200) candidates.push({ x, z });
  }
  const patrolPoints = [{ x: spawn.x, z: spawn.z }];
  while (candidates.length) {
    const previous = patrolPoints[patrolPoints.length - 1];
    let closest = 0;
    for (let i = 1; i < candidates.length; i++) {
      if (Math.hypot(candidates[i].x - previous.x, candidates[i].z - previous.z) < Math.hypot(candidates[closest].x - previous.x, candidates[closest].z - previous.z)) closest = i;
    }
    patrolPoints.push(candidates.splice(closest, 1)[0]);
  }
  const launch = (id: string, point: { x: number; z: number }, patrolIndex: number, altitude: number): AircraftLaunch => ({
    id, ...point, patrolIndex,
    heading: Math.atan2(patrolPoints[patrolIndex].x - point.x, patrolPoints[patrolIndex].z - point.z),
    altitude: Math.max(world.waterLevel + altitude, sampleRiverHeight(world, point.x, point.z) + 70),
  });
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
  const resetAircraft = (initial: AircraftLaunch): AircraftState => ({ ...initial, speed: 0, detecting: false, mode: "patrol", searchPhase: 0 });
  const drones = initialDrones.map((initial) => ({ ...resetAircraft(initial), tagProgress: 0, distanceToBoat: Math.hypot(initial.x - spawn.x, initial.z - spawn.z) }));
  const state: GameState = {
    status: "ready", time: 0, simulationTime: 0,
    boat: { ...spawn, speed: 0, roll: 0 },
    drones, plane: { ...resetAircraft(initialPlane), speed: GAME_RULES.planeSpeed },
    towers: world.towers.map((tower) => ({ ...tower, baseHeading: tower.heading, detecting: false })),
    detected: false, alert: "clear", tagProgress: 0,
    distanceToDrone: Math.min(...drones.map((drone) => drone.distanceToBoat)),
    lastKnown: null, lostFor: 0, collision: false,
    ...getSector(world, spawn.x, spawn.z), escaped: false, distanceTraveled: 0, boostRemaining: 0, pickups: [],
    accumulator: 0, collisionFor: 0,
    initialBoat: spawn, initialDrones, initialPlane, patrolPoints,
    randomState: seed >>> 0, initialRandomState: seed >>> 0, initialPickups: [], nextPickupId: 1, nextPickupAt: 7,
  };
  spawnPickup(state, world, true);
  state.initialPickups = state.pickups.map((pickup) => ({ ...pickup }));
  state.initialRandomState = state.randomState;
  return state;
}

export function startGame(state: GameState): void {
  Object.assign(state.boat, state.initialBoat, { speed: 0, roll: 0 });
  state.drones.forEach((drone, i) => Object.assign(drone, state.initialDrones[i], {
    speed: 0, detecting: false, mode: "patrol", searchPhase: 0, tagProgress: 0,
    distanceToBoat: Math.hypot(state.initialDrones[i].x - state.boat.x, state.initialDrones[i].z - state.boat.z),
  }));
  Object.assign(state.plane, state.initialPlane, { speed: GAME_RULES.planeSpeed, detecting: false, mode: "patrol", searchPhase: 0 });
  for (const tower of state.towers) { tower.heading = tower.baseHeading; tower.detecting = false; }
  Object.assign(state, {
    status: "playing", time: 0, simulationTime: 0, detected: false, alert: "clear", tagProgress: 0,
    distanceToDrone: Math.min(...state.drones.map((drone) => drone.distanceToBoat)),
    lastKnown: null, lostFor: 0, collision: false, accumulator: 0, collisionFor: 0,
    sectorX: 0, sectorZ: 0, escaped: false, distanceTraveled: 0, boostRemaining: 0,
    pickups: state.initialPickups.map((pickup) => ({ ...pickup })), randomState: state.initialRandomState,
    nextPickupId: state.initialPickups.length + 1, nextPickupAt: 7,
  });
}

export function togglePause(state: GameState): void {
  if (state.status === "playing") state.status = "paused";
  else if (state.status === "paused") state.status = "playing";
  state.accumulator = 0;
}

function tick(state: GameState, world: WorldData, input: InputState): void {
  const realStep = STEP / GAME_RULES.pace;
  state.time += realStep;
  state.simulationTime += STEP;
  const boat = state.boat;
  const throttle = clamp(Number.isFinite(input.throttle) ? input.throttle : 0, -1, 1);
  const steer = clamp(Number.isFinite(input.steer) ? input.steer : 0, -1, 1);
  state.boostRemaining = Math.max(0, state.boostRemaining - realStep);
  const topSpeed = GAME_RULES.maxSpeed * (state.boostRemaining > 0 ? GAME_RULES.boostMultiplier : 1);
  boat.speed = Math.max(0, approach(boat.speed, Math.max(0, throttle) * topSpeed, (throttle === 0 ? 13 : 27) * STEP));
  const steeringPower = 0.27 + Math.min(boat.speed / 25, 1) * 0.73;
  const previousHeading = boat.heading;
  boat.heading = clamp(boat.heading - steer * steeringPower * 0.95 * STEP,
    state.initialBoat.heading - GAME_RULES.maxCourseDeviation,
    state.initialBoat.heading + GAME_RULES.maxCourseDeviation);
  const appliedSteer = clamp((previousHeading - boat.heading) / (steeringPower * 0.95 * STEP), -1, 1);
  boat.roll += (-appliedSteer * (boat.speed / GAME_RULES.maxSpeed) * 0.15 - boat.roll) * (1 - Math.exp(-STEP * 5));
  const nx = boat.x + Math.sin(boat.heading) * boat.speed * STEP;
  const nz = boat.z + Math.cos(boat.heading) * boat.speed * STEP;
  state.collisionFor = Math.max(0, state.collisionFor - STEP);
  if (boatFits(world, nx, nz, boat.heading)) {
    state.distanceTraveled += Math.hypot(nx - boat.x, nz - boat.z);
    boat.x = nx; boat.z = nz;
  } else if (Math.abs(boat.speed) > 0.5) {
    boat.speed *= 0.28;
    state.collisionFor = 0.4;
  }
  state.collision = state.collisionFor > 0;

  Object.assign(state, getSector(world, boat.x, boat.z));
  state.escaped ||= state.sectorX !== 0 || state.sectorZ !== 0;
  if (state.escaped) {
    state.lastKnown = null;
    state.lostFor = 0;
  }
  const forwardX = Math.sin(state.initialBoat.heading), forwardZ = Math.cos(state.initialBoat.heading);
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

  const active = !state.escaped && state.simulationTime >= GAME_RULES.graceSeconds;
  let towerSeesBoat = false;
  state.towers.forEach((tower, i) => {
    tower.heading = tower.baseHeading + Math.sin(state.simulationTime * 0.27 + i * 1.7) * 1.08;
    const dx = boat.x - tower.x;
    const dz = boat.z - tower.z;
    tower.detecting = active && Math.hypot(dx, dz) <= tower.range
      && Math.abs(angleDifference(Math.atan2(dx, dz), tower.heading)) <= GAME_RULES.radarFov / 2
      && hasLineOfSight(world, tower.x, tower.z, tower.height + 55, boat.x, boat.z, world.waterLevel + 5);
    towerSeesBoat ||= tower.detecting;
  });
  const aircraftSeeBoat = (aircraft: AircraftState, range: number, fov: number) => active
    && Math.hypot(aircraft.x - boat.x, aircraft.z - boat.z) <= range
    && Math.abs(angleDifference(Math.atan2(boat.x - aircraft.x, boat.z - aircraft.z), aircraft.heading)) <= fov / 2
    && hasLineOfSight(world, aircraft.x, aircraft.z, aircraft.altitude, boat.x, boat.z, world.waterLevel + 5);
  // Every participant contributes only a real camera/radar observation. A plane
  // looking away from the boat cannot report it merely because it is nearby.
  for (const drone of state.drones) drone.detecting = aircraftSeeBoat(drone, GAME_RULES.droneVision, GAME_RULES.droneFov);
  state.plane.detecting = aircraftSeeBoat(state.plane, GAME_RULES.planeVision, GAME_RULES.planeFov);
  state.detected = towerSeesBoat || state.drones.some((drone) => drone.detecting) || state.plane.detecting;
  if (state.detected) {
    state.lastKnown = { x: boat.x, z: boat.z };
    state.lostFor = 0;
    for (const aircraft of [...state.drones, state.plane]) aircraft.searchPhase = 0;
  } else if (state.lastKnown) {
    state.lostFor += STEP;
    if (state.lostFor >= 45) {
      state.lastKnown = null;
      state.lostFor = 0;
      // Resume the terrain-defined route near the last search, without consulting
      // the boat's hidden position.
      for (const aircraft of [...state.drones, state.plane]) {
        aircraft.patrolIndex = state.patrolPoints.reduce((best, point, i, points) =>
          Math.hypot(point.x - aircraft.x, point.z - aircraft.z) < Math.hypot(points[best].x - aircraft.x, points[best].z - aircraft.z) ? i : best, 0);
      }
    }
  }

  const patrolTarget = (aircraft: AircraftState, reach: number) => {
    let waypoint = state.patrolPoints[aircraft.patrolIndex];
    if (Math.hypot(aircraft.x - waypoint.x, aircraft.z - waypoint.z) < reach) {
      aircraft.patrolIndex = (aircraft.patrolIndex + 1) % state.patrolPoints.length;
      waypoint = state.patrolPoints[aircraft.patrolIndex];
    }
    return waypoint;
  };
  const limit = world.half - 80;
  const moveAircraft = (aircraft: AircraftState, target: { x: number; z: number }, turnRate: number, altitude: number) => {
    const desiredHeading = Math.atan2(clamp(target.x, -limit, limit) - aircraft.x, clamp(target.z, -limit, limit) - aircraft.z);
    aircraft.heading += clamp(angleDifference(desiredHeading, aircraft.heading), -STEP * turnRate, STEP * turnRate);
    aircraft.x = clamp(aircraft.x + Math.sin(aircraft.heading) * aircraft.speed * STEP, -limit, limit);
    aircraft.z = clamp(aircraft.z + Math.cos(aircraft.heading) * aircraft.speed * STEP, -limit, limit);
    const ground = sampleRiverHeight(world, aircraft.x, aircraft.z);
    aircraft.altitude = Math.max(ground + 30, aircraft.altitude + (Math.max(world.waterLevel + altitude, ground + 70) - aircraft.altitude) * (1 - Math.exp(-STEP * 1.8)));
    aircraft.mode = state.lastKnown ? state.detected ? "pursuit" : "searching" : "patrol";
  };

  state.drones.forEach((drone, i) => {
    let target: { x: number; z: number };
    if (state.lastKnown) {
      const searchDistance = Math.hypot(drone.x - state.lastKnown.x, drone.z - state.lastKnown.z);
      if (!state.detected && searchDistance < 200) drone.searchPhase += STEP * 0.65;
      const orbit = drone.searchPhase > 0 ? 150 : 0;
      target = {
        x: state.lastKnown.x + Math.sin(drone.searchPhase + i * Math.PI) * orbit,
        z: state.lastKnown.z + Math.cos(drone.searchPhase + i * Math.PI) * orbit,
      };
    } else target = patrolTarget(drone, 100);
    const chaseSpeed = Math.min(GAME_RULES.droneMaxSpeed, 52 + state.simulationTime * 0.25);
    // Boat velocity and distance may influence pursuit only while a sensor has
    // an actual observation. Hidden movement never changes the search flight.
    let desiredSpeed = state.lastKnown ? 53 : Math.min(70, 38 + state.simulationTime * 0.07);
    if (state.detected) {
      const observedDistance = Math.hypot(drone.x - boat.x, drone.z - boat.z);
      const approachSpeed = Math.max(18, Math.abs(boat.speed) + Math.max(0, observedDistance - 25) * 0.65);
      desiredSpeed = Math.min(chaseSpeed, approachSpeed);
    }
    drone.speed = approach(drone.speed, desiredSpeed, STEP * 19);
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
  if (state.lastKnown) {
    // Fixed-wing aircraft cannot hover: a bounded turn produces repeated passes
    // and a circling search around the last observation. Its FPV camera always
    // faces its own heading, so it must really reacquire the boat on a pass.
    if (!state.detected && Math.hypot(plane.x - state.lastKnown.x, plane.z - state.lastKnown.z) < 500) plane.searchPhase += STEP * 0.35;
    const orbit = plane.searchPhase > 0 ? 260 : 0;
    planeTarget = { x: state.lastKnown.x + Math.sin(plane.searchPhase) * orbit, z: state.lastKnown.z + Math.cos(plane.searchPhase) * orbit };
  } else planeTarget = patrolTarget(plane, 300);
  plane.speed = GAME_RULES.planeSpeed;
  moveAircraft(plane, planeTarget, 0.43, 235);

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
