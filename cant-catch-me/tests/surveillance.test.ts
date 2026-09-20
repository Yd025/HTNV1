import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createGame, GAME_RULES, startGame, stepGame, type GameState, type WorldData } from '../lib/game';
import { proposeMissionPolicies, REAL_TICK_SECONDS, replayTrace, scoreReplays } from '../lib/learningOptimizer';
import { COORDINATED_RULES_VERSION, OVERHEAD_RULES_VERSION, RULES_VERSION, type Layout } from '../lib/learningTypes';
import { applyLearningLayout } from '../lib/learningWorld';
import { DEFAULT_FLIGHT_POLICY, FLIGHT_ALGORITHM, LEGACY_FLIGHT_ALGORITHM, normalizeFlightPolicy, planPlaneShadow, validFlightPolicy } from '../lib/surveillance';

const world = JSON.parse(readFileSync(path.resolve(__dirname, '../../public/assets/world.json'), 'utf8')) as WorldData;
const layout: Layout = { version: 0, towers: world.towers.map(({ id, x, z }) => ({ id, x, z })), algorithm: FLIGHT_ALGORITHM,
  flightPolicy: { ...DEFAULT_FLIGHT_POLICY }, createdAt: '2026-09-20T00:00:00Z', reason: 'Test baseline' };
const tick = (game: GameState, terrain: WorldData) => stepGame(game, terrain, { throttle: 0, steer: 0 }, REAL_TICK_SECONDS);

test('training proposes reproducible bounded flight-only, tower-only and joint policies that change actual routes', () => {
  const candidates = proposeMissionPolicies(world, layout, 3);
  assert.equal(candidates.length, 12);
  assert.deepEqual(candidates, proposeMissionPolicies(world, layout, 3));
  assert.notDeepEqual(candidates, proposeMissionPolicies(world, layout, 4));
  assert.ok(candidates.every((candidate) => candidate.algorithm === FLIGHT_ALGORITHM && validFlightPolicy(candidate.flightPolicy)));
  assert.ok(candidates.slice(0, 4).every((candidate) => JSON.stringify(candidate.towers) === JSON.stringify(layout.towers)));
  assert.ok(candidates.slice(0, 4).every((candidate) => JSON.stringify(candidate.flightPolicy) !== JSON.stringify(layout.flightPolicy)));
  assert.deepEqual(candidates[4].flightPolicy, layout.flightPolicy);
  const baseline = createGame(applyLearningLayout(world, layout));
  const changed = createGame(applyLearningLayout(world, candidates[0]));
  assert.notDeepEqual(changed.surveillance.routes, baseline.surveillance.routes);
  startGame(baseline); startGame(changed);
  for (let step = 0; step < 240; step++) { tick(baseline, world); tick(changed, world); }
  assert.notDeepEqual(changed.drones.map(({ x, z }) => ({ x, z })), baseline.drones.map(({ x, z }) => ({ x, z })));
  assert.equal(baseline.detected, false); assert.equal(changed.detected, false);
  assert.equal(GAME_RULES.overheadSpottingRadius, 65); assert.equal(GAME_RULES.tagSeconds, 2); assert.equal(GAME_RULES.droneDetectedSpeed, 96);
});

test('policy validation rejects unbounded saved policies and each attempt owns a detached flight policy', () => {
  assert.deepEqual(normalizeFlightPolicy({ laneSpacingM: Infinity, routePhase: -1, lookaheadS: 999 }), { ...DEFAULT_FLIGHT_POLICY, routePhase: 0, lookaheadS: 40 });
  assert.throws(() => applyLearningLayout(world, { ...layout, flightPolicy: { ...DEFAULT_FLIGHT_POLICY, routePhase: 9 } }), /Invalid flight policy/);
  const pinned = applyLearningLayout(world, layout), game = createGame(pinned);
  const expected = structuredClone(game.flightPolicy), expectedRoutes = structuredClone(game.surveillance.routes);
  pinned.flightPolicy!.routePhase = 0.8;
  startGame(game);
  assert.deepEqual(game.flightPolicy, expected); assert.deepEqual(game.surveillance.routes, expectedRoutes);
});

