/** The same bounded policy vocabulary is used by the ArcticSim trainer. */
export const FLIGHT_ALGORITHM = 'coordinated-surveillance-v1' as const;
export const LEGACY_FLIGHT_ALGORITHM = 'legacy-patrol-v2' as const;
export type FlightPolicy = {
  laneSpacingM: number; routePhase: number; quadSearchRadiusM: number;
  lookaheadS: number; supportOffsetM: number; reacquireWidthM: number;
};
export const DEFAULT_FLIGHT_POLICY: Readonly<FlightPolicy> = Object.freeze({
  // The game's 65 m downward spotting radius needs closer search lanes than
  // ArcticSim's forward cameras. Sensor/speed rules themselves remain fixed.
  laneSpacingM: 200, routePhase: 0, quadSearchRadiusM: 1200,
  lookaheadS: 15, supportOffsetM: 350, reacquireWidthM: 250,
});
export const FLIGHT_POLICY_BOUNDS: Readonly<Record<keyof FlightPolicy, readonly [number, number]>> = {
  laneSpacingM: [200, 1600], routePhase: [0, 1], quadSearchRadiusM: [250, 2200],
  lookaheadS: [0, 40], supportOffsetM: [100, 1000], reacquireWidthM: [50, 700],
};
export function normalizeFlightPolicy(values: Partial<FlightPolicy> = {}): FlightPolicy {
  return Object.fromEntries((Object.keys(DEFAULT_FLIGHT_POLICY) as (keyof FlightPolicy)[]).map((key) => {
    const [low, high] = FLIGHT_POLICY_BOUNDS[key], value = values[key];
    return [key, typeof value === 'number' && Number.isFinite(value) ? Math.max(low, Math.min(high, value)) : DEFAULT_FLIGHT_POLICY[key]];
  })) as FlightPolicy;
}
export function validFlightPolicy(value: unknown): value is FlightPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return (Object.keys(DEFAULT_FLIGHT_POLICY) as (keyof FlightPolicy)[]).every((key) => {
    const entry = (value as FlightPolicy)[key], [low, high] = FLIGHT_POLICY_BOUNDS[key];
    return typeof entry === 'number' && Number.isFinite(entry) && entry >= low && entry <= high;
  });
}
export type SurveillanceRole = 'gap-search' | 'broad-search' | 'track' | 'forward-support' | 'reacquire';
export type SearchPoint = { x: number; z: number };
export type VisualObservation = SearchPoint & { at: number; vx: number; vz: number };
export type SurveillanceState = {
  routes: Record<string, SearchPoint[]>;
  observation: VisualObservation | null;
  leadDroneId: string | null;
  planePlan?: { at: number; turnRate: number; target: SearchPoint };
};

/** A small deterministic receding-horizon controller for the game's downward
 * camera. A faster plane cannot hover over a slower vessel: choose feasible
 * repeat passes by rewarding predicted time within the unchanged camera radius.
 * Only observations, the plane's pose, and public flight limits enter planning.
 * Replan once per simulated second; the ordinary fixed tick enforces the turn.
 */
export function planPlaneShadow(
  aircraft: SearchPoint & { heading: number }, observation: VisualObservation,
  policy: FlightPolicy, at: number,
  limits: { speed: number; turnRate: number; viewRadius: number; minX: number; maxX: number; minZ: number; maxZ: number },
): { at: number; turnRate: number; target: SearchPoint } {
  type Node = SearchPoint & { heading: number; reward: number; first: number; target: SearchPoint };
  const actions = [-1, -0.5, 0, 0.5, 1];
  let beam: Node[] = [{ ...aircraft, reward: 0, first: 0, target: { x: aircraft.x, z: aircraft.z } }];
  let elapsed = 0;
  // Includes at least one minimum-radius turn (about 14.6 seconds). Without
  // that horizon, a greedy pursuit controller settles into an unseen orbit.
  for (let depth = 0; depth < 9; depth++) {
    const duration = depth === 0 ? 1 : 2, next: Node[] = [];
    for (const parent of beam) for (const action of actions) {
      const node = { ...parent }, rate = action * limits.turnRate;
      for (let dt = 0.25; dt <= duration; dt += 0.25) {
        node.heading += rate * 0.25;
        node.x += Math.sin(node.heading) * limits.speed * 0.25;
        node.z += Math.cos(node.heading) * limits.speed * 0.25;
        const horizon = Math.min(Math.max(0, at - observation.at) + elapsed + dt, policy.lookaheadS);
        const dx = node.x - observation.x - observation.vx * horizon;
        const dz = node.z - observation.z - observation.vz * horizon;
        const distance = Math.hypot(dx, dz), discount = Math.exp(-(elapsed + dt) / 16);
        // The soft term brings a distant plane into range; actual footprint
        // time then dominates. Turning never changes the camera/capture rules.
        node.reward += discount * 0.25 * (Math.exp(-distance / 250)
          + (distance < limits.viewRadius ? 6 * (1 - distance / (limits.viewRadius * 2)) : 0));
        if (node.x < limits.minX || node.x > limits.maxX || node.z < limits.minZ || node.z > limits.maxZ) node.reward -= 4;
      }
      if (depth === 0) { node.first = rate; node.target = { x: node.x, z: node.z }; }
      next.push(node);
    }
    next.sort((a, b) => b.reward - a.reward || Math.abs(a.first) - Math.abs(b.first) || a.first - b.first);
    // Retain branches for every first action so an immediate greedy turn does
    // not prune the wider return that will regain contact later in the pass.
    beam = actions.flatMap((action) => next.filter((node) => node.first === action * limits.turnRate).slice(0, 3));
    elapsed += duration;
  }
  beam.sort((a, b) => b.reward - a.reward || Math.abs(a.first) - Math.abs(b.first) || a.first - b.first);
  const best = beam[0];
  return { at, turnRate: best.first, target: best.target };
}

