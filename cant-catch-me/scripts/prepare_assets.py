"""Deterministically export inert game assets from the supplied ArcticSim files.

Run with Python + Pillow; no simulator, model plugins, or source scripts execute.
The tracked output lets the Next.js app run without the original simulator.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
from pathlib import Path
import subprocess
import xml.etree.ElementTree as ET

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
NS = {"c": "http://www.collada.org/2005/11/COLLADASchema"}
IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


def multiply(a, b):
    return [sum(a[r * 4 + k] * b[k * 4 + c] for k in range(4))
            for r in range(4) for c in range(4)]


def transform(matrix, point):
    return [sum(matrix[r * 4 + k] * point[k] for k in range(3)) + matrix[r * 4 + 3]
            for r in range(3)]


def bilinear(image, x, y):
    x = min(image.width - 1, max(0, x))
    y = min(image.height - 1, max(0, y))
    x0, y0 = math.floor(x), math.floor(y)
    x1, y1 = min(x0 + 1, image.width - 1), min(y0 + 1, image.height - 1)
    u, v = x - x0, y - y0
    return (float(image.getpixel((x0, y0))) * (1 - u) * (1 - v)
            + float(image.getpixel((x1, y0))) * u * (1 - v)
            + float(image.getpixel((x0, y1))) * (1 - u) * v
            + float(image.getpixel((x1, y1))) * u * v)


def build_world(sim_root):
    folder = sim_root / "out/fort_ross"
    meta = json.loads((folder / "terrain.json").read_text())
    dem = Image.open(folder / "dem_clamped.tif")
    rendered = Image.open(folder / "heightmap.png").convert("L")
    assert dem.size == rendered.size == (1025, 1025)
    half, size = float(meta["extent_m"]) / 2, 257
    assert half == 3250
    zmin, zrange = meta["elevation_m"]["min"], meta["elevation_m"]["range"]

    def pixels(x, z):
        # Raster row 0 is world +Y, hence THREE -Z. No vertical flip needed.
        return ((x + half) / (2 * half) * (dem.width - 1),
                (z + half) / (2 * half) * (dem.height - 1))

    def height(x, z):
        px, py = pixels(x, z)
        if bilinear(dem, px, py) <= .05:
            return 0.0
        return round(zmin + bilinear(rendered, px, py) / 255 * zrange, 4)

    heights = [height(-half + col * (2 * half) / (size - 1),
                      -half + row * (2 * half) / (size - 1))
               for row in range(size) for col in range(size)]
    selected = [("tower-1", 1489.583333333333, -2031.25, 79.27643275888849),
                ("tower-2", -677.0833333333335, 1760.416666666666, 236.64575767478493)]
    towers = [{"id": name, "x": x, "z": -y, "height": height(x, -y),
               # Source heading is clockwise from source +Y; THREE z is -Y.
               "heading": round((math.pi - math.radians(heading)) % (2 * math.pi), 8),
               "range": 1500} for name, x, y, heading in selected]
    spawn = {"x": -500, "z": 250, "heading": 1.1}
    # The spawn and its first 600 m toward the southeast have water clearance.
    for distance in range(0, 601, 25):
        x = spawn["x"] + math.sin(spawn["heading"]) * distance
        z = spawn["z"] + math.cos(spawn["heading"]) * distance
        for dx, dz in ((0, 0), (20, 0), (-20, 0), (0, 20), (0, -20)):
            assert bilinear(dem, *pixels(x + dx, z + dz)) <= .05, "Spawn route crosses land"
    return {"size": size, "half": half, "heights": heights, "waterLevel": 1,
            "towers": towers, "spawn": spawn,
            "source": "Supplied ArcticSim Fort Ross world; ArcticDEM v4.1, PGC / University of Minnesota, CC-BY-4.0. "
                      "257x257 samples of rendered heightmap, water classified with float DEM. "
                      "THREE (x,y,z) = source (X,elevation,-Y)."}


def compact(vertices, indices):
    unique, positions, remap = {}, [], []
    for vertex in vertices:
        rounded = tuple(round(v, 5) for v in vertex)
        if rounded not in unique:
            unique[rounded] = len(positions)
            positions.append(rounded)
        remap.append(unique[rounded])
    triangles, seen = [], set()
    for i in range(0, len(indices), 3):
        tri = tuple(remap[j] for j in indices[i:i + 3])
        # A reverse-facing source triangle is a distinct surface: the supplied
        # vessel intentionally has paired faces for thin hull/deck details.
        # Collapse cyclic duplicates only; sorting would erase their back side.
        key = min(tri, tri[1:] + tri[:1], tri[2:] + tri[:2])
        if len(set(tri)) == 3 and key not in seen:
            triangles.extend(tri)
            seen.add(key)
    used = sorted(set(triangles))
    lookup = {old: new for new, old in enumerate(used)}
    return [v for index in used for v in positions[index]], [lookup[index] for index in triangles]


def build_boat(sim_root):
    source = sim_root / "sim/models/fishing_vessel/meshes/fishing_vessel.dae"
    root = ET.parse(source).getroot()
    colors = {}
    for effect in root.findall("c:library_effects/c:effect", NS):
        color = effect.find(".//c:diffuse/c:color", NS)
        if color is not None:
            channels = [max(0, min(255, round(float(v) * 255))) for v in color.text.split()[:3]]
            colors[effect.get("id")] = "#" + "".join(f"{v:02x}" for v in channels)
    materials = {}
    for material in root.findall("c:library_materials/c:material", NS):
        effect = material.find("c:instance_effect", NS).get("url")[1:]
        materials[material.get("id")] = (material.get("name", material.get("id")), colors.get(effect, "#c2c2bd"))

    geometries = {}
    for geometry in root.findall("c:library_geometries/c:geometry", NS):
        mesh, sources = geometry.find("c:mesh", NS), {}
        for src in mesh.findall("c:source", NS):
            array = src.find("c:float_array", NS)
            if array is not None:
                stride = int(src.find("c:technique_common/c:accessor", NS).get("stride", "3"))
                values = list(map(float, array.text.split()))
                sources[src.get("id")] = [values[i:i + stride] for i in range(0, len(values), stride)]
        vertices = {v.get("id"): v.find("c:input[@semantic='POSITION']", NS).get("source")[1:]
                    for v in mesh.findall("c:vertices", NS)}
        parts = []
        for primitive in mesh:
            if primitive.tag.split("}")[-1] not in ("triangles", "polylist"):
                continue
            inputs = primitive.findall("c:input", NS)
            vertex = next(v for v in inputs if v.get("semantic") == "VERTEX")
            stride = max(int(v.get("offset", "0")) for v in inputs) + 1
            indices = list(map(int, primitive.find("c:p", NS).text.split()))[int(vertex.get("offset", "0"))::stride]
            vcount = primitive.find("c:vcount", NS)
            if vcount is not None:
                triangulated, cursor = [], 0
                for count in map(int, vcount.text.split()):
                    face = indices[cursor:cursor + count]
                    for i in range(1, count - 1):
                        triangulated.extend((face[0], face[i], face[i + 1]))
                    cursor += count
                indices = triangulated
            parts.append((sources[vertices[vertex.get("source")[1:]]], indices, primitive.get("material")))
        geometries[geometry.get("id")] = parts

    output = []
    # Preserve the supplied visual pose: keel -2.6 m below sea surface.
    draft = IDENTITY.copy()
    draft[11] = -2.6

    def visit(node, parent):
        matrix = parent
        for child in node:
            if child.tag.endswith("}matrix"):
                matrix = multiply(matrix, list(map(float, child.text.split())))
        for instance in node.findall("c:instance_geometry", NS):
            bindings = {m.get("symbol"): m.get("target")[1:]
                        for m in instance.findall(".//c:instance_material", NS)}
            for vertices, indices, symbol in geometries[instance.get("url")[1:]]:
                positions, triangles = compact([transform(matrix, v) for v in vertices], indices)
                name, color = materials.get(bindings.get(symbol, ""), (symbol or "boat", "#c2c2bd"))
                if triangles:
                    output.append({"name": f"fishing_vessel_{node.get('id')}", "type": "mesh",
                                   "material": name, "color": color, "positions": positions, "indices": triangles})
        for child in node.findall("c:node", NS):
            visit(child, matrix)

    for node in root.findall("c:library_visual_scenes/c:visual_scene/c:node", NS):
        visit(node, draft)
    bounds = [[min(p["positions"][axis::3]) for axis in range(3)] for p in output]
    upper = [[max(p["positions"][axis::3]) for axis in range(3)] for p in output]
    return {"name": "Fishing Vessel VII", "source": "arctic-sim/sim/models/fishing_vessel/meshes/fishing_vessel.dae",
            "origin": "Supplied ArcticSim Fishing Vessel VII asset, already decimated by its source converter",
            "authors": ["arctic-sim (supplied conversion)"],
            "license": "No original vessel license or author was supplied beside these local model sources.",
            "axes": "+X forward, +Y port, +Z up; visual draft -2.6 m already applied",
            "bounds": {"min": [min(p[a] for p in bounds) for a in range(3)],
                       "max": [max(p[a] for p in upper) for a in range(3)]},
            "parts": output,
            "processing": "Source triangle winding, paired reverse-facing surfaces, and material colors preserved; duplicate vertices, same-winding duplicate triangles, and degenerate triangles removed; coordinates rounded to 0.00001 m."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sim-root", type=Path, default=ROOT.parent / "arctic-sim")
    parser.add_argument("--repo", type=Path, default=ROOT.parent / "HTNV1")
    parser.add_argument("--revision", default="2686ec95c0435d217a8a28e32bfa3e6a60b2826e")
    parser.add_argument("--output", type=Path, default=ROOT / "public/assets")
    args = parser.parse_args()
    source_path = "frontend/components/scene/simModels.json"
    baked = json.loads(subprocess.check_output(["git", "-C", str(args.repo), "show", f"{args.revision}:{source_path}"]))
    models = {kind: baked[kind] for kind in ("plane", "copter", "tower")}
    models["boat"] = build_boat(args.sim_root)
    world = build_world(args.sim_root)
    args.output.mkdir(parents=True, exist_ok=True)
    for name, data in (("world.json", world), ("models.json", models)):
        content = json.dumps(data, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        (args.output / name).write_bytes(content)
        print(f"{name}: {len(content):,} bytes; sha256 {hashlib.sha256(content).hexdigest()}")
    print(json.dumps({"towerGrounds": world["towers"], "spawn": world["spawn"],
                      "boatBounds": models["boat"]["bounds"], "boatParts": len(models["boat"]["parts"]),
                      "boatTriangles": sum(len(p["indices"]) // 3 for p in models["boat"]["parts"])}, indent=2))


if __name__ == "__main__":
    main()
