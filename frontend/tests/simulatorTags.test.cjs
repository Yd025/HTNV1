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

function harness() {
  const origin = "http://localhost:3000";
  const document = { head: element("head"), body: element("body"), createElement: element };
  const models = new Map();
  const messages = [];
  const renderCalls = [];
  let time = 10000;
  let controlUpdates = 0;
  const scene = {
    camera: { position: new Vector3(0, -100, 100), project: point => point.multiplyScalar(0.01) },
    controls: { target: new Vector3(), update() { controlUpdates += 1; } },
    getByName: id => models.get(id),
    getDomElement: () => ({ getBoundingClientRect: () => ({ left: 20, top: 30, width: 800, height: 600 }) }),
    render(...args) { renderCalls.push({ receiver: this, args }); return "native-render-result"; },
  };
  const parent = { postMessage(message, targetOrigin) { messages.push({ message, targetOrigin }); } };
  const listeners = {};
  const window = {
    parent, location: { origin }, scene, THREE: { Vector3 }, iface: { isConnected: true },
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
    advance(ms) { time += ms; },
    model(id, x = 0, y = 0, z = 0) {
      const object = { position: new Vector3(x, y, z), visible: true, getWorldPosition(out) { return out.copy(this.position); } };
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
  assert.equal(tag.children[1].textContent, role + " · copter");
  assert.equal(tag.children[2].textContent, "— · 12.3 m/s");
  assert.equal(tag.attributes["aria-label"], "Inspect " + id);
  assert.equal(tag.attributes["aria-pressed"], "true");
  assert.equal(h.layer.style["--tag-bg"], "#123abc");
  assert.equal(h.layer.style["--tag-text"], "#ffeedd");
  assert.equal(h.layer.style["--tag-accent"], undefined);
  h.telemetry([asset(id, { role: "Confirm" })]);
  assert.equal(h.tags.length, 1);
  assert.equal(tag.children[1].textContent, "Confirm · copter");
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
  assert.equal(h.layer.children.length, 0);
  assert.equal(tag.parentNode, null);
});

test("turning tags off hides the layer and turning them on uses the current native pose", () => {
  const h = harness();
  const object = h.model("copter-1");
  h.telemetry([asset()], { tags: false });
  h.scene.render();
  assert.equal(h.layer.hidden, true);
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
  assert.equal(tag.children[1].textContent, "Track · telemetry stale");
  h.telemetry([asset()]);
  assert.equal(tag.dataset.stale, "false");
  assert.equal(tag.children[1].textContent, "Track · copter");
  h.telemetry([asset()], { fresh: false });
  assert.equal(tag.dataset.stale, "true");
  h.telemetry([asset("copter-1", { linked: false })]);
  assert.equal(tag.dataset.stale, "true");
  assert.equal(tag.children[1].textContent, "Track · link unavailable");
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
  assert.ok(Math.abs(cameraOffset.length() - 160) < 1e-10);
  assert.equal(cameraOffset.x, 0);
  assert.ok(cameraOffset.y < 0 && cameraOffset.z > 0);
  assert.equal(h.messages.length, 0);
  assert.equal(h.renderCalls.length, 0);
  h.models.delete("copter-1");
  h.send(focus);
  assert.equal(h.controlUpdates, 1);
});
