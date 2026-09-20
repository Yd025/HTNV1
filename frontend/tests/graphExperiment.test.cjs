const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const ts = require("typescript");

function load(file, globals = {}) {
  const exports = {};
  const source = fs.readFileSync(path.resolve(__dirname, "..", file), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  vm.runInNewContext(compiled, { exports, URL, ...globals });
  return exports;
}
const { nearestSource, cameraFootprint, nearestCell, gridPoint, drawFrame, isTowerFirstReport } = load("lib/graphExperiment.ts");

test("legacy reports cannot be relabeled as verified tower-first evaluation", () => {
  assert.equal(isTowerFirstReport({ replays: [{ frames: [{ t: 0 }] }] }), false);
  assert.equal(isTowerFirstReport({ missionVersion: "tower-first-v2", replays: [{ frames: [{ t: 0 }] }] }), false);
  assert.equal(isTowerFirstReport({ missionVersion: "tower-first-v2", replays: [{ frames: [{ targetConfirmed: false }] }] }), true);
});

test("an accepted false contact guide uses its estimate instead of the hidden true boat", () => {
  const frame = { phase: "dispatch", boat: { x: 0, y: 0 }, estimate: { x: 1000, y: 0 }, acceptedSources: ["tower-1"], sources: ["tower-1"], drones: [] };
  const towers = [{ id: "tower-1", x: 1100, y: 0 }];
  assert.equal(nearestSource(frame, towers, true).distanceM, 100);
  assert.equal(nearestSource(frame, towers, false).distanceM, 1100);
  assert.equal(nearestSource({ ...frame, estimate: null }, towers, true), null);
});

test("smooth drawing interpolates position and wrapped headings without revealing future detections", () => {
  const first = { t: 0, boat: { x: 0, y: 0 }, drones: [{ id: "plane", x: 0, y: 0, z: 100, heading: 350 }], sources: [], towerHeadings: [350, 90], estimate: null };
  const last = { t: 5, boat: { x: 10, y: 0 }, drones: [{ id: "plane", x: 50, y: 0, z: 100, heading: 10 }], sources: ["plane"], towerHeadings: [20, 120], estimate: { x: 10, y: 0 } };
  const replay = { frames: [first, last] };
  const halfway = drawFrame(replay, 2.5);
  assert.equal(halfway.boat.x, 5); assert.equal(halfway.drones[0].x, 25); assert.equal(halfway.drones[0].heading, 0);
  assert.equal(halfway.towerHeadings[0], 5); assert.equal(halfway.sources.length, 0); assert.equal(halfway.estimate, null);
  assert.equal(drawFrame(replay, 5), last); assert.equal(drawFrame(replay, 0).boat.x, 0);
  assert.equal(first.boat.x, 0); assert.equal(first.towerHeadings[0], 350);
});

test("nearest reporting sensor excludes closer sensors with no observation and breaks ties consistently", () => {
  const frame = { boat: { x: 0, y: 0 }, sources: ["plane", "tower-2"], drones: [{ id: "plane", x: 0, y: 200 }] };
  const towers = [{ id: "tower-1", x: 1, y: 0 }, { id: "tower-2", x: 200, y: 0 }];
  assert.equal(nearestSource(frame, towers, true).source.id, "plane");
  assert.equal(nearestSource(frame, towers, false).source.id, "tower-1");
  assert.equal(nearestSource({ ...frame, sources: [] }, towers, true), null);
  assert.equal(nearestSource(frame, towers, true).distanceM, 200);
});

test("camera footprint uses an optical depth plane rather than truncating the field to a radius", () => {
  const sensor = { hfovDeg: 60, vfovDeg: 40, farClipM: 1500, nearClipM: .1, pitchDeg: 0 };
  const polygon = cameraFootprint({ x: 0, y: 0, z: 1.5, heading: 0 }, sensor);
  assert.ok(polygon.length >= 4);
  assert.ok(polygon.every(p => p.y >= .1 - 1e-8 && p.y <= 1500 + 1e-8));
  assert.ok(polygon.some(p => Math.hypot(p.x, p.y) > 1700));
  assert.ok(polygon.some(p => Math.abs(p.x - 1500 / Math.sqrt(3)) < 1e-8));
  const down = cameraFootprint({ x: 0, y: 0, z: 101.5, heading: 0 }, { ...sensor, pitchDeg: -90 });
  assert.ok(down.every(p => Math.abs(p.x) <= 100 / Math.sqrt(3) + 1e-8 && Math.abs(p.y) <= 100 * Math.tan(Math.PI / 9) + 1e-8));
});

test("map editing snaps to the appropriate source-derived water or land grid", () => {
  const profile = { grid: { size: 3, halfM: 100, cellM: 100, water: [false, false, false, false, true, true, false, true, false], waterEdges: [[4, 5]], landCandidates: [0, 2, 6, 8] } };
  assert.equal(nearestCell(profile, { x: 90, y: 20 }, true), 5);
  assert.equal(nearestCell(profile, { x: 90, y: 20 }, false), 8);
  assert.equal(gridPoint(profile, 0).y, -100);
  assert.equal(gridPoint(profile, 8).y, 100);
  assert.equal(nearestCell(profile, { x: 0, y: 100 }, true), 4, "isolated water cannot be selected as a boat route start");
});

function harness() {
  const spawns = [], writes = [], child = new EventEmitter();
  let sequence = 0;
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
  const handler = load("pages/api/graph-experiment.ts", {
    process: { cwd: () => "C:/project/frontend", platform: "win32", env: { GRAPH_PYTHON: "C:/Python/python.exe" } },
    setTimeout: () => 1, clearTimeout: () => {},
    require: name => {
      if (name === "node:child_process") return { spawn: (...args) => { spawns.push(args); return child; } };
      if (name === "node:crypto") return { randomUUID: () => sequence++ ? `job-${sequence}` : "fixed-job-id" };
      if (name === "node:fs") return { existsSync: () => true };
      if (name === "node:fs/promises") return { mkdir: async () => {}, writeFile: async (...args) => writes.push(args), readFile: async () => '{"ok":true}' };
      if (name === "node:path") return path.win32;
      throw new Error(`Unexpected dependency: ${name}`);
    },
  }).default;
  const request = (overrides = {}) => ({ method: "POST", headers: { host: "127.0.0.1:3003", origin: "http://127.0.0.1:3003", "content-type": "application/json" }, socket: { remoteAddress: "127.0.0.1" }, body: { kind: "train", seed: 42 }, query: {}, ...overrides });
  async function invoke(req) {
    const result = { headers: {} };
    const res = { setHeader: (key, value) => { result.headers[key] = value; }, status(code) { result.status = code; return this; }, json(body) { result.body = body; return this; } };
    await handler(req, res); return result;
  }
  return { request, invoke, spawns, writes, child };
}

test("training rejects remote clients and foreign origins before spawning", async () => {
  const h = harness();
  assert.equal((await h.invoke(h.request({ socket: { remoteAddress: "10.0.0.2" } }))).status, 403);
  assert.equal((await h.invoke(h.request({ headers: { host: "127.0.0.1:3003", origin: "https://elsewhere.example", "content-type": "application/json" } }))).status, 403);
  assert.equal(h.spawns.length, 0);
});

test("training input rejects non-finite and out-of-bounds values without file writes", async () => {
  const h = harness();
  for (const body of [{ kind: "anything", seed: 1 }, { kind: "train", seed: -1 }, { kind: "train", seed: 1.5 }, { kind: "replay", seed: 1, boatStart: { x: 9000, y: 0 } }, { kind: "replay", seed: 1, towers: [{ x: NaN, y: 0 }, { x: 0, y: 0 }] }]) {
    assert.equal((await h.invoke(h.request({ body }))).status, 400);
  }
  assert.equal(h.spawns.length, 0); assert.equal(h.writes.length, 0);
});

test("training uses fixed script arguments, no shell, and allows only one running experiment", async () => {
  const h = harness();
  const result = await h.invoke(h.request({ body: { kind: "train", seed: 42, command: "untrusted", output: "outside" } }));
  assert.equal(result.status, 202); assert.equal(h.spawns.length, 1);
  const [command, args, options] = h.spawns[0];
  assert.equal(command, "C:/Python/python.exe"); assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
  assert.equal(options.env.ADAPTER, "local"); assert.ok(args.some(a => a.endsWith("train_graph_search.py")));
  assert.ok(!args.includes("untrusted")); assert.ok(!args.includes("outside"));
  assert.equal((await h.invoke(h.request())).status, 409);
  h.child.emit("close", 0);
  const done = await h.invoke(h.request({ method: "GET", query: { id: "fixed-job-id" } }));
  assert.equal(done.body.status, "complete"); assert.equal(done.body.result.ok, true);
});

test("replay serializes coordinates as data and reports Python launch failure", async () => {
  const h = harness();
  const result = await h.invoke(h.request({ body: { kind: "replay", seed: 42, towers: [{ x: 100, y: 200, heading: 725 }, { x: -100, y: -200 }] } }));
  assert.equal(result.status, 202);
  const payload = JSON.parse(h.writes[0][1]);
  assert.equal(payload.towers[0].heading, 5); assert.equal(payload.towers[1].id, "tower-2");
  h.child.emit("error", new Error("Python missing"));
  const failed = await h.invoke(h.request({ method: "GET", query: { id: "fixed-job-id" } }));
  assert.equal(failed.body.status, "failed"); assert.match(failed.body.error, /GRAPH_PYTHON/);
});

test("simultaneous requests reserve a single process before asynchronous setup", async () => {
  const h = harness();
  const results = await Promise.all([h.invoke(h.request()), h.invoke(h.request())]);
  assert.deepEqual(results.map(r => r.status).sort(), [202, 409]);
  assert.equal(h.spawns.length, 1);
  h.child.emit("close", 0);
});

test("many random replays do not evict the trained model they depend on", async () => {
  const h = harness(); h.child.setMaxListeners(100); h.child.stdout.setMaxListeners(100); h.child.stderr.setMaxListeners(100);
  await h.invoke(h.request()); h.child.emit("close", 0);
  for (let i = 0; i < 33; i++) {
    const r = await h.invoke(h.request({ body: { kind: "replay", seed: i, modelJob: "fixed-job-id" } }));
    assert.equal(r.status, 202); h.child.emit("close", 0);
  }
  const model = await h.invoke(h.request({ method: "GET", query: { id: "fixed-job-id", download: "model" } }));
  assert.equal(model.status, 200); assert.equal(model.body.ok, true);
});

test("page reload recovers the latest training job without starting another process", async () => {
  const h = harness();
  const latest = () => h.invoke(h.request({ method: "GET", query: { latestTraining: "1" } }));
  assert.equal((await latest()).body.status, "idle");
  await h.invoke(h.request());
  assert.equal((await latest()).body.id, "fixed-job-id");
  assert.equal((await latest()).body.status, "running");
  h.child.emit("close", 0);
  const complete = await latest();
  assert.equal(complete.body.status, "complete");
  assert.equal(complete.body.result.ok, true);
  await h.invoke(h.request({ body: { kind: "replay", seed: 9 } }));
  assert.equal((await latest()).body.id, "fixed-job-id");
  h.child.emit("close", 0);
  const next = await h.invoke(h.request({ body: { kind: "train", seed: 10 } }));
  assert.equal((await latest()).body.id, next.body.id);
  assert.equal(h.spawns.length, 3);
  assert.equal((await h.invoke(h.request({ method: "GET", query: { latestTraining: "1" }, socket: { remoteAddress: "10.0.0.2" } }))).status, 403);
  h.child.emit("close", 0);
});
