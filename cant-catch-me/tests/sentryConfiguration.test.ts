import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { gameDataCollection, stripPrivateEventData, traceSampleRate } from '../lib/sentryPrivacy';

type Integration = { name: string; options?: Record<string, unknown> };
type Configuration = {
  defaultIntegrations?: boolean;
  integrations: (defaults: Integration[]) => Integration[];
  tracesSampleRate: number;
  dataCollection: typeof gameDataCollection;
  enableLogs: boolean;
  includeLocalVariables?: boolean;
  beforeBreadcrumb?: (breadcrumb: { category: string; message?: string }) => unknown;
  beforeSend: typeof stripPrivateEventData;
  beforeSendTransaction: typeof stripPrivateEventData;
};

function loadConfig(runtime: 'client' | 'server', env: Record<string, string> = {}) {
  const configurations: Configuration[] = [];
  let installs = 0;
  const sentry = {
    init: (options: Configuration) => configurations.push(options),
    browserTracingIntegration: (options: Record<string, unknown>) => ({ name: 'BrowserTracing', options }),
    replayIntegration: (options: Record<string, unknown>) => ({ name: 'Replay', options }),
    replayCanvasIntegration: (options: Record<string, unknown>) => ({ name: 'ReplayCanvas', options }),
  };
  const compiled = ts.transpileModule(readFileSync(resolve(__dirname, `../../sentry.${runtime}.config.ts`), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  runInNewContext(compiled, { exports: {}, process: { env }, URL, window: { location: { origin: 'https://game.example' } }, require: (name: string) => {
    if (name === '@sentry/nextjs') return sentry;
    if (name === './lib/sentryPrivacy') return { gameDataCollection, stripPrivateEventData, traceSampleRate };
    if (name === './lib/sentryGame') return { installGameRecording: () => { installs++; } };
    throw new Error(`Unexpected import ${name}`);
  } });
  return { configurations, installs };
}

test('SDK configuration stays inactive without a DSN and never treats a read token as one', () => {
  for (const runtime of ['client', 'server'] as const) {
    assert.equal(loadConfig(runtime).configurations.length, 0);
    assert.equal(loadConfig(runtime, { SENTRY_API_TOKEN: 'test-read-token' }).configurations.length, 0);
  }
});

test('browser keeps global error handlers and one tracing integration while removing automatic private breadcrumbs', () => {
  const { configurations: [config], installs } = loadConfig('client', { NEXT_PUBLIC_SENTRY_DSN: 'test-dsn' });
  const integrations = config.integrations(['GlobalHandlers', 'BrowserApiErrors', 'Dedupe', 'Breadcrumbs', 'HttpContext', 'BrowserTracing'].map(name => ({ name })));
  const names = integrations.map(integration => integration.name);
  assert.equal(config.defaultIntegrations, undefined);
  assert.ok(names.includes('GlobalHandlers'));
  assert.ok(names.includes('BrowserApiErrors'));
  assert.equal(names.filter(name => name === 'BrowserTracing').length, 1);
  assert.ok(!names.includes('Breadcrumbs') && !names.includes('HttpContext'));
  assert.equal(config.tracesSampleRate, 0.1);
  assert.equal(installs, 1);
  assert.equal(config.beforeBreadcrumb!({ category: 'console', message: 'sensitive' }), null);
  assert.equal(config.beforeBreadcrumb!({ category: 'fetch', message: 'sensitive' }), null);
  assert.deepEqual(config.beforeBreadcrumb!({ category: 'game.attempt' }), { category: 'game.attempt' });
  const shouldTrace = integrations.find(item => item.name === 'BrowserTracing')!.options!.shouldCreateSpanForRequest as (url: string) => boolean;
  assert.equal(shouldTrace('/api/learning/finish'), true);
  assert.equal(shouldTrace('/api/learning/live'), false);
  assert.equal(shouldTrace('https://other.example/api/learning/finish'), false);
});

test('server retains uncaught error handling and request tracing without console, local variables, or AI monitoring', () => {
  const { configurations: [config] } = loadConfig('server', { SENTRY_DSN: 'test-dsn' });
  const names = config.integrations(['OnUncaughtException', 'OnUnhandledRejection', 'Http', 'NodeFetch', 'Console', 'LocalVariables', 'RequestData', 'ChildProcess', 'OpenAI', 'Anthropic_AI', 'Google_GenAI', 'LangChain', 'LangGraph', 'VercelAI'].map(name => ({ name }))).map(item => item.name);
  assert.deepEqual(Array.from(names), ['OnUncaughtException', 'OnUnhandledRejection', 'Http', 'NodeFetch']);
  assert.equal(config.tracesSampleRate, 0.1);
  assert.equal(config.enableLogs, false);
  assert.equal(config.includeLocalVariables, false);
});

test('errors and transactions remove request bodies, user data, extras, and unrelated breadcrumbs', () => {
  assert.deepEqual(gameDataCollection.httpBodies, []);
  assert.equal(gameDataCollection.userInfo, false);
  assert.equal(gameDataCollection.cookies, false);
  assert.equal(gameDataCollection.httpHeaders, false);
  assert.equal(gameDataCollection.urlQueryParams, false);
  assert.equal(gameDataCollection.stackFrameVariables, false);
  for (const runtime of ['client', 'server'] as const) {
    const config = loadConfig(runtime, { SENTRY_DSN: 'test-dsn', NEXT_PUBLIC_SENTRY_DSN: 'test-dsn' }).configurations[0];
    for (const scrub of [config.beforeSend, config.beforeSendTransaction]) {
      const event = scrub({
        event_id: 'a'.repeat(32), request: { data: 'secret-body', headers: { Authorization: 'secret-token' } },
        user: { email: 'private@example.com' }, extra: { localStorage: 'private' },
        breadcrumbs: [{ category: 'console', message: 'secret' }, { category: 'game.attempt', message: 'Opening stretch started' }],
        exception: { values: [{ type: 'Error', value: 'Game render failed', stacktrace: { frames: [{ filename: 'components/Scene.tsx', lineno: 12 }] } }] },
      });
      assert.equal(event.request, undefined);
      assert.equal(event.user, undefined);
      assert.equal(event.extra, undefined);
      assert.deepEqual(event.breadcrumbs, [{ category: 'game.attempt', message: 'Opening stretch started' }]);
      assert.equal(event.exception?.values?.[0].stacktrace?.frames?.[0].lineno, 12);
    }
  }
});

test('trace sample rates keep a bounded explicit override and safe default', () => {
  for (const value of [undefined, '', 'bad', '-1', '1.1', 'Infinity']) assert.equal(traceSampleRate(value), 0.1);
  assert.equal(traceSampleRate('0'), 0);
  assert.equal(traceSampleRate('1'), 1);
  assert.equal(traceSampleRate('0.25'), 0.25);
});
