import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { WorldData } from '../lib/game';
import { MAX_TICKS, replayTrace } from '../lib/learningOptimizer';
import { LearningService, validateFinish } from '../lib/learningServer';
import { createSentryTransport, importSentryRecord, SENTRY_ATTACHMENT_NAME, sentryEventId, SentrySyncError, type SentryAttemptRecord, type SentryTransport } from '../lib/learningSentry';
import { RULES_VERSION, WORLD_VERSION, type FinishRequest } from '../lib/learningTypes';

const world = JSON.parse(readFileSync(path.resolve(__dirname, '../../public/assets/world.json'), 'utf8')) as WorldData;
const controls = [{ tick: 0, throttle: 0, steer: 0 }];
const seed = 0x51a7, start = { seed, rulesVersion: RULES_VERSION, worldVersion: WORLD_VERSION };
const idle = replayTrace(world, world.towers, { seed, ticks: MAX_TICKS, controls });
function fakeSentry() {
  const uploaded = new Map<string, string>(), calls = { publish: 0, download: 0 };
  const transport: SentryTransport = {
    configured: true, uploadConfigured: true, configurationMessage: 'Test Sentry is configured.', destination: 'o123.ingest.us.sentry.io/456',
    replayUrl: (id) => `https://hackthenorth-nt.sentry.io/replays/${id}/`,
    async publish(record, eventId) { calls.publish++; uploaded.set(eventId, JSON.stringify(record)); },
    async download(eventId) { calls.download++; return uploaded.get(eventId) ?? null; },
  };
  return { uploaded, calls, transport };
}
async function fixture(transport: SentryTransport, autoTrain = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cant-catch-sentry-'));
  let clock = 1000000;
  const options = { directory, world, autoTrain, autoSync: false, sentryTransport: transport, now: () => clock };
  return { directory, options, service: new LearningService(options), advance: () => { clock += 310000; }, remove: () => rm(directory, { recursive: true, force: true }) };
}
async function finish(service: LearningService, replayId?: string) {
  const session = await service.start(start), result = await idle;
  const payload: FinishRequest = { attemptId: session.attemptId, token: session.token, controls, ticks: result.ticks, outcome: 'caught', ...(replayId ? { replayId } : {}) };
  await service.finish(payload);
  return { session, payload };
}

test('only downloaded and checked Sentry recordings become eligible for the tower model', async () => {
  const remote = fakeSentry(), f = await fixture(remote.transport, true);
  try {
    const submissions = [];
    for (let index = 0; index < 8; index++) submissions.push(await finish(f.service, index === 0 ? 'a'.repeat(32) : undefined));
    const before = await f.service.dashboard();
    assert.equal(before.totals.captured, 8); assert.equal(before.sentry.pending, 8); assert.equal(before.sentry.imported, 0);
    assert.equal(before.rounds.length, 0); assert.match(before.learning.message, /0 of 8 Sentry-imported/);
    await Promise.all([f.service.syncSentry(), f.service.syncSentry()]);
    assert.equal(remote.calls.publish, 4, 'Concurrent drains share one worker, and a pass has a bounded batch.');
    assert.equal((await f.service.dashboard()).rounds.length, 0);
    await f.service.syncSentry(); await f.service.waitForTraining();
    const after = await f.service.dashboard();
    assert.equal(after.sentry.imported, 8); assert.equal(after.sentry.pending, 0); assert.equal(after.sentry.status, 'ready');
    assert.equal(after.rounds.length, 1); assert.equal(after.rounds[0].attempts, 8);
    assert.equal(after.rounds[0].algorithm, 'coordinated-surveillance-v1');
    assert.ok(after.rounds[0].flightPolicy);
    assert.ok(after.rounds[0].baseline.surveillance && after.rounds[0].candidate.surveillance);
    assert.ok(after.attempts.every((item) => item.sentry?.state === 'imported'));
    const record = JSON.parse(remote.uploaded.get(sentryEventId(submissions[0].session.attemptId))!);
    assert.equal(record.replayId, 'a'.repeat(32)); assert.equal(record.layout.version, 0);
    assert.deepEqual(record.layout.flightPolicy, submissions[0].session.layout.flightPolicy);
    assert.equal(record.layout.algorithm, 'coordinated-surveillance-v1');
    for (const forbidden of [submissions[0].session.token, 'tokenHash', 'finishDigest', 'live', 'Authorization']) assert.ok(!JSON.stringify(record).includes(forbidden));
    await f.service.syncSentry(); assert.equal(remote.calls.publish, 8); assert.equal(remote.calls.download, 8);
    const restarted = new LearningService(f.options); await restarted.syncSentry(); await restarted.waitForTraining();
    assert.equal((await restarted.dashboard()).rounds.length, 1); assert.equal(remote.calls.publish, 8);
    assert.equal((await restarted.finish(submissions[0].payload)).sentry?.state, 'imported');
  } finally { await f.remove(); }
});

