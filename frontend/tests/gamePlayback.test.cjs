// Run from frontend: node --test tests/gamePlayback.test.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");

const exports_ = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.resolve(__dirname, "../lib/gamePlayback.ts"), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText, { exports: exports_ });
const { frameIndexAtTime } = exports_;
const advance = (...args) => JSON.parse(JSON.stringify(exports_.advancePlayback(...args)));

test("seeking selects the most recent recorded frame without revealing a future frame", () => {
  const frames = Object.freeze([0, 0.5, 2, 2, 4.25].map(time => Object.freeze({ time })));
  assert.equal(frameIndexAtTime(frames, 0), 0);
  assert.equal(frameIndexAtTime(frames, 0.499), 0);
  assert.equal(frameIndexAtTime(frames, 0.5), 1);
  assert.equal(frameIndexAtTime(frames, 1.99), 1);
  assert.equal(frameIndexAtTime(frames, 2), 3, "duplicate timestamps select the last frame at that instant");
  assert.equal(frameIndexAtTime(frames, 4.25), 4);
  assert.equal(frameIndexAtTime(frames, 900), 4);
});

test("empty, single-frame, pre-roll, and invalid seeks remain safe", () => {
  assert.equal(frameIndexAtTime([], 0), -1);
  for (const seconds of [-10, 0, 3, NaN, Infinity, -Infinity]) {
    assert.equal(frameIndexAtTime([{ time: 2 }], seconds), 0);
  }
  for (const seconds of [-10, NaN, Infinity, -Infinity]) {
    assert.equal(frameIndexAtTime([{ time: 0 }, { time: 2 }], seconds), 0);
  }
});

test("long recordings use bounded binary lookup rather than scanning every frame", () => {
  let reads = 0;
  const frames = Array.from({ length: 16384 }, (_, index) => ({ get time() { reads++; return index / 2; } }));
  assert.equal(frameIndexAtTime(frames, 4096.7), 8193);
  assert.ok(reads <= 16, `${reads} timestamp reads`);
});

test("non-looping playback reaches and holds the final recorded instant", () => {
  assert.deepEqual(advance(1, 0.5, 4, false), { time: 1.5, ended: false });
  assert.deepEqual(advance(3, 1, 4, false), { time: 4, ended: true });
  assert.deepEqual(advance(3, 400, 4, false), { time: 4, ended: true });
  assert.deepEqual(advance(4, 0, 4, false), { time: 4, ended: true });
  assert.deepEqual(advance(40, 1, 4, false), { time: 4, ended: true });
});

test("looping wraps exact boundaries and multiple laps while retaining fractional time", () => {
  assert.deepEqual(advance(3, 1, 4, true), { time: 0, ended: false });
  assert.deepEqual(advance(3, 13.25, 4, true), { time: 0.25, ended: false });
  assert.deepEqual(advance(1, 100, 4, true), { time: 1, ended: false });
  assert.deepEqual(advance(4, 0, 4, true), { time: 0, ended: false });
  assert.deepEqual(advance(40, 0.5, 4, true), { time: 0.5, ended: false });
});

test("zero-length recordings end safely and invalid clocks cannot move playback backwards", () => {
  for (const duration of [0, -1, NaN, Infinity, -Infinity]) {
    for (const loop of [false, true]) assert.deepEqual(advance(2, 1, duration, loop), { time: 0, ended: true });
  }
  for (const invalid of [-1, NaN, Infinity, -Infinity]) {
    assert.deepEqual(advance(2, invalid, 4, false), { time: 2, ended: false });
    assert.deepEqual(advance(invalid, 1, 4, false), { time: 1, ended: false });
  }
});

test("large finite clocks stay finite even when adding them directly would overflow", () => {
  const result = advance(9e307, 9e307, 1e308, true);
  assert.equal(result.ended, false);
  assert.ok(Number.isFinite(result.time) && result.time >= 0 && result.time < 1e308);
  assert.ok(Math.abs(result.time / 1e308 - 0.8) < 1e-12);
  assert.deepEqual(advance(9e307, 9e307, 1e308, false), { time: 1e308, ended: true });
});
