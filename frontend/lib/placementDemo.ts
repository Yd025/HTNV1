/**
 * Deterministic, ideal visibility for the placement playground only.
 * Local metres: north is 0 degrees, east is 90 degrees. No terrain occlusion,
 * camera uncertainty, fleet search, or live simulator observations are modelled.
 */
export type Point = { north: number; east: number };

export type DemoTower = Point & {
  id: string;
  label: string;
  heading: number;
  rangeM: number;
  fovDeg: number;
};

export type BoatRoute = { start: Point; end: Point; speedMps: number };

export type RouteOptions = {
  horizonS?: number;
  stepS?: number;
  scanPeriodS?: number;
};

export type RouteResult = {
  detectedAt: number | null;
  sourceId: string | null;
  position: Point | null;
};

const DEGREES = 180 / Math.PI;
const EPSILON = 1e-9;
const MAX_EVALUATION_STEPS = 100_000;

function finite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function nonnegative(value: number, name: string): void {
  finite(value, name);
  if (value < 0) throw new RangeError(`${name} must be nonnegative`);
}

function positive(value: number, name: string): void {
  finite(value, name);
  if (value <= 0) throw new RangeError(`${name} must be positive`);
}

function validatePoint(point: Point): void {
  if (!point) throw new TypeError("A point is required");
  finite(point.north, "north");
  finite(point.east, "east");
}

function validateTower(tower: DemoTower): void {
  validatePoint(tower);
  if (typeof tower.id !== "string" || !tower.id.trim()) throw new TypeError("A tower id is required");
  if (typeof tower.label !== "string" || !tower.label.trim()) throw new TypeError("A tower label is required");
  finite(tower.heading, "heading");
  positive(tower.rangeM, "rangeM");
  nonnegative(tower.fovDeg, "fovDeg");
  if (tower.fovDeg > 360) throw new RangeError("fovDeg must not exceed 360");
}

function validateRoute(route: BoatRoute): void {
  if (!route) throw new TypeError("A route is required");
  validatePoint(route.start);
  validatePoint(route.end);
  nonnegative(route.speedMps, "speedMps");
  finite(Math.hypot(route.end.north - route.start.north, route.end.east - route.start.east), "route length");
}

function normalize(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

function headingAt(tower: DemoTower, timeS: number, scanPeriodS: number): number {
  return normalize(normalize(tower.heading) + ((timeS % scanPeriodS) / scanPeriodS) * 360);
}

function visibleAt(tower: DemoTower, point: Point, timeS: number, scanPeriodS: number): boolean {
  const north = point.north - tower.north;
  const east = point.east - tower.east;
  const distance = Math.hypot(north, east);
  if (distance > tower.rangeM + EPSILON) return false;
  if (distance <= EPSILON || tower.fovDeg === 360) return true;
  const bearing = Math.atan2(east, north) * DEGREES;
  const offset = normalize(bearing - headingAt(tower, timeS, scanPeriodS) + 180) - 180;
  return Math.abs(offset) <= tower.fovDeg / 2 + EPSILON;
}

function positionAt(route: BoatRoute, timeS: number): Point {
  const north = route.end.north - route.start.north;
  const east = route.end.east - route.start.east;
  const distance = Math.hypot(north, east);
  // Divide first: very large finite speed/time inputs should arrive, not overflow.
  const arrivalS = route.speedMps > 0 ? distance / route.speedMps : Infinity;
  if (distance === 0 || timeS >= arrivalS) return { ...route.end };
  const fraction = timeS / arrivalS;
  return { north: route.start.north + north * fraction, east: route.start.east + east * fraction };
}

/** Clamp map/keyboard edits before rendering and evaluation; never mutate input. */
export function clampPoint(point: Point, halfM = 1500): Point {
  validatePoint(point);
  positive(halfM, "halfM");
  return {
    north: Math.max(-halfM, Math.min(halfM, point.north)),
    east: Math.max(-halfM, Math.min(halfM, point.east)),
  };
}

/** Clockwise sweep, shared by the rendered sector and visibility calculation. */
export function towerHeading(tower: DemoTower, timeS: number, scanPeriodS = 60): number {
  validateTower(tower);
  nonnegative(timeS, "timeS");
  positive(scanPeriodS, "scanPeriodS");
  return headingAt(tower, timeS, scanPeriodS);
}

/** Range and inclusive sector edges; displayed radial pulses are only decoration. */
export function inTowerView(tower: DemoTower, point: Point, timeS: number, scanPeriodS = 60): boolean {
  validateTower(tower);
  validatePoint(point);
  nonnegative(timeS, "timeS");
  positive(scanPeriodS, "scanPeriodS");
  return visibleAt(tower, point, timeS, scanPeriodS);
}

/** Straight constant-speed motion followed by holding at the route endpoint. */
export function boatPosition(route: BoatRoute, timeS: number): Point {
  validateRoute(route);
  nonnegative(timeS, "timeS");
  return positionAt(route, timeS);
}

/**
 * First visible sample, including time zero and the exact horizon. This is a
 * sampled preview, not a continuous-time optimum. Compare layouts with the same
 * route and options; a simultaneous hit is attributed to the first tower.
 */
export function evaluateRoute(
  towers: readonly DemoTower[],
  route: BoatRoute,
  { horizonS = 180, stepS = 1, scanPeriodS = 60 }: RouteOptions = {},
): RouteResult {
  if (!Array.isArray(towers)) throw new TypeError("towers must be an array");
  towers.forEach(validateTower);
  if (new Set(towers.map((tower) => tower.id)).size !== towers.length) throw new TypeError("Tower ids must be unique");
  validateRoute(route);
  nonnegative(horizonS, "horizonS");
  positive(stepS, "stepS");
  positive(scanPeriodS, "scanPeriodS");
  if (horizonS / stepS > MAX_EVALUATION_STEPS) throw new RangeError("Too many route evaluation steps");

  const check = (timeS: number): RouteResult | null => {
    const position = positionAt(route, timeS);
    const tower = towers.find((candidate) => visibleAt(candidate, position, timeS, scanPeriodS));
    return tower ? { detectedAt: timeS, sourceId: tower.id, position } : null;
  };

  const steps = Math.floor(horizonS / stepS);
  for (let index = 0; index <= steps; index += 1) {
    const result = check(index * stepS);
    if (result) return result;
  }
  if (steps * stepS < horizonS) {
    const result = check(horizonS);
    if (result) return result;
  }
  return { detectedAt: null, sourceId: null, position: null };
}