test('DSN-only uploads survive restart and wait for a read token before importing or training', async () => {
  const remote = fakeSentry(); remote.transport.configured = false;
  remote.transport.configurationMessage = 'Upload enabled; add server-only SENTRY_API_TOKEN with project:read to feed the model.';
  const f = await fixture(remote.transport);
  try {
    const { session } = await finish(f.service);
    await f.service.syncSentry(); await f.service.syncSentry();
    const waiting = await f.service.dashboard();
    assert.equal(waiting.sentry.configured, false); assert.equal(waiting.sentry.status, 'unconfigured'); assert.equal(waiting.sentry.pending, 1);
    assert.equal(waiting.attempts[0].sentry?.state, 'uploaded'); assert.equal(remote.calls.publish, 1); assert.equal(remote.calls.download, 0);
    const restarted = new LearningService(f.options); await restarted.syncSentry();
    assert.equal(remote.calls.publish, 1, 'The durable uploaded state prevents resending after restart.');
    remote.transport.configured = true;
    await restarted.syncSentry();
    const imported = await restarted.dashboard();
    assert.equal(imported.sentry.imported, 1); assert.match(imported.learning.message, /1 of 8 Sentry-imported/);
    assert.equal(imported.attempts[0].id, session.attemptId); assert.equal(remote.calls.publish, 1);
  } finally { await f.remove(); }
});

test('outbox retries stable event ids, indexing delay and mismatched downloads without training from local data', async () => {
  const remote = fakeSentry(), f = await fixture(remote.transport);
  try {
    const { session } = await finish(f.service);
    const publish = remote.transport.publish, download = remote.transport.download;
    let failOnce = true;
    remote.transport.publish = async (record, eventId) => { await publish(record, eventId); if (failOnce) { failOnce = false; throw new Error('private bearer token must not leak'); } };
    await f.service.syncSentry();
    let dashboard = await f.service.dashboard();
    assert.equal(dashboard.attempts[0].sentry?.state, 'error'); assert.equal(dashboard.sentry.imported, 0);
    assert.ok(!JSON.stringify(dashboard).includes('private bearer'));
    await f.service.syncSentry(); assert.equal(remote.calls.publish, 1, 'Persistent backoff prevents tight retries.');
    f.advance(); remote.transport.download = async () => null;
    await f.service.syncSentry();
    assert.equal(remote.calls.publish, 2); assert.equal(remote.uploaded.size, 1, 'Uncertain uploads retry the same event id.');
    assert.equal((await f.service.dashboard()).attempts[0].sentry?.state, 'uploaded');
    f.advance(); remote.transport.download = async (eventId) => {
      const value = JSON.parse(remote.uploaded.get(eventId)!); value.controls[0].throttle = 1; return JSON.stringify(value);
    };
    await f.service.syncSentry(); dashboard = await f.service.dashboard();
    assert.equal(dashboard.sentry.imported, 0); assert.equal(dashboard.sentry.failed, 1);
    assert.match(dashboard.attempts[0].sentry?.error || '', /did not match/); assert.equal(dashboard.rounds.length, 0);
    f.advance(); remote.transport.download = download;
    const restarted = new LearningService(f.options); await restarted.syncSentry();
    assert.equal((await restarted.dashboard()).sentry.imported, 1); assert.equal(remote.calls.publish, 2);
    const stored = JSON.parse(await readFile(path.join(f.directory, 'attempts', `${session.attemptId}.json`), 'utf8'));
    assert.equal(stored.sentry.imported.attemptId, session.attemptId); assert.equal(stored.sentry.imported.controls[0].throttle, 0);
  } finally { await f.remove(); }
});

