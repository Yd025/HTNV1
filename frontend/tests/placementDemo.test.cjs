// Run from frontend: node --test tests/placementDemo.test.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../lib/placementDemo.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;
const exportsForTest = {};
vm.runInNewContext(compiled, { exports: exportsForTest });
const { clampPoint, towerHeading, inTowerView, boatPosition, evaluateRoute } = exportsForTest;
const plain = (value) => JSON.parse(JSON.stringify(value));
const tower = { id: "one", label: "Tower 1", north: 0, east: 0, heading: 0, rangeM: 1000, fovDeg: 20 };
const stationary = (north, east) => ({ start: { north, east }, end: { north, east }, speedMps: 0 });
const atBearing = (bearing, range = 500) => ({ north: Math.cos(bearing * Math.PI / 180) * range, east: Math.sin(bearing * Math.PI / 180) * range });

test("map edits clamp to the arena without mutating the point", () => {
  const original = { north: 1800, east: -4000 };
  assert.deepEqual(plain(clampPoint(original)), { north: 1500, east: -1500 });
  assert.deepEqual(plain(clampPoint(original, 500)), { north: 500, east: -500 });
  assert.deepEqual(original, { north: 1800, east: -4000 });
  assert.deepEqual(plain(clampPoint({ north: 10, east: -20 })), { north: 10, east: -20 });
});

test("clockwise headings use north zero, east ninety and wrap every sweep", () => {
  assert.equal(towerHeading(tower, 0), 0);
  assert.equal(towerHeading(tower, 15), 90);
  assert.equal(towerHeading(tower, 30), 180);
  assert.equal(towerHeading(tower, 60), 0);
  assert.equal(towerHeading({ ...tower, heading: -10 }, 0), 350);
  assert.equal(towerHeading({ ...tower, heading: 710 }, 5, 90), 10);
});

test("visibility respects Euclidean radius, inclusive sector edges and heading wrap", () => {
  assert.equal(inTowerView(tower, { north: 1000, east: 0 }, 0), true);
  assert.equal(inTowerView(tower, { north: 1000.01, east: 0 }, 0), false);
  assert.equal(inTowerView(tower, atBearing(10), 0), true);
  assert.equal(inTowerView(tower, atBearing(-10), 0), true);
  assert.equal(inTowerView(tower, atBearing(10.01), 0), false);
  assert.equal(inTowerView(tower, atBearing(350), 0), true);
  assert.equal(inTowerView(tower, atBearing(180), 0), false);
  assert.equal(inTowerView(tower, { north: 0, east: 0 }, 0), true);
  assert.equal(inTowerView({ ...tower, fovDeg: 360 }, atBearing(180), 0), true);
  assert.equal(inTowerView({ ...tower, north: 500, east: -300 }, { north: 1500, east: -300 }, 0), true);
});

test("a boat waits for the rotating sector and is revisited each period", () => {
  const point = atBearing(90);
  assert.equal(inTowerView(tower, point, 0), false);
  assert.equal(inTowerView(tower, point, 14), true);
  assert.equal(inTowerView(tower, point, 30), false);
  assert.equal(inTowerView(tower, point, 74), true);
  const route = stationary(point.north, point.east);
  assert.equal(evaluateRoute([tower], route).detectedAt, 14);
  assert.equal(evaluateRoute([tower], route, { horizonS: 13 }).detectedAt, null);
});

test("boat motion follows distance/speed, starts at time zero and holds at endpoint", () => {
  const route = { start: { north: 0, east: 0 }, end: { north: 300, east: 400 }, speedMps: 10 };
  assert.deepEqual(plain(boatPosition(route, 0)), { north: 0, east: 0 });
  assert.deepEqual(plain(boatPosition(route, 25)), { north: 150, east: 200 });
  assert.deepEqual(plain(boatPosition(route, 50)), route.end);
  assert.deepEqual(plain(boatPosition(route, 200)), route.end);
  assert.deepEqual(plain(boatPosition({ ...route, speedMps: 0 }, 200)), route.start);
  assert.deepEqual(plain(boatPosition(stationary(10, 20), 0)), { north: 10, east: 20 });
});

