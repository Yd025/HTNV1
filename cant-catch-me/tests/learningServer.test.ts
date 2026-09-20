import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createGame, startGame, stepGame, type WorldData } from '../lib/game';
import { gameFrame, MAX_TICKS, proposePositions, REAL_TICK_SECONDS } from '../lib/learningOptimizer';
import { LearningService, validateFinish } from '../lib/learningServer';
import { createSentryTransport } from '../lib/learningSentry';
import { RULES_VERSION, WORLD_VERSION, type FinishRequest, type StartResponse } from '../lib/learningTypes';

const world = JSON.parse(readFileSync(path.resolve(__dirname, '../../public/assets/world.json'), 'utf8')) as WorldData;
const start = { seed: 0x51a7, rulesVersion: RULES_VERSION, worldVersion: WORLD_VERSION };
const offline = { autoTrain: false, autoSync: false, sentryTransport: createSentryTransport({}) };
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cant-catch-learning-'));
  return { directory, service: new LearningService({ directory, world, ...offline }), remove: () => rm(directory, { recursive: true, force: true }) };
}

test('cold start is empty and consistent; attempts persist with immutable layout and idempotent finish after restart', async () => {
  const { directory, service, remove } = await fixture();
  try {
    const empty = await service.dashboard();
    assert.equal(empty.totals.attempts, 0); assert.equal(empty.layout.version, 0); assert.equal(empty.learning.status, 'collecting');
    assert.equal(empty.world.heights.length, empty.world.size ** 2); assert.ok(JSON.stringify(empty).length < 2_000_000);
    const session = await service.start(start), pinned = structuredClone(session.layout);
    session.layout.towers[0].x += 100;
    session.layout.flightPolicy!.routePhase = 0.8;
    assert.deepEqual((await service.dashboard()).layout, pinned);
    const game = createGame(world, start.seed); startGame(game);
    let ticks = 0;
    while (game.status === 'playing' && ticks < MAX_TICKS) { stepGame(game, world, { throttle: 0, steer: 0 }, REAL_TICK_SECONDS); ticks++; }
    const payload: FinishRequest = { attemptId: session.attemptId, token: session.token, ticks, controls: [{ tick: 0, throttle: 0, steer: 0 }], outcome: 'caught' };
    const first = await service.finish(payload), duplicate = await service.finish(payload);
    assert.deepEqual(first, duplicate); assert.equal(first.verified, true); assert.equal(first.seconds, game.time);
    const restarted = new LearningService({ directory, world, ...offline });
    assert.deepEqual(await restarted.finish(payload), first);
    const dashboard = await restarted.dashboard();
    assert.equal(dashboard.totals.attempts, 1); assert.equal(dashboard.totals.captured, 1); assert.equal(dashboard.totals.abandoned, 0);
    assert.equal(dashboard.live?.frame.status, 'caught'); assert.ok(dashboard.live!.path.length > 0);
    const serialized = JSON.stringify(dashboard);
    assert.ok(!serialized.includes(session.token) && !serialized.includes('tokenHash') && !serialized.includes('controls'));
    await assert.rejects(() => restarted.finish({ ...payload, outcome: 'escaped' }), /different final result/);
    await assert.rejects(() => restarted.finish({ ...payload, token: '0'.repeat(64) }), /credentials/);
  } finally { await remove(); }
});

test('live frames ignore reordered packets, preserve terminal replay and reject invalid or unpinned data', async () => {
  const { service, remove } = await fixture();
  try {
    const session = await service.start(start);
    const game = createGame(world, start.seed); startGame(game);
    const frame = gameFrame(game);
    const payload = { attemptId: session.attemptId, token: session.token, seq: 2, frame };
    assert.equal((await service.live(payload)).accepted, true);
    assert.equal((await service.live({ ...payload, seq: 1 })).accepted, false);
    assert.equal((await service.live({ ...payload, seq: 2 })).accepted, false);
    const invalid = structuredClone(frame); invalid.towers[0].x += 1;
    await assert.rejects(() => service.live({ ...payload, seq: 3, frame: invalid }), /pinned/);
    await assert.rejects(() => service.live({ ...payload, seq: 3, frame: { ...frame, time: Infinity } }), /game time/);
    await service.finish({ attemptId: session.attemptId, token: session.token, ticks: 0, controls: [], outcome: 'abandoned' });
    assert.equal((await service.live({ ...payload, seq: 99 })).accepted, false);
    assert.equal((await service.dashboard()).live?.frame.status, 'abandoned');
    assert.equal((await service.dashboard()).learning.status, 'collecting');
  } finally { await remove(); }
});

