import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createGame, startGame, stepGame, togglePause, type WorldData } from '../lib/game';
import { applyTowerLayout } from '../lib/learningWorld';
import { MAX_TICKS, promotionDecision, proposePositions, REAL_TICK_SECONDS, replayTrace, scoreReplays, validPositions, type ReplayResult, type ReplayTrace } from '../lib/learningOptimizer';
import type { ControlSample } from '../lib/learningTypes';

const world = JSON.parse(readFileSync(path.resolve(__dirname, '../../public/assets/world.json'), 'utf8')) as WorldData;
const towers = world.towers.map(({ id, x, z }) => ({ id, x, z }));

test('server replay exactly reproduces game capture, compressed inputs and active ticks around a pause', async () => {
  const game = createGame(world, 0x51a7); startGame(game);
  const controls: ControlSample[] = [{ tick: 0, throttle: 0, steer: 0 }];
  let ticks = 0, firstDetection: number | null = null;
  while (game.status === 'playing' && ticks < MAX_TICKS) {
    if (ticks === 120) {
      togglePause(game); const before = JSON.stringify(game);
      stepGame(game, world, { throttle: 1, steer: 1 }, 0.1);
      assert.equal(JSON.stringify(game), before); togglePause(game);
    }
    stepGame(game, world, controls[0], REAL_TICK_SECONDS); ticks++;
    if (game.detected && firstDetection === null) firstDetection = game.time;
  }
  assert.equal(game.status, 'caught');
  const replay = await replayTrace(world, towers, { seed: 0x51a7, ticks, controls }, true);
  assert.equal(replay.outcome, 'caught'); assert.equal(replay.ticks, ticks); assert.equal(replay.seconds, game.time);
  assert.equal(replay.firstDetectionSeconds, firstDetection);
  assert.deepEqual(replay.frame.boat, { x: game.boat.x, z: game.boat.z, heading: game.boat.heading });
  assert.deepEqual(replay.frame.drones.map(({ x, z, heading, tagProgress }) => ({ x, z, heading, tagProgress })), game.drones.map(({ x, z, heading, tagProgress }) => ({ x, z, heading, tagProgress })));
});

test('local and global position proposals preserve sensors, launches, pickups and legal opening land', () => {
  const proposals = proposePositions(world, towers, 1);
  assert.equal(proposals.length, 12);
  assert.deepEqual(proposePositions(world, towers, 1), proposals, 'Geometry and round seed reproduce all candidates.');
  assert.notDeepEqual(proposePositions(world, towers, 2), proposals);
  assert.ok(proposals.slice(0, 4).every((proposal) => proposal.every((tower, i) => Math.hypot(tower.x - towers[i].x, tower.z - towers[i].z) <= 350)));
  assert.ok(proposals.slice(4).some((proposal) => proposal.some((tower, i) => Math.hypot(tower.x - towers[i].x, tower.z - towers[i].z) > 350)), 'Global candidates can cross a local objective plateau.');
  const original = createGame(world, 19);
  for (const proposal of proposals) {
    assert.equal(validPositions(world, towers, proposal), true);
    const changed = applyTowerLayout(world, proposal), game = createGame(changed, 19);
    changed.towers.forEach((tower, i) => {
      assert.equal(tower.id, world.towers[i].id); assert.equal(tower.range, world.towers[i].range); assert.equal(tower.heading, world.towers[i].heading);
      assert.ok(Math.abs(tower.x) < world.half && Math.abs(tower.z) < world.half);
      assert.ok(Math.hypot(tower.x - world.spawn.x, tower.z - world.spawn.z) >= tower.range + 250);
    });
    assert.deepEqual(game.drones, original.drones); assert.deepEqual(game.plane, original.plane); assert.deepEqual(game.pickups, original.pickups);
  }
  assert.equal(validPositions(world, towers, [{ ...towers[0], x: Infinity }, ...towers.slice(1)]), false);
  assert.equal(validPositions(world, towers, [{ ...towers[0], x: world.half }, ...towers.slice(1)]), false);
  assert.equal(validPositions(world, towers, [{ ...towers[0], x: world.spawn.x, z: world.spawn.z }, ...towers.slice(1)]), false);
  assert.deepEqual(world.towers.map(({ id, x, z }) => ({ id, x, z })), towers);
});