test("a miss stays null and time-zero detection is preserved", () => {
  assert.deepEqual(plain(evaluateRoute([tower], stationary(1200, 0))), { detectedAt: null, sourceId: null, position: null });
  assert.deepEqual(plain(evaluateRoute([], stationary(0, 0))), { detectedAt: null, sourceId: null, position: null });
  assert.deepEqual(plain(evaluateRoute([tower], stationary(100, 0), { horizonS: 0 })), {
    detectedAt: 0, sourceId: "one", position: { north: 100, east: 0 },
  });
});

test("evaluation includes the exact horizon when the step does not divide it", () => {
  const route = { start: { north: 1010, east: 0 }, end: { north: 1000, east: 0 }, speedMps: 10 };
  assert.equal(evaluateRoute([{ ...tower, fovDeg: 360 }], route, { horizonS: 1, stepS: 0.6 }).detectedAt, 1);
});

test("both layouts use the identical route and options without changing inputs", () => {
  const route = { start: { north: 1400, east: 0 }, end: { north: 0, east: 0 }, speedMps: 10 };
  const options = { horizonS: 180, stepS: 1, scanPeriodS: 60 };
  const baseline = [{ ...tower, fovDeg: 360 }];
  const selected = [{ ...tower, north: 500, fovDeg: 360 }];
  const before = JSON.stringify({ route, options, baseline, selected });
  const baselineResult = evaluateRoute(baseline, route, options);
  const selectedResult = evaluateRoute(selected, route, options);
  assert.equal(baselineResult.detectedAt, 40);
  assert.equal(selectedResult.detectedAt, 0);
  assert.deepEqual(plain(evaluateRoute(baseline, route, options)), plain(baselineResult));
  assert.equal(JSON.stringify({ route, options, baseline, selected }), before);
});

test("reported tower and position correspond to visibility at the sampled time", () => {
  const towers = [tower, { ...tower, id: "two", heading: 90 }];
  const route = stationary(0, 500);
  const result = evaluateRoute(towers, route);
  assert.equal(result.sourceId, "two");
  assert.equal(result.detectedAt, 0);
  assert.equal(inTowerView(towers[1], result.position, result.detectedAt), true);
  assert.deepEqual(plain(result.position), plain(boatPosition(route, result.detectedAt)));
});

test("nonfinite values, invalid ranges and unbounded workloads are rejected", () => {
  const route = stationary(0, 0);
  for (const invalid of [NaN, Infinity, -Infinity]) {
    assert.throws(() => clampPoint({ north: invalid, east: 0 }));
    assert.throws(() => clampPoint({ north: 0, east: 0 }, invalid));
    assert.throws(() => towerHeading({ ...tower, heading: invalid }, 0));
    assert.throws(() => inTowerView(tower, { north: 0, east: invalid }, 0));
    assert.throws(() => boatPosition(route, invalid));
    assert.throws(() => boatPosition({ ...route, speedMps: invalid }, 0));
    assert.throws(() => evaluateRoute([tower], route, { horizonS: invalid }));
  }
  for (const field of ["rangeM", "fovDeg"]) assert.throws(() => inTowerView({ ...tower, [field]: -1 }, route.start, 0));
  assert.throws(() => inTowerView({ ...tower, fovDeg: 361 }, route.start, 0));
  assert.throws(() => towerHeading(tower, 0, 0));
  assert.throws(() => towerHeading(tower, -1));
  assert.throws(() => clampPoint(route.start, 0));
  assert.throws(() => boatPosition({ ...route, speedMps: -1 }, 0));
  assert.throws(() => evaluateRoute([tower], route, { stepS: 0 }));
  assert.throws(() => evaluateRoute([tower], route, { horizonS: -1 }));
  assert.throws(() => evaluateRoute([tower], route, { stepS: 0.00001 }));
  assert.throws(() => evaluateRoute([tower, tower], route));
  assert.throws(() => evaluateRoute([{ ...tower, id: "" }], route));
});
