import { clampPoint, evaluateRoute, inTowerView } from "./placementDemo";
import type { BoatRoute, DemoTower, Point, RouteResult } from "./placementDemo";

/** A bounded, synthetic placement search. No live telemetry or simulator writes. */
export const EXPERIMENT = {
  candidates: 48,
  trainEpisodes: 80,
  validationEpisodes: 64,
  testEpisodes: 200,
  validationFinalists: 8,
  halfM: 1500,
  horizonS: 180,
  stepS: 1,
  scanPeriodS: 60,
} as const;

export type BatchScore = {
  episodes: number;
  detected: number;
  meanCappedS: number;
  p90CappedS: number;
  worstCappedS: number;
};

export type Candidate = {
  index: number;
  towers: DemoTower[];
  train: BatchScore;
  /** Improvement over the training incumbent; validation may choose another. */
  accepted: boolean;
  validation?: BatchScore;
};

export type Experiment = {
  seed: number;
  completed: number;
  total: number;
  phase: "search" | "complete";
  candidates: Candidate[];
  bestTowers: DemoTower[];
  bestIndex: number;
  winnerIndex?: number;
  test?: { baseline: BatchScore; learned: BatchScore };
  testRoutes?: BoatRoute[];
  testResults?: RouteResult[];
};

function uint32(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${name} must be an unsigned 32-bit integer`);
  }
}

// Separate streams keep candidate proposals independent of route generation.
function random(seed: number, index: number, stream: number): () => number {
  let state = (seed ^ Math.imul(index + 1, 0x9e3779b1) ^ stream) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let bits = Math.imul(state ^ (state >>> 15), state | 1);
    bits ^= bits + Math.imul(bits ^ (bits >>> 7), bits | 61);
    return ((bits ^ (bits >>> 14)) >>> 0) / 4294967296;
  };
}

/** Uniform independent start/destination over the whole square; no miss rejection. */
export function randomRoute(seed: number, index: number): BoatRoute {
  uint32(seed, "seed");
  uint32(index, "index");
  const next = random(seed, index, 0x72a18d9b);
  const coordinate = () => (next() * 2 - 1) * EXPERIMENT.halfM;
  return {
    start: { north: coordinate(), east: coordinate() },
    end: { north: coordinate(), east: coordinate() },
    speedMps: 6 + next() * 10,
  };
}

function routes(seed: number, offset: number, count: number): BoatRoute[] {
  return Array.from({ length: count }, (_, index) => randomRoute(seed, offset + index));
}

/** Misses count as 180 seconds in every time statistic, including p90/worst. */
function summarize(results: readonly RouteResult[]): BatchScore {
  const times = results.map((result) => result.detectedAt ?? EXPERIMENT.horizonS).sort((a, b) => a - b);
  return {
    episodes: results.length,
    detected: results.filter((result) => result.detectedAt !== null).length,
    meanCappedS: times.reduce((sum, time) => sum + time, 0) / times.length,
    p90CappedS: times[Math.ceil(times.length * 0.9) - 1],
    worstCappedS: times[times.length - 1],
  };
}

function evaluate(towers: readonly DemoTower[], batch: readonly BoatRoute[]): RouteResult[] {
  return batch.map((route) => evaluateRoute(towers, route, EXPERIMENT));
}

// Lexicographic objective: maximize detections, then minimize capped mean time.
// Equal scores retain the earlier proposal. Test scores never enter selection.
function compareScores(left: BatchScore, right: BatchScore): number {
  return right.detected - left.detected || left.meanCappedS - right.meanCappedS;
}

function cloneTowers(towers: readonly DemoTower[]): DemoTower[] {
  return towers.map((tower) => ({ ...tower }));
}

export function createExperiment(seed: number, initial: readonly DemoTower[]): Experiment {
  uint32(seed, "seed");
  if (!Array.isArray(initial) || initial.length !== 2) throw new RangeError("Exactly two initial towers are required");
  if (initial.some((tower) => Math.abs(tower.north) > EXPERIMENT.halfM || Math.abs(tower.east) > EXPERIMENT.halfM)) {
    throw new RangeError("Initial towers must be inside the arena");
  }
  const towers = cloneTowers(initial);
  const train = summarize(evaluate(towers, routes(seed, 0, EXPERIMENT.trainEpisodes)));
  return {
    seed,
    completed: 1,
    total: EXPERIMENT.candidates,
    phase: "search",
    candidates: [{ index: 0, towers, train, accepted: true }],
    bestTowers: cloneTowers(towers),
    bestIndex: 0,
  };
}

function propose(experiment: Experiment, index: number): DemoTower[] {
  const next = random(experiment.seed, index, 0xc136ef43);
  const initial = experiment.candidates[0].towers;
  // Explore the full square, then useful symmetric coverage configurations.
  if (index <= 8 || index % 8 === 0) {
    return initial.map((tower) => ({
      ...tower,
      north: (next() * 2 - 1) * EXPERIMENT.halfM,
      east: (next() * 2 - 1) * EXPERIMENT.halfM,
      heading: next() * 360,
    }));
  }
  if (index <= 16) {
    const angle = ((index - 9) / 8) * Math.PI * 2;
    const radius = 450 + next() * 300;
    return initial.map((tower, towerIndex) => ({
      ...tower,
      north: Math.cos(angle + towerIndex * Math.PI) * radius,
      east: Math.sin(angle + towerIndex * Math.PI) * radius,
      heading: next() * 360,
    }));
  }
  const scale = 400 - (index / EXPERIMENT.candidates) * 280;
  return experiment.bestTowers.map((tower) => {
    // Sum of uniforms gives bounded local perturbations without heavy tails.
    const north = tower.north + (next() + next() + next() - 1.5) * scale;
    const east = tower.east + (next() + next() + next() - 1.5) * scale;
    return {
      ...tower,
      ...clampPoint({ north, east }, EXPERIMENT.halfM),
      heading: (tower.heading + (next() - 0.5) * 120 + 360) % 360,
    };
  });
}

function finish(experiment: Experiment): Experiment {
  const ranked = [...experiment.candidates].sort((a, b) => compareScores(a.train, b.train) || a.index - b.index);
  const finalists = new Set([0, ...ranked.slice(0, EXPERIMENT.validationFinalists).map((candidate) => candidate.index)]);
  const validationRoutes = routes(experiment.seed, EXPERIMENT.trainEpisodes, EXPERIMENT.validationEpisodes);
  const candidates = experiment.candidates.map((candidate) => finalists.has(candidate.index)
    ? { ...candidate, validation: summarize(evaluate(candidate.towers, validationRoutes)) }
    : candidate);
  const winner = candidates.filter((candidate) => candidate.validation).sort((a, b) =>
    compareScores(a.validation!, b.validation!) || a.index - b.index)[0];

  // Create and inspect held-out test routes only after the winner is fixed.
  const testRoutes = routes(experiment.seed, EXPERIMENT.trainEpisodes + EXPERIMENT.validationEpisodes, EXPERIMENT.testEpisodes);
  const testResults = evaluate(winner.towers, testRoutes);
  const baselineResults = evaluate(candidates[0].towers, testRoutes);
  return {
    ...experiment,
    phase: "complete",
    candidates,
    bestTowers: cloneTowers(winner.towers),
    bestIndex: winner.index,
    winnerIndex: winner.index,
    test: { baseline: summarize(baselineResults), learned: summarize(testResults) },
    testRoutes,
    testResults,
  };
}

/**
 * Score one proposal and return a new state. Call between browser frames to show
 * each placement and stay interruptible. The last call validates the shortlist
 * and evaluates the untouched test set. This finds a best-tested pair, not a
 * mathematical optimum or a pair guaranteed to detect every possible route.
 */
export function advanceExperiment(experiment: Experiment): Experiment {
  if (experiment.phase === "complete") return experiment;
  const index = experiment.completed;
  if (index < 1 || index >= EXPERIMENT.candidates || index !== experiment.candidates.length) {
    throw new RangeError("Invalid experiment progress");
  }
  const towers = propose(experiment, index);
  const train = summarize(evaluate(towers, routes(experiment.seed, 0, EXPERIMENT.trainEpisodes)));
  const accepted = compareScores(train, experiment.candidates[experiment.bestIndex].train) < 0;
  const next: Experiment = {
    ...experiment,
    completed: index + 1,
    candidates: [...experiment.candidates, { index, towers, train, accepted }],
    bestTowers: accepted ? cloneTowers(towers) : experiment.bestTowers,
    bestIndex: accepted ? index : experiment.bestIndex,
  };
  return next.completed === EXPERIMENT.candidates ? finish(next) : next;
}

/** Nearest straight-line tower; when requested, require visibility right now. */
export function nearestTower(
  towers: readonly DemoTower[], point: Point, timeS: number, visibleOnly: boolean,
): { tower: DemoTower; distanceM: number } | null {
  if (!Number.isFinite(point.north) || !Number.isFinite(point.east) || !Number.isFinite(timeS) || timeS < 0) {
    throw new RangeError("Finite coordinates and nonnegative time are required");
  }
  let nearest: { tower: DemoTower; distanceM: number } | null = null;
  for (const tower of towers) {
    const visible = inTowerView(tower, point, timeS, EXPERIMENT.scanPeriodS);
    if (visibleOnly && !visible) continue;
    const distanceM = Math.hypot(point.north - tower.north, point.east - tower.east);
    if (!nearest || distanceM < nearest.distanceM || (distanceM === nearest.distanceM && tower.id < nearest.tower.id)) {
      nearest = { tower, distanceM };
    }
  }
  return nearest;
}