test('uncaught incomplete counterfactuals are censored and penalized, not invented escapes', async () => {
  const result = await replayTrace(world, towers, { seed: 1, ticks: 120, controls: [{ tick: 0, throttle: 1, steer: 0 }] });
  assert.equal(result.outcome, 'censored');
  const { surveillance, ...captureScore } = scoreReplays([result]);
  assert.deepEqual(captureScore, { attempts: 1, captures: 0, escapes: 0, censored: 1, captureRate: 0, meanCaptureSeconds: null, cappedMeanSeconds: 300 });
  assert.equal(surveillance?.detectionRate, 0); assert.equal(surveillance?.visualContactFraction, 0);
  assert.equal(surveillance?.longestContactGapSeconds, result.seconds, 'A never-observed replay cannot report zero contact loss');
  assert.ok(surveillance!.meanAircraftDistanceM > 0);
});

function results(outcomes: ('caught' | 'escaped' | 'censored')[], captureSeconds = 25): ReplayResult[] {
  return outcomes.map((outcome) => ({ outcome, seconds: outcome === 'caught' ? captureSeconds : 40, ticks: 120, firstDetectionSeconds: 5, path: [], frame: {} as ReplayResult['frame'] }));
}
function originals(rows: ReplayResult[]): ReplayTrace[] {
  return rows.map((row) => ({ outcome: row.outcome as 'caught' | 'escaped', seconds: row.seconds, ticks: row.ticks, seed: 1, controls: [{ tick: 0, throttle: 1, steer: 0 }] }));
}

test('promotion requires genuine faster holdout captures while retaining escape and fairness limits', () => {
  const baseline = results(['caught', 'escaped', 'caught', 'escaped', 'caught', 'escaped', 'caught', 'escaped']);
  const candidate = results(['caught', 'escaped', 'caught', 'escaped', 'caught', 'escaped', 'caught', 'escaped'], 20);
  const original = originals(baseline);
  assert.equal(promotionDecision(original, baseline, candidate, 4).promote, true);
  assert.equal(promotionDecision(original, baseline, baseline, 4).promote, false);
  const tooFast = structuredClone(candidate); tooFast[0].seconds = 11;
  assert.match(promotionDecision(original, baseline, tooFast, 4).reason, /12-second/);
  const existingEarly = structuredClone(baseline), unchangedEarly = structuredClone(candidate);
  existingEarly[0].seconds = 11; unchangedEarly[0].seconds = 11;
  assert.equal(promotionDecision(originals(existingEarly), existingEarly, unchangedEarly, 4).promote, true, 'Tower movement must not be blamed for an unchanged early aircraft catch.');
  unchangedEarly[0].seconds = 10;
  assert.equal(promotionDecision(originals(existingEarly), existingEarly, unchangedEarly, 4).promote, false);
  const tooHard = results(Array(8).fill('caught'), 20);
  assert.match(promotionDecision(original, baseline, tooHard, 4).reason, /80%/);
  const lostEscape = structuredClone(candidate); lostEscape[5].outcome = 'censored'; lostEscape[7].outcome = 'censored';
  assert.match(promotionDecision(original, baseline, lostEscape, 4).reason, /successful player escape/);
  const fewerCaptures = structuredClone(candidate); fewerCaptures[0].outcome = 'censored';
  assert.match(promotionDecision(original, baseline, fewerCaptures, 4).reason, /Capture rate fell/);
  assert.equal(promotionDecision(original, baseline, candidate, 5).promote, false);
});
