import { createGame, GAME_RULES, sampleRiverHeight, SIMULATION_STEP, startGame, stepGame, type GameState, type WorldData } from './game';
import { LEARNING_POLICY, LEGACY_RULES_VERSION, OVERHEAD_RULES_VERSION, COORDINATED_RULES_VERSION, RULES_VERSION, type ControlSample, type Layout, type LiveFrame, type PathSample, type ReplayScore, type TowerPosition } from './learningTypes';
import { applyLearningLayout, applyTowerLayout } from './learningWorld';
import { DEFAULT_FLIGHT_POLICY, FLIGHT_ALGORITHM, FLIGHT_POLICY_BOUNDS, LEGACY_FLIGHT_ALGORITHM, normalizeFlightPolicy, type FlightPolicy } from './surveillance';

export const MAX_TICKS = Math.round(LEARNING_POLICY.maxSeconds * GAME_RULES.pace / SIMULATION_STEP);
export const REAL_TICK_SECONDS = SIMULATION_STEP / GAME_RULES.pace;
export type ReplayTrace = { seed: number; ticks: number; controls: ControlSample[]; outcome: 'caught' | 'escaped'; seconds: number; rulesVersion?: string };
export type ReplayResult = { outcome: 'caught' | 'escaped' | 'censored'; ticks: number; seconds: number; firstDetectionSeconds: number | null; path: PathSample[]; frame: LiveFrame;
  surveillance?: { visualContactSeconds: number; longestContactGapSeconds: number; aircraftDistanceM: number; planeVisualContactSeconds?: number } };
const breathe = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export function gameFrame(game: GameState, status: LiveFrame['status'] = game.status === 'caught' ? 'caught' : 'playing'): LiveFrame {
  return {
    ...(game.algorithm === FLIGHT_ALGORITHM ? { algorithm: FLIGHT_ALGORITHM } : {}),
    time: game.time, status, boat: { x: game.boat.x, z: game.boat.z, heading: game.boat.heading },
    towers: game.towers.map(({ id, x, z, heading, range, detecting }) => ({ id, x, z, heading, range, detecting })),
    drones: game.drones.map(({ id, x, z, heading, detecting, tagProgress, role, target }) => ({ id, x, z, heading, detecting, tagProgress, ...(role ? { role, ...(target ? { target: { ...target } } : {}) } : {}) })),
    plane: { x: game.plane.x, z: game.plane.z, heading: game.plane.heading, detecting: game.plane.detecting,
      ...(game.plane.role ? { role: game.plane.role, ...(game.plane.target ? { target: { ...game.plane.target } } : {}) } : {}) },
    detected: game.detected, tagProgress: game.tagProgress,
  };
}

