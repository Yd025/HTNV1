// Run from frontend: node --test tests/gameLearningApi.test.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");

const source = fs.readFileSync(path.resolve(__dirname, "../pages/api/game-learning.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const attemptId = "12345678-1234-4123-8123-123456789abc";

async function invoke({ method = "GET", query = {}, upstream, serviceUrl } = {}) {
  const calls = [], timers = [], cleared = [], exports = {};
  vm.runInNewContext(compiled, {
    exports, Buffer, URL, AbortController,
    process: { env: { GAME_SERVICE_URL: serviceUrl } },
    setTimeout: (callback, milliseconds) => {
      const timer = { callback, milliseconds };
      timers.push(timer);
      return timer;
    },
    clearTimeout: timer => cleared.push(timer),
    fetch: async (url, options) => {
      calls.push({ url, options });
      return typeof upstream === "function" ? upstream(url, options) : (upstream || Response.json({ total: 0 }));
    },
  });
  const response = {
    headers: {}, code: null, body: null,
    setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.code = code; return this; },
    json(body) { this.body = JSON.parse(JSON.stringify(body)); return this; },
  };
  await exports.default({ method, query }, response);
  return { response, calls, timers, cleared };
}

test("dashboard requests retain the fixed route, safe fetch options, and short timeout", async () => {
  const result = await invoke({
    serviceUrl: "https://game.example:444/base?token=ignored",
    query: { url: "https://unrelated.example/", action: "finish" },
    upstream: Response.json({ total: 9 }),
  });
  assert.equal(result.response.code, 200);
  assert.deepEqual(result.response.body, { total: 9 });
  assert.equal(result.calls[0].url.href, "https://game.example:444/api/learning/dashboard");
  assert.equal(result.calls[0].options.cache, "no-store");
  assert.equal(result.calls[0].options.redirect, "error");
  assert.ok(result.calls[0].options.signal instanceof AbortSignal);
  assert.equal(result.response.headers["Cache-Control"], "no-store, max-age=0");
  assert.equal(result.timers[0].milliseconds, 5000);
  assert.deepEqual(result.cleared, result.timers);
});

test("a saved replay request forwards only its UUID to the fixed replay route", async () => {
  const payload = { attempt: { id: attemptId }, layout: { version: 2 }, frames: [{ t: 0 }, { t: 14 }] };
  const result = await invoke({ query: { attemptId, url: "http://unrelated.example/", token: "ignored" }, upstream: Response.json(payload) });
  assert.equal(result.response.code, 200);
  assert.deepEqual(result.response.body, payload);
  assert.equal(result.calls[0].url.href, `http://127.0.0.1:3100/api/learning/replay?attemptId=${attemptId}`);
  assert.equal(result.timers[0].milliseconds, 20000);
  assert.deepEqual(result.cleared, result.timers);
});

test("non-GET requests never contact the game server", async () => {
  for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
    const result = await invoke({ method });
    assert.equal(result.response.code, 405);
    assert.equal(result.response.headers.Allow, "GET");
    assert.deepEqual(result.response.body, { error: "Only GET is supported." });
    assert.equal(result.calls.length, 0);
    assert.equal(result.timers.length, 0);
  }
});

test("missing-format, duplicate, and path-like replay identifiers are rejected before fetch", async () => {
  for (const value of ["", "not-a-uuid", "../dashboard", `${attemptId}/../dashboard`, `${attemptId}?token=x`, [attemptId], [attemptId, attemptId], "12345678-1234-1123-8123-123456789abc"]) {
    const result = await invoke({ query: { attemptId: value } });
    assert.equal(result.response.code, 400, JSON.stringify(value));
    assert.equal(result.calls.length, 0);
    assert.equal(result.timers.length, 0);
  }
});

test("known replay errors are friendly without exposing upstream error details", async () => {
  for (const [status, expected] of [[404, "This saved attempt is no longer available to replay. Choose another attempt."], [429, "Saved replays are busy right now. Try again in a moment."]]) {
    const result = await invoke({ query: { attemptId }, upstream: Response.json({ error: "SECRET internal archive path" }, { status }) });
    assert.equal(result.response.code, status);
    assert.deepEqual(result.response.body, { error: expected });
    assert.equal(result.calls[0].options.signal.aborted, true);
    assert.deepEqual(result.cleared, result.timers);
  }
});

test("other upstream failures remain generic and do not leak internals", async () => {
  for (const options of [
    { upstream: Response.json({ error: "SECRET" }, { status: 500 }) },
    { upstream: Response.json({ error: "SECRET" }, { status: 404 }) },
    { query: { attemptId }, upstream: Response.json({ error: "SECRET" }, { status: 401 }) },
    { upstream: () => { throw new Error("SECRET"); } },
    { upstream: new Response("SECRET invalid JSON") },
    { serviceUrl: "file:///SECRET/archive" },
  ]) {
    const result = await invoke(options);
    assert.equal(result.response.code, 502);
    assert.match(result.response.body.error, /Cannot reach the game service/);
    assert.doesNotMatch(result.response.body.error, /SECRET/);
    assert.deepEqual(result.cleared, result.timers);
  }
});

test("the response size limit includes all streamed chunks and cancels oversized replay responses", async () => {
  let cancelled = false;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(4 * 1024 * 1024));
      controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1));
    },
    cancel() { cancelled = true; },
  });
  const result = await invoke({ query: { attemptId }, upstream: new Response(body) });
  assert.equal(result.response.code, 502);
  assert.equal(cancelled, true);
  assert.deepEqual(result.cleared, result.timers);
});

test("JSON can span response chunks without losing replay frames", async () => {
  const body = new ReadableStream({
    start(controller) {
      for (const text of ['{"frames":[', '{"t":0},', '{"t":1}]}']) controller.enqueue(Buffer.from(text));
      controller.close();
    },
  });
  const result = await invoke({ query: { attemptId }, upstream: new Response(body) });
  assert.equal(result.response.code, 200);
  assert.deepEqual(result.response.body, { frames: [{ t: 0 }, { t: 1 }] });
});
