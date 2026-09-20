const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");
const exports_ = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname, "../lib/tickWindow.ts"), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, { exports: exports_ });
const { TickWindow } = exports_;
function tick(sequence, duration = sequence, extra = {}) {
  return { run: { run_id: "run-a", sequence }, diagnostics: {
    trace_id: `trace-${sequence}`, duration_ms: duration, budget_ms: 100, started_at: 0, over_budget: false,
    stages: [{ op: "track.update", name: "target", duration_ms: duration / 2, offset_ms: 0, status: "ok" }], ...extra,
  } };
}

test("window reports nearest-rank percentiles, actual budget violations and worst evidence", () => {
  const w = new TickWindow();
  for (let i = 1; i <= 100; i++) w.add(tick(i), i * 100, true);
  w.add(tick(101, 150), 10100, true);
  const s = w.summarize(10100);
  assert.equal(s.count, 101); assert.equal(s.p50, 51); assert.equal(s.p95, 96);
  assert.equal(s.max, 150); assert.equal(s.overBudget, 1); assert.equal(s.worst.trace_id, "trace-101");
  assert.equal(s.stages[0].p95, 48); assert.equal(s.stages[0].share, .5);
});

test("duplicates, out-of-order, stale and invalid durations do not inflate the sample", () => {
  const w = new TickWindow();
  w.add(tick(2), 1000, true); w.add(tick(2), 1100, true); w.add(tick(1), 1200, true);
  w.add(tick(3), 1300, false); w.add(tick(4, NaN), 1400, true);
  w.add(tick(5, -1), 1500, true); w.add(tick(6, 6, { budget_ms: 0 }), 1600, true);
  assert.equal(w.summarize(1600).count, 1);
  assert.equal(w.summarize(61000).count, 0);
  assert.equal(w.summarize(61000).p95, null);
  w.add(tick(2), 61000, true); assert.equal(w.summarize(61000).count, 0);
});

test("run changes reset history, capacity is bounded and removed timings leave the window", () => {
  const w = new TickWindow(60000, 3);
  for (let i = 1; i < 6; i++) w.add(tick(i), i * 100, true);
  assert.equal(w.summarize(500).count, 3); assert.equal(w.summarize(500).p50, 4);
  w.add({ ...tick(0, 10), run: { run_id: "run-b", sequence: 0 } }, 600, true);
  assert.equal(w.summarize(600).count, 1); assert.equal(w.summarize(600).runId, "run-b");
  w.add({ run: { run_id: "run-c", sequence: 0 } }, 700, false);
  assert.equal(w.summarize(700).count, 0);
});

test("stage totals combine vehicles per tick and include absent calls as zero", () => {
  const w = new TickWindow();
  w.add(tick(1, 100, { stages: [
    { op: "adapter.send", duration_ms: 20, status: "ok" },
    { op: "adapter.send", duration_ms: 30, status: "error" },
    { op: "bad", duration_ms: NaN },
  ] }), 100, true);
  for (let i = 2; i <= 40; i++) w.add(tick(i, 100, { stages: [] }), i * 100, true);
  const stage = w.summarize(4000).stages[0];
  assert.equal(stage.p95, 0); assert.equal(stage.max, 50); assert.equal(stage.errors, 1);
  assert.equal(stage.share, 50 / 4000);
});
