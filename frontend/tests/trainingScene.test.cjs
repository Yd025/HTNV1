const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");
const exportsObject = {};
const source = fs.readFileSync(path.resolve(__dirname, "../lib/trainingScene.ts"), "utf8");
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports: exportsObject });
const { scenePosition, sensorDirection, sensorPose, sensorAspect, terrainHeight, projectSensorPoint, acceptedSensorReport, sensorReportCrop, sensorReplayDetail, cropSensorPoint } = exportsObject;

test("world coordinates preserve projected axes and the camera basis matches the overview frustum", () => {
  assert.deepEqual(Array.from(scenePosition({ x: 20, y: 30, z: 40 })), [20, 40, -30]);
  const forward = sensorDirection(90, -30);
  assert.ok(Math.abs(forward[0] - Math.sqrt(3) / 2) < 1e-10);
  assert.ok(Math.abs(forward[1] + .5) < 1e-10);
  assert.ok(Math.abs(forward[2]) < 1e-10);
  assert.ok(Math.abs(Math.hypot(...forward) - 1) < 1e-10);
});

test("sensors use recorded camera orientation without aiming at hidden boat truth", () => {
  const profile = { sensors: { tower: { pitchDeg: 0 }, quad: { pitchDeg: -20 } } };
  const towers = [{ id: "tower-1", x: 10, y: 20, z: 32.7, heading: 180 }];
  const frame = { boat: { x: 1000, y: 2000 }, towerHeadings: [270], towerPitches: [-12], drones: [{ id: "quad", x: 1, y: 2, z: 60, heading: 45, cameraHeading: 65, cameraPitch: -22 }] };
  const tower = sensorPose(profile, frame, towers, "tower-1"), quad = sensorPose(profile, frame, towers, "quad");
  assert.equal(tower.heading, 270); assert.equal(tower.pitch, -12); assert.equal(tower.z, 32.7);
  assert.equal(quad.heading, 65); assert.equal(quad.pitch, -22);
  frame.boat = { x: -2000, y: -1000 };
  assert.deepEqual(sensorPose(profile, frame, towers, "quad"), quad);
  assert.equal(sensorPose(profile, frame, towers, "missing"), null);
  assert.equal(sensorPose(profile, { ...frame, towerHeadings: undefined, towerPitches: undefined }, towers, "tower-1").heading, 180);
});

test("each camera retains its optical aspect and sampled terrain preserves south to north ordering", () => {
  assert.equal(sensorAspect({ width: 960, height: 720 }), 4 / 3);
  assert.ok(Math.abs(sensorAspect({ hfovDeg: 90, vfovDeg: 90 }) - 1) < 1e-10);
  const profile = { grid: { size: 2, halfM: 10, cellM: 20, elevations: [10, 20, 30, 40] } };
  assert.equal(terrainHeight(profile, { x: -10, y: -10 }), 10);
  assert.equal(terrainHeight(profile, { x: 10, y: 10 }), 40);
  assert.equal(terrainHeight(profile, { x: 0, y: 0 }), 25);
});

test("recorded Fort Ross image dimensions preserve both horizontal and vertical FOV", () => {
  const profile = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../public/experiments/arctic-profile.json"), "utf8"));
  for (const sensor of Object.values(profile.sensors)) {
    const horizontal = 2 * Math.atan(Math.tan(sensor.vfovDeg * Math.PI / 360) * sensorAspect(sensor)) * 180 / Math.PI;
    assert.ok(Math.abs(horizontal - sensor.hfovDeg) < 1e-5);
  }
});

const opticalPose = { id: "quad", x: 0, y: 0, z: 1.5, heading: 0, pitch: 0,
  sensor: { hfovDeg: 90, vfovDeg: 90, nearClipM: 1, farClipM: 1500 } };

test("report projection preserves camera image axes and excludes points outside the optical frustum", () => {
  const center = projectSensorPoint(opticalPose, { x: 0, y: 100, z: 1.5 });
  assert.equal(center.x, .5); assert.equal(center.y, .5); assert.equal(center.depthM, 100);
  const rightUp = projectSensorPoint(opticalPose, { x: 50, y: 100, z: 51.5 });
  assert.ok(Math.abs(rightUp.x - .75) < 1e-10); assert.ok(Math.abs(rightUp.y - .25) < 1e-10);
  for (const point of [{ x: 0, y: -100 }, { x: 0, y: .5 }, { x: 0, y: 1501 }, { x: 101, y: 100 }, { x: 0, y: 100, z: 102 }]) {
    assert.equal(projectSensorPoint(opticalPose, point), null);
  }
  const tilted = { ...opticalPose, heading: 90, pitch: -30, z: 51.5 };
  const projected = projectSensorPoint(tilted, { x: Math.sqrt(3) * 50, y: 0, z: 1.5 });
  assert.ok(Math.abs(projected.x - .5) < 1e-10); assert.ok(Math.abs(projected.y - .5) < 1e-10);
});

