const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const script = fs.readFileSync(path.join(__dirname, "../public/simulator-tags.js"), "utf8");

class Vector3 {
  constructor(x = 0, y = 0, z = 0) { this.set(x, y, z); }
  set(x, y, z) { this.x = x; this.y = y; this.z = z; return this; }
  copy(other) { return this.set(other.x, other.y, other.z); }
  add(other) { this.x += other.x; this.y += other.y; this.z += other.z; return this; }
  subVectors(a, b) { return this.set(a.x - b.x, a.y - b.y, a.z - b.z); }
  length() { return Math.hypot(this.x, this.y, this.z); }
  normalize() { return this.multiplyScalar(1 / (this.length() || 1)); }
  multiplyScalar(scale) { this.x *= scale; this.y *= scale; this.z *= scale; return this; }
  project(camera) { return camera.project(this); }
}

function element(tagName) {
  return {
    tagName, children: [], attributes: {}, dataset: {}, events: {}, hidden: false,
    offsetWidth: tagName === "button" ? 140 : 0, offsetHeight: tagName === "button" ? 54 : 0,
    textContent: "", parentNode: null,
    // Fail immediately if untrusted mission text ever reaches an HTML parser.
    set innerHTML(value) { throw new Error("Unexpected innerHTML assignment: " + value); },
    style: { setProperty(name, value) { this[name] = value; } },
    appendChild(child) { this.children.push(child); child.parentNode = this; return child; },
    remove() {
      if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
      this.parentNode = null;
    },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(type, listener) { this.events[type] = listener; },
  };
}

function harness(three = { Vector3 }) {
  const origin = "http://localhost:3000";
  const document = { head: element("head"), body: element("body"), createElement: element };
  const models = new Map();
  const messages = [];
  const renderCalls = [];
  let cameraLookTarget = null;
  let time = 10000;
  let controlUpdates = 0;
  const scene = {
    camera: { position: new Vector3(0, -100, 100), project: point => point.multiplyScalar(0.01), lookAt(target) { cameraLookTarget = new Vector3().copy(target); } },
    controls: { target: new three.Vector3(), enablePan: true, enableRotate: true, enableZoom: true, noPan: false, noRotate: false, noZoom: false, update() { controlUpdates += 1; } },
    onMouseScroll() { return "native-scroll"; },
    getByName: id => models.get(id),
    getDomElement: () => ({ getBoundingClientRect: () => ({ left: 20, top: 30, width: 800, height: 600 }) }),
    render(...args) { renderCalls.push({ receiver: this, args }); return "native-render-result"; },
  };
  const parent = { postMessage(message, targetOrigin) { messages.push({ message, targetOrigin }); } };
  const listeners = {};
  const window = {
    parent, location: { origin }, scene, THREE: three, iface: { isConnected: true },
    addEventListener(type, listener) { listeners[type] = listener; },
    setTimeout() { throw new Error("Scene should already be available"); },
  };
  vm.runInNewContext(script, {
    window, document, Date: { now: () => time },
    fetch() { throw new Error("Overlay must not send simulator commands"); },
  });
  const layer = document.body.children.find(child => child.id === "ow-tags");
  return {
    window, document, scene, models, messages, layer, renderCalls,
    get tags() { return layer.children.filter(child => child.className === "ow-tag"); },
    get leaders() { return layer.children.filter(child => child.className === "ow-line"); },
    get dots() { return layer.children.filter(child => child.className === "ow-dot"); },
    get controlUpdates() { return controlUpdates; },
    get cameraLookTarget() { return cameraLookTarget; },
    advance(ms) { time += ms; },
    model(id, x = 0, y = 0, z = 0, yaw = 0) {
      const object = {
        position: new Vector3(x, y, z), yaw, visible: true,
        getWorldPosition(out) { return out.copy(this.position); },
        localToWorld(out) {
          const lx = out.x, ly = out.y, c = Math.cos(this.yaw), s = Math.sin(this.yaw);
          return out.set(lx * c - ly * s + this.position.x, lx * s + ly * c + this.position.y, out.z + this.position.z);
        },
      };
      models.set(id, object);
      return object;
    },
    send(data, overrides = {}) { listeners.message({ origin, source: parent, data: JSON.stringify(data), ...overrides }); },
    telemetry(fleet, extras = {}) {
      this.send({ type: "overwatch:telemetry", version: 1, fresh: true, tags: true, fleet, ...extras });
    },
  };
}