/** Reuses the actual game physics, seeded pickups, terrain, radar and two-second drone capture. */
export async function replayTrace(world: WorldData, mission: TowerPosition[] | Pick<Layout, 'towers' | 'algorithm' | 'flightPolicy'>, trace: Pick<ReplayTrace, 'seed' | 'ticks' | 'controls' | 'rulesVersion'>, keepPath = false, collectFrame?: (frame: LiveFrame) => void): Promise<ReplayResult> {
  const rulesVersion = trace.rulesVersion ?? RULES_VERSION;
  if (![RULES_VERSION, COORDINATED_RULES_VERSION, OVERHEAD_RULES_VERSION, LEGACY_RULES_VERSION].includes(rulesVersion)) throw new Error('Unsupported recording rules version.');
  const coordinated = rulesVersion === RULES_VERSION || rulesVersion === COORDINATED_RULES_VERSION;
  const layout = Array.isArray(mission) ? { towers: mission } : mission;
  const replayWorld = coordinated ? applyLearningLayout(world, layout) : applyTowerLayout(world, layout.towers);
  const game = createGame(replayWorld, trace.seed, { aircraftSpotting: rulesVersion === LEGACY_RULES_VERSION ? 'forward-camera' : 'overhead',
    algorithm: coordinated ? FLIGHT_ALGORITHM : LEGACY_FLIGHT_ALGORITHM,
    planeTracking: rulesVersion === RULES_VERSION ? 'observation-shadowing' : 'point-pursuit' });
  startGame(game);
  let input = { throttle: 0, steer: 0 }, control = 0, ticks = 0;
  let firstDetectionSeconds: number | null = null;
  let visualContactSeconds = 0, planeVisualContactSeconds = 0, gapSeconds = 0, longestContactGapSeconds = 0, aircraftDistanceM = 0;
  let openingFrame: LiveFrame | null = null;
  const path: PathSample[] = [];
  const sample = () => path.push({ t: game.time, x: game.boat.x, z: game.boat.z, detected: game.detected, tagProgress: game.tagProgress });
  if (keepPath) sample();
  collectFrame?.(gameFrame(game));
  for (; ticks < trace.ticks;) {
    if (keepPath || collectFrame) openingFrame = gameFrame(game);
    if (control < trace.controls.length && trace.controls[control].tick === ticks) input = trace.controls[control++];
    const positions = [game.drones[0].x, game.drones[0].z, game.drones[1].x, game.drones[1].z, game.plane.x, game.plane.z];
    stepGame(game, replayWorld, input, REAL_TICK_SECONDS);
    ticks++;
    if (game.detected && firstDetectionSeconds === null) firstDetectionSeconds = game.time;
    if (game.plane.detecting) planeVisualContactSeconds += REAL_TICK_SECONDS;
    if (game.detected) { visualContactSeconds += REAL_TICK_SECONDS; gapSeconds = 0; }
    else if (firstDetectionSeconds !== null) { gapSeconds += REAL_TICK_SECONDS; longestContactGapSeconds = Math.max(longestContactGapSeconds, gapSeconds); }
    // A section reset respawns the game fleet; this is not flown distance.
    if (game.loop === 0) [game.drones[0], game.drones[1], game.plane].forEach((aircraft, index) => {
      aircraftDistanceM += Math.hypot(aircraft.x - positions[index * 2], aircraft.z - positions[index * 2 + 1]);
    });
    if (keepPath && ticks % 60 === 0) sample();
    if (game.status === 'caught' || game.loop > 0) break;
    // Playback samples at 10 Hz, while verification and training retain the
    // exact 120 Hz game physics without allocating a playback recording.
    if (collectFrame && ticks % 12 === 0 && ticks < trace.ticks) collectFrame(gameFrame(game));
    // A replay cannot monopolize the Next.js event loop while players start/live/finish.
    if (ticks % 240 === 0) await breathe();
  }
  if (keepPath && (!path.length || path[path.length - 1].t !== game.time)) sample();
  const outcome = game.status === 'caught' ? 'caught' : game.loop > 0 ? 'escaped' : 'censored';
  // A mission that never sees the ship has no continuity: do not report a
  // misleading zero gap. Otherwise gaps measure losses after first sighting.
  if (firstDetectionSeconds === null) longestContactGapSeconds = game.time;
  const frame = gameFrame(game, outcome === 'censored' ? 'abandoned' : outcome);
  if (outcome === 'escaped' && openingFrame) {
    frame.towers = openingFrame.towers; frame.drones = openingFrame.drones; frame.plane = openingFrame.plane;
  }
  collectFrame?.(frame);
  return { outcome, ticks, seconds: game.time, firstDetectionSeconds, path, frame,
    ...(coordinated ? { surveillance: { visualContactSeconds, longestContactGapSeconds, aircraftDistanceM,
      ...(rulesVersion === RULES_VERSION ? { planeVisualContactSeconds } : {}) } } : {}) };
}

