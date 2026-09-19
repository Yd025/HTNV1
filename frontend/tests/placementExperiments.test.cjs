// Run from frontend: node --test tests/placementExperiments.test.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");

const modules = {};
function load(name) {
  if (modules[name]) return modules[name];
  const source = fs.readFileSync(path.join(__dirname, `../lib/${name}.ts`), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: (dependency) => load(dependency.replace("./", "")) });
  modules[name] = exports;
  return exports;
}
const { EXPERIMENT, randomRoute, createExperiment, advanceExperiment, nearestTower } = load("placementExperiments");
const { evaluateRoute, inTowerView } = load("placementDemo");
const evidence = require("../lib/placementDemoData.json");
const plain = (value) => JSON.parse(JSON.stringify(value));
const scoreOrder = (a, b) => b.detected - a.detected || a.meanCappedS - b.meanCappedS;
const finish = (seed, towers) => {
  let experiment = createExperiment(seed, towers);
  while (experiment.phase !== "complete") experiment = advanceExperiment(experiment);
  return experiment;
};

test("seeded random routes are reproducible and cover the full arena without tower-dependent filtering", () => {
  const quadrants = [0, 0, 0, 0];
  let nearEdge = 0;
  let sumNorth = 0;
  let sumEast = 0;
  for (let index = 0; index < 1000; index += 1) {
    const route = randomRoute(7351, index);
    assert.deepEqual(plain(route), plain(randomRoute(7351, index)));
    assert.notDeepEqual(plain(route), plain(randomRoute(7352, index)));
    for (const point of [route.start, route.end]) {
      assert.ok(point.north >= -1500 && point.north <= 1500);
      assert.ok(point.east >= -1500 && point.east <= 1500);
    }
    assert.ok(route.speedMps >= 6 && route.speedMps < 16);
    quadrants[(route.start.north >= 0 ? 2 : 0) + (route.start.east >= 0 ? 1 : 0)] += 1;
    if (Math.abs(route.start.north) > 1400 || Math.abs(route.start.east) > 1400) nearEdge += 1;
    sumNorth += route.start.north;
    sumEast += route.start.east;
  }
  assert.ok(quadrants.every((count) => count > 190 && count < 310), JSON.stringify(quadrants));
  assert.ok(nearEdge > 90, "edge spawns must not be rejected");
  assert.ok(Math.abs(sumNorth / 1000) < 90 && Math.abs(sumEast / 1000) < 90);
});

test("each search step is immutable, bounded, retains sensor settings and has no test results", () => {
  const initial = structuredClone(evidence.baseline.towers);
  const initialBefore = JSON.stringify(initial);
  let experiment = createExperiment(391, initial);
  assert.equal(experiment.completed, 1);
  for (let step = 1; step < EXPERIMENT.candidates; step += 1) {
    const before = JSON.stringify(experiment);
    const next = advanceExperiment(experiment);
    assert.equal(JSON.stringify(experiment), before);
    assert.equal(next.completed, step + 1);
    assert.equal(next.candidates.length, step + 1);
    const candidate = next.candidates[step];
    assert.equal(candidate.train.episodes, 80);
    for (let index = 0; index < 2; index += 1) {
      const tower = candidate.towers[index];
      assert.ok(Math.abs(tower.north) <= 1500 && Math.abs(tower.east) <= 1500);
      assert.equal(tower.id, initial[index].id);
      assert.equal(tower.rangeM, initial[index].rangeM);
      assert.equal(tower.fovDeg, initial[index].fovDeg);
      assert.ok(tower.heading >= 0 && tower.heading < 360);
    }
    if (step < EXPERIMENT.candidates - 1) {
      assert.equal(next.phase, "search");
      assert.equal(next.test, undefined);
      assert.equal(next.testRoutes, undefined);
      assert.equal(next.testResults, undefined);
      assert.equal(next.winnerIndex, undefined);
      assert.ok(next.candidates.every((item) => item.validation === undefined));
      assert.ok(scoreOrder(next.candidates[next.bestIndex].train, experiment.candidates[experiment.bestIndex].train) <= 0);
    }
    experiment = next;
  }
  assert.equal(JSON.stringify(initial), initialBefore);
  assert.equal(experiment.phase, "complete");
  assert.equal(advanceExperiment(experiment), experiment);
});