test('invalid outcomes never become training data and validation caps bounded input', async () => {
  const { directory, service, remove } = await fixture();
  try {
    const session = await service.start(start);
    const payload: FinishRequest = { attemptId: session.attemptId, token: session.token, ticks: 1, controls: [{ tick: 0, throttle: 0, steer: 0 }], outcome: 'caught' };
    await assert.rejects(() => service.finish(payload), /does not match/);
    assert.equal((await service.dashboard()).totals.attempts, 0);
    assert.throws(() => validateFinish({ ...payload, ticks: MAX_TICKS + 1 }), /300 active/);
    assert.throws(() => validateFinish({ ...payload, controls: [{ tick: 0, throttle: NaN, steer: 0 }] }), /finite/);
    assert.throws(() => validateFinish({ ...payload, ticks: 3, controls: [{ tick: 0, throttle: 0, steer: 0 }, { tick: 0, throttle: 1, steer: 0 }] }), /increase/);
    assert.throws(() => validateFinish({ ...payload, controls: [{ tick: 1, throttle: 0, steer: 0 }] }), /tick/);
    await assert.rejects(() => service.start({ ...start, rulesVersion: 'old' }), /Reload/);
    await assert.rejects(() => service.start({ ...start, seed: -1 }), /uint32/);
    const restarted = new LearningService({ directory, world, ...offline });
    const abandoned = await restarted.finish({ ...payload, outcome: 'abandoned' });
    assert.equal(abandoned.verified, false); assert.equal((await restarted.dashboard()).totals.abandoned, 1);
  } finally { await remove(); }
});

test('expired sessions accept delayed verified recordings without duplicating history and then become immutable', async () => {
  const { directory, service, remove } = await fixture();
  try {
    const session = await service.start(start);
    const filename = path.join(directory, 'attempts', `${session.attemptId}.json`);
    const archived = JSON.parse(await readFile(filename, 'utf8'));
    archived.startedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    await writeFile(filename, JSON.stringify(archived));
    const restarted = new LearningService({ directory, world, ...offline });
    await restarted.start(start); // Frees the old active slot and records provisional abandonment.
    const expired = await restarted.dashboard();
    assert.equal(expired.totals.attempts, 1); assert.equal(expired.totals.abandoned, 1);
    assert.equal(expired.attempts[0].verified, false);
    assert.equal(expired.attempts[0].replayAvailable, false);
    await assert.rejects(() => restarted.replay(session.attemptId), { status: 404 });

    const game = createGame(world, start.seed); startGame(game);
    let ticks = 0;
    while (game.status === 'playing' && ticks < MAX_TICKS) { stepGame(game, world, { throttle: 0, steer: 0 }, REAL_TICK_SECONDS); ticks++; }
    const payload: FinishRequest = { attemptId: session.attemptId, token: session.token, ticks, controls: [{ tick: 0, throttle: 0, steer: 0 }], outcome: 'caught' };
    const [first, duplicate] = await Promise.all([restarted.finish(payload), restarted.finish(payload)]);
    assert.deepEqual(first, duplicate); assert.equal(first.verified, true); assert.equal(first.layoutVersion, session.layout.version);
    const completed = await restarted.dashboard();
    assert.equal(completed.totals.attempts, 1); assert.equal(completed.totals.captured, 1); assert.equal(completed.totals.abandoned, 0);
    assert.match(completed.learning.message, /0 of 8 Sentry-imported/);
    assert.equal(completed.sentry.pending, 1);
    assert.equal(completed.attempts[0].id, session.attemptId);

    const again = new LearningService({ directory, world, ...offline });
    assert.deepEqual(await again.finish(payload), first);
    await assert.rejects(() => again.finish({ ...payload, ticks: 0, controls: [], outcome: 'abandoned' }), /different final result/);
    assert.equal((await again.dashboard()).totals.attempts, 1);
  } finally { await remove(); }
});