function asset(id = "copter-1", extras = {}) {
  return { id, role: "Track", vehicleClass: "copter", alt: 40, speed: 8, linked: true, ...extras };
}

function translation(element) {
  const match = /^translate\((-?[\d.]+)px,(-?[\d.]+)px\)/.exec(element.style.transform);
  assert.ok(match, "element has a screen-space position");
  return { x: Number(match[1]), y: Number(match[2]) };
}

function assertAnchor(h, index, x, y) {
  assert.deepEqual(translation(h.leaders[index]), { x, y });
  assert.deepEqual(translation(h.dots[index]), { x: x - 3, y: y - 3 });
  const tag = h.tags[index], position = translation(tag);
  const dx = Math.max(position.x, Math.min(position.x + tag.offsetWidth, x)) - x;
  const dy = Math.max(position.y, Math.min(position.y + tag.offsetHeight, y)) - y;
  assert.ok(Math.abs(parseFloat(h.leaders[index].style.width) - Math.hypot(dx, dy)) < 0.1,
    "leader spans from the exact native anchor to the nearest label edge");
}

function assertVector(actual, expected, message) {
  for (const axis of ["x", "y", "z"]) assert.ok(Math.abs(actual[axis] - expected[axis]) < 1e-9,
    `${message ?? "vector"} ${axis}: expected ${expected[axis]}, received ${actual[axis]}`);
}

test("bridge rejects messages from another origin, source, or protocol version", () => {
  const h = harness();
  const message = { type: "overwatch:telemetry", version: 1, fresh: true, fleet: [asset()] };
  h.send(message, { origin: "https://untrusted.example" });
  h.send(message, { source: {} });
  h.send({ ...message, version: 2 });
  h.send({ ...message, version: undefined });
  h.send(null);
  h.send(message, { data: "not valid JSON" });
  h.send(message, { data: message });
  assert.equal(h.tags.length, 0);
  h.send(message);
  assert.equal(h.tags.length, 1);
  assert.equal(h.messages[0].message.type, "overwatch:ready");
  assert.equal(h.messages[0].message.version, 1);
  assert.equal(h.messages[0].targetOrigin, "http://localhost:3000");
});

test("telemetry creates safe text labels, selected state, and bounded valid theme colors", () => {
  const h = harness();
  const id = '<img src=x onerror="alert(1)">';
  const role = "<script>bad()</script>";
  h.telemetry([asset(id, { role, alt: NaN, speed: 12.34 })], {
    selected: id, colors: { surface: "#123abc", accentText: "url(javascript:bad())", text: "#ffeedd" },
  });
  const tag = h.tags[0];
  assert.deepEqual(tag.children.map(child => child.tagName), ["strong", "span", "span"]);
  assert.equal(tag.children[0].textContent, id);
  assert.equal(tag.children[1].textContent, "Quadcopter · " + role);
  assert.equal(tag.children[2].textContent, "— · 12.3 m/s");
  assert.equal(tag.attributes["aria-label"], "Inspect " + id);
  assert.equal(tag.attributes["aria-pressed"], "true");
  assert.equal(h.layer.style["--tag-bg"], "#123abc");
  assert.equal(h.layer.style["--tag-text"], "#ffeedd");
  assert.equal(h.layer.style["--tag-accent"], undefined);
  h.telemetry([asset(id, { role: "Confirm" })]);
  assert.equal(h.tags.length, 1);
  assert.equal(tag.children[1].textContent, "Quadcopter · Confirm");
  assert.equal(tag.attributes["aria-pressed"], "false");
});

test("selecting a tag sends only its ID to the same-origin parent and stops native pointer events", () => {
  const h = harness();
  h.telemetry([asset()]);
  h.messages.length = 0;
  const tag = h.tags[0];
  let stopped = 0;
  for (const type of ["pointerdown", "mousedown", "touchstart", "wheel", "click"]) {
    tag.events[type]({ stopPropagation() { stopped += 1; } });
  }
  assert.equal(stopped, 5);
  assert.equal(h.messages.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.messages[0])), {
    message: { type: "overwatch:select", version: 1, id: "copter-1" }, targetOrigin: "http://localhost:3000",
  });
});