export function scoreReplays(rows: (Pick<ReplayResult, 'outcome' | 'seconds'> & Partial<Pick<ReplayResult, 'firstDetectionSeconds' | 'surveillance'>>)[]): ReplayScore {
  const captures = rows.filter((row) => row.outcome === 'caught');
  const measured = rows.filter((row) => row.surveillance !== undefined);
  const detected = measured.filter((row) => row.firstDetectionSeconds != null);
  const seconds = measured.reduce((sum, row) => sum + row.seconds, 0);
  return {
    attempts: rows.length, captures: captures.length, escapes: rows.filter((row) => row.outcome === 'escaped').length,
    censored: rows.filter((row) => row.outcome === 'censored').length,
    captureRate: rows.length ? captures.length / rows.length : 0,
    meanCaptureSeconds: captures.length ? captures.reduce((sum, row) => sum + row.seconds, 0) / captures.length : null,
    // Uncaught truncated replays are censored, never invented escapes or free successes.
    cappedMeanSeconds: rows.length ? rows.reduce((sum, row) => sum + (row.outcome === 'caught' ? row.seconds : LEARNING_POLICY.maxSeconds), 0) / rows.length : 0,
    ...(measured.length ? { surveillance: {
      detectionRate: detected.length / measured.length,
      meanFirstDetectionSeconds: detected.length ? detected.reduce((sum, row) => sum + row.firstDetectionSeconds!, 0) / detected.length : null,
      visualContactFraction: seconds ? measured.reduce((sum, row) => sum + row.surveillance!.visualContactSeconds, 0) / seconds : 0,
      longestContactGapSeconds: Math.max(...measured.map((row) => row.surveillance!.longestContactGapSeconds)),
      meanAircraftDistanceM: measured.reduce((sum, row) => sum + row.surveillance!.aircraftDistanceM, 0) / measured.length,
      ...(measured.every((row) => row.surveillance!.planeVisualContactSeconds !== undefined) ? {
        planeVisualContactFraction: seconds ? measured.reduce((sum, row) => sum + row.surveillance!.planeVisualContactSeconds!, 0) / seconds : 0,
      } : {}),
    } } : {}),
  };
}

export function validPositions(world: WorldData, previous: TowerPosition[], candidate: TowerPosition[]): boolean {
  if (candidate.length !== world.towers.length || previous.length !== candidate.length) return false;
  return candidate.every((point, i) => {
    const tower = world.towers[i], old = previous[i];
    if (point.id !== tower.id || old.id !== point.id || !Number.isFinite(point.x) || !Number.isFinite(point.z)) return false;
    if (Math.abs(point.x) >= world.half || Math.abs(point.z) >= world.half) return false;
    const height = sampleRiverHeight(world, point.x, point.z);
    if (!Number.isFinite(height) || height <= world.waterLevel + 4) return false;
    if (Math.hypot(point.x - world.spawn.x, point.z - world.spawn.z) < tower.range + LEARNING_POLICY.spawnProtectionMetres) return false;
    return candidate.every((other, j) => i === j || Math.hypot(point.x - other.x, point.z - other.z) >= LEARNING_POLICY.minimumTowerSeparation);
  });
}

