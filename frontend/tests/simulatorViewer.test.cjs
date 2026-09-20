const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");

const frontend = path.resolve(__dirname, "..");
function load(relative, extra = {}) {
  const compiled = ts.transpileModule(fs.readFileSync(path.join(frontend, relative), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exported = {};
  vm.runInNewContext(compiled, { exports: exported, URL, Error, AbortController, setTimeout, clearTimeout, ...extra });
  return exported;
}
const helper = load("lib/simulatorViewer.ts");
const native = `<!doctype html><html><head><script src="gz3d.gui.js"></script><link rel="stylesheet" href="style/gz3d.css"></head><body><button id="native-control">Native control</button><script>scene=new GZ3D.Scene(shaders);iface=new GZ3D.GZIface(scene);animate();</script><script>window.__AS_API='http://'+location.hostname+':8090';(function(){var s=document.createElement('script');s.src=window.__AS_API+'/panel.js';document.head.appendChild(s);})();</script></body></html>`;

test("native assets and socket keep the configured simulator origin", () => {
  const output = helper.prepareSimulatorViewerHtml(native, "http://sim.example:8088/");
  assert.match(output, /<base href="http:\/\/sim\.example:8088\/">/);
  assert.match(output, /new GZ3D\.GZIface\(scene, "sim\.example:8088"\)/);
  assert.match(output, /src="gz3d\.gui\.js"/);
  assert.match(output, /href="style\/gz3d\.css"/);
  assert.match(output, /id="native-control"/);
  assert.match(output, /animate\(\)/);
  const base = output.match(/<base href="([^"]+)"/)[1];
  assert.equal(new URL("assets/iris/model.dae", base).href, "http://sim.example:8088/assets/iris/model.dae");
});

test("injected panel uses simulator host or explicitly configured control URL", () => {
  const defaultOutput = helper.prepareSimulatorViewerHtml(native, "http://sim.example:8088/");
  assert.match(defaultOutput, /window\.__AS_API="http:\/\/sim\.example:8090";/);
  assert.doesNotMatch(defaultOutput, /location\.hostname/);
  const configured = helper.prepareSimulatorViewerHtml(native, "http://sim.example:8088/", "https://control.example/arctic/");
  assert.equal((configured.match(/window\.__AS_API="https:\/\/control\.example\/arctic";/g) ?? []).length, 2);
  assert.match(configured, /s\.src=window\.__AS_API\+'\/panel\.js'/);
});

test("overlay resolves to the frontend origin despite the simulator base", () => {
  const output = helper.prepareSimulatorViewerHtml(native, "http://sim.example:8088/");
  const loader = [...output.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
  let appended;
  vm.runInNewContext(loader, {
    URL, window: { location: { href: "http://localhost:3000/api/simulator-viewer" } },
    document: { createElement: () => ({}), body: { appendChild: value => { appended = value; } } },
  });
  assert.equal(appended.src, "http://localhost:3000/simulator-tags.js");
});

test("unsupported upstreams fail rather than silently creating a disconnected scene", () => {
  for (const address of ["file:///tmp/viewer", "https://sim.example/", "http://user:secret@sim.example/", "http://sim.example/?url=other"]) {
    assert.throws(() => helper.prepareSimulatorViewerHtml(native, address));
  }
  for (const html of ["<html><body>Login</body></html>", native.replace("new GZ3D.GZIface(scene)", "new OtherViewer(scene)"), native.replace("</body>", "")]) {
    assert.throws(() => helper.prepareSimulatorViewerHtml(html, "http://sim.example/"), /unsupported viewer/);
  }
  assert.throws(() => helper.prepareSimulatorViewerHtml(native, "http://sim.example/", "javascript:alert(1)"), /control address/);
});

function routeHarness(fetch, env = {}) {
  const handler = load("pages/api/simulator-viewer.ts", {
    require: name => { assert.equal(name, "../../lib/simulatorViewer"); return helper; },
    process: { env }, fetch,
  }).default;
  const result = { headers: {} };
  const response = {
    setHeader(name, value) { result.headers[name] = value; },
    status(code) { result.status = code; return this; },
    send(body) { result.body = body; return this; },
  };
  return { handler, result, response };
}

test("route is GET-only and does not fetch a caller-supplied upstream", async () => {
  const calls = [];
  const h = routeHarness(async (url, options) => {
    calls.push({ url, options });
    return { ok: true, headers: new Headers({ "content-type": "text/html" }), text: async () => native };
  }, { SIM_VIEWER_URL: "http://configured.example:8080/", NEXT_PUBLIC_SIM_VIEWER_URL: "http://other.example/" });
  await h.handler({ method: "POST", query: {} }, h.response);
  assert.equal(h.result.status, 405);
  assert.equal(h.result.headers.Allow, "GET");
  assert.equal(calls.length, 0);
  await h.handler({ method: "GET", query: { url: "http://caller.example/" } }, h.response);
  assert.equal(h.result.status, 200);
  assert.equal(calls[0].url, "http://configured.example:8080/");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.cache, "no-store");
  assert.equal(h.result.headers["Cache-Control"], "no-store");
  assert.match(h.result.body, /configured\.example:8080/);
});

test("route presents honest errors for failed and incompatible responses", async () => {
  const cases = [
    { fetch: async () => ({ ok: false, status: 502 }), status: 502, text: /HTTP 502/ },
    { fetch: async () => ({ ok: true, headers: new Headers({ "content-type": "application/json" }) }), status: 502, text: /did not return an HTML/ },
    { fetch: async () => ({ ok: true, headers: new Headers({ "content-type": "text/html" }), text: async () => "<html>Login</html>" }), status: 503, text: /unsupported viewer/ },
    { fetch: async () => { throw new Error("private network details"); }, status: 503, text: /could not be reached/ },
  ];
  for (const item of cases) {
    const h = routeHarness(item.fetch);
    await h.handler({ method: "GET", query: {} }, h.response);
    assert.equal(h.result.status, item.status);
    assert.match(h.result.body, item.text);
    assert.doesNotMatch(h.result.body, /private network details/);
  }
});