test("report reticles require an accepted measurement from this camera and never use boat truth", () => {
  const rejected = { source: "quad", x: 0, y: 100, timestamp: 20, accepted: false };
  const other = { ...rejected, source: "tower-1", accepted: true };
  const frame = { boat: { x: 0, y: 100 }, observations: [rejected, other] };
  assert.equal(acceptedSensorReport(frame, opticalPose), null);
  assert.equal(acceptedSensorReport({ ...frame, observations: undefined }, opticalPose), null);
  frame.observations.push({ ...rejected, x: 50, accepted: true });
  const report = acceptedSensorReport(frame, opticalPose);
  assert.ok(Math.abs(report.x - .75) < 1e-10); assert.equal(report.timestamp, 20);
  frame.boat = { x: 5000, y: -5000 };
  assert.deepEqual(acceptedSensorReport(frame, opticalPose), report);
  frame.observations.push({ ...rejected, x: 0, y: -100, timestamp: 25, accepted: true });
  assert.equal(acceptedSensorReport(frame, opticalPose), null, "a newer out-of-view report must not show an old reticle");
});

test("digital detail uses only accepted in-view reports and preserves the source image aspect", () => {
  const observation = { source: "quad", x: 0, y: 100, timestamp: 20, accepted: true };
  const frame = { boat: { x: 1000, y: 1000 }, observations: [observation] };
  const crop = sensorReportCrop(frame, opticalPose);
  assert.equal(crop.zoom, 12);
  assert.equal(crop.width, 1 / 12);
  assert.equal(crop.height, crop.width);
  assert.ok(Math.abs(crop.x + crop.width / 2 - .5) < 1e-10);
  assert.ok(Math.abs(crop.y + crop.height / 2 - .5) < 1e-10);
  frame.boat = { x: -5000, y: -5000 };
  assert.deepEqual(sensorReportCrop(frame, opticalPose), crop, "boat truth cannot move the crop");
  for (const observations of [undefined, [], [{ ...observation, accepted: false }], [{ ...observation, source: "tower-1" }], [{ ...observation, y: -100 }]]) {
    assert.equal(sensorReportCrop({ ...frame, observations }, opticalPose), null);
  }
  assert.equal(sensorReportCrop(frame, opticalPose, 0).zoom, 1);
  assert.equal(sensorReportCrop(frame, opticalPose, Infinity).zoom, 1);
});

test("digital crops stay within image edges and reticles use the same crop transform", () => {
  const frame = { observations: [{ source: "quad", x: 99, y: 100, timestamp: 30, accepted: true }] };
  const crop = sensorReportCrop(frame, opticalPose);
  assert.equal(crop.x + crop.width, 1);
  assert.ok(crop.x >= 0 && crop.y >= 0 && crop.y + crop.height <= 1);
  const projected = acceptedSensorReport(frame, opticalPose), detail = cropSensorPoint(projected, crop);
  assert.ok(detail.x > .9 && detail.x < 1, "edge reports remain near the image edge instead of inventing outside pixels");
  assert.ok(Math.abs(detail.y - .5) < 1e-10);
  assert.equal(detail.timestamp, 30);
  assert.equal(detail.depthM, projected.depthM);
  assert.equal(cropSensorPoint({ x: 0, y: 0 }, crop), null);
  assert.equal(cropSensorPoint(null, crop), null);
  const origin = cropSensorPoint({ x: crop.x, y: crop.y }, crop);
  assert.equal(origin.x, 0); assert.equal(origin.y, 0);
});

test("saved handoff report crops include the physical vessel at 150 s and the reported 245 s regression", () => {
  const profile = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../public/experiments/arctic-profile.json"), "utf8"));
  const report = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../public/experiments/graph-report.json"), "utf8"));
  const replay = report.replays.find(item => item.seed === 591955);
  assert.ok(replay, "the saved handoff example must exist");
  for (const time of [150, 245]) for (const zoom of [12, 24]) {
    const frame = replay.frames.find(item => item.t === time), pose = sensorPose(profile, frame, replay.towers, "quad");
    const crop = sensorReplayDetail(profile, replay.frames, replay.towers, pose, time, zoom).crop;
    assert.ok(crop, `the quad must have an accepted in-view report at ${time} s`);
    const corners = [];
    // Bounds of the existing six-metre vessel, in metres, at the replay's evaluation truth.
    for (const dx of [-.9, .9]) for (const dy of [-3, 3]) for (const z of [0, 1.625]) {
      const projected = projectSensorPoint(pose, { x: frame.boat.x + dx, y: frame.boat.y + dy, z });
      assert.ok(projected, `the physical vessel must be in the source camera at ${time} s`);
      const detail = cropSensorPoint(projected, crop);
      assert.ok(detail, `the report-centered crop must contain the vessel at ${time} s`);
      corners.push(detail);
    }
    const displayedWidth = (Math.max(...corners.map(point => point.x)) - Math.min(...corners.map(point => point.x))) * 186;
    assert.ok(displayedWidth > 14, `the crop must make the compact vessel visible at ${time} s`);
  }
});