test("native rendering is preserved and tags follow native poses rather than telemetry coordinates", () => {
  const h = harness();
  const object = h.model("copter-1", 20, -20, 0);
  h.telemetry([asset("copter-1", { alt: 99999, lat: 900, lon: 900 })]);
  assert.equal(h.scene.render("frame", 7), "native-render-result");
  assert.equal(h.renderCalls.length, 1);
  assert.equal(h.renderCalls[0].receiver, h.scene);
  assert.deepEqual(h.renderCalls[0].args, ["frame", 7]);
  const tag = h.tags[0];
  assert.equal(tag.hidden, false);
  assertAnchor(h, 0, 500, 390);
  const originalPosition = tag.style.transform;
  object.position.set(-40, 40, 0);
  h.scene.render();
  assertAnchor(h, 0, 260, 210);
  assert.notEqual(tag.style.transform, originalPosition);
  assert.equal(h.renderCalls.length, 2);
  const status = h.messages.find(({ message }) => message.type === "overwatch:status");
  assert.deepEqual(Array.from(status.message.matched), ["copter-1"]);
  assert.equal(status.message.connected, true);
});

test("missing, invisible, clipped and removed native objects cannot leave visible tags", () => {
  const h = harness();
  const object = h.model("copter-1");
  h.telemetry([asset(), asset("not-in-scene")]);
  h.scene.render();
  const [tag, absent] = h.tags;
  assert.equal(tag.hidden, false);
  assert.equal(absent.hidden, true);
  assert.equal(h.leaders[1].hidden, true);
  assert.equal(h.dots[1].hidden, true);
  for (const position of [[110, 0, 0], [0, -110, 0], [0, 0, 101], [0, 0, -101], [NaN, 0, 0]]) {
    object.position.set(...position);
    h.scene.render();
    assert.equal(tag.hidden, true, "hidden at " + position);
    assert.equal(h.leaders[0].hidden, true);
    assert.equal(h.dots[0].hidden, true);
  }
  object.position.set(0, 0, 0);
  object.visible = false;
  h.scene.render();
  assert.equal(tag.hidden, true);
  object.visible = true;
  h.scene.render();
  assert.equal(tag.hidden, false);
  h.models.delete("copter-1");
  h.scene.render();
  assert.equal(tag.hidden, true);
  assert.equal(h.leaders[0].hidden, true);
  assert.equal(h.dots[0].hidden, true);
  h.telemetry([]);
  assert.equal(h.tags.length + h.leaders.length + h.dots.length, 0);
  assert.equal(tag.parentNode, null);
});

test("turning asset tags off leaves ship overlays available and reenabling uses the current pose", () => {
  const h = harness();
  const object = h.model("copter-1");
  h.telemetry([asset()], { tags: false });
  h.scene.render();
  h.scene.render();
  assert.equal(h.tags[0].hidden, true);
  assert.equal(h.layer.hidden, false);
  object.position.set(20, -20, 0);
  h.telemetry([asset()], { tags: true });
  h.scene.render();
  assert.equal(h.layer.hidden, false);
  assertAnchor(h, 0, 500, 390);
});

test("metadata becomes stale after a telemetry timeout and recovers with fresh telemetry", () => {
  const h = harness();
  h.model("copter-1");
  h.telemetry([asset()]);
  h.scene.render();
  const tag = h.tags[0];
  assert.equal(tag.dataset.stale, "false");
  h.advance(5600);
  h.scene.render();
  assert.equal(tag.dataset.stale, "true");
  assert.equal(tag.children[1].textContent, "Quadcopter · Track");
  assert.equal(tag.children[2].textContent, "Telemetry stale");
  h.telemetry([asset()]);
  assert.equal(tag.dataset.stale, "false");
  assert.equal(tag.children[1].textContent, "Quadcopter · Track");
  h.telemetry([asset()], { fresh: false });
  assert.equal(tag.dataset.stale, "true");
  h.telemetry([asset("copter-1", { linked: false })]);
  assert.equal(tag.dataset.stale, "true");
  assert.equal(tag.children[2].textContent, "Link unavailable");
});

test("native towers can be located without borrowing assignments from another simulation", () => {
  const h = harness();
  h.model("tower-1", 20, 10, 0);
  h.model("terrain_fort_ross");
  h.scene.render();
  assert.equal(h.tags.length, 1, "terrain is not a fleet asset");
  const tag = h.tags[0];
  assert.equal(tag.children[1].textContent, "Sensor tower · Assignment unavailable");
  const status = h.messages.find(({ message }) => message.type === "overwatch:status").message;
  assert.equal(status.assets[0].id, "tower-1");
  assert.equal(status.matched.length, 0, "native presence is not linked mission telemetry");
  h.send({ type: "overwatch:focus", version: 1, id: "tower-1" });
  assertVector(h.scene.controls.target, { x: 20, y: 10, z: 0 });
  h.telemetry([asset("tower-1", { vehicleClass: "tower", role: "cue" })]);
  assert.equal(tag.children[1].textContent, "Sensor tower · Cue sensors");
  assert.equal(tag.dataset.role, "cue");
  h.telemetry([]);
  assert.equal(tag.children[1].textContent, "Sensor tower · Assignment unavailable");
  assert.equal(tag.dataset.role, "");
  h.models.delete("tower-1");
  h.advance(1100);
  h.scene.render();
  assert.equal(h.tags.length, 0, "removed native assets are no longer selectable");
});