/** Local refinements plus global land exploration; only tower X/Z can change. */
export function proposePositions(world: WorldData, current: TowerPosition[], round: number, count = 12): TowerPosition[][] {
  const proposals: TowerPosition[][] = [];
  const limit = Math.min(12, Math.max(0, Math.floor(count))), localCount = Math.min(4, limit);
  if (!current.length || !Number.isFinite(limit)) return proposals;
  let randomState = ((round + 1) * 2654435761) >>> 0;
  const random = () => ((randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let attempt = 0; attempt < 180 && proposals.length < localCount; attempt++) {
    const moving = attempt % (current.length + 1);
    const candidate = current.map((tower, i) => {
      if (moving < current.length && moving !== i) return { ...tower };
      const angle = random() * Math.PI * 2;
      const radius = 75 + random() * 275;
      return { id: tower.id, x: tower.x + Math.cos(angle) * radius, z: tower.z + Math.sin(angle) * radius };
    });
    if (validPositions(world, current, candidate)) proposals.push(candidate);
  }
  // Global proposals cross flat regions of the objective where small moves do
  // not affect the aircraft's first observation. They depend only on geometry
  // and this round's seed; held-out controls never influence the proposals.
  for (let attempt = 0; attempt < 768 && proposals.length < limit; attempt++) {
    const moving = attempt % (current.length + 1);
    const candidate = current.map((tower, i) => moving < current.length && moving !== i ? { ...tower } : {
      id: tower.id, x: (random() * 2 - 1) * (world.half - 1), z: (random() * 2 - 1) * (world.half - 1),
    });
    if (validPositions(world, current, candidate)) proposals.push(candidate);
  }
  return proposals;
}

/** Flight-only and joint proposals share the existing bounded replay optimizer.
 * Validation inputs never enter proposal generation or candidate ranking. */
export function proposeMissionPolicies(world: WorldData, current: Layout, round: number): Layout[] {
  const towerCandidates = proposePositions(world, current.towers, round, 8);
  let seed = Math.imul(round + 7, 2246822519) >>> 0;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const original = normalizeFlightPolicy(current.flightPolicy ?? DEFAULT_FLIGHT_POLICY);
  const mutate = (global: boolean): FlightPolicy => normalizeFlightPolicy(Object.fromEntries(
    (Object.keys(original) as (keyof FlightPolicy)[]).map((key) => {
      const [low, high] = FLIGHT_POLICY_BOUNDS[key];
      return [key, global ? low + random() * (high - low) : original[key] + (random() - 0.5) * (high - low) * 0.5];
    })));
  const candidates: Layout[] = [];
  for (let index = 0; index < 12; index++) candidates.push({ ...current, algorithm: FLIGHT_ALGORITHM,
    // Four pure flight candidates guarantee learnable routes even if no valid tower move exists.
    towers: (index < 4 ? current.towers : towerCandidates[index - 4] ?? current.towers).map((tower) => ({ ...tower })),
    flightPolicy: index === 4 || index === 5 ? { ...original } : mutate(index >= 8),
  });
  return candidates;
}

export function introducesEarlyCapture(baseline: ReplayResult[], candidate: ReplayResult[]): boolean {
  return candidate.some((row, i) => row.outcome === 'caught' && row.seconds < LEARNING_POLICY.minimumCaptureSeconds
    && (!baseline[i] || baseline[i].outcome !== 'caught' || row.seconds < baseline[i].seconds - 0.01));
}

export function promotionDecision(
  original: ReplayTrace[], baseline: ReplayResult[], candidate: ReplayResult[], validationStart: number,
): { promote: boolean; reason: string } {
  if (original.length < LEARNING_POLICY.minimumAttempts || original.length !== baseline.length || original.length !== candidate.length || original.length - validationStart < 4) {
    return { promote: false, reason: 'More completed attempts are needed for a separate validation group.' };
  }
  if (introducesEarlyCapture(baseline, candidate)) {
    return { promote: false, reason: 'Candidate introduced an earlier capture below the 12-second fairness threshold.' };
  }
  const held = candidate.slice(validationStart);
  if (scoreReplays(held).captureRate > LEARNING_POLICY.maximumValidationCaptureRate) return { promote: false, reason: 'Candidate exceeded the 80% held-out capture limit.' };
  if (!held.some((row, i) => original[validationStart + i].outcome === 'escaped' && row.outcome === 'escaped')) {
    return { promote: false, reason: 'Validation must retain an actual successful player escape.' };
  }
  // Compare against both the deployed layout replay and actual outcomes, which
  // may have been recorded on older layouts. No validation data ranks proposals.
  for (const [start, label] of [[0, 'all attempts'], [validationStart, 'held-out attempts']] as const) {
    const score = scoreReplays(candidate.slice(start));
    const comparisons = [scoreReplays(baseline.slice(start)), scoreReplays(original.slice(start))];
    if (comparisons.some((previous) => score.captureRate < previous.captureRate)) return { promote: false, reason: `Capture rate fell on ${label}.` };
    if (comparisons.some((previous) => score.cappedMeanSeconds >= previous.cappedMeanSeconds - 0.01)) return { promote: false, reason: `No faster capped capture time on ${label}.` };
  }
  return { promote: true, reason: 'Faster replay captures passed held-out escape and fairness checks.' };
}