test('camera handoff gives a tracking quad and separate forward support; lost contact ignores hidden motion', () => {
  const ocean: WorldData = { size: 21, half: 3250, heights: Array(441).fill(-20), waterLevel: 1, towers: [], spawn: { x: 0, z: 0, heading: 0 }, source: 'test' };
  const game = createGame(ocean); startGame(game); game.simulationTime = 7; game.time = 3.5;
  game.drones.forEach((drone, index) => Object.assign(drone, { x: -2500 + index * 200, z: -2500 }));
  Object.assign(game.plane, { x: 0, z: 30 });
  tick(game, ocean);
  assert.equal(game.plane.detecting, true); assert.equal(game.plane.role, 'track', 'The plane keeps observing until a quad sees the ship itself');
  assert.equal(game.drones.filter((drone) => drone.role === 'track').length, 1);
  assert.equal(game.drones.filter((drone) => drone.role === 'forward-support').length, 1);
  const follower = game.drones.find((drone) => drone.role === 'track')!;
  Object.assign(follower, { x: 0, z: 30 });
  tick(game, ocean);
  assert.equal(follower.detecting, true); assert.equal(game.plane.role, 'forward-support');
  assert.notDeepEqual(game.plane.target, follower.target);
  const a = structuredClone(game), b = structuredClone(game);
  Object.assign(a.boat, { x: 2000, z: 2000, velocityX: 0, velocityZ: 0, speed: 0 });
  Object.assign(b.boat, { x: -2000, z: 2000, velocityX: 60, velocityZ: 0, speed: 60 });
  for (let step = 0; step < 120; step++) { tick(a, ocean); tick(b, ocean); }
  assert.equal(a.detected, false); assert.equal(b.detected, false);
  assert.deepEqual(a.surveillance.observation, b.surveillance.observation);
  const flight = (state: GameState) => [...state.drones, state.plane].map(({ x, z, heading, target, role }) => ({ x, z, heading, target, role }));
  assert.deepEqual(flight(a), flight(b), 'Different unobserved positions and speeds cannot affect reacquisition');
  assert.ok([...a.drones, a.plane].every((aircraft) => aircraft.role === 'reacquire'));
  assert.notDeepEqual(a.drones[0].target, a.drones[1].target);
});

test('v2 overhead recordings keep their old route and current replays apply the full pinned flight policy', async () => {
  const controls = [{ tick: 0, throttle: 0, steer: 0 }], trace = { seed: 19, ticks: 1200, controls };
  const old = createGame(world, 19, { aircraftSpotting: 'overhead', algorithm: LEGACY_FLIGHT_ALGORITHM }); startGame(old);
  for (let step = 0; step < trace.ticks; step++) tick(old, world);
  const previous = await replayTrace(world, { ...layout, flightPolicy: { ...DEFAULT_FLIGHT_POLICY, routePhase: 0.8 } }, { ...trace, rulesVersion: OVERHEAD_RULES_VERSION });
  assert.equal(previous.frame.plane.x, old.plane.x); assert.equal(previous.frame.plane.z, old.plane.z);
  assert.equal(previous.frame.algorithm, undefined); assert.equal(previous.frame.plane.role, undefined);
  const custom = { ...layout, flightPolicy: { ...DEFAULT_FLIGHT_POLICY, routePhase: 0.5 } };
  const current = await replayTrace(world, custom, { ...trace, rulesVersion: RULES_VERSION });
  const again = await replayTrace(world, custom, { ...trace, rulesVersion: RULES_VERSION });
  const baseline = await replayTrace(world, layout, { ...trace, rulesVersion: RULES_VERSION });
  assert.deepEqual(current, again); assert.notDeepEqual(current.frame.drones, baseline.frame.drones);
  assert.equal(current.frame.algorithm, FLIGHT_ALGORITHM);
  const metric = scoreReplays([current]).surveillance!;
  assert.ok(metric.meanAircraftDistanceM > 0 && Number.isFinite(metric.meanAircraftDistanceM));
  assert.ok(metric.visualContactFraction >= 0 && metric.visualContactFraction <= 1);
  assert.ok(metric.planeVisualContactFraction! >= 0 && metric.planeVisualContactFraction! <= 1);
});

