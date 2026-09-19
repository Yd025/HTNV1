const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const root = path.resolve(__dirname, "../..");
const read = (file) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const data = read("frontend/lib/placementDemoData.json");
const report = read("docs/research/tower-search-benchmark.json");
const policy = read("docs/research/example-search-policy.json");

test("placement demo preserves evidence provenance and selected policy geometry", () => {
  assert.deepEqual(policy, report.selected_policy);
  assert.equal(data.sourceRevision, report.source_revision);
  assert.equal(data.sourceSha256, report.source_sha256);
  assert.equal(data.halfM, policy.arena.half_m);
  assert.equal(data.scanPeriodS, policy.planner.scan_period_s);
  assert.equal(data.learned.towers.length, policy.arena.towers.length);
  const metersLongitude = 111111 * Math.max(0.2, Math.abs(Math.cos(policy.arena.origin_lat * Math.PI / 180)));
  policy.arena.towers.forEach((tower, index) => {
    const demoTower = data.learned.towers[index];
    assert.equal(demoTower.id, tower.vehicle_id);
    assert.equal(demoTower.label, `Tower ${index + 1}`);
    assert.ok(Math.abs(demoTower.north - (tower.lat - policy.arena.origin_lat) * 111111) <= 0.000001);
    assert.ok(Math.abs(demoTower.east - (tower.lon - policy.arena.origin_lon) * metersLongitude) <= 0.000001);
    assert.equal(demoTower.heading, tower.heading);
    assert.equal(demoTower.rangeM, tower.range_m);
    assert.equal(demoTower.fovDeg, tower.fov_deg);
  });
});

test("comparison uses held-out capped means and success rates, including misses", () => {
  const baseline = report.test.fixed_towers_sweep.summary;
  const learned = report.test[report.selected].summary;
  for (const [view, summary] of [[data.baseline, baseline], [data.learned, learned]]) {
    assert.equal(view.meanDetectionS, summary.restricted_mean_detection_s);
    assert.equal(view.successRate, summary.success_rate);
  }
  assert.equal(data.benchmark.episodes, learned.episodes);
  assert.equal(data.benchmark.episodes, baseline.episodes);
  assert.equal(data.benchmark.deadlineS, learned.deadline_s);
  assert.equal(data.benchmark.mode, "synthetic");
  assert.equal(data.benchmark.meanSecondsSaved, report.comparison.mean_seconds_saved);
  assert.equal(data.benchmark.percentFaster, report.comparison.mean_seconds_saved / baseline.restricted_mean_detection_s * 100);
  assert.ok(fs.statSync(path.join(root, "frontend/lib/placementDemoData.json")).size < 5000);
});

test("original placement retains the experiment's original towers and sensor model", () => {
  assert.deepEqual(data.baseline.towers.map(({ id, north, east, heading }) => ({ id, north, east, heading })), [
    { id: "tower-ne", north: 900, east: 900, heading: 225 },
    { id: "tower-sw", north: -900, east: -900, heading: 45 },
  ]);
  for (const tower of [...data.baseline.towers, ...data.learned.towers]) {
    assert.equal(tower.rangeM, data.rangeM);
    assert.equal(tower.fovDeg, data.fovDeg);
    assert.ok(Math.max(Math.abs(tower.north), Math.abs(tower.east)) <= data.halfM);
  }
  assert.equal(data.rangeM, 600);
  assert.equal(data.fovDeg, 40);
});
