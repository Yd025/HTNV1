import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createGame, GAME_RULES, sampleRiverHeight, SIMULATION_STEP, startGame, stepGame, togglePause, type GameState, type InputState, type WorldData } from '../lib/game';
import { OpeningAttemptRecorder, flushPendingAttempts, registerGameReplayHooks, requestLearningStart, type AttemptTransport } from '../lib/learningClient';
import { applyTowerLayout } from '../lib/learningWorld';
import { LEARNING_POLICY, RULES_VERSION, WORLD_VERSION, type FinishRequest, type LiveFrame, type StartResponse } from '../lib/learningTypes';

const world = JSON.parse(readFileSync(resolve(__dirname, '../../public/assets/world.json'), 'utf8')) as WorldData;
const session: StartResponse = {
  attemptId: 'test-attempt', token: 'test-token', rulesVersion: RULES_VERSION, worldVersion: WORLD_VERSION,
  layout: { version: 0, towers: world.towers.map(({ id, x, z }) => ({ id, x, z })), createdAt: '', reason: 'Initial layout' },
};
function harness() {
  const finishes: FinishRequest[] = [];
  const live: { seq: number; frame: LiveFrame }[] = [];
  let now = 0;
  const transport: AttemptTransport = {
    now: () => now,
    live: async message => { live.push(message); },
    finish: message => { finishes.push(structuredClone(message)); },
  };
  return { recorder: new OpeningAttemptRecorder(session, transport), finishes, live, setNow: (value: number) => { now = value; } };
}
function advance(state: GameState, recorder: OpeningAttemptRecorder, input: InputState, dt = SIMULATION_STEP / GAME_RULES.pace) {
  stepGame(state, world, input, dt, () => recorder.beforeTick(state, input));
  recorder.afterStep(state);
}

test('a pinned layout changes only tower sites and terrain elevation, preserving aircraft and boost launches', () => {
  assert.deepEqual(applyTowerLayout(world, session.layout.towers), world, 'Baseline must keep the supplied tower elevations exactly');
  const before = structuredClone(world);
  const positions = session.layout.towers.map(position => ({ ...position }));
  const tower = positions[0];
  let found = false;
  for (const dx of [20, -20, 40, -40]) {
    if (sampleRiverHeight(world, tower.x + dx, tower.z) > world.waterLevel) { tower.x += dx; found = true; break; }
  }
  assert.ok(found);
  const selected = applyTowerLayout(world, positions);
  assert.deepEqual(world, before, 'Baseline world is immutable');
  for (let i = 0; i < world.towers.length; i++) {
    assert.equal(selected.towers[i].heading, world.towers[i].heading);
    assert.equal(selected.towers[i].range, world.towers[i].range);
    assert.equal(selected.towers[i].id, world.towers[i].id);
  }
  const baseline = createGame(world, 123), candidate = createGame(selected, 123);
  assert.deepEqual(candidate.drones, baseline.drones);
  assert.deepEqual(candidate.plane, baseline.plane);
  assert.deepEqual(candidate.pickups, baseline.pickups);
  assert.deepEqual(candidate.patrolPoints, baseline.patrolPoints);
  assert.equal(candidate.towers[0].height, sampleRiverHeight(world, tower.x, tower.z));
  positions[0].x += 20;
  assert.notEqual(candidate.towers[0].x, positions[0].x, 'Later layout data cannot move active towers');
  assert.throws(() => applyTowerLayout(world, [positions[0], positions[0]]));
  assert.throws(() => applyTowerLayout(world, [{ ...positions[0], x: world.half + 1 }, positions[1]]));
});