/** Routes see map geometry and aircraft launch poses, never the hidden ship. */
export function buildSurveillanceRoutes(
  points: SearchPoint[], aircraft: { id: string; x: number; z: number }[],
  towers: { x: number; z: number; range: number }[], policy: FlightPolicy, courseHeading: number,
): Record<string, SearchPoint[]> {
  const fx = Math.sin(courseHeading), fz = Math.cos(courseHeading);
  const along = (point: SearchPoint) => point.x * fx + point.z * fz;
  const across = (point: SearchPoint) => point.x * fz - point.z * fx;
  const lane = (point: SearchPoint) => Math.floor(across(point) / policy.laneSpacingM);
  const sweep = (subset: SearchPoint[]) => [...subset].sort((a, b) => lane(a) - lane(b)
    || (Math.abs(lane(a)) % 2 ? -1 : 1) * (along(a) - along(b)));
  const drones = aircraft.filter((item) => item.id !== 'P1');
  const covered = (point: SearchPoint) => towers.some((tower) => Math.hypot(point.x - tower.x, point.z - tower.z) < tower.range * 0.7);
  const localOwner = (point: SearchPoint) => drones.reduce((best, drone) =>
    Math.hypot(point.x - drone.x, point.z - drone.z) < Math.hypot(point.x - best.x, point.z - best.z) ? drone : best, drones[0]);
  const routes: Record<string, SearchPoint[]> = {};
  for (const item of aircraft) {
    let pool = item.id === 'P1'
      ? points.filter((point) => !covered(point) && drones.every((drone) => Math.hypot(point.x - drone.x, point.z - drone.z) > policy.quadSearchRadiusM))
      : points.filter((point) => localOwner(point)?.id === item.id && Math.hypot(point.x - item.x, point.z - item.z) <= policy.quadSearchRadiusM);
    // Every aircraft receives a useful map-defined route, even on a small map.
    if (pool.length < 3) pool = item.id === 'P1' ? points : points.filter((point) => localOwner(point)?.id === item.id);
    if (!pool.length) pool = points;
    const ordered = sweep(pool.length ? pool : [{ x: item.x, z: item.z }]);
    const closest = ordered.reduce((best, point, index) => Math.hypot(point.x - item.x, point.z - item.z)
      < Math.hypot(ordered[best].x - item.x, ordered[best].z - item.z) ? index : best, 0);
    const offset = (closest + Math.floor(policy.routePhase * ordered.length)) % ordered.length;
    routes[item.id] = [...ordered.slice(offset), ...ordered.slice(0, offset)].map((point) => ({ ...point }));
  }
  return routes;
}

/** Estimate motion from two camera observations; a missed view never reads truth. */
export function observePosition(previous: VisualObservation | null, position: SearchPoint, at: number, maxSpeed: number): VisualObservation {
  const dt = previous ? at - previous.at : 0;
  let vx = dt > 0 && dt < 10 ? (position.x - previous!.x) / dt : 0;
  let vz = dt > 0 && dt < 10 ? (position.z - previous!.z) / dt : 0;
  const speed = Math.hypot(vx, vz);
  if (speed > maxSpeed) { vx *= maxSpeed / speed; vz *= maxSpeed / speed; }
  return { x: position.x, z: position.z, at, vx, vz };
}

/** Only this observation record and aircraft state enter pursuit planning. */
export function surveillanceTarget(
  observation: VisualObservation, policy: FlightPolicy, at: number,
  role: 'track' | 'forward-support' | 'reacquire', slot: number, heading: number,
): SearchPoint {
  const age = Math.max(0, at - observation.at), speed = Math.hypot(observation.vx, observation.vz);
  const fx = speed > 1 ? observation.vx / speed : Math.sin(heading);
  const fz = speed > 1 ? observation.vz / speed : Math.cos(heading);
  const horizon = Math.min(age, policy.lookaheadS);
  const center = { x: observation.x + observation.vx * horizon, z: observation.z + observation.vz * horizon };
  if (role === 'track') return center;
  if (role === 'forward-support') return { x: center.x + fx * policy.supportOffsetM, z: center.z + fz * policy.supportOffsetM };
  const phase = age * 0.45 + slot * Math.PI * 2 / 3;
  const radius = policy.reacquireWidthM * Math.min(1.8, 0.25 + age / 15);
  return { x: center.x + fx * Math.cos(phase) * radius + fz * Math.sin(phase) * radius,
    z: center.z + fz * Math.cos(phase) * radius - fx * Math.sin(phase) * radius };
}
