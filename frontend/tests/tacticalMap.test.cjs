const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const React = require("react");
const ts = require("typescript");

const source = fs.readFileSync(
  path.resolve(__dirname, "../components/TacticalMap.tsx"),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.CommonJS,
    jsx: ts.JsxEmit.ReactJSX,
  },
}).outputText;

function renderBasemap(key) {
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    process: {
      env: key === undefined ? {} : { NEXT_PUBLIC_CARTO_BASEMAP_API_KEY: key },
    },
    require(name) {
      if (name === "react/jsx-runtime") return require(name);
      if (name === "react-leaflet") {
        return Object.fromEntries(
          ["Circle", "CircleMarker", "MapContainer", "Polyline", "Popup", "ScaleControl", "TileLayer", "Tooltip"]
            .map((component) => [component, component]),
        );
      }
      if (name === "../lib/geo") {
        return { DEFAULT_ARENA: { origin_lat: 74.6973, origin_lon: -94.8297 } };
      }
      if (name === "../lib/theme") {
        return { sceneColors: { chalk: "#eee", muted: "#888", rust: "#a54", ink: "#123", void: "#000" } };
      }
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  const map = exports.default({
    fleet: {}, track: null, truth: null, heatmap: [], strategy: null,
  });
  assert.equal(map.type, "MapContainer");
  assert.equal(map.props.attributionControl, true);
  const layers = React.Children.toArray(map.props.children)
    .filter((child) => child.type === "TileLayer");
  assert.equal(layers.length, 1);
  return layers[0].props;
}

test("configured CARTO basemap sends an encoded key and preserves provider attribution", () => {
  const testKey = "test-only+/key?&=";
  const layer = renderBasemap(`  ${testKey}  `);
  assert.equal(
    layer.url,
    `https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=${encodeURIComponent(testKey)}`,
  );
  assert.equal(new URL(layer.url).searchParams.get("key"), testKey);
  assert.match(layer.attribution, /https:\/\/www\.openstreetmap\.org\/copyright/);
  assert.match(layer.attribution, /https:\/\/carto\.com\/attributions/);
  assert.equal(layer.maxZoom, 20);
});

for (const [label, key] of [["missing", undefined], ["whitespace-only", " \t "]]) {
  test(`${label} CARTO key uses the OpenStreetMap fallback with correct attribution`, () => {
    const layer = renderBasemap(key);
    assert.equal(layer.url, "https://tile.openstreetmap.org/{z}/{x}/{y}.png");
    assert.match(layer.attribution, /https:\/\/www\.openstreetmap\.org\/copyright/);
    assert.doesNotMatch(layer.attribution, /carto/i);
    assert.equal(layer.maxZoom, 19);
  });
}