test('compressed fixed-tick controls replay exactly, including pause and the initial boost seed', () => {
  const { recorder, finishes } = harness();
  const played = createGame(world, 82); startGame(played);
  for (let tick = 0; tick < 600; tick++) {
    const input = { throttle: tick < 450 ? 1 : -1, steer: tick >= 100 && tick < 180 ? 0.2 : 0 };
    advance(played, recorder, input);
    if (tick === 200) {
      togglePause(played);
      advance(played, recorder, { throttle: 0, steer: 1 }, 0.1);
      togglePause(played);
    }
  }
  recorder.abandon(played); recorder.abandon(played, true); recorder.afterStep(played);
  assert.equal(finishes.length, 1);
  const result = finishes[0];
  assert.equal(result.ticks, 600);
  assert.deepEqual(result.controls.map(sample => sample.tick), [0, 100, 180, 450]);
  const replay = createGame(world, 82); startGame(replay);
  let index = 0;
  for (let tick = 0; tick < result.ticks; tick++) {
    if (result.controls[index + 1]?.tick === tick) index++;
    stepGame(replay, world, result.controls[index], SIMULATION_STEP / GAME_RULES.pace);
  }
  assert.deepEqual(replay, played);
});

test('first boundary crossing finishes once at the exact tick even when rendering advances more ticks', () => {
  const { recorder, finishes, live } = harness();
  const state = createGame(world, 123); startGame(state);
  const originalTowers = state.towers.map(tower => ({ ...tower }));
  // The recorder observes these same calls inside stepGame's before-tick hook.
  recorder.beforeTick(state, { throttle: 1, steer: 0 });
  state.time += SIMULATION_STEP / GAME_RULES.pace;
  state.loop = 1;
  state.boat.x = world.half + 1;
  state.towers[0].x += 6500;
  recorder.beforeTick(state, { throttle: 1, steer: 0 });
  recorder.beforeTick(state, { throttle: 1, steer: 0 });
  recorder.afterStep(state); recorder.abandon(state);
  assert.equal(finishes.length, 1);
  assert.equal(finishes[0].ticks, 1);
  assert.equal(finishes[0].outcome, 'escaped');
  assert.equal(live.at(-1)?.frame.status, 'escaped');
  assert.equal(live.at(-1)?.frame.towers[0].x, originalTowers[0].x);
  assert.equal(live.at(-1)?.frame.boat.x, state.boat.x);
});

test('capture and the recording time limit leave the game state untouched and finish only once', () => {
  const caught = harness(), state = createGame(world); startGame(state);
  caught.recorder.beforeTick(state, { throttle: 0, steer: 0 });
  state.status = 'caught';
  caught.recorder.afterStep(state); caught.recorder.abandon(state);
  assert.equal(caught.finishes.length, 1);
  assert.equal(caught.finishes[0].outcome, 'caught');

  const limited = harness(), playing = createGame(world); startGame(playing);
  const cap = Math.round(LEARNING_POLICY.maxSeconds * GAME_RULES.pace / SIMULATION_STEP);
  for (let tick = 0; tick < cap; tick++) limited.recorder.beforeTick(playing, { throttle: 0, steer: 0 });
  limited.recorder.afterStep(playing);
  limited.recorder.beforeTick(playing, { throttle: 1, steer: 0 });
  limited.recorder.afterStep(playing);
  assert.equal(limited.finishes.length, 1);
  assert.equal(limited.finishes[0].ticks, cap);
  assert.equal(limited.finishes[0].outcome, 'abandoned');
  assert.equal(playing.status, 'playing');
});

test('live preview is rate limited, skips overlapping requests, and preserves pause', async () => {
  const { recorder, live, setNow } = harness();
  const state = createGame(world); startGame(state);
  recorder.afterStep(state); recorder.afterStep(state);
  assert.equal(live.length, 1);
  await new Promise(resolve => setImmediate(resolve));
  setNow(499); recorder.afterStep(state);
  assert.equal(live.length, 1);
  setNow(500); togglePause(state); recorder.afterStep(state);
  assert.equal(live.length, 2);
  assert.equal(live[1].frame.status, 'paused');
  assert.equal(live[1].seq, 2);
});