test("overlapping native anchors receive separate nonoverlapping labels with accurate leaders", () => {
  const h = harness();
  const ids = ["copter-1", "plane-1", "rover-1", "tower-1"];
  for (const id of ids) h.model(id);
  h.telemetry(ids.map(id => asset(id)));
  h.scene.render();
  const boxes = h.tags.map((tag, index) => {
    assert.equal(tag.hidden, false);
    assertAnchor(h, index, 420, 330);
    return { ...translation(tag), w: tag.offsetWidth, h: tag.offsetHeight };
  });
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i], b = boxes[j];
      assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y,
        ids[i] + " and " + ids[j] + " labels do not overlap");
    }
  }
});

test("focus changes only the local camera and ignores untrusted or unknown requests", () => {
  const h = harness();
  const object = h.model("copter-1", 20, 30, 40);
  h.telemetry([asset()]);
  h.messages.length = 0;
  const focus = { type: "overwatch:focus", version: 1, id: "copter-1" };
  h.send(focus, { origin: "https://untrusted.example" });
  h.send(focus, { source: {} });
  h.send({ ...focus, version: 2 });
  h.send({ ...focus, id: "not-in-fleet" });
  assert.equal(h.controlUpdates, 0);
  h.send(focus);
  assert.equal(h.controlUpdates, 1);
  assert.deepEqual(h.scene.controls.target, new Vector3(20, 30, 40));
  assert.deepEqual(object.position, new Vector3(20, 30, 40));
  const cameraOffset = new Vector3().subVectors(h.scene.camera.position, object.position);
  assert.ok(cameraOffset.length() > 120, "camera fits the copter reference radius");
  assert.ok(cameraOffset.y < 0 && cameraOffset.z > 0);
  assert.equal(h.messages.length, 0);
  assert.equal(h.renderCalls.length, 0);
  h.models.delete("copter-1");
  h.send(focus);
  assert.equal(h.controlUpdates, 1);
});

test("selected radius and ship both fit the overview, including portrait layouts", () => {
  const T = require("three");
  for (const aspect of [4 / 3, 0.55]) {
    const h = harness(T);
    h.scene.camera = new T.PerspectiveCamera(60, aspect, 0.1, 50000);
    h.scene.camera.up.set(0, 0, 1);
    h.scene.scene = new T.Scene();
    h.scene.getDomElement = () => ({ getBoundingClientRect: () => ({ left: 0, top: 0, width: 600 * aspect, height: 600 }) });
    h.model("tower-1", 100, 200, 8);
    const ship = h.model("target_vessel", 8000, -4000, 0);
    h.telemetry([asset("tower-1", { vehicleClass: "tower", role: "cue" })], { selected: "tower-1" });
    h.send({ type: "overwatch:focus", version: 1, id: "tower-1" });
    h.scene.render(); h.scene.camera.updateMatrixWorld();
    const ring = h.scene.scene.getObjectByName("overwatch-reference-radius");
    assert.equal(ring.scale.x, 2500);
    assert.equal(ring.scale.y, 2500);
    assert.equal(ring.position.x, 100);
    assert.equal(ring.position.y, 200);
    for (const p of [[100-2500,200,9], [100+2500,200,9], [100,200-2500,9], [100,200+2500,9], [ship.position.x,ship.position.y,ship.position.z]]) {
      const screen = new T.Vector3(...p).project(h.scene.camera);
      assert.ok(Math.abs(screen.x) < 0.9 && Math.abs(screen.y) < 0.9 && Math.abs(screen.z) < 1, "radius and native ship remain inside the viewport");
    }
    const label = h.layer.children.find(child => child.className === "ow-range");
    assert.match(label.textContent, /Reference radius 2.5 km/);
    assert.match(label.textContent, /sensor reach unverified/);
    h.telemetry([asset("tower-1", { vehicleClass: "tower" })], { selected: null });
    h.scene.render();
    assert.equal(ring.visible, false);
    assert.equal(label.hidden, true);
  }
});