test("replay detail retains magnification through missed reports without showing old evidence as current", () => {
  const profile = { sensors: { quad: opticalPose.sensor } };
  const drone = { ...opticalPose, cameraHeading: 0, cameraPitch: 0 };
  const observation = { source: "quad", x: 0, y: 100, timestamp: 10, accepted: true };
  const frames = [
    { t: 0, drones: [drone], observations: [] },
    { t: 10, drones: [drone], observations: [observation] },
    { t: 15, drones: [drone], observations: [] },
    { t: 20, drones: [drone], observations: [{ ...observation, x: 30, timestamp: 20, accepted: false }] },
    { t: 25, drones: [drone], observations: [{ ...observation, x: 50, timestamp: 25 }] },
  ];
  for (const zoom of [1, 12, 24]) {
    const acquired = sensorReplayDetail(profile, frames, [], opticalPose, 10, zoom);
    assert.equal(acquired.crop.zoom, zoom);
    for (const time of [15, 20, 24.9]) {
      const held = sensorReplayDetail(profile, frames, [], opticalPose, time, zoom);
      assert.deepEqual(held, acquired, "missing or rejected reports cannot toggle zoom or recenter it");
    }
  }
  assert.equal(acceptedSensorReport(frames[2], opticalPose), null, "holding zoom must not fabricate a current reticle");
  assert.equal(sensorReplayDetail(profile, frames, [], opticalPose, 25).timestamp, 25);
  const before = sensorReplayDetail(profile, frames, [], opticalPose, 24.9999, 12, true);
  const during = sensorReplayDetail(profile, frames, [], opticalPose, 26, 12, true);
  const after = sensorReplayDetail(profile, frames, [], opticalPose, 27, 12, true);
  assert.deepEqual(sensorReplayDetail(profile, frames, [], opticalPose, 25, 12, true).crop, before.crop, "a new report cannot snap the crop");
  assert.deepEqual(sensorReplayDetail(profile, frames, [], opticalPose, 25, 12, false).crop, after.crop, "paused or sought frames settle on their current report");
  assert.ok(during.crop.x > before.crop.x && during.crop.x < after.crop.x, "the crop eases toward the new image report");
  assert.equal(sensorReplayDetail(profile, frames, [], opticalPose, 15).timestamp, 10, "rewind must discard future evidence");
  assert.equal(sensorReplayDetail(profile, frames, [], opticalPose, 9.9), null);
  assert.equal(sensorReplayDetail(profile, [frames[0]], [], opticalPose, 30), null, "a different mission has no inherited crop");
  assert.equal(sensorReplayDetail(profile, frames, [], { ...opticalPose, id: "other" }, 30), null);
  const outside = sensorReplayDetail(profile, frames, [], { ...opticalPose, heading: 180 }, 15);
  assert.equal(outside.crop.zoom, 12);
  assert.deepEqual(outside.crop, sensorReplayDetail(profile, frames, [], opticalPose, 15).crop, "camera motion and frustum exits cannot pull the crop back to another image region");
  assert.equal(outside.inView, false, "retained magnification cannot imply that the old report is still in view");
});

test("handoff playback never drops detail magnification after a camera's first accepted report", () => {
  const profile = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../public/experiments/arctic-profile.json"), "utf8"));
  const report = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../public/experiments/graph-report.json"), "utf8"));
  const replay = report.replays.find(item => item.seed === 591955);
  for (const id of ["tower-1", "tower-2", "plane", "quad"]) {
    let acquired = false, gaps = 0;
    for (const frame of replay.frames) {
      const pose = sensorPose(profile, frame, replay.towers, id);
      const detail = sensorReplayDetail(profile, replay.frames, replay.towers, pose, frame.t, 24);
      if (detail) acquired = true;
      if (acquired) {
        assert.equal(detail?.crop.zoom, 24, `${id} must retain detail at ${frame.t} s`);
        assert.ok(detail.timestamp <= frame.t);
        if (!acceptedSensorReport(frame, pose)) gaps++;
      }
    }
    if (id === "quad") assert.ok(gaps > 10, "the regression must exercise intermittent aircraft reports");
  }
});
