const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../lib/graphLiveMetrics.ts"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
const exportsForTest = {};
vm.runInNewContext(compiled, { exports: exportsForTest });
const { computeLiveMetrics, liveSeries } = exportsForTest;
const plain = value => JSON.parse(JSON.stringify(value));
const drone = (id, x, y, z = 60) => ({ id, x, y, z, heading: 0 });
const frame = (t, extra = {}) => ({ t, boat: { x: 0, y: 0 }, drones: [drone("quad", 0, 0)], sources: [], coveragePct: 0, estimate: null, trackingSource: null, ...extra });
const replay = frames => ({ seed: 1, towers: [{ id: "tower-1", x: 0, y: 0, z: 2.7, heading: 0 }], frames,
  metrics: { detectionRate: 100, meanCappedS: 0, p90CappedS: 0, coveragePct: 99, custodyPct: 99, rmseM: 1, estimateAvailabilityPct: 99, distanceM: 99999, handoffs: 999 } });

test("future frames and final mission scores cannot influence live prefix values or charts", () => {
  const first = frame(0, { coveragePct: 3 });
  const second = frame(5, { drones: [drone("quad", 3, 4)], coveragePct: 8 });
  const current = replay([first, second, frame(10, { sources: ["plane"], estimate: { x: 0, y: 0 }, coveragePct: 90 })]);
  const poisoned = { t: 10 };
  for (const key of ["boat", "drones", "sources", "coveragePct", "estimate", "trackingSource"]) {
    Object.defineProperty(poisoned, key, { get() { throw new Error(`Read future ${key}`); } });
  }
  const alternate = replay([first, second, poisoned]);
  Object.defineProperty(alternate, "metrics", { get() { throw new Error("Read final metrics"); } });
  Object.defineProperty(alternate, "firstDetectionS", { get() { throw new Error("Read future detection"); } });
  assert.deepEqual(plain(computeLiveMetrics(current, 7)), plain(computeLiveMetrics(alternate, 7)));
  assert.deepEqual(plain(liveSeries(current, 7)), plain(liveSeries(alternate, 7)));
  const live = computeLiveMetrics(current, 7);
  assert.equal(live.detected, false);
  assert.equal(live.detectedAt, null);
  assert.equal(live.observedThroughS, 5);
  assert.equal(live.samples, 2);
  assert.equal(live.distanceM, 5);
  assert.equal(live.coveragePct, 8);
  assert.equal(live.bySource.plane, undefined, "future asset identities do not leak into counts");
});

test("time-zero detection is preserved and no sample has explicit empty statistics", () => {
  const mission = replay([frame(0, { sources: ["tower-1"], trackingSource: "tower-1", estimate: { x: 3, y: 4 }, coveragePct: 2 })]);
  const live = computeLiveMetrics(mission, 0);
  assert.equal(live.detectedAt, 0);
  assert.equal(live.detected, true);
  assert.equal(live.samples, 1);
  assert.equal(live.custodyPct, 100);
  assert.equal(live.rmseM, 5);
  assert.equal(live.distanceM, 0);
  const empty = computeLiveMetrics(replay([]), 0);
  assert.equal(empty.samples, 0);
  assert.equal(empty.observedThroughS, 0);
  assert.equal(empty.detectedAt, null);
  assert.equal(empty.rmseM, null);
  assert.equal(empty.custodyPct, 0);
  assert.deepEqual(plain(liveSeries(replay([frame(5)]), 4)), []);
});

test("fresh estimates expire at the declared boundary and misses remain in the denominator", () => {
  const mission = replay([
    frame(0, { sources: ["quad"], trackingSource: "quad", estimate: { x: 3, y: 4 } }),
    frame(5, { estimate: { x: 0, y: 12 } }),
    frame(10, { estimate: { x: 0, y: 0 } }),
    frame(15, { estimate: { x: 1000, y: 1000 } }),
    frame(20),
  ]);
  const live = computeLiveMetrics(mission, 20);
  assert.equal(live.samples, 5);
  assert.equal(live.custodyPct, 60);
  assert.equal(live.estimateAvailabilityPct, 60);
  assert.equal(live.rmseM, Math.sqrt((25 + 144) / 3));
  assert.equal(computeLiveMetrics(mission, 20, 5).custodyPct, 40);
  const missed = computeLiveMetrics(replay([frame(0), frame(5), frame(10)]), 10);
  assert.equal(missed.detectedAt, null);
  assert.equal(missed.custodyPct, 0);
  assert.equal(missed.rmseM, null);
});

