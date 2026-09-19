"""Bake the existing ArcticSim display models into compact, inert UI geometry.

No simulator process, plugin, controller, material script or network URL is run.
Source attribution is retained in the output. Run from any working directory.
"""
from pathlib import Path
import json
import math
import re
import xml.etree.ElementTree as ET

HERE = Path(__file__).resolve().parent
MODELS = HERE.parents[3] / "arctic-sim" / "sim" / "models"
NS = {"c": "http://www.collada.org/2005/11/COLLADASchema"}
IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]


def multiply(a, b):
    return [sum(a[row * 4 + k] * b[k * 4 + col] for k in range(4))
            for row in range(4) for col in range(4)]


def transform(matrix, point):
    return [sum(matrix[row * 4 + k] * point[k] for k in range(3)) + matrix[row * 4 + 3]
            for row in range(3)]


def pose(text):
    x, y, z, roll, pitch, yaw = map(float, (text or "0 0 0 0 0 0").split())
    cr, sr, cp, sp, cy, sy = math.cos(roll), math.sin(roll), math.cos(pitch), math.sin(pitch), math.cos(yaw), math.sin(yaw)
    return [cy*cp, cy*sp*sr-sy*cr, cy*sp*cr+sy*sr, x,
            sy*cp, sy*sp*sr+cy*cr, sy*sp*cr-cy*sr, y,
            -sp, cp*sr, cp*cr, z, 0, 0, 0, 1]


def collada(path):
    root = ET.parse(path).getroot()
    geometries = {}
    for geometry in root.findall("c:library_geometries/c:geometry", NS):
        mesh = geometry.find("c:mesh", NS)
        sources = {}
        for source in mesh.findall("c:source", NS):
            array = source.find("c:float_array", NS)
            if array is not None:
                stride = int(source.find("c:technique_common/c:accessor", NS).get("stride", "3"))
                values = list(map(float, array.text.split()))
                sources[source.get("id")] = [values[i:i+3] for i in range(0, len(values), stride)]
        vertices = {v.get("id"): v.find("c:input[@semantic='POSITION']", NS).get("source")[1:]
                    for v in mesh.findall("c:vertices", NS)}
        parts = []
        for primitive in mesh:
            if primitive.tag.split("}")[-1] not in ("triangles", "polylist"):
                continue
            inputs = primitive.findall("c:input", NS)
            vertex = next(i for i in inputs if i.get("semantic") == "VERTEX")
            stride = max(int(i.get("offset", "0")) for i in inputs) + 1
            offset = int(vertex.get("offset", "0"))
            indices = list(map(int, primitive.find("c:p", NS).text.split()))[offset::stride]
            vcount = primitive.find("c:vcount", NS)
            if vcount is not None:
                triangles, cursor = [], 0
                for count in map(int, vcount.text.split()):
                    face = indices[cursor:cursor+count]
                    for i in range(1, count-1):
                        triangles.extend([face[0], face[i], face[i+1]])
                    cursor += count
                indices = triangles
            parts.append((sources[vertices[vertex.get("source")[1:]]], indices))
        geometries[geometry.get("id")] = parts
    output = []
    def visit(node, parent):
        matrix = parent
        for child in node:
            if child.tag.endswith("}matrix"):
                matrix = multiply(matrix, list(map(float, child.text.split())))
        for instance in node.findall("c:instance_geometry", NS):
            for vertices, indices in geometries[instance.get("url")[1:]]:
                output.append(([transform(matrix, v) for v in vertices], indices))
        for child in node.findall("c:node", NS):
            visit(child, matrix)
    for node in root.findall("c:library_visual_scenes/c:visual_scene/c:node", NS):
        visit(node, IDENTITY)
    return output


def compact(vertices, indices, grid):
    # Vertex clustering removes sub-millimeter CAD detail, never samples faces away.
    buckets, remap, positions = {}, [], []
    for point in vertices:
        key = tuple(round(value / grid) for value in point)
        if key not in buckets:
            buckets[key] = len(positions)
            positions.append([round(value, 5) for value in point])
        remap.append(buckets[key])
    triangles, seen = [], set()
    for i in range(0, len(indices), 3):
        tri = tuple(remap[index] for index in indices[i:i+3])
        if len(set(tri)) != 3 or tuple(sorted(tri)) in seen:
            continue
        seen.add(tuple(sorted(tri)))
        triangles.extend(tri)
    used = sorted(set(triangles))
    lookup = {old: new for new, old in enumerate(used)}
    return [value for index in used for value in positions[index]], [lookup[index] for index in triangles]