test('start service failures and incompatible responses fall back to the unchanged baseline', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new Error('Offline'); };
    assert.deepEqual(await requestLearningStart(world, 123), { world, session: null });
    globalThis.fetch = async () => new Response(JSON.stringify({ ...session, rulesVersion: 'old-rules' }));
    assert.deepEqual(await requestLearningStart(world, 123), { world, session: null });
    let request: unknown;
    globalThis.fetch = async (_url, options) => { request = JSON.parse(String(options?.body)); return new Response(JSON.stringify(session)); };
    const selected = await requestLearningStart(world, 123);
    assert.deepEqual(selected.session, session);
    assert.deepEqual(request, { seed: 123, rulesVersion: RULES_VERSION, worldVersion: WORLD_VERSION });
  } finally { globalThis.fetch = original; }
});

test('a disconnected finish is persisted and retried idempotently when connectivity returns', async () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const stored = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  } });
  const uploads: FinishRequest[] = [];
  try {
    globalThis.fetch = async (url, options) => {
      if (url === '/api/learning/finish') {
        uploads.push(JSON.parse(String(options?.body)));
        if (uploads.length === 1) throw new Error('Connection lost');
      }
      return new Response('{}');
    };
    const recorder = new OpeningAttemptRecorder({ ...session, attemptId: 'retry-attempt' });
    const state = createGame(world); startGame(state);
    recorder.beforeTick(state, { throttle: 1, steer: 0 });
    recorder.abandon(state);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(uploads.length, 1);
    assert.equal(JSON.parse([...stored.values()][0]).length, 1);
    flushPendingAttempts();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(uploads.length, 2);
    assert.deepEqual(uploads[0], uploads[1]);
    assert.equal(JSON.parse([...stored.values()][0]).length, 0);
    recorder.abandon(state, true); flushPendingAttempts();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(uploads.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('recording starts only after a supported layout arrives and its failure never prevents launch', async () => {
  const originalFetch = globalThis.fetch;
  const starts: { id: string; version: number }[] = [];
  try {
    registerGameReplayHooks({
      start: (id, version) => { starts.push({ id, version }); throw new Error('Replay unavailable'); },
      finish: () => undefined,
    });
    globalThis.fetch = async () => new Response(JSON.stringify({ ...session, rulesVersion: 'old-rules' }));
    assert.equal((await requestLearningStart(world, 123)).session, null);
    assert.equal(starts.length, 0);
    globalThis.fetch = async () => new Response(JSON.stringify(session));
    const selected = await requestLearningStart(world, 123);
    assert.deepEqual(selected.session, session);
    assert.deepEqual(starts, [{ id: session.attemptId, version: session.layout.version }]);
  } finally {
    globalThis.fetch = originalFetch;
    registerGameReplayHooks(null);
  }
});

test('offline retries keep the replay ID selected at finish even after another replay starts', async () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const stored = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
  } });
  const uploads: FinishRequest[] = [];
  let currentReplay = 'a'.repeat(32), finished = 0;
  try {
    registerGameReplayHooks({ start: () => undefined, finish: () => { finished++; return currentReplay; } });
    globalThis.fetch = async (url, options) => {
      if (url === '/api/learning/finish') {
        uploads.push(JSON.parse(String(options?.body)));
        if (uploads.length === 1) throw new Error('Offline');
      }
      return new Response('{}');
    };
    const state = createGame(world); startGame(state);
    const recorder = new OpeningAttemptRecorder({ ...session, attemptId: 'replay-retry-attempt' });
    recorder.beforeTick(state, { throttle: 1, steer: 0 });
    recorder.abandon(state);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(uploads[0].replayId, 'a'.repeat(32));
    assert.equal(JSON.parse([...stored.values()][0])[0].replayId, 'a'.repeat(32));
    currentReplay = 'b'.repeat(32);
    flushPendingAttempts();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(uploads[0], uploads[1]);
    assert.equal(finished, 1);
    assert.equal(JSON.parse([...stored.values()][0]).length, 0);
  } finally {
    registerGameReplayHooks(null);
    globalThis.fetch = originalFetch;
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});