test('older local attempts queue for backfill and unconfigured Sentry never triggers a local fallback', async () => {
  const remote = fakeSentry(), f = await fixture(createSentryTransport({}));
  try {
    const { session, payload } = await finish(f.service);
    await f.service.syncSentry();
    assert.equal((await f.service.dashboard()).sentry.status, 'unconfigured');
    assert.throws(() => validateFinish({ ...payload, replayId: '../private' }), /replay id/);
    const filename = path.join(f.directory, 'attempts', `${session.attemptId}.json`), saved = JSON.parse(await readFile(filename, 'utf8'));
    delete saved.sentry; delete saved.summary.sentry;
    await writeFile(filename, JSON.stringify(saved));
    const restarted = new LearningService({ ...f.options, sentryTransport: remote.transport });
    assert.equal((await restarted.dashboard()).attempts[0].sentry?.state, 'pending');
    await restarted.syncSentry();
    assert.equal((await restarted.dashboard()).sentry.imported, 1); assert.equal(remote.calls.publish, 1);
  } finally { await f.remove(); }
});

test('changing Sentry destinations requeues old acknowledgments and removes replay links from the prior project', async () => {
  const original = fakeSentry(), f = await fixture(original.transport);
  try {
    const first = await finish(f.service, 'a'.repeat(32));
    await f.service.syncSentry();
    assert.equal((await f.service.dashboard()).sentry.imported, 1);
    original.transport.configured = false;
    const second = await finish(f.service, 'b'.repeat(32));
    await f.service.syncSentry();
    assert.equal((await f.service.dashboard()).attempts.find((row) => row.id === second.session.attemptId)?.sentry?.state, 'uploaded');
    const statePath = path.join(f.directory, 'state.json'), state = JSON.parse(await readFile(statePath, 'utf8'));
    state.lastTrainedCount = 1;
    await writeFile(statePath, JSON.stringify(state));
    const destination = fakeSentry(); destination.transport.destination = 'o999.ingest.us.sentry.io/888';
    destination.transport.configured = false;
    destination.transport.replayUrl = () => undefined;
    destination.transport.configurationMessage = 'Upload enabled; set SENTRY_ORG, SENTRY_PROJECT, server-only SENTRY_API_TOKEN with project:read to feed the model.';
    const restarted = new LearningService({ ...f.options, sentryTransport: destination.transport });
    const reset = await restarted.dashboard();
    assert.equal(reset.sentry.imported, 0); assert.equal(reset.sentry.pending, 2); assert.equal(reset.learning.completed, 0);
    assert.deepEqual(reset.layout, state.layout); assert.deepEqual(reset.rounds, state.rounds);
    assert.ok(reset.attempts.every((row) => row.sentry?.state === 'pending' && !row.sentry.replayId && !row.sentry.replayUrl));
    assert.equal(JSON.parse(await readFile(statePath, 'utf8')).lastTrainedCount, 0);
    await restarted.syncSentry();
    assert.equal(destination.calls.publish, 2); assert.equal(destination.calls.download, 0);
    assert.ok((await restarted.dashboard()).attempts.every((row) => row.sentry?.state === 'uploaded'));
    const eventId = sentryEventId(first.session.attemptId);
    assert.ok(destination.uploaded.has(eventId)); assert.ok(original.uploaded.has(eventId), 'Stable event IDs are scoped to their projects.');
    assert.equal(JSON.parse(destination.uploaded.get(eventId)!).replayId, undefined);
    const archived = JSON.parse(await readFile(path.join(f.directory, 'attempts', `${first.session.attemptId}.json`), 'utf8'));
    assert.equal(archived.sentry.destination, destination.transport.destination); assert.equal(archived.sentry.imported, undefined);
    destination.transport.configured = true;
    await restarted.syncSentry();
    const imported = await restarted.dashboard();
    assert.equal(imported.sentry.imported, 2); assert.equal(imported.learning.completed, 2); assert.equal(destination.calls.publish, 2);
    assert.equal(imported.totals.attempts, 2, 'Moving the data does not duplicate player history.');
  } finally { await f.remove(); }
});