test("ship inset restores the main renderer viewport and never changes model poses", () => {
  const T = require("three"), h = harness(T), calls = [];
  h.scene.camera = new T.PerspectiveCamera(60, 4/3, 0.1, 50000);
  h.scene.scene = new T.Scene();
  h.scene.renderer = { autoClear: true, setViewport(...values) { calls.push(["viewport", ...values]); }, setScissor() {}, setScissorTest(on) { calls.push(["scissor", on]); }, clear() {}, render() { calls.push(["inset"]); } };
  h.model("tower-1", 10, 20, 8);
  const ship = h.model("target_vessel", 300, 400, 0);
  h.telemetry([asset("tower-1", { vehicleClass: "tower" })], { selected: "tower-1" });
  h.scene.render();
  assert.ok(calls.some(call => call[0] === "inset"));
  assert.deepEqual(calls.at(-1), ["viewport", 0, 0, 800, 600]);
  assert.deepEqual(calls.at(-2), ["scissor", false]);
  assert.equal(h.scene.renderer.autoClear, true);
  assertVector(ship.position, { x: 300, y: 400, z: 0 });
  h.window.THREE = { ...T, REVISION: "86" };
  calls.length = 0; h.scene.render();
  assert.equal(calls.find(call => call[0] === "viewport")[2], 12, "native r86 expects a top-left viewport origin");
  h.scene.renderer.render = () => { throw new Error("Auxiliary render failed"); };
  assert.equal(h.scene.render(), "native-render-result");
  assert.equal(h.scene.renderer.autoClear, true);
  assert.equal(h.layer.children.find(child => child.className === "ow-inset").hidden, true);
  h.window.iface.isConnected = false; h.scene.render();
  assert.equal(h.layer.children.find(child => child.className === "ow-inset").hidden, true);
});

test("ship follow tracks native movement in the paint call and preserves orbit and zoom", () => {
  const h = harness();
  const ship = h.model("target_vessel", 20, 30, 0);
  h.scene.camera.position.set(0, 0, -100);
  h.send({ type: "overwatch:follow-ship", version: 1, enabled: true });
  h.scene.render();
  assert.deepEqual(h.scene.controls.target, ship.position);
  assert.ok(h.scene.camera.position.z > ship.position.z, "demo camera begins above the ship even after an underwater view");
  assertVector(h.cameraLookTarget, ship.position);
  assert.equal(h.scene.controls.enablePan, false);
  h.scene.camera.position.copy(ship.position).add(new Vector3(30, -60, 40));
  ship.position.set(25, 35, 0);
  h.advance(1000); h.scene.render();
  assert.deepEqual(h.scene.controls.target, ship.position);
  assert.deepEqual(h.scene.camera.position, new Vector3(55, -25, 40));
  assert.equal(h.messages.at(-1).message.followingShip, true);
  let prevented = false;
  assert.equal(h.scene.onMouseScroll({ preventDefault() { prevented = true; } }), undefined);
  assert.equal(prevented, true);
  h.send({ type: "overwatch:follow-ship", version: 1, enabled: false });
  const previous = new Vector3().copy(h.scene.camera.position);
  ship.position.set(99, 99, 0); h.scene.render();
  assert.deepEqual(h.scene.camera.position, previous);
  assert.equal(h.scene.controls.enablePan, true);
  assert.equal(h.scene.onMouseScroll(), "native-scroll");
});

test("camera presets are ship-relative and cover chase, profiles, overhead and context views", () => {
  const h = harness();
  h.model("target_vessel", 10, 20, 0, Math.PI / 2);
  const expected = {
    chase: [[37.5, -90, 42.5], [10, 35, 7]],
    stern: [[10, -100, 32.5], [10, 27.5, 7]],
    bow: [[10, 130, 32.5], [10, 20, 7]],
    port: [[-77.5, 20, 32.5], [10, 20, 7]],
    starboard: [[97.5, 20, 32.5], [10, 20, 7]],
    portQuarter: [[-52.5, -57.5, 42.5], [10, 27.5, 7]],
    starboardQuarter: [[72.5, -57.5, 42.5], [10, 27.5, 7]],
    waterline: [[85, 22.5, 5], [10, 26, 7]],
    overhead: [[10, 17.5, 140], [10, 20, 0]],
    wide: [[97.5, -90, 82.5], [10, 27.5, 7]],
    bridge: [[10, 37.5, 19], [10, 170, 6]],
  };
  for (const [mode, [camera, target]] of Object.entries(expected)) {
    h.send({ type: "overwatch:camera", version: 1, mode });
    h.advance(1000); h.scene.render();
    assertVector(h.scene.camera.position, new Vector3(...camera), mode + " camera");
    assertVector(h.scene.controls.target, new Vector3(...target), mode + " target");
    assertVector(h.cameraLookTarget, new Vector3(...target), mode + " look target");
    assert.equal(h.scene.controls.enablePan, false);
    assert.equal(h.scene.controls.enableRotate, false);
    assert.equal(h.scene.controls.enableZoom, false);
    assert.equal(h.scene.controls.noPan, true);
    assert.equal(h.scene.controls.noRotate, true);
    assert.equal(h.scene.controls.noZoom, true);
    assert.equal(h.messages.at(-1).message.cameraMode, mode);
    assert.equal(h.messages.at(-1).message.followingShip, true);
  }
});

