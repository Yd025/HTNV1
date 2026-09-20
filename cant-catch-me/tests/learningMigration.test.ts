import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createGame, startGame, stepGame, type WorldData } from '../lib/game';
import { gameFrame, MAX_TICKS, REAL_TICK_SECONDS, replayTrace, scoreReplays } from '../lib/learningOptimizer';
import { LearningService } from '../lib/learningServer';
import { importSentryRecord, sentryEventId, sentryRecord, type SentryTransport } from '../lib/learningSentry';
import { LEGACY_RULES_VERSION, OVERHEAD_RULES_VERSION, COORDINATED_RULES_VERSION, RULES_VERSION, WORLD_VERSION, type AttemptSummary, type Layout, type LiveFrame } from '../lib/learningTypes';
import { DEFAULT_FLIGHT_POLICY, FLIGHT_ALGORITHM } from '../lib/surveillance';

const world = JSON.parse(readFileSync(path.resolve(__dirname, '../../public/assets/world.json'), 'utf8')) as WorldData;
const seed = 0x51a7, controls = [{ tick: 0, throttle: 0, steer: 0 }];
const legacy = replayTrace(world, world.towers, { seed, ticks: MAX_TICKS, controls, rulesVersion: LEGACY_RULES_VERSION }, true);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

test('rules migration preserves legacy recordings, imported hashes, deployed towers and round history while resetting the model cohort', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cant-catch-rules-'));
  const remote = new Map<string, string>(); let uploads = 0, downloads = 0;
  const sentryTransport: SentryTransport = {
    configured: true, uploadConfigured: true, destination: 'test-project', configurationMessage: 'Test transport', replayUrl: () => undefined,
    async publish(record, eventId) { uploads++; remote.set(eventId, JSON.stringify(record)); },
    async download(eventId) { downloads++; return remote.get(eventId) ?? null; },
  };
  const options = { directory, world, autoSync: false, sentryTransport };
  try {
    await mkdir(path.join(directory, 'attempts'));
    const result = await legacy;
    assert.equal(result.outcome, 'caught');
    const layout: Layout = { version: 7, towers: world.towers.map(({ id, x, z }) => ({ id, x, z })), createdAt: '2026-09-20T00:00:00.000Z', reason: 'Previously deployed sites' };
    const round = { id: 1, at: layout.createdAt, attempts: 8, candidateCount: 13, promoted: false, previousVersion: 7, selectedVersion: 7,
      reason: 'Legacy evaluation retained towers.', baseline: scoreReplays([result]), candidate: scoreReplays([result]), towers: layout.towers };
    await writeFile(path.join(directory, 'state.json'), JSON.stringify({ schema: 1, rulesVersion: LEGACY_RULES_VERSION, worldVersion: WORLD_VERSION,
      layout, rounds: [round], lastTrainedCount: 8, trainingSource: 'sentry-v1', sentryDestination: sentryTransport.destination }));
    const originals: { id: string; text: string; token: string }[] = [];
    for (let i = 0; i < 8; i++) {
      const id = randomUUID(), token = String(i).repeat(64), eventId = sentryEventId(id);
      const summary: AttemptSummary = { id, layoutVersion: layout.version, endedAt: layout.createdAt, outcome: 'caught', seconds: result.seconds,
        firstDetectionSeconds: result.firstDetectionSeconds, verified: true, replayAvailable: true, sentry: { state: 'imported', eventId } };
      const imported = sentryRecord({ id, seed, ticks: result.ticks, controls, layout, summary, rulesVersion: LEGACY_RULES_VERSION });
      const saved = { id, tokenHash: hash(token), seed, startedAt: layout.createdAt, layout, summary, result, controls, ticks: result.ticks,
        finishDigest: hash(JSON.stringify({ ticks: result.ticks, controls, outcome: 'caught' })),
        ...(i % 2 ? { rulesVersion: LEGACY_RULES_VERSION, worldVersion: WORLD_VERSION } : {}),
        sentry: { eventId, destination: sentryTransport.destination, retries: 0, nextRetryAt: 0, uploaded: true, imported } };
      const text = JSON.stringify(saved); originals.push({ id, text, token });
      await writeFile(path.join(directory, 'attempts', `${id}.json`), text);
    }
    const service = new LearningService(options);
    const dashboard = await service.dashboard();
    assert.equal(dashboard.rulesVersion, RULES_VERSION); assert.deepEqual(dashboard.layout, { ...layout, algorithm: FLIGHT_ALGORITHM, flightPolicy: DEFAULT_FLIGHT_POLICY });
    assert.equal(dashboard.totals.attempts, 8); assert.equal(dashboard.sentry.imported, 8);
    assert.equal(dashboard.learning.completed, 0); assert.equal(dashboard.learning.status, 'collecting');
    assert.deepEqual(dashboard.rounds, [{ ...round, rulesVersion: LEGACY_RULES_VERSION }]);
    assert.ok(dashboard.attempts.every((item) => item.rulesVersion === LEGACY_RULES_VERSION && item.replayAvailable));
    const migrated = JSON.parse(await readFile(path.join(directory, 'state.json'), 'utf8'));
    assert.equal(migrated.rulesVersion, RULES_VERSION); assert.equal(migrated.lastTrainedCount, 0);
    const expectedFrames: LiveFrame[] = [];
    await replayTrace(world, layout.towers, { seed, ticks: result.ticks, controls, rulesVersion: LEGACY_RULES_VERSION }, false, (frame) => expectedFrames.push(frame));
    for (const original of originals) {
      const replay = await service.replay(original.id);
      assert.deepEqual(replay.frames, expectedFrames); assert.deepEqual(replay.frames.at(-1), result.frame);
      assert.deepEqual(replay.layout, layout); assert.equal(replay.attempt.rulesVersion, LEGACY_RULES_VERSION);
      assert.equal(await readFile(path.join(directory, 'attempts', `${original.id}.json`), 'utf8'), original.text, 'Migration must not rewrite old recordings or imported attachment hashes.');
    }
    await service.syncSentry(); await service.waitForTraining();
    assert.equal(uploads, 0); assert.equal(downloads, 0); assert.equal((await service.dashboard()).rounds.length, 1, 'Eight imported legacy runs must not train new mechanics.');
    await assert.rejects(() => service.start({ seed, rulesVersion: LEGACY_RULES_VERSION, worldVersion: WORLD_VERSION }), { status: 409 });
    const first = originals[0];
    assert.equal((await service.finish({ attemptId: first.id, token: first.token, ticks: result.ticks, controls, outcome: 'caught' })).rulesVersion, LEGACY_RULES_VERSION);

    const restarted = new LearningService(options);
    assert.equal((await restarted.dashboard()).learning.completed, 0);
    assert.deepEqual((await restarted.replay(first.id)).frames, expectedFrames, 'Missing per-attempt versions stay legacy after the archive header migrates.');
    const session = await restarted.start({ seed, rulesVersion: RULES_VERSION, worldVersion: WORLD_VERSION });
    const current = await replayTrace(world, layout.towers, { seed, ticks: MAX_TICKS, controls });
    const outcome = current.outcome === 'censored' ? 'abandoned' : current.outcome;
    const summary = await restarted.finish({ attemptId: session.attemptId, token: session.token, ticks: current.ticks, controls, outcome });
    assert.equal(summary.rulesVersion, RULES_VERSION);
    const playback = await restarted.replay(session.attemptId);
    assert.deepEqual(playback.frames.at(-1), current.frame); assert.notDeepEqual(playback.frames[0].plane, expectedFrames[0].plane);
    await restarted.syncSentry(); await restarted.waitForTraining();
    const after = await restarted.dashboard();
    assert.equal(after.learning.completed, outcome === 'abandoned' ? 0 : 1);
    assert.equal(after.rounds.length, 1); assert.equal(after.totals.attempts, 9);
    assert.equal(JSON.parse(remote.get(sentryEventId(session.attemptId))!).rulesVersion, RULES_VERSION);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('legacy Sentry attachments retain provenance and cannot be relabeled as overhead training records', async () => {
  const result = await legacy, id = randomUUID();
  const layout: Layout = { version: 0, towers: world.towers, createdAt: '2026-09-20T00:00:00.000Z', reason: 'Original' };
  const summary: AttemptSummary = { id, rulesVersion: LEGACY_RULES_VERSION, layoutVersion: 0, endedAt: layout.createdAt, outcome: 'caught', seconds: result.seconds,
    firstDetectionSeconds: result.firstDetectionSeconds, verified: true };
  const expected = sentryRecord({ id, seed, ticks: result.ticks, controls, layout, summary, rulesVersion: LEGACY_RULES_VERSION });
  assert.deepEqual(importSentryRecord(JSON.stringify(expected), expected), expected);
  assert.equal(Object.prototype.hasOwnProperty.call(expected.summary, 'rulesVersion'), false, 'The original Sentry summary shape is unchanged.');
  assert.throws(() => importSentryRecord(JSON.stringify(expected), { ...expected, rulesVersion: RULES_VERSION }), /did not match/);
  const unknown = { ...expected, rulesVersion: 'unknown-rules' };
  assert.throws(() => importSentryRecord(JSON.stringify(unknown), unknown), /did not match/);
});

test('versioned replay uses legacy camera mechanics or the current overhead mechanics explicitly', async () => {
  const frames: LiveFrame[] = [];
  const old = await replayTrace(world, world.towers, { seed, ticks: 372, controls, rulesVersion: LEGACY_RULES_VERSION }, false, (frame) => frames.push(frame));
  assert.ok(Math.abs(old.firstDetectionSeconds! - 3.0083333333333253) < 1e-10);
  const lastClear = frames.find((frame) => Math.abs(frame.time - 3) < 1e-8)!;
  assert.equal(lastClear.detected, false);
  assert.ok(Math.abs(lastClear.plane.x - -267.9215942278599) < 1e-10);
  assert.ok(Math.abs(lastClear.plane.z - 963.1897458420428) < 1e-10);
  assert.equal(old.frame.plane.detecting, true);
  const game = createGame(world, seed); startGame(game);
  for (let tick = 0; tick < 372; tick++) stepGame(game, world, controls[0], REAL_TICK_SECONDS);
  const current = await replayTrace(world, world.towers, { seed, ticks: 372, controls, rulesVersion: RULES_VERSION });
  assert.deepEqual(current.frame, gameFrame(game, 'abandoned'));
  assert.equal(current.firstDetectionSeconds, null); assert.equal(current.frame.plane.detecting, false);
  await assert.rejects(() => replayTrace(world, world.towers, { seed, ticks: 372, controls, rulesVersion: 'unknown' }), /Unsupported/);
});

for (const previousRules of [OVERHEAD_RULES_VERSION, COORDINATED_RULES_VERSION]) test(`an active ${previousRules} attempt keeps its original flights across a v4 archive migration`, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cant-catch-flight-migration-'));
  const id = randomUUID(), token = '9'.repeat(64), startedAt = new Date().toISOString();
  const layout: Layout = { version: 4, towers: world.towers.map(({ id, x, z }) => ({ id, x, z })), createdAt: startedAt, reason: 'Previous cohort',
    ...(previousRules === COORDINATED_RULES_VERSION ? { algorithm: FLIGHT_ALGORITHM, flightPolicy: { ...DEFAULT_FLIGHT_POLICY, routePhase: 0.7 } } : {}) };
  try {
    await mkdir(path.join(directory, 'attempts'));
    await writeFile(path.join(directory, 'state.json'), JSON.stringify({ schema: 1, rulesVersion: previousRules, worldVersion: WORLD_VERSION,
      layout, rounds: [], lastTrainedCount: 8 }));
    await writeFile(path.join(directory, 'attempts', `${id}.json`), JSON.stringify({ id, tokenHash: hash(token), seed, startedAt, layout,
      rulesVersion: previousRules, worldVersion: WORLD_VERSION }));
    const service = new LearningService({ directory, world, autoSync: false, autoTrain: false });
    const current = await service.dashboard();
    assert.equal(current.rulesVersion, RULES_VERSION); assert.equal(current.learning.completed, 0);
    assert.equal(current.layout.algorithm, FLIGHT_ALGORITHM); assert.deepEqual(current.layout.flightPolicy, layout.flightPolicy ?? DEFAULT_FLIGHT_POLICY);
    const old = await replayTrace(world, layout, { seed, ticks: 1200, controls, rulesVersion: previousRules });
    assert.equal(old.outcome, 'censored');
    const finished = await service.finish({ attemptId: id, token, ticks: 1200, controls, outcome: 'abandoned' });
    assert.equal(finished.rulesVersion, previousRules);
    const playback = await service.replay(id);
    assert.deepEqual(playback.layout, layout); assert.deepEqual(playback.frames.at(-1), old.frame);
    assert.equal(playback.frames[0].algorithm, layout.algorithm);
    const saved = JSON.parse(await readFile(path.join(directory, 'attempts', `${id}.json`), 'utf8'));
    const exported = sentryRecord(saved);
    assert.deepEqual(exported.layout.flightPolicy, layout.flightPolicy); assert.equal(exported.rulesVersion, previousRules);
    assert.deepEqual(importSentryRecord(JSON.stringify(exported), exported), exported);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