test('Sentry HTTP transport uploads an attachment and strips bearer authorization on storage redirects', async () => {
  const token = 'test-server-token', dsn = `https://${'a'.repeat(32)}@o123.ingest.us.sentry.io/456`;
  const calls: { url: string; init: RequestInit }[] = [];
  const record: SentryAttemptRecord = { schema: 1, kind: 'cant-catch-me.opening-attempt', rulesVersion: RULES_VERSION, worldVersion: WORLD_VERSION,
    attemptId: '00000000-0000-4000-8000-000000000001', seed, ticks: 0, controls: [], layout: { version: 0, towers: [], createdAt: '2026-09-20T00:00:00.000Z', reason: 'Original' },
    summary: { endedAt: '2026-09-20T00:00:00.000Z', outcome: 'abandoned', seconds: 0, firstDetectionSeconds: null, verified: false }, replayId: 'b'.repeat(32) };
  const request: typeof fetch = async (input, init = {}) => {
    const url = String(input); calls.push({ url, init });
    if (init.method === 'POST') return new Response('{}', { status: 200 });
    if (url.endsWith('/api/0/projects/123/456/')) return new Response(JSON.stringify({ id: '456', organization: { id: '123', slug: 'new-game-studio' } }));
    if (url.includes('?download=1')) return new Response(null, { status: 302, headers: { location: 'https://storage.googleapis.com/sentry-bucket/recording.json?signature=test' } });
    if (url.startsWith('https://storage.googleapis.com/')) return new Response(JSON.stringify(record));
    return new Response(JSON.stringify([{ id: '123', name: SENTRY_ATTACHMENT_NAME, size: 1000 }]));
  };
  const transport = createSentryTransport({ SENTRY_DSN: dsn, SENTRY_API_TOKEN: token, SENTRY_API_BASE: 'https://us.sentry.io' }, request);
  const eventId = sentryEventId(record.attemptId);
  assert.equal(transport.configured, true, 'Numeric organization and project IDs are derived from the validated DSN.');
  assert.equal(transport.replayUrl(record.replayId!), undefined, 'A numeric API ID is never used as an organization hostname.');
  await transport.publish(record, eventId);
  const imported = await transport.download(eventId);
  assert.deepEqual(importSentryRecord(imported!, record), record);
  assert.equal(transport.replayUrl(record.replayId!), `https://new-game-studio.sentry.io/replays/${record.replayId}/`);
  assert.match(calls[0].url, /^https:\/\/o123\.ingest\.us\.sentry\.io\/api\/456\/envelope\//);
  const envelope = String(calls[0].init.body);
  assert.ok(envelope.includes('"type":"attachment"')); assert.ok(envelope.includes(SENTRY_ATTACHMENT_NAME)); assert.ok(envelope.includes('replay_id'));
  assert.ok(!envelope.includes(token)); assert.equal(calls[0].init.headers && new Headers(calls[0].init.headers).get('authorization'), null);
  assert.equal(new Headers(calls[1].init.headers).get('authorization'), `Bearer ${token}`);
  assert.equal(calls[1].url, 'https://us.sentry.io/api/0/projects/123/456/');
  assert.equal(new Headers(calls[2].init.headers).get('authorization'), `Bearer ${token}`);
  assert.match(calls[2].url, /projects\/123\/456\/events\//);
  assert.equal(new Headers(calls[3].init.headers).get('authorization'), `Bearer ${token}`);
  assert.equal(new Headers(calls[4].init.headers).get('authorization'), null);
  assert.ok(calls.every((call) => call.init.redirect === 'manual'));
  await Promise.all([transport.resolveProject!(), transport.resolveProject!()]);
  assert.equal(calls.filter((call) => call.url.endsWith('/api/0/projects/123/456/')).length, 1, 'Verified project metadata is cached.');
  const uploadOnly = createSentryTransport({ SENTRY_DSN: dsn }, request);
  assert.equal(uploadOnly.uploadConfigured, true); assert.equal(uploadOnly.configured, false);
  assert.equal(uploadOnly.destination, 'o123.ingest.us.sentry.io/456');
  assert.equal(uploadOnly.replayUrl(record.replayId!), undefined);
  assert.ok(!JSON.stringify(uploadOnly).includes('hackthenorth'));
  assert.match(uploadOnly.configurationMessage, /SENTRY_API_TOKEN/);
  assert.ok(!uploadOnly.configurationMessage.includes('SENTRY_ORG') && !uploadOnly.configurationMessage.includes('SENTRY_PROJECT'));
  await uploadOnly.publish(record, eventId);
  await assert.rejects(() => uploadOnly.download(eventId), /SENTRY_API_TOKEN/);
  const missingSlugs = createSentryTransport({ SENTRY_DSN: dsn, SENTRY_API_TOKEN: token }, request);
  assert.equal(missingSlugs.uploadConfigured, true); assert.equal(missingSlugs.configured, true);
  await missingSlugs.resolveProject!();
  assert.equal(missingSlugs.replayUrl(record.replayId!), `https://new-game-studio.sentry.io/replays/${record.replayId}/`);
  assert.equal(createSentryTransport({ SENTRY_DSN: dsn, SENTRY_API_TOKEN: token, SENTRY_API_BASE: 'https://unrelated.example' }, request).configured, false);
});

test('project resolution checks both DSN IDs, deduplicates lookups and keeps unsafe or unverified links closed', async () => {
  const dsn = `https://${'a'.repeat(32)}@o123.ingest.us.sentry.io/456`, replayId = 'b'.repeat(32);
  let lookups = 0;
  const request: typeof fetch = async () => { lookups++; return new Response(JSON.stringify({ id: '456', organization: { id: '999', slug: 'wrong-organization' } })); };
  const wrong = createSentryTransport({ SENTRY_DSN: dsn, SENTRY_API_TOKEN: 'test-token', SENTRY_ORG: 'provided-org', SENTRY_PROJECT: 'provided-project' }, request);
  const results = await Promise.allSettled([wrong.resolveProject!(), wrong.resolveProject!()]);
  assert.ok(results.every((result) => result.status === 'rejected')); assert.equal(lookups, 1);
  await assert.rejects(() => wrong.download('a'.repeat(32)), /does not match/);
  assert.equal(lookups, 1, 'A failed metadata lookup has a bounded retry delay.');
  assert.equal(wrong.replayUrl(replayId), undefined); assert.equal(wrong.uploadConfigured, true);
  for (const slug of ['123', 'bad.example/path', 'bad_slug']) {
    const unsafe = createSentryTransport({ SENTRY_DSN: dsn, SENTRY_API_TOKEN: 'test-token' }, async () => new Response(JSON.stringify({ id: '456', organization: { id: '123', slug } })));
    await unsafe.resolveProject!(); assert.equal(unsafe.replayUrl(replayId), undefined);
  }
  const wrongProject = createSentryTransport({ SENTRY_DSN: dsn, SENTRY_API_TOKEN: 'test-token' }, async () => new Response(JSON.stringify({ id: '777', organization: { id: '123', slug: 'right-org' } })));
  await assert.rejects(() => wrongProject.resolveProject!(), /does not match/);
  assert.equal(wrongProject.replayUrl(replayId), undefined);
});

test('import fills a previously missing replay link and restart refreshes links without exporting again', async () => {
  const remote = fakeSentry(); let resolved = false;
  remote.transport.replayUrl = (id) => resolved ? `https://verified-studio.sentry.io/replays/${id}/` : undefined;
  remote.transport.resolveProject = async () => { resolved = true; };
  const download = remote.transport.download;
  remote.transport.download = async (eventId) => { await remote.transport.resolveProject!(); return download(eventId); };
  const f = await fixture(remote.transport);
  try {
    const replayId = 'b'.repeat(32);
    await finish(f.service, replayId);
    assert.equal((await f.service.dashboard()).attempts[0].sentry?.replayUrl, undefined);
    await f.service.syncSentry();
    assert.equal((await f.service.dashboard()).attempts[0].sentry?.replayUrl, `https://verified-studio.sentry.io/replays/${replayId}/`);
    resolved = false;
    const restarted = new LearningService(f.options);
    assert.equal((await restarted.dashboard()).attempts[0].sentry?.replayUrl, undefined);
    await restarted.syncSentry();
    assert.equal((await restarted.dashboard()).attempts[0].sentry?.replayUrl, `https://verified-studio.sentry.io/replays/${replayId}/`);
    assert.equal(remote.calls.publish, 1); assert.equal(remote.calls.download, 1);
  } finally { await f.remove(); }
});