def material(name):
    name = name.lower()
    if any(s in name for s in ("lens", "black", "track", "belt", "lug", "wheel", "prop", "rotor")):
        return "body"
    if any(s in name for s in ("elevon", "head", "fork", "pan", "white", "wing", "body_visual")):
        return "panel"
    if any(s in name for s in ("leg", "mast", "foot", "grey", "housing")):
        return "metal"
    return "body"


def sdf(model_name, parent=IDENTITY):
    # Local SDF comments contain explanatory double-hyphens; ignore comments only.
    source_text = (MODELS / model_name / "model.sdf").read_text(encoding="utf-8")
    root = ET.fromstring(re.sub(r"<!--.*?-->", "", source_text, flags=re.S)).find("model")
    base = multiply(parent, pose(root.findtext("pose")))
    output = []
    for include in root.findall("include"):
        name = include.findtext("uri").removeprefix("model://").split("/")[0]
        output.extend(sdf(name, multiply(base, pose(include.findtext("pose")))))
    for link in root.findall("link"):
        link_transform = multiply(base, pose(link.findtext("pose")))
        for visual in link.findall("visual"):
            matrix = multiply(link_transform, pose(visual.findtext("pose")))
            geom = visual.find("geometry")
            if geom is None:
                continue
            name = visual.get("name", "")
            tone = material(name + " " + (visual.findtext("material/script/name") or ""))
            mesh = geom.find("mesh")
            if mesh is not None:
                source = mesh.findtext("uri").removeprefix("model://")
                scale = list(map(float, (mesh.findtext("scale") or "1 1 1").split()))
                # Iris source is 21 MB / 261k faces; 2.5 mm clustering retains its airframe silhouette.
                grid = 0.0025 if source.endswith("/iris.dae") else 0.001
                for vertices, indices in collada(MODELS / source):
                    world = [transform(matrix, [p[i]*scale[i] for i in range(3)]) for p in vertices]
                    positions, indices = compact(world, indices, grid)
                    output.append({"name": name, "type": "mesh", "material": tone, "positions": positions, "indices": indices})
            else:
                shape = next(iter(geom), None)
                if shape is None or shape.tag not in ("box", "cylinder", "sphere"):
                    continue
                part = {"name": name, "type": shape.tag, "material": tone, "matrix": [round(n, 7) for n in matrix]}
                if shape.tag == "box":
                    part["size"] = list(map(float, shape.findtext("size").split()))
                else:
                    part["radius"] = float(shape.findtext("radius"))
                    if shape.tag == "cylinder":
                        part["length"] = float(shape.findtext("length"))
                output.append(part)
    return output


catalog = {
    "plane": ("skywalker_x8", "Skywalker X8", "ArduPilot/SITL_Models", ["Roman Bapst", "Rhys Mainwaring"]),
    "copter": ("iris_with_ardupilot", "3DR Iris", "PX4/sitl_gazebo; local standoffs and camera mount", ["Fadri Furrer", "Michael Burri", "Mina Kamel", "Janosch Nikolic", "Markus Achtelik"]),
    "rover": ("rover_core", "Tracked rover", "Local ArcticSim rover_core/model.sdf", ["Nick"]),
    "tower": ("tower-1", "EO/IR tripod", "Local ArcticSim terrain/tower.py", []),
}
result = {}
for kind, (folder, name, origin, authors) in catalog.items():
    parts = sdf(folder)
    result[kind] = {"name": name, "source": f"arctic-sim/sim/models/{folder}/model.sdf", "origin": origin,
                    "authors": authors, "license": "No license file supplied beside these local model sources; original attribution retained.",
                    "parts": parts}
    print(kind, len(parts), "parts", sum(len(p.get("indices", []))//3 for p in parts), "mesh triangles")
destination = HERE / "simModels.json"
destination.write_text(json.dumps(result, separators=(",", ":")), encoding="utf-8")
print(destination.name, destination.stat().st_size, "bytes")
