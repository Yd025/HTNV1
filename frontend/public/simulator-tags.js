/* Mission metadata only. Native Gazebo objects remain the source of 3D poses. */
(function () {
  'use strict';
  if (window.parent === window) return;
  var origin = window.location.origin;
  var entries = new Map();
  var selected = null, enabled = true, fresh = false, receivedAt = 0;
  var scene, layer, lastStatus = 0;
  var point, projected, offset;
  var nativeClasses = { quadcopter: 'copter', 'fixed-wing': 'plane', 'tower-1': 'tower', 'tower-2': 'tower', rover: 'rover' };
  // make_world.py names the ship target_vessel. This is a viewer camera only;
  // native truth never enters mission telemetry, detections or vehicle commands.
  // Start free until the trusted parent explicitly requests a view.
  var cameraMode = 'free', following = false, framedShip = null, framedMode = null, shipScale = 50;
  var savedControls = null, cameraPoint, lookPoint, boundsSize;
  var CAMERA_PRESETS = {
    chase:            { camera: [-2.20, -0.55, 0.85], target: [ 0.30,  0.00, 0.14] },
    stern:            { camera: [-2.40,  0.00, 0.65], target: [ 0.15,  0.00, 0.14] },
    bow:              { camera: [ 2.20,  0.00, 0.65], target: [ 0.00,  0.00, 0.14] },
    port:             { camera: [ 0.00,  1.75, 0.65], target: [ 0.00,  0.00, 0.14] },
    starboard:        { camera: [ 0.00, -1.75, 0.65], target: [ 0.00,  0.00, 0.14] },
    portQuarter:      { camera: [-1.55,  1.25, 0.85], target: [ 0.15,  0.00, 0.14] },
    starboardQuarter: { camera: [-1.55, -1.25, 0.85], target: [ 0.15,  0.00, 0.14] },
    waterline:        { camera: [ 0.05, -1.50, 0.10], target: [ 0.12,  0.00, 0.14] },
    overhead:         { camera: [-0.05,  0.00, 2.80], target: [ 0.00,  0.00, 0.00] },
    wide:             { camera: [-2.20, -1.75, 1.65], target: [ 0.15,  0.00, 0.14] },
    bridge:           { camera: [ 0.35,  0.00, 0.38], target: [ 3.00,  0.00, 0.12] }
  };
  var lastSnapshot = 0;
  var style = document.createElement('style');
  style.textContent = '#ow-tags{position:fixed;inset:0;pointer-events:none;z-index:110;font:12px system-ui,sans-serif;--tag-bg:#182232;--tag-text:#e2e7ea;--tag-muted:#a4b0b7;--tag-accent:#e7ad9f;--tag-line:#5b6670}' +
    '.ow-tag{position:absolute;left:0;top:0;pointer-events:auto;display:block;min-width:116px;max-width:180px;padding:7px 10px;text-align:left;background:var(--tag-bg);color:var(--tag-text);border:1px solid var(--tag-line);border-radius:3px;box-shadow:0 3px 10px #0004;cursor:pointer;font:inherit;line-height:1.35;white-space:nowrap}' +
    '.ow-tag[hidden],.ow-line[hidden],.ow-dot[hidden]{display:none}.ow-line{position:absolute;left:0;top:0;height:1px;background:var(--tag-text);transform-origin:0 0;opacity:.8}.ow-dot{position:absolute;left:0;top:0;width:5px;height:5px;border:1px solid var(--tag-text);border-radius:50%;background:var(--tag-bg)}' +
    '.ow-tag[data-role=search]{border-left:3px solid #72b8dd}.ow-tag[data-role=cue]{border-left:3px solid #c3a0e5}.ow-tag[data-role=track]{border-left:3px solid #e7ad9f}.ow-tag[data-role=confirm]{border-left:3px solid #8bcbb2}' +
    '.ow-tag strong,.ow-tag span{display:block;overflow:hidden;text-overflow:ellipsis}.ow-tag strong{font-size:12px;font-weight:600}.ow-tag span{font-size:10px;color:var(--tag-muted);font-variant-numeric:tabular-nums}.ow-tag[aria-pressed=true]{border-color:var(--tag-accent);z-index:2}.ow-tag[aria-pressed=true] strong{color:var(--tag-accent)}.ow-tag:focus-visible{outline:2px solid var(--tag-accent);outline-offset:3px}.ow-tag[data-stale=true]{border-style:dashed}' +
    '#as-assets,#as-bar,#as-pick,#as-env,#as-console,#play-header-fieldset,#clock-header-fieldset,#clock-mouse{display:none!important}' +
    '@media(max-width:500px){.ow-tag{min-width:98px;padding:5px 7px}.ow-tag strong{font-size:11px}.ow-tag span{font-size:9px}}';
  document.head.appendChild(style);

  function post(type, data) { window.parent.postMessage(Object.assign({ type: type, version: 1 }, data || {}), origin); }
  function text(value, fallback) { return typeof value === 'string' ? value.slice(0, 100) : fallback; }
  function number(value, unit) { return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) + unit : '—'; }
  function model(id) { return scene && scene.getByName ? scene.getByName(id) : null; }
  function isStale() { return !fresh || Date.now() - receivedAt > 5500; }
  function updateLabel(entry) {
    var stale = isStale();
    var roles = { search: 'Search area', cue: 'Cue sensors', track: 'Track ship', confirm: 'Confirm contact', reserve: 'Stand by' };
    var classes = { tower: 'Sensor tower', plane: 'Search plane', copter: 'Quadcopter', rover: 'Ground rover' };
    var role = Object.prototype.hasOwnProperty.call(roles, entry.data.role) ? roles[entry.data.role] : text(entry.data.role, 'Unassigned');
    var kind = Object.prototype.hasOwnProperty.call(classes, entry.data.vehicleClass) ? classes[entry.data.vehicleClass] : text(entry.data.vehicleClass, 'asset');
    entry.button.dataset.stale = String(stale || !entry.data.linked);
    entry.button.dataset.role = Object.prototype.hasOwnProperty.call(roles, entry.data.role) ? entry.data.role : '';
    entry.button.setAttribute('aria-pressed', String(entry.data.id === selected));
    entry.name.textContent = entry.data.id;
    entry.role.textContent = kind + ' · ' + (entry.nativeOnly ? 'Assignment unavailable' : role);
    entry.readings.textContent = entry.nativeOnly ? 'Native object · no mission telemetry' : stale ? 'Telemetry stale' : !entry.data.linked ? 'Link unavailable' : number(entry.data.alt, ' m') + ' · ' + number(entry.data.speed, ' m/s');
  }
  function upsert(data, nativeOnly) {
    var entry = entries.get(data.id);
    if (!entry) {
      var button = document.createElement('button'); button.type = 'button'; button.className = 'ow-tag';
      var name = document.createElement('strong'), role = document.createElement('span'), readings = document.createElement('span');
      button.appendChild(name); button.appendChild(role); button.appendChild(readings);
      button.setAttribute('aria-label', 'Inspect ' + data.id);
      button.addEventListener('click', function(event) { event.stopPropagation(); post('overwatch:select', { id: data.id }); });
      ['pointerdown', 'mousedown', 'touchstart', 'wheel'].forEach(function(type) { button.addEventListener(type, function(event) { event.stopPropagation(); }); });
      var leader = document.createElement('div'), dot = document.createElement('div');
      leader.className = 'ow-line'; dot.className = 'ow-dot';
      leader.setAttribute('aria-hidden', 'true'); dot.setAttribute('aria-hidden', 'true');
      layer.appendChild(leader); layer.appendChild(dot); layer.appendChild(button);
      entry = { button: button, leader: leader, dot: dot, name: name, role: role, readings: readings };
      entries.set(data.id, entry);
    }
    entry.data = data; entry.nativeOnly = nativeOnly; updateLabel(entry);
  }
  function removeEntry(entry, id) { entry.button.remove(); entry.leader.remove(); entry.dot.remove(); entries.delete(id); }
  function discoverAssets() {
    var assets = [];
    Object.keys(nativeClasses).forEach(function(id) {
      var object = model(id);
      if (!object || object.visible === false) return;
      assets.push({ id: id, vehicleClass: nativeClasses[id] });
      if (!entries.has(id)) upsert({ id: id, vehicleClass: nativeClasses[id] }, true);
    });
    entries.forEach(function(entry, id) { if (entry.nativeOnly && !assets.some(function(asset) { return asset.id === id; })) removeEntry(entry, id); });
    return assets;
  }
  function receive(event) {
    if (event.origin !== origin || event.source !== window.parent || typeof event.data !== 'string') return;
    var message;
    try { message = JSON.parse(event.data); } catch (_) { return; }
    if (!message || message.version !== 1) return;
    if (message.type === 'overwatch:camera') {
      setCameraMode(message.mode);
      return;
    }
    // Keep the first bridge version compatible with an already-open parent.
    if (message.type === 'overwatch:follow-ship') {
      setCameraMode(message.enabled === true ? 'orbit' : 'free');
      return;
    }
    if (message.type === 'overwatch:focus') {
      if (typeof message.id === 'string' && entries.has(message.id)) { setCameraMode('free'); focus(message.id); }
      return;
    }
    if (message.type !== 'overwatch:telemetry' || !Array.isArray(message.fleet) || !layer) return;
    fresh = message.fresh === true; receivedAt = Date.now(); enabled = message.tags !== false;
    selected = typeof message.selected === 'string' ? message.selected : null;
    layer.hidden = !enabled;
    var colors = message.colors || {};
    [['surface','bg'],['text','text'],['textMuted','muted'],['accentText','accent'],['lineStrong','line']].forEach(function(pair) {
      if (/^#[0-9a-f]{6}$/i.test(colors[pair[0]])) layer.style.setProperty('--tag-' + pair[1], colors[pair[0]]);
    });
    var ids = new Set();
    message.fleet.slice(0, 128).forEach(function(data) {
      if (!data || typeof data.id !== 'string' || !data.id || data.id.length > 100) return;
      ids.add(data.id);
      upsert(data, false);
    });
    entries.forEach(function(entry, id) {
      if (ids.has(id)) return;
      if (Object.prototype.hasOwnProperty.call(nativeClasses, id) && model(id)) upsert({ id: id, vehicleClass: nativeClasses[id] }, true);
      else removeEntry(entry, id);
    });
  }
  function focus(id) {
    var object = model(id);
    if (!object || !scene.camera || !scene.controls || !scene.controls.target) return;
    object.getWorldPosition(point);
    // Keep the camera's viewing angle, then place the orbit centre at the asset.
    offset.subVectors(scene.camera.position, scene.controls.target);
    if (offset.length() < 1) offset.set(1, -1, 1);
    var distance = 160;
    if (window.THREE.Box3) {
      try {
        new window.THREE.Box3().setFromObject(object).getSize(boundsSize);
        var extent = Math.max(boundsSize.x, boundsSize.y, boundsSize.z);
        if (Number.isFinite(extent) && extent > 0) distance = Math.max(20, Math.min(500, extent * 2.5));
      } catch (_) { /* Keep a usable focus distance while geometry loads. */ }
    }
    offset.normalize().multiplyScalar(distance);
    scene.camera.position.copy(point).add(offset);
    scene.controls.target.copy(point);
    scene.controls.update();
    if (typeof scene.camera.lookAt === 'function') scene.camera.lookAt(scene.controls.target);
  }
  function releaseFollow() {
    if (savedControls && scene && scene.controls) Object.keys(savedControls).forEach(function(key) {
      if (savedControls[key] !== undefined) scene.controls[key] = savedControls[key];
    });
    following = false; framedShip = null; framedMode = null; savedControls = null;
  }
  function setCameraMode(mode) {
    if (mode !== 'free' && mode !== 'orbit' && !Object.prototype.hasOwnProperty.call(CAMERA_PRESETS, mode)) return;
    if (mode === cameraMode) return;
    cameraMode = mode;
    framedShip = null; framedMode = null;
    if (mode === 'free') releaseFollow();
  }
  function frameShip(object) {
    if (!savedControls) savedControls = {
      enablePan: scene.controls.enablePan, enableRotate: scene.controls.enableRotate, enableZoom: scene.controls.enableZoom,
      noPan: scene.controls.noPan, noRotate: scene.controls.noRotate, noZoom: scene.controls.noZoom
    };
    shipScale = 50;
    if (window.THREE.Box3) {
      try {
        new window.THREE.Box3().setFromObject(object).getSize(boundsSize);
        var extent = Math.max(boundsSize.x, boundsSize.y, boundsSize.z);
        if (Number.isFinite(extent) && extent > 0) shipScale = Math.max(15, Math.min(160, extent));
      } catch (_) { /* Mesh bounds can be incomplete while the native model loads. */ }
    }
    if (cameraMode === 'orbit') {
      // Start the single demo view above the water, independent of whichever
      // native camera angle was active before following or locating an asset.
      scene.camera.position.copy(worldPoint(object, [-1.15, -0.9, 0.72], cameraPoint));
      scene.controls.target.copy(point);
    }
    framedShip = object; framedMode = cameraMode;
  }
  function worldPoint(object, coordinates, output) {
    output.set(coordinates[0] * shipScale, coordinates[1] * shipScale, coordinates[2] * shipScale);
    if (typeof object.localToWorld === 'function') object.localToWorld(output);
    else output.add(point);
    return output;
  }
  function updateFollow() {
    var object = model('target_vessel');
    if (cameraMode === 'free' || !window.iface || !window.iface.isConnected || !object || object.visible === false || !scene.camera || !scene.controls || !scene.controls.target) { releaseFollow(); return; }
    object.getWorldPosition(point);
    if (![point.x, point.y, point.z].every(Number.isFinite)) { releaseFollow(); return; }
    if (framedShip !== object || framedMode !== cameraMode) frameShip(object);
    var preset = CAMERA_PRESETS[cameraMode];
    if (preset) {
      if ('enablePan' in scene.controls) scene.controls.enablePan = false;
      if ('enableRotate' in scene.controls) scene.controls.enableRotate = false;
      if ('enableZoom' in scene.controls) scene.controls.enableZoom = false;
      if ('noPan' in scene.controls) scene.controls.noPan = true;
      if ('noRotate' in scene.controls) scene.controls.noRotate = true;
      if ('noZoom' in scene.controls) scene.controls.noZoom = true;
      scene.camera.position.copy(worldPoint(object, preset.camera, cameraPoint));
      scene.controls.target.copy(worldPoint(object, preset.target, lookPoint));
    } else {
      if ('enablePan' in scene.controls) scene.controls.enablePan = false;
      if ('noPan' in scene.controls) scene.controls.noPan = true;
      if ('enableRotate' in scene.controls && savedControls.enableRotate !== undefined) scene.controls.enableRotate = savedControls.enableRotate;
      if ('enableZoom' in scene.controls && savedControls.enableZoom !== undefined) scene.controls.enableZoom = savedControls.enableZoom;
      if ('noRotate' in scene.controls && savedControls.noRotate !== undefined) scene.controls.noRotate = savedControls.noRotate;
      if ('noZoom' in scene.controls && savedControls.noZoom !== undefined) scene.controls.noZoom = savedControls.noZoom;
      // Re-derive this after user orbit/zoom so the camera does not fight input.
      offset.subVectors(scene.camera.position, scene.controls.target);
      scene.camera.position.copy(point).add(offset);
      scene.controls.target.copy(point);
    }
    scene.controls.update();
    // gzweb's legacy OrbitControls intentionally comments out lookAt() when
    // only target/position change. Following must also aim the native camera.
    if (typeof scene.camera.lookAt === 'function') scene.camera.lookAt(scene.controls.target);
    following = true;
  }
  function captureReplay() {
    var now = Date.now();
    if (document.hidden || now - lastSnapshot < 500 || typeof window.__overwatchCaptureCanvas !== 'function') return;
    lastSnapshot = now;
    // Same paint call as the native WebGL render; no preserved drawing buffer.
    try { window.__overwatchCaptureCanvas(scene.getDomElement()); } catch (_) { /* Replay cannot interrupt the renderer. */ }
  }
  function renderTags() {
    if (!scene.camera || !layer) return;
    var canvas = scene.getDomElement(), rect = canvas.getBoundingClientRect();
    var matched = [], placed = [], now = Date.now(), updateStatus = now - lastStatus >= 1000;
    var assets = updateStatus ? discoverAssets() : [];
    Array.from(entries.values()).sort(function(a, b) { return a.data.id === selected ? -1 : b.data.id === selected ? 1 : a.data.id.localeCompare(b.data.id); }).forEach(function(entry) {
      var id = entry.data.id;
      var object = model(id);
      if (!object) { entry.button.hidden = entry.leader.hidden = entry.dot.hidden = true; return; }
      if (!entry.nativeOnly) matched.push(id);
      if (updateStatus) updateLabel(entry);
      if (!enabled) return;
      object.getWorldPosition(point);
      projected.copy(point).project(scene.camera);
      var visible = object.visible !== false && Number.isFinite(projected.x) && Number.isFinite(projected.y) && projected.z > -1 && projected.z < 1 && Math.abs(projected.x) < 1 && Math.abs(projected.y) < 1;
      entry.button.hidden = entry.leader.hidden = entry.dot.hidden = !visible;
      if (!visible) return;
      var x = rect.left + (projected.x + 1) * rect.width / 2;
      var y = rect.top + (1 - projected.y) * rect.height / 2;
      var w = entry.button.offsetWidth || 140, h = entry.button.offsetHeight || 54;
      var best, score = Infinity;
      // Resolve nearby labels in screen space; leader lines retain the exact
      // model anchor while the cards stay readable at the terrain overview.
      var candidates = [];
      [12, -w-12, -w/2, w+24, -2*w-24].forEach(function(cx) {
        [-h-14, 14, -2*h-26, h+26, -3*h-38, 2*h+38].forEach(function(cy) { candidates.push([cx,cy]); });
      });
      candidates.forEach(function(candidate) {
        var left = Math.max(rect.left + 8, Math.min(rect.left + rect.width - w - 8, x + candidate[0]));
        var top = Math.max(rect.top + 46, Math.min(rect.top + rect.height - h - 8, y + candidate[1]));
        var overlap = placed.reduce(function(total, other) { return total + Math.max(0, Math.min(left+w+8,other.x+other.w)-Math.max(left-8,other.x)) * Math.max(0,Math.min(top+h+8,other.y+other.h)-Math.max(top-8,other.y)); }, 0);
        var cost = overlap * 1000 + Math.abs(left-x) + Math.abs(top-y);
        if (cost < score) { score = cost; best = { x:left, y:top, w:w, h:h }; }
      });
      placed.push(best);
      entry.button.style.transform = 'translate(' + best.x.toFixed(1) + 'px,' + best.y.toFixed(1) + 'px)';
      var dx = Math.max(best.x, Math.min(best.x+w,x)) - x, dy = Math.max(best.y, Math.min(best.y+h,y)) - y;
      entry.leader.style.width = Math.sqrt(dx*dx+dy*dy).toFixed(1) + 'px';
      entry.leader.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px) rotate(' + Math.atan2(dy,dx) + 'rad)';
      entry.dot.style.transform = 'translate(' + (x-3).toFixed(1) + 'px,' + (y-3).toFixed(1) + 'px)';
    });
    if (updateStatus) { lastStatus = now; post('overwatch:status', { matched: matched, assets: assets, connected: !!(window.iface && window.iface.isConnected), shipAvailable: !!model('target_vessel'), followingShip: following, cameraMode: cameraMode }); }
  }
  function attach() {
    scene = window.scene;
    if (!scene || typeof scene.render !== 'function' || !window.THREE) { window.setTimeout(attach, 250); return; }
    point = new window.THREE.Vector3(); projected = new window.THREE.Vector3(); offset = new window.THREE.Vector3();
    cameraPoint = new window.THREE.Vector3(); lookPoint = new window.THREE.Vector3(); boundsSize = new window.THREE.Vector3();
    layer = document.createElement('div'); layer.id = 'ow-tags'; layer.setAttribute('aria-label', 'Live simulator object tags'); document.body.appendChild(layer);
    var original = scene.render;
    scene.render = function() { updateFollow(); var result = original.apply(this, arguments); renderTags(); captureReplay(); return result; };
    // Native zoom-to-cursor retargets terrain. Preserve OrbitControls' own dolly
    // while following so wheel zoom stays centered on the ship.
    var originalScroll = scene.onMouseScroll;
    if (typeof originalScroll === 'function') scene.onMouseScroll = function(event) {
      if (following) { if (event && event.preventDefault) event.preventDefault(); return; }
      return originalScroll.apply(this, arguments);
    };
    post('overwatch:ready');
  }
  window.addEventListener('message', receive);
  attach();
})();