test("validation alone chooses the finalist before untouched test routes are evaluated", () => {
  const experiment = finish(20260919, evidence.baseline.towers);
  const ranked = [...experiment.candidates].sort((a, b) => scoreOrder(a.train, b.train) || a.index - b.index);
  const finalistIds = new Set([0, ...ranked.slice(0, 8).map((candidate) => candidate.index)]);
  const finalists = experiment.candidates.filter((candidate) => candidate.validation);
  assert.equal(finalists.length, finalistIds.size);
  assert.ok(finalists.every((candidate) => finalistIds.has(candidate.index)));
  assert.ok(finalists.every((candidate) => candidate.validation.episodes === 64));
  const independentlySelected = [...finalists].sort((a, b) => scoreOrder(a.validation, b.validation) || a.index - b.index)[0];
  assert.equal(experiment.winnerIndex, independentlySelected.index);
  assert.deepEqual(plain(experiment.bestTowers), plain(independentlySelected.towers));
  assert.equal(experiment.testRoutes.length, 200);
  assert.equal(experiment.testResults.length, 200);
  const learningRoutes = new Set(Array.from({ length: 144 }, (_, index) => JSON.stringify(randomRoute(experiment.seed, index))));
  const manualTimes = [];
  let detected = 0;
  for (let index = 0; index < 200; index += 1) {
    const route = experiment.testRoutes[index];
    assert.deepEqual(plain(route), plain(randomRoute(experiment.seed, 144 + index)));
    assert.equal(learningRoutes.has(JSON.stringify(route)), false);
    const result = evaluateRoute(experiment.bestTowers, route);
    assert.deepEqual(plain(experiment.testResults[index]), plain(result));
    if (result.detectedAt !== null) detected += 1;
    manualTimes.push(result.detectedAt ?? 180);
  }
  manualTimes.sort((a, b) => a - b);
  assert.equal(experiment.test.learned.detected, detected);
  assert.equal(experiment.test.learned.meanCappedS, manualTimes.reduce((sum, time) => sum + time, 0) / 200);
  assert.equal(experiment.test.learned.p90CappedS, manualTimes[179]);
  assert.equal(experiment.test.learned.worstCappedS, manualTimes[199]);
  assert.equal(experiment.test.baseline.episodes, 200);
  assert.ok(experiment.test.learned.detected > 0 && experiment.test.learned.detected < 200, "show misses honestly");
});

test("complete searches replay deterministically and initialize without aliasing caller towers", () => {
  const first = finish(89, evidence.learned.towers);
  const second = finish(89, evidence.learned.towers);
  assert.deepEqual(plain(first), plain(second));
  const input = structuredClone(evidence.baseline.towers);
  const experiment = createExperiment(3, input);
  input[0].north = -1499;
  assert.equal(experiment.candidates[0].towers[0].north, 900);
  assert.equal(experiment.bestTowers[0].north, 900);
});

test("misses remain in every capped score and ties preserve the initial placement", () => {
  const tinyTowers = evidence.baseline.towers.map((tower) => ({ ...tower, rangeM: 0.000001 }));
  const experiment = finish(55, tinyTowers);
  for (const candidate of experiment.candidates) {
    assert.deepEqual(plain(candidate.train), { episodes: 80, detected: 0, meanCappedS: 180, p90CappedS: 180, worstCappedS: 180 });
  }
  assert.equal(experiment.winnerIndex, 0);
  assert.deepEqual(plain(experiment.test.learned), { episodes: 200, detected: 0, meanCappedS: 180, p90CappedS: 180, worstCappedS: 180 });
  assert.deepEqual(plain(experiment.test.baseline), plain(experiment.test.learned));
  assert.ok(experiment.testResults.every((result) => result.detectedAt === null));
});

test("nearest tracking line uses the nearest currently visible tower, with stable id ties", () => {
  const tower = { id: "z", label: "Near", north: 100, east: 0, heading: 0, rangeM: 600, fovDeg: 40 };
  const far = { ...tower, id: "a", label: "Far", north: -200 };
  const point = { north: 0, east: 0 };
  assert.equal(nearestTower([tower, far], point, 0, false).tower.id, "z");
  assert.equal(inTowerView(tower, point, 0), false);
  assert.equal(nearestTower([tower, far], point, 0, true).tower.id, "a");
  assert.equal(nearestTower([tower, far], point, 0, true).distanceM, 200);
  assert.equal(nearestTower([tower, far], point, 30, true).tower.id, "z");
  const tie = { ...tower, id: "a" };
  assert.equal(nearestTower([tower, tie], point, 0, false).tower.id, "a");
  assert.equal(nearestTower([tie, tower], point, 0, false).tower.id, "a");
  assert.equal(nearestTower([tower], point, 0, true), null);
  assert.equal(nearestTower([], point, 0, false), null);
});

test("invalid seeds, route indices and initial tower configurations are rejected", () => {
  for (const value of [-1, NaN, Infinity, 3.5, 4294967296]) {
    assert.throws(() => randomRoute(value, 0));
    assert.throws(() => randomRoute(0, value));
    assert.throws(() => createExperiment(value, evidence.baseline.towers));
  }
  assert.throws(() => createExperiment(1, []));
  assert.throws(() => createExperiment(1, [evidence.baseline.towers[0]]));
  assert.throws(() => createExperiment(1, evidence.baseline.towers.map((tower) => ({ ...tower, north: 1501 }))));
  assert.throws(() => createExperiment(1, evidence.baseline.towers.map((tower) => ({ ...tower, north: NaN }))));
  assert.throws(() => nearestTower([], { north: Infinity, east: 0 }, 0, false));
  assert.throws(() => nearestTower([], { north: 0, east: 0 }, -1, false));
});