test('v3 recordings retain their exact pre-shadowing frame, path and result hashes', async () => {
  for (const [throttle, expected] of [[0, 'e72951368f029a3aa78f5fdaff0d6b0ed1462ea55a370ae237526a38b8a15560'],
    [1, 'b2e320d91454f70001cb22f5376b5ed18a38adcc43fd19a970b639285e21eb06']] as const) {
    const frames: unknown[] = [];
    const result = await replayTrace(world, world.towers, { seed: 20903, ticks: 7200,
      controls: [{ tick: 0, throttle, steer: 0 }], rulesVersion: COORDINATED_RULES_VERSION }, true, (frame) => frames.push(frame));
    assert.equal(createHash('sha256').update(JSON.stringify({ result, frames })).digest('hex'), expected);
    assert.equal(result.surveillance?.planeVisualContactSeconds, undefined, 'Archived result schema remains unchanged.');
  }
});

test('moving-boat surveillance plans return passes within unchanged speed and turning limits', () => {
  const exercise = (shadow: boolean) => {
    const plane = { x: 0, z: -500, heading: 0 };
    let plan: ReturnType<typeof planPlaneShadow> | undefined, visibleSeconds = 0, gap = 0, longestGap = 0, hasSeen = false, passes = 0, wasVisible = false;
    const dt = 0.05;
    for (let at = 0; at < 120; at += dt) {
      // This fixture supplies fresh camera/tower estimates of a straight course.
      const observation = { x: 0, z: at * 60, vx: 0, vz: 60, at };
      const before = { ...plane };
      if (shadow) {
        if (!plan || at - plan.at >= 1) plan = planPlaneShadow(plane, observation, DEFAULT_FLIGHT_POLICY, at,
          { speed: GAME_RULES.planeSpeed, turnRate: 0.43, viewRadius: GAME_RULES.overheadSpottingRadius, minX: -20000, maxX: 20000, minZ: -20000, maxZ: 20000 });
        plane.heading += plan.turnRate * dt;
      } else {
        const desired = Math.atan2(observation.x - plane.x, observation.z - plane.z);
        const difference = Math.atan2(Math.sin(desired - plane.heading), Math.cos(desired - plane.heading));
        plane.heading += Math.max(-0.43 * dt, Math.min(0.43 * dt, difference));
      }
      plane.x += Math.sin(plane.heading) * GAME_RULES.planeSpeed * dt;
      plane.z += Math.cos(plane.heading) * GAME_RULES.planeSpeed * dt;
      assert.ok(Math.abs(plane.heading - before.heading) <= 0.43 * dt + 1e-12);
      assert.ok(Math.abs(Math.hypot(plane.x - before.x, plane.z - before.z) / dt - GAME_RULES.planeSpeed) < 1e-8);
      const visible = Math.hypot(plane.x - observation.x, plane.z - observation.z) < GAME_RULES.overheadSpottingRadius;
      if (visible) { visibleSeconds += dt; hasSeen = true; gap = 0; if (!wasVisible) passes++; }
      else if (hasSeen) { gap += dt; longestGap = Math.max(longestGap, gap); }
      wasVisible = visible;
    }
    return { visibleSeconds, longestGap, passes };
  };
  const baseline = exercise(false), improved = exercise(true);
  assert.ok(improved.visibleSeconds > baseline.visibleSeconds * 1.5);
  assert.ok(improved.longestGap < baseline.longestGap * 0.75);
  assert.ok(improved.passes >= 5, 'Repeated useful passes must replace a fly-by or permanently out-of-view orbit.');
});
