// Run from frontend: node --test tests/sceneLabels.test.cjs
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const { test } = require("node:test");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../lib/sceneLabels.ts"), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;
const moduleExports = {};
vm.runInNewContext(compiled, { exports: moduleExports, Map });
const { layoutFleetLabels } = moduleExports;

function assertPosition(positions, id, x, y) {
  assert.equal(positions.get(id)?.x, x, `${id} horizontal position`);
  assert.equal(positions.get(id)?.y, y, `${id} vertical position`);
}

function assertSeparated(labels, positions) {
  for (let i = 0; i < labels.length; i += 1) {
    for (const other of labels.slice(i + 1)) {
      const label = labels[i];
      const a = positions.get(label.id);
      const b = positions.get(other.id);
      assert.ok(
        Math.abs(a.x - b.x) >= (label.width + other.width) / 2 + 6 - 0.000001 ||
          Math.abs(a.y - b.y) >= (label.height + other.height) / 2 + 6 - 0.000001,
        `${label.id} and ${other.id} must have a readable gap`,
      );
    }
  }
}

test("separates the overlapping live aircraft labels and nearby tower labels", () => {
  const labels = [
    { id: "quadcopter", x: 579, y: 641.5, width: 107, height: 22 },
    { id: "fixedwing", x: 583.5, y: 634.5, width: 103, height: 22 },
    { id: "tower-1", x: 502, y: 659.5, width: 78, height: 22 },
    { id: "tower-2", x: 677, y: 609, width: 78, height: 22 },
  ];
  const positions = layoutFleetLabels(labels, { width: 1200, height: 800 });
  assertPosition(positions, "fixedwing", 583.5, 634.5);
  assertPosition(positions, "quadcopter", 579, 662.5);
  assertSeparated(labels, positions);
});

test("coincident labels receive distinct nearest vertical slots", () => {
  const labels = ["a", "b", "c"].map((id) => ({ id, x: 200, y: 200, width: 100, height: 22 }));
  const positions = layoutFleetLabels(labels, { width: 400, height: 400 });
  assertPosition(positions, "a", 200, 200);
  assertPosition(positions, "b", 200, 172);
  assertPosition(positions, "c", 200, 228);
  assertSeparated(labels, positions);
});

test("separated labels retain their projected anchors", () => {
  const labels = [
    { id: "a", x: 100, y: 100, width: 80, height: 22 },
    { id: "b", x: 300, y: 100, width: 80, height: 22 },
    { id: "c", x: 100, y: 300, width: 80, height: 22 },
  ];
  const positions = layoutFleetLabels(labels, { width: 400, height: 400 });
  for (const label of labels) assertPosition(positions, label.id, label.x, label.y);
});

test("placement is stable under reversed input and does not mutate labels", () => {
  const labels = ["c", "a", "b"].map((id) => Object.freeze({ id, x: 100, y: 100, width: 80, height: 22 }));
  Object.freeze(labels);
  const forward = layoutFleetLabels(labels, { width: 400, height: 400 });
  const backward = layoutFleetLabels([...labels].reverse(), { width: 400, height: 400 });
  assert.deepEqual([...forward.keys()], ["a", "b", "c"]);
  assert.equal(JSON.stringify([...forward]), JSON.stringify([...backward]));
  assert.deepEqual(labels.map((label) => [label.id, label.x, label.y]), [["c", 100, 100], ["a", 100, 100], ["b", 100, 100]]);
});

test("labels at viewport edges stay inside the eight-pixel margin", () => {
  const labels = [
    { id: "a", x: -20, y: -20, width: 100, height: 22 },
    { id: "b", x: -20, y: -20, width: 100, height: 22 },
    { id: "c", x: 350, y: 250, width: 100, height: 22 },
    { id: "d", x: 350, y: 250, width: 100, height: 22 },
  ];
  const positions = layoutFleetLabels(labels, { width: 320, height: 240 });
  for (const label of labels) {
    const { x, y } = positions.get(label.id);
    assert.ok(x - label.width / 2 >= 8 && x + label.width / 2 <= 312);
    assert.ok(y - label.height / 2 >= 8 && y + label.height / 2 <= 232);
  }
  assertSeparated(labels, positions);
});

test("different label dimensions determine the required vertical separation", () => {
  const labels = [
    { id: "a", x: 200, y: 200, width: 200, height: 40 },
    { id: "b", x: 240, y: 205, width: 100, height: 20 },
    { id: "c", x: 190, y: 195, width: 160, height: 30 },
  ];
  const positions = layoutFleetLabels(labels, { width: 500, height: 400 });
  assertPosition(positions, "b", 240, 236);
  assertPosition(positions, "c", 190, 159);
  assertSeparated(labels, positions);
});

test("uses a second column when four tall labels cannot fit vertically", () => {
  const labels = ["a", "b", "c", "d"].map((id) => ({ id, x: 220, y: 80, width: 100, height: 120 }));
  const positions = layoutFleetLabels(labels, { width: 300, height: 300 });
  assertPosition(positions, "a", 220, 80);
  assertPosition(positions, "b", 220, 206);
  assertPosition(positions, "c", 114, 80);
  assertPosition(positions, "d", 114, 206);
  assertSeparated(labels, positions);
});

test("fractional projected coordinates retain the nearest six-pixel gap", () => {
  const labels = ["a", "b"].map((id) => ({ id, x: 179.341, y: 183.691, width: 104.375, height: 22.375 }));
  const positions = layoutFleetLabels(labels, { width: 400, height: 400 });
  assertPosition(positions, "a", 179.341, 183.691);
  assert.ok(Math.abs(Math.abs(positions.get("b").y - 183.691) - 28.375) < 0.000001);
  assertSeparated(labels, positions);
});