test("locked views rotate with heading, switch immediately and free restores navigation", () => {
  const h = harness();
  const ship = h.model("target_vessel", 0, 0, 0);
  h.send({ type: "overwatch:camera", version: 1, mode: "chase" }); h.scene.render();
  assertVector(h.scene.camera.position, new Vector3(-110, -27.5, 42.5), "chase camera");
  ship.yaw = Math.PI / 2; h.scene.render();
  assertVector(h.scene.camera.position, new Vector3(27.5, -110, 42.5), "rotated chase camera");
  h.send({ type: "overwatch:camera", version: 1, mode: "bow" }); h.scene.render();
  assertVector(h.scene.camera.position, new Vector3(0, 110, 32.5), "rotated bow camera");
  h.send({ type: "overwatch:camera", version: 1, mode: "unknown" }); h.scene.render();
  assertVector(h.scene.camera.position, new Vector3(0, 110, 32.5), "unknown mode ignored");
  h.send({ type: "overwatch:camera", version: 1, mode: "free" });
  const free = new Vector3().copy(h.scene.camera.position);
  ship.position.set(20, 30, 0); h.scene.render();
  assert.deepEqual(h.scene.camera.position, free);
  assert.equal(h.scene.controls.enablePan, true);
  assert.equal(h.scene.controls.enableRotate, true);
  assert.equal(h.scene.controls.enableZoom, true);
  assert.equal(h.scene.controls.noPan, false);
  assert.equal(h.scene.controls.noRotate, false);
  assert.equal(h.scene.controls.noZoom, false);
});

test("ship follow rejects untrusted messages and pauses on disconnect, invalid or missing model", () => {
  const h = harness();
  const request = { type: "overwatch:follow-ship", version: 1, enabled: true };
  const ship = h.model("target_vessel", 20, 30, 0);
  h.send(request, { source: {} }); h.scene.render();
  assert.deepEqual(h.scene.controls.target, new Vector3());
  h.send(request); h.scene.render();
  h.window.iface.isConnected = false;
  ship.position.set(50, 50, 0); h.scene.render();
  assert.deepEqual(h.scene.controls.target, new Vector3(20, 30, 0));
  assert.equal(h.scene.controls.enablePan, true);
  h.window.iface.isConnected = true; h.scene.render();
  assert.deepEqual(h.scene.controls.target, new Vector3(50, 50, 0));
  ship.position.x = NaN; h.scene.render();
  assert.deepEqual(h.scene.controls.target, new Vector3(50, 50, 0));
  h.models.delete("target_vessel"); h.advance(1000); h.scene.render();
  assert.equal(h.messages.at(-1).message.followingShip, false);
  const replacement = h.model("target_vessel", 5, 6, 0); h.scene.render();
  assert.deepEqual(h.scene.controls.target, replacement.position);
});

test("replay capture runs after native paint, is bounded, and cannot interrupt rendering", () => {
  const h = harness();
  let snapshots = 0;
  h.window.__overwatchCaptureCanvas = () => { assert.ok(h.renderCalls.length > snapshots); snapshots += 1; };
  h.scene.render(); h.advance(100); h.scene.render();
  assert.equal(snapshots, 1);
  h.advance(400); h.scene.render(); assert.equal(snapshots, 2);
  h.document.hidden = true; h.advance(1000); h.scene.render(); assert.equal(snapshots, 2);
  h.document.hidden = false;
  h.window.__overwatchCaptureCanvas = () => { throw new Error("Replay unavailable"); };
  assert.equal(h.scene.render(), "native-render-result");
});