test("drone distance is horizontal, tracks IDs and does not invent transit across missing poses", () => {
  const mission = replay([
    frame(0, { drones: [drone("quad", 0, 0), drone("plane", 10, 0)] }),
    frame(5, { drones: [drone("plane", 10, 12, 1000), drone("quad", 3, 4, 1000)] }),
    frame(10, { drones: [drone("plane", 10, 12, 2000)] }),
    frame(15, { drones: [drone("plane", 10, 12, 3000), drone("quad", 100, 100)] }),
  ]);
  assert.equal(computeLiveMetrics(mission, 15).distanceM, 17);
  assert.deepEqual(plain(computeLiveMetrics(mission, 15).bySource), { "tower-1": 0, quad: 0, plane: 0 });
});

test("handoffs use the reporting source, retain identity across gaps and count unique samples", () => {
  const mission = replay([
    frame(0, { sources: ["quad", "tower-1", "quad"], trackingSource: "quad" }),
    frame(5),
    frame(10, { sources: ["tower-1", "quad"], trackingSource: "quad" }),
    frame(15),
    frame(20, { sources: ["tower-1"], trackingSource: "tower-1" }),
    frame(25, { sources: [], trackingSource: "quad" }),
    frame(30, { sources: ["quad"], trackingSource: "quad" }),
  ]);
  const live = computeLiveMetrics(mission, 30);
  assert.equal(live.handoffs, 2);
  assert.deepEqual(plain(live.bySource), { "tower-1": 3, quad: 3 });
  assert.equal(computeLiveMetrics(mission, 15).handoffs, 0);
});

test("rewinding or changing tower layouts resets the prefix without shared state or input mutation", () => {
  const original = replay([frame(0), frame(5, { sources: ["quad"], estimate: { x: 3, y: 4 }, coveragePct: 20 })]);
  const edited = replay([frame(0, { sources: ["tower-1"], estimate: { x: 0, y: 0 }, trackingSource: "tower-1", coveragePct: 70 }), frame(5)]);
  const before = JSON.stringify({ original, edited });
  const early = plain(computeLiveMetrics(original, 0));
  computeLiveMetrics(original, 300);
  const other = computeLiveMetrics(edited, 5);
  assert.equal(other.detectedAt, 0);
  assert.deepEqual(plain(computeLiveMetrics(original, 0)), early);
  assert.equal(computeLiveMetrics(original, 5).detectedAt, 5);
  assert.equal(JSON.stringify({ original, edited }), before);
  const chart = liveSeries(original, 5);
  const final = computeLiveMetrics(original, 5);
  for (const key of ["coveragePct", "custodyPct", "estimateAvailabilityPct", "rmseM", "distanceM"]) assert.equal(chart[1][key], final[key]);
});

test("invalid playback times fail explicitly", () => {
  for (const invalid of [-1, NaN, Infinity, -Infinity]) {
    assert.throws(() => computeLiveMetrics(replay([]), invalid));
    assert.throws(() => computeLiveMetrics(replay([]), 0, invalid));
    assert.throws(() => liveSeries(replay([]), invalid));
  }
});

test("complete prefixes reproduce every saved benchmark replay's mission statistics", () => {
  const report = JSON.parse(fs.readFileSync(path.join(__dirname, "../public/experiments/graph-report.json"), "utf8"));
  assert.equal(report.replays.length, 200);
  for (const mission of report.replays) {
    const actual = computeLiveMetrics(mission, report.protocol.horizonS, report.protocol.freshnessS);
    const expected = mission.metrics;
    assert.equal(actual.detected, expected.detectionRate > 0);
    assert.equal(actual.detectedAt, expected.detectedAt);
    for (const key of ["coveragePct", "custodyPct", "estimateAvailabilityPct", "distanceM", "handoffs"]) {
      assert.ok(Math.abs(actual[key] - expected[key]) < 1e-6, `${mission.seed} ${key}: ${actual[key]} vs ${expected[key]}`);
    }
    if (expected.rmseM === null) assert.equal(actual.rmseM, null);
    else assert.ok(Math.abs(actual.rmseM - expected.rmseM) < 1e-6, `${mission.seed} RMSE`);
    assert.deepEqual(plain(actual.bySource), expected.bySource);
  }
});
