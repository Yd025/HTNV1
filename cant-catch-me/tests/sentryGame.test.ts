import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

type Hooks = { start: (id: string, layout: number) => void; finish: (id: string, outcome: string) => string | undefined };
const flushMicrotasks = () => new Promise<void>(done => setImmediate(done));

function loadRecorder() {
  const source = readFileSync(resolve(__dirname, '../../lib/sentryGame.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const calls = { starts: 0, flushes: 0, snapshots: 0, sampledOnly: [] as boolean[], breadcrumbs: [] as unknown[] };
  const document = { hidden: false };
  let currentReplay: string | undefined, now = 0, hooks!: Hooks;
  const sentry = {
    getReplay: () => ({
      getReplayId: (sampled: boolean) => { calls.sampledOnly.push(sampled); return currentReplay; },
      start: () => { calls.starts++; currentReplay = 'abcd1234-abcd-4123-8123-abcd12345678'; },
      flush: async () => { calls.flushes++; },
    }),
    addBreadcrumb: (breadcrumb: unknown) => { calls.breadcrumbs.push(breadcrumb); },
    getClient: () => ({ getIntegrationByName: () => ({ snapshot: async () => { calls.snapshots++; } }) }),
  };
  const exports: { installGameRecording?: () => void; snapshotGameCanvas?: (canvas: { hasAttribute: () => boolean }) => void } = {};
  runInNewContext(compiled, {
    exports, document, performance: { now: () => now },
    require: (name: string) => {
      if (name === '@sentry/nextjs') return sentry;
      if (name === './learningClient') return { registerGameReplayHooks: (value: Hooks) => { hooks = value; } };
      throw new Error(`Unexpected import ${name}`);
    },
  });
  exports.installGameRecording!();
  return { hooks, calls, document, sentry, snapshot: exports.snapshotGameCanvas!, setTime: (value: number) => { now = value; } };
}

test('manual Sentry recording starts with a run, shares one session, and exports only attempt metadata', async () => {
  const recorder = loadRecorder();
  assert.equal(recorder.calls.starts, 0);
  recorder.hooks.start('attempt-a', 2);
  await flushMicrotasks();
  recorder.hooks.start('attempt-b', 3);
  assert.equal(recorder.calls.starts, 1);
  assert.equal(recorder.hooks.finish('attempt-a', 'caught'), 'abcd1234abcd41238123abcd12345678');
  assert.equal(recorder.hooks.finish('attempt-b', 'escaped'), 'abcd1234abcd41238123abcd12345678');
  assert.equal(recorder.hooks.finish('attempt-b', 'escaped'), undefined);
  assert.equal(recorder.calls.flushes, 2);
  assert.ok(recorder.calls.sampledOnly.every(Boolean), 'Unsampled IDs must not masquerade as recordings');
  const breadcrumbs = JSON.parse(JSON.stringify(recorder.calls.breadcrumbs));
  assert.deepEqual(breadcrumbs.map((item: { data: unknown }) => item.data), [
    { attemptId: 'attempt-a', layoutVersion: 2 }, { attemptId: 'attempt-b', layoutVersion: 3 },
    { attemptId: 'attempt-a', outcome: 'caught' }, { attemptId: 'attempt-b', outcome: 'escaped' },
  ]);
});

test('canvas snapshots require an active game canvas and stay bounded to two frames per second', async () => {
  const recorder = loadRecorder(), canvas = { hasAttribute: () => true };
  recorder.snapshot(canvas);
  assert.equal(recorder.calls.snapshots, 0);
  recorder.hooks.start('attempt', 0);
  await flushMicrotasks();
  recorder.snapshot({ hasAttribute: () => false });
  recorder.document.hidden = true; recorder.snapshot(canvas);
  assert.equal(recorder.calls.snapshots, 0);
  recorder.document.hidden = false; recorder.snapshot(canvas);
  await flushMicrotasks();
  recorder.setTime(499); recorder.snapshot(canvas);
  assert.equal(recorder.calls.snapshots, 1);
  recorder.setTime(500); recorder.snapshot(canvas);
  await flushMicrotasks();
  assert.equal(recorder.calls.snapshots, 2);
  recorder.hooks.finish('attempt', 'caught');
  recorder.setTime(1000); recorder.snapshot(canvas);
  assert.equal(recorder.calls.snapshots, 2);
});
