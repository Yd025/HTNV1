// Run from frontend: node --test tests/telemetry.test.cjs
// Optionally set TELEMETRY_TEST_PYTHON to verify actual backend serializers too.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");
const assert = require("node:assert/strict");
const { test } = require("node:test");
const ts = require("typescript");

const frontend = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(frontend, "hooks/useMissionTelemetry.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;

function createHarness() {
  let time = 0, timerId = 0, stateCursor = 0, effectCursor = 0, dirty = false, output;
  const timers = new Map(), slots = [], effectSlots = [], pendingEffects = [];
  const react = {
    useState(initial) {
      const slot = stateCursor++;
      if (!(slot in slots)) slots[slot] = initial;
      return [slots[slot], (next) => {
        const value = typeof next === "function" ? next(slots[slot]) : next;
        if (!Object.is(value, slots[slot])) { slots[slot] = value; dirty = true; }
      }];
    },
    useEffect(effect, deps) {
      const index = effectCursor++;
      const previous = effectSlots[index];
      if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
        previous?.cleanup?.();
        effectSlots[index] = { deps };
        pendingEffects.push(() => { effectSlots[index].cleanup = effect(); });
      }
    },
    useMemo(factory) { return factory(); },
  };
  const browserWindow = {
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id, { callback, due: time + delay }); return id; },
    setInterval(callback, delay) { const id = ++timerId; timers.set(id, { callback, due: time + delay, interval: delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    clearInterval(id) { timers.delete(id); },
  };
  class FakeSocket {
    static instances = [];
    constructor(url) { this.url = url; FakeSocket.instances.push(this); }
    open() { this.onopen?.({}); }
    message(value) { this.onmessage?.({ data: typeof value === "string" ? value : JSON.stringify(value) }); }
    fail() { this.onerror?.({}); }
    close() { this.closed = true; this.onclose?.({ code: 1000 }); }
  }
  const moduleExports = {};
  vm.runInNewContext(compiled, {
    exports: moduleExports,
    require: (name) => { assert.equal(name, "react"); return react; },
    process: { env: {} }, performance: { now: () => time }, Date,
    window: browserWindow, WebSocket: FakeSocket,
  });
  function flush() {
    do {
      dirty = false; stateCursor = 0; effectCursor = 0;
      output = moduleExports.useMissionTelemetry();
      while (pendingEffects.length) pendingEffects.shift()();
    } while (dirty);
  }
  function advance(milliseconds) {
    const target = time + milliseconds;
    let due;
    while ((due = [...timers].filter(([, timer]) => timer.due <= target).sort((a, b) => a[1].due - b[1].due)[0])) {
      const [id, timer] = due; time = timer.due;
      if (timer.interval) timer.due += timer.interval; else timers.delete(id);
      timer.callback(); flush();
    }
    time = target; flush();
  }
  return {
    parse: moduleExports.parseTelemetryMessage, flush, advance, timers,
    get output() { return output; }, sockets: FakeSocket.instances,
    cleanup() { effectSlots.forEach((effect) => effect.cleanup?.()); },
  };
}

const base = {
  type: "state", adapter: "local", deployed: true, heartbeat: 123, tick_hz: 10, fleet: {},
  scores: { coverage: 0, collaboration: 0, efficiency: 0, tracking: 0, track_error_m: null },
  track: null, truth: null, advisor: null, heatmap: [], detections: [], commands: [], blackboard: [],
  arena: { origin_lat: 74.6973, origin_lon: -94.8297, half_m: 1500 },
};

test("parser accepts the wire contract and rejects malformed/warming frames", () => {
  const { parse } = createHarness();
  assert.equal(parse(JSON.stringify(base)).kind, "state");
  for (const invalid of [
    "{", "null", "[]", JSON.stringify({ status: "warming" }),
    JSON.stringify({ type: "state", status: "warming" }), JSON.stringify({ type: "state" }),
    JSON.stringify({ ...base, fleet: [] }),
    JSON.stringify({ ...base, track: { lat: "bad", lon: 1 } }),
    JSON.stringify({ ...base, heatmap: [{ lat: 999, lon: 1, heat: 1 }] }),
    JSON.stringify({ ...base, advisor: { rationale: {} } }),
  ]) assert.equal(parse(invalid), null);
  assert.equal(parse(JSON.stringify({ type: "strategy", data: null })).strategy, null);
  assert.equal(parse(JSON.stringify({ ...base, commands: [{ vehicle_id: "plane-1", type: "hold", lat: null, lon: null, alt: null, sector: null }] })).kind, "state");
});

test("stream lifecycle retains state, measures actual traffic, and reconnects safely", () => {
  const harness = createHarness();
  const { flush, advance, sockets } = harness;
  flush();
  assert.equal(sockets.length, 1);
  assert.equal(harness.output.hasReceived, false);
  assert.equal(harness.output.receivedHz, null);
  const first = sockets[0];
  first.open(); flush();
  assert.equal(harness.output.connection, "live");
  assert.equal(harness.output.isFresh, false);
  first.message({ status: "warming" }); flush();
  assert.equal(harness.output.frameCount, 0);
  first.message(base); flush();
  assert.equal(harness.output.isFresh, true);
  assert.equal(harness.output.frameCount, 1);
  first.message({ type: "strategy", data: { rationale: "Observed advice" } }); flush();
  assert.equal(harness.output.strategy.rationale, "Observed advice");
  assert.equal(harness.output.frameCount, 1);
  first.message("{"); flush();
  assert.equal(harness.output.frameCount, 1);
  assert.equal(harness.output.state.adapter, "local");
  advance(100); first.message(base); flush();
  assert.equal(harness.output.strategy, null);
  assert.equal(harness.output.receivedHz, 10);
  first.fail(); flush();
  assert.equal(harness.output.connection, "down");
  assert.equal(harness.output.isFresh, false);
  assert.match(harness.output.error, /Retrying in 1 s/);
  advance(1000);
  assert.equal(sockets.length, 2);
  assert.equal(harness.output.reconnects, 1);
  const second = sockets[1]; second.open(); flush();
  assert.equal(harness.output.isFresh, false);
  assert.equal(harness.output.state.adapter, "local");
  second.fail(); flush();
  assert.match(harness.output.error, /Retrying in 2 s/);
  advance(2000);
  const third = sockets[2]; third.open(); third.message(base); flush();
  assert.equal(harness.output.isFresh, true);
  assert.equal(harness.output.frameCount, 3);
  advance(6000);
  assert.equal(harness.output.isFresh, false);
  assert.ok(harness.output.ageSeconds >= 5);
  third.fail(); flush();
  assert.match(harness.output.error, /Retrying in 1 s/);
  const socketCount = sockets.length;
  harness.cleanup(); advance(30000);
  assert.equal(sockets.length, socketCount);
  assert.equal(harness.timers.size, 0);
});

test("a silent handshake times out and reconnect delays remain capped", () => {
  const harness = createHarness();
  harness.flush(); harness.advance(10000);
  assert.equal(harness.output.connection, "down");
  assert.match(harness.output.error, /timed out/);
  harness.advance(1000);
  for (const delay of [2, 4, 8, 15, 15]) {
    harness.sockets.at(-1).fail(); harness.flush();
    assert.match(harness.output.error, new RegExp(`Retrying in ${delay} s`));
    harness.advance(delay * 1000);
  }
  harness.cleanup();
  assert.equal(harness.timers.size, 0);
});

const python = process.env.TELEMETRY_TEST_PYTHON;
test("parser accepts snapshots serialized by the actual backend classes", { skip: python ? false : "Set TELEMETRY_TEST_PYTHON to a Python 3 executable" }, () => {
  // Constructor + snapshot only: never connect, tick, run, poll, or send commands.
  // -B prevents writes to backend __pycache__; everything remains in memory.
  const snapshotCode = `
import json
from brain import SwarmBrain
from metrics import MetricsEngine
from sim.local_sitl import LocalSitlAdapter
from sim.types import VehicleState, Detection, Command
from tracker import Track

adapter = LocalSitlAdapter()
brain = SwarmBrain(adapter)
snapshots = [brain.snapshot()]
lat, lon = adapter.arena().origin_lat, adapter.arena().origin_lon
brain.world.vehicles = {
    kind: VehicleState(vehicle_id=kind, sysid=index + 1, vehicle_class=kind,
        lat=lat, lon=lon, role=role, connected=index % 2 == 0, mavlink=False)
    for index, (kind, role) in enumerate([
        ("plane", "search"), ("copter", "track"), ("rover", "confirm"), ("tower", "cue")
    ])
}
brain.world.track = Track(lat=lat, lon=lon)
brain.world.detections = [Detection("tower", lat, lon, "vessel", 0.6, 123456.0)]
brain.world.post("tower", "copter", "cue", {"lat": lat, "lon": lon})
brain.commands_last = [
    Command("plane", "hold"),
    Command("copter", "goto", lat, lon, alt=40.0),
    Command("plane", "search_sector", lat, lon, alt=90.0, sector=1),
]
brain.metrics = MetricsEngine(adapter.arena())
brain.metrics.heatmap = [{"lat": lat, "lon": lon, "heat": 0.5}]
brain.world.advisor = {"role_bias": {"plane": "search"}, "rationale": "Fixture advice", "intercept": {"lat": lat, "lon": lon}, "ts": "2026-09-19T12:00:00Z"}
snapshots.append(brain.snapshot())
brain.world.advisor = None
brain.world.track = None
snapshots.append(brain.snapshot())
print(json.dumps(snapshots, allow_nan=False))
`;
  const result = spawnSync(python, ["-B", "-c", snapshotCode], {
    cwd: path.resolve(frontend, "../backend"), encoding: "utf8", timeout: 15000,
    env: { ...process.env, FORCE_KINEMATIC: "1", ADAPTER: "local", PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const snapshots = JSON.parse(result.stdout);
  const { parse } = createHarness();
  for (const [index, snapshot] of snapshots.entries()) {
    assert.equal(parse(JSON.stringify(snapshot))?.kind, "state", `backend snapshot ${index} was rejected`);
  }
  assert.equal(snapshots.length, 3);
  assert.equal(Object.keys(snapshots[1].fleet).length, 4);
  assert.equal(snapshots[1].commands[0].lat, null);
  assert.equal(snapshots[2].advisor, null);
});