test('saved playback reconstructs the original layout after later learning and never changes player history', async () => {
  const { directory, service, remove } = await fixture();
  try {
    const session = await service.start(start);
    const game = createGame(world, start.seed); startGame(game);
    let ticks = 0;
    while (game.status === 'playing' && ticks < MAX_TICKS) { stepGame(game, world, { throttle: 0, steer: 0 }, REAL_TICK_SECONDS); ticks++; }
    const payload: FinishRequest = { attemptId: session.attemptId, token: session.token, ticks, controls: [{ tick: 0, throttle: 0, steer: 0 }], outcome: 'caught' };
    const summary = await service.finish(payload);
    assert.equal(summary.replayAvailable, true);
    const statePath = path.join(directory, 'state.json'), attemptPath = path.join(directory, 'attempts', `${session.attemptId}.json`);
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    state.layout = { ...state.layout, version: 7, towers: proposePositions(world, session.layout.towers, 1)[0],
      flightPolicy: { ...state.layout.flightPolicy, routePhase: 0.7, laneSpacingM: 600 } };
    await writeFile(statePath, JSON.stringify(state));
    // Playback availability can be derived without changing the original file.
    const oldAttempt = JSON.parse(await readFile(attemptPath, 'utf8'));
    delete oldAttempt.summary.replayAvailable;
    await writeFile(attemptPath, JSON.stringify(oldAttempt));
    const before = [await readFile(statePath, 'utf8'), await readFile(attemptPath, 'utf8')];
    const restarted = new LearningService({ directory, world, ...offline });
    assert.equal((await restarted.dashboard()).layout.version, 7);
    const [replay, duplicate] = await Promise.all([restarted.replay(session.attemptId), restarted.replay(session.attemptId)]);
    assert.deepEqual(duplicate, replay); assert.deepEqual(replay.layout, session.layout);
    assert.deepEqual(replay.attempt, summary);
    assert.equal(replay.frames[0].time, 0); assert.equal(replay.frames[0].status, 'playing');
    assert.deepEqual(replay.frames[0].boat, world.spawn);
    assert.equal(replay.frames[replay.frames.length - 1].time, game.time);
    assert.deepEqual(replay.frames[replay.frames.length - 1], gameFrame(game));
    assert.ok(replay.frames.length <= 3002);
    for (let i = 1; i < replay.frames.length; i++) {
      assert.ok(replay.frames[i].time > replay.frames[i - 1].time);
      assert.ok(replay.frames[i].time - replay.frames[i - 1].time <= 0.100001);
    }
    const serialized = JSON.stringify(replay);
    for (const secret of [session.token, 'tokenHash', 'controls', 'finishDigest']) assert.ok(!serialized.includes(secret));
    replay.frames[0].boat.x = 9000; replay.layout.towers[0].x = 9000;
    assert.deepEqual(await restarted.replay(session.attemptId), duplicate, 'Playback callers cannot mutate the cached original.');
    assert.deepEqual(await restarted.finish(payload), summary, 'Playback leaves finish idempotency intact.');
    const after = await restarted.dashboard();
    assert.equal(after.totals.attempts, 1); assert.equal(after.layout.version, 7); assert.deepEqual(after.rounds, []);
    assert.equal(after.live?.frame.status, 'caught'); assert.equal(after.live?.layoutVersion, 0);
    assert.deepEqual([await readFile(statePath, 'utf8'), await readFile(attemptPath, 'utf8')], before);
  } finally { await remove(); }
});

test('recorded abandonments replay, while missing, active, incompatible and incomplete attempts return 404', async () => {
  const { directory, service, remove } = await fixture();
  try {
    for (const invalid of [undefined, ['not-a-uuid'], '../state', '00000000-0000-4000-8000-000000000000']) await assert.rejects(() => service.replay(invalid), { status: 404 });
    const session = await service.start(start);
    await assert.rejects(() => service.replay(session.attemptId), { status: 404 });
    await service.finish({ attemptId: session.attemptId, token: session.token, ticks: 120, controls: [{ tick: 0, throttle: 1, steer: 0 }], outcome: 'abandoned' });
    const replay = await service.replay(session.attemptId);
    assert.equal(replay.attempt.verified, false); assert.equal(replay.attempt.replayAvailable, true);
    assert.equal(replay.frames.length, 11); assert.equal(replay.frames[10].status, 'abandoned');
    assert.ok(Math.abs(replay.frames[10].time - 1) < 1e-8);

    const filename = path.join(directory, 'attempts', `${session.attemptId}.json`);
    const saved = JSON.parse(await readFile(filename, 'utf8'));
    await writeFile(filename, JSON.stringify({ ...saved, worldVersion: 'incompatible' }));
    const incompatible = new LearningService({ directory, world, ...offline });
    assert.equal((await incompatible.dashboard()).attempts[0].replayAvailable, false);
    await assert.rejects(() => incompatible.replay(session.attemptId), { status: 404 });
    await writeFile(filename, JSON.stringify({ ...saved, controls: undefined }));
    const incomplete = new LearningService({ directory, world, ...offline });
    assert.equal((await incomplete.dashboard()).attempts[0].replayAvailable, false);
    await assert.rejects(() => incomplete.replay(session.attemptId), { status: 404 });

    const zero = await service.start(start);
    await service.finish({ attemptId: zero.attemptId, token: zero.token, ticks: 0, controls: [], outcome: 'abandoned' });
    const zeroReplay = await service.replay(zero.attemptId);
    assert.equal(zeroReplay.frames.length, 1); assert.equal(zeroReplay.frames[0].time, 0); assert.equal(zeroReplay.frames[0].status, 'abandoned');
  } finally { await remove(); }
});

test('playback deduplicates simultaneous requests and bounds uncached reconstruction work', async () => {
  const { service, remove } = await fixture();
  try {
    const sessions: StartResponse[] = [];
    for (let index = 0; index < 3; index++) {
      const session = await service.start({ ...start, seed: index });
      await service.finish({ attemptId: session.attemptId, token: session.token, ticks: 600, controls: [{ tick: 0, throttle: 1, steer: 0 }], outcome: 'abandoned' });
      sessions.push(session);
    }
    const first = service.replay(sessions[0].attemptId), same = service.replay(sessions[0].attemptId), second = service.replay(sessions[1].attemptId);
    await assert.rejects(() => service.replay(sessions[2].attemptId), { status: 429 });
    const [one, duplicate] = await Promise.all([first, same, second]);
    assert.deepEqual(one, duplicate);
    assert.equal((await service.replay(sessions[2].attemptId)).frames.length, 51);
    assert.equal((await service.dashboard()).totals.attempts, 3);
  } finally { await remove(); }
});
