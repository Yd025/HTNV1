const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const ts = require("typescript");

const cache = new Map();
function load(file) {
  if (cache.has(file)) return cache.get(file);
  const exports = {};
  const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(compiled, { exports, require: name => {
    if (name.endsWith(".css")) return {};
    if (!name.startsWith(".")) return require(name);
    const base = path.resolve(path.dirname(file), name);
    return load([`${base}.ts`, `${base}.tsx`].find(fs.existsSync));
  } });
  cache.set(file, exports);
  return exports;
}
const Monitor = load(path.resolve(__dirname, "../components/TrainingRunMonitor.tsx")).default;
const towerPair = x => [{ id: "tower1", x, y: 0, z: 102.7, heading: 30 }, { id: "tower2", x: 1200, y: 800, z: 202.7, heading: 230 }];
const profile = { grid: { halfM: 3250 }, sensors: { tower: { farClipM: 1500, hfovDeg: 60 }, quad: { farClipM: 1500, hfovDeg: 114.6 }, plane: { farClipM: 1500, hfovDeg: 69 } } };
const metric = rate => ({ episodes: 2, detectionRate: rate, meanCappedS: 61, coveragePct: 44, custodyPct: 33, rmseM: 15, p90CappedS: 90, estimateAvailabilityPct: 33, distanceM: 3000, handoffs: 1 });
const replay = {
  seed: 41, towers: towerPair(-987), metrics: metric(100),
  frames: [
    { t: 0, boat: { x: 70, y: -80 }, drones: [{ id: "quad", x: 5, y: 15, z: 60, heading: 30 }, { id: "plane", x: 40, y: 50, z: 120, heading: 60 }], sources: [], coveragePct: 10 },
    { t: 5, boat: { x: 85, y: -80 }, drones: [], sources: ["tower1"], trackingSource: "tower1", estimate: { x: 85, y: -80 }, coveragePct: 20 },
  ],
};
const preview = { id: "candidate-0-training", phase: "training", candidateIndex: 0, episodeIndex: 0, episodeTotal: 24, replay };
const render = (progress, inspectedCandidate) => renderToStaticMarkup(React.createElement(Monitor, { profile, progress, inspectedCandidate, onFollow() {} }));

test("a newly proposed placement is visible before its first mission without borrowing a previous candidate's scores", () => {
  const output = render({ phase: "training", activeCandidate: { index: 1, towers: towerPair(-543), weights: [] }, candidateCompleted: 0, candidateEpisodes: 24, preview: null, history: [{ index: 0, towers: towerPair(-987), train: metric(100), preview }] });
  assert.match(output, /Trying placement 2/);
  assert.match(output, /-543/);
  assert.match(output, /0 \/ 24 completed/);
  assert.match(output, /Awaiting results/);
  assert.doesNotMatch(output, /Recorded example · training continues|100\.0%/);
});

test("a training example renders actual boat and aircraft data with prefix-only statistics beside its aggregate", () => {
  const output = render({ phase: "training", activeCandidate: { index: 0, towers: replay.towers, weights: [] }, candidateCompleted: 2, candidateEpisodes: 24, candidateMetrics: metric(50), preview });
  assert.match(output, /Recorded example · training continues/);
  assert.match(output, /Mission 1 of 24/);
  assert.match(output, /50\.0%/);
  assert.match(output, /No sensor report at 0 s/);
  assert.match(output, /Searching…/);
  assert.doesNotMatch(output, />100\.0%</);
});

test("inspecting a finished placement holds its own positions and measured example while current training advances", () => {
  const inspected = { index: 0, towers: replay.towers, train: metric(75), preview };
  const output = render({ phase: "training", activeCandidate: { index: 3, towers: towerPair(-543), weights: [] }, candidateMetrics: metric(25), candidateCompleted: 1, candidateEpisodes: 24, preview: null }, inspected);
  assert.match(output, /Inspecting placement 1/);
  assert.match(output, /-987/);
  assert.match(output, /75\.0%/);
  assert.match(output, /Follow current training/);
  assert.doesNotMatch(output, /-543|25\.0%|Trying placement 4/);
});

test("test phase labels and aggregates follow the policy being evaluated, including its different tower coordinates", () => {
  const output = render({ phase: "test", evaluatingPolicy: "baseline", activeCandidate: { index: null, towers: towerPair(-543), weights: [] }, candidateMetrics: metric(100), partialMetrics: { baseline: metric(50), trained: metric(99) }, preview: { ...preview, id: "baseline-test", phase: "test", policy: "baseline", candidateIndex: null, episodeTotal: 200 } });
  assert.match(output, /Reference strategy/);
  assert.match(output, /Untouched test missions/);
  assert.match(output, /50\.0%/);
  assert.match(output, /-987/);
  assert.doesNotMatch(output, /99\.0%|>100\.0%<|Trying placement/);
});

test("test phase identifies the validation winner using validation scores, including during historical inspection", () => {
  const winner = { index: 2, towers: towerPair(-543), train: metric(80), validation: metric(95) };
  const history = [{ index: 0, towers: replay.towers, train: metric(100), preview }, winner];
  const progress = { phase: "test", bestCandidate: 2, history, evaluatingPolicy: "baseline", activeCandidate: { index: null, towers: towerPair(-543), weights: [] }, preview: null };
  for (const inspected of [undefined, history[0]]) {
    const output = render(progress, inspected);
    assert.match(output, /Validation-selected placement:/);
    assert.match(output, /placement 3/);
    assert.match(output, /95\.0% found/);
    assert.match(output, /capped delay on validation missions/);
    assert.doesNotMatch(output, /Best completed training candidate:|80\.0% found|Validation chooses the final model/);
  }
});
