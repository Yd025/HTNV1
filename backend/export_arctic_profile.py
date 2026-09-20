"""Export a reproducible, offline planning profile from local ArcticSim assets.

Reads files only: never connects to MAVLink, HTTP, or the live controller.
Pillow is already a backend dependency. Float DEM data identifies water; the
quantized heightmap identifies the surface Gazebo actually renders.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path

from PIL import Image, ImageFilter


def image_values(image: Image.Image):
    # Pillow 14 removes getdata; older supported Pillow releases lack its replacement.
    method = getattr(image, "get_flattened_data", None)
    return method() if method else image.getdata()


def sdf(path: Path) -> ET.Element:
    # Some bundled SDF comments contain '--'. Comments do not affect geometry;
    # remove them before strict ElementTree parsing without changing source files.
    text = re.sub(r"<!--.*?-->", "", path.read_text(encoding="utf-8"), flags=re.DOTALL)
    return ET.fromstring(text)


def bilinear(image: Image.Image, px: float, py: float) -> float:
    px = min(image.width - 1.0, max(0.0, px))
    py = min(image.height - 1.0, max(0.0, py))
    x0, y0 = int(px), int(py)
    x1, y1 = min(x0 + 1, image.width - 1), min(y0 + 1, image.height - 1)
    fx, fy = px - x0, py - y0
    top = float(image.getpixel((x0, y0))) * (1 - fx) + float(image.getpixel((x1, y0))) * fx
    bottom = float(image.getpixel((x0, y1))) * (1 - fx) + float(image.getpixel((x1, y1))) * fx
    return top * (1 - fy) + bottom * fy


def world_pixel(x: float, y: float, half_m: float, pixels: int) -> tuple[float, float]:
    """Raster row zero is north; exported graph row zero is south."""
    return ((x + half_m) / (2 * half_m) * (pixels - 1),
            (half_m - y) / (2 * half_m) * (pixels - 1))


def water_mask(dem: Image.Image, spacing_m: float, clearance_m: float) -> tuple[Image.Image, int]:
    """Match ArcticSim's float-DEM threshold, then conservatively buffer shore.

    A square erosion gives at least the requested clearance in all directions.
    It deliberately removes more diagonal shoreline water than a circular disk.
    """
    if dem.mode != "F":
        raise ValueError("Water classification requires the float DEM, not the quantized heightmap")
    mask = Image.new("L", dem.size)
    mask.putdata([255 if math.isfinite(float(z)) and z <= 0.05 else 0 for z in image_values(dem)])
    radius = math.ceil(clearance_m / spacing_m)
    return (mask.filter(ImageFilter.MinFilter(2 * radius + 1)) if radius else mask, radius)


def safe_water(mask: Image.Image, px: float, py: float, radius: int) -> bool:
    """Require all neighboring source samples and clearance inside the world."""
    xs, ys = (math.floor(px), math.ceil(px)), (math.floor(py), math.ceil(py))
    if min(xs) < radius or min(ys) < radius or max(xs) >= mask.width - radius or max(ys) >= mask.height - radius:
        return False
    return all(mask.getpixel((x, y)) != 0 for x in xs for y in ys)


def water_segment(mask: Image.Image, a: tuple[float, float], b: tuple[float, float], radius: int) -> bool:
    """Check the buffered full-resolution mask at <= half-source-pixel steps."""
    steps = max(1, math.ceil(math.dist(a, b) * 2))
    return all(safe_water(mask, a[0] + (b[0] - a[0]) * i / steps,
                          a[1] + (b[1] - a[1]) * i / steps, radius)
               for i in range(steps + 1))


def sampled_grid(dem: Image.Image, heightmap: Image.Image, *, size: int, half_m: float,
                 zmin: float, zrange: float, clearance_m: float = 25.0) -> dict:
    if dem.size != heightmap.size or dem.width != dem.height or dem.width < 3:
        raise ValueError("DEM and heightmap must be matching square rasters")
    if size < 3 or size % 2 != 1 or size > dem.width:
        raise ValueError("Grid size must be odd, at least 3, and no greater than the source raster")
    spacing = 2 * half_m / (dem.width - 1)
    cell_m = 2 * half_m / (size - 1)
    mask, radius = water_mask(dem, spacing, clearance_m)
    heights, lows, highs, water, candidates, source_points = [], [], [], [], [], []
    pixel_half_cell = cell_m / spacing / 2
    for row in range(size):
        for col in range(size):
            x, y = -half_m + col * cell_m, -half_m + row * cell_m
            px, py = world_pixel(x, y, half_m, dem.width)
            source_points.append((px, py))
            heights.append(round(zmin + bilinear(heightmap, px, py) / 255 * zrange, 3))
            box = (max(0, math.floor(px - pixel_half_cell)), max(0, math.floor(py - pixel_half_cell)),
                   min(dem.width, math.ceil(px + pixel_half_cell) + 1), min(dem.height, math.ceil(py + pixel_half_cell) + 1))
            lo, hi = heightmap.crop(box).getextrema()
            lows.append(round(zmin + float(lo) / 255 * zrange, 3))
            highs.append(round(zmin + float(hi) / 255 * zrange, 3))
            water.append(safe_water(mask, px, py, radius))
            # Native-resolution terrain slope around a candidate mast footprint.
            # Border positions are excluded because the derivative needs neighbors.
            if 1 <= px < dem.width - 2 and 1 <= py < dem.height - 2:
                z = bilinear(dem, px, py)
                dx = (bilinear(dem, px + 1, py) - bilinear(dem, px - 1, py)) / (2 * spacing)
                dy = (bilinear(dem, px, py + 1) - bilinear(dem, px, py - 1)) / (2 * spacing)
                slope = math.degrees(math.atan(math.hypot(dx, dy)))
                footprint_land = all(bilinear(dem, px + ox, py + oy) > 0.05
                                     for ox, oy in ((0, 0), (1, 0), (-1, 0), (0, 1), (0, -1)))
                if z > 0.05 and slope <= 15 and footprint_land:
                    candidates.append(row * size + col)
    edges = []
    for index, wet in enumerate(water):
        if not wet:
            continue
        row, col = divmod(index, size)
        # One copy of every undirected edge; consumers can add both directions.
        for dr, dc in ((0, 1), (1, 0), (1, 1), (1, -1)):
            rr, cc = row + dr, col + dc
            if not (0 <= rr < size and 0 <= cc < size):
                continue
            other = rr * size + cc
            if not water[other]:
                continue
            if dr and dc and not (water[row * size + cc] and water[rr * size + col]):
                continue
            if water_segment(mask, source_points[index], source_points[other], radius):
                edges.append([index, other])
    return {"size": size, "halfM": half_m, "cellM": cell_m, "xMin": -half_m, "yMin": -half_m,
            "elevations": heights, "elevationMin": lows, "elevationMax": highs,
            "water": water, "landCandidates": candidates, "waterEdges": edges,
            "shoreClearanceM": clearance_m, "sourceBufferAxisM": radius * spacing,
            "elevationEnvelopeHalfWidthM": cell_m / 2,
            "waterEdgesUndirected": True}


def camera(path: Path) -> dict:
    sensor = sdf(path).find(".//sensor[@type='camera']")
    if sensor is None:
        raise ValueError(f"Missing camera: {path}")
    cam = sensor.find("camera")
    if cam is None:
        raise ValueError(f"Missing camera optics: {path}")
    hfov = float(cam.findtext("horizontal_fov", "nan"))
    width, height = int(cam.findtext("image/width", "0")), int(cam.findtext("image/height", "0"))
    if not (0 < hfov < math.pi and width > 0 and height > 0):
        raise ValueError(f"Invalid camera optics: {path}")
    return {"hfovDeg": round(math.degrees(hfov), 6),
            "vfovDeg": round(math.degrees(2 * math.atan(math.tan(hfov / 2) * height / width)), 6),
            "width": width, "height": height,
            "farClipM": float(cam.findtext("clip/far", "nan")),
            "nearClipM": float(cam.findtext("clip/near", "nan")),
            "framesPerSecond": float(sensor.findtext("update_rate", "nan"))}


def parameter(path: Path, name: str) -> float:
    for line in path.read_text(encoding="utf-8").splitlines():
        fields = line.split("#", 1)[0].split()
        if len(fields) >= 2 and fields[0] == name:
            return float(fields[1])
    raise ValueError(f"Missing {name}: {path}")


def rotate_rpy(vector, pose):
    """SDF intrinsic roll/pitch/yaw, applied as Rz(yaw) Ry(pitch) Rx(roll)."""
    x,y,z=vector
    roll,pitch,yaw=pose[3:]
    y,z=math.cos(roll)*y-math.sin(roll)*z,math.sin(roll)*y+math.cos(roll)*z
    x,z=math.cos(pitch)*x+math.sin(pitch)*z,-math.sin(pitch)*x+math.cos(pitch)*z
    return (math.cos(yaw)*x-math.sin(yaw)*y,math.sin(yaw)*x+math.cos(yaw)*y,z)


def fixed_quad_camera(sim_root: Path) -> dict:
    """Resolve the actual iris fixed mount, rather than inventing a gimbal pose."""
    mount_path=sim_root/"sim/models/iris_with_ardupilot/model.sdf"
    camera_path=sim_root/"sim/models/gimbal_small_2d/model.sdf"
    airframe,gimbal=sdf(mount_path),sdf(camera_path)
    mount=next((item for item in airframe.findall("./model/include")
                if item.findtext("uri")=="model://gimbal_small_2d"),None)
    mount_joint=airframe.find(".//joint[@name='iris_gimbal_mount']")
    tilt_joint=gimbal.find(".//joint[@name='tilt_joint']")
    if mount is None or mount_joint is None or tilt_joint is None or any(joint.get("type")!="fixed" for joint in (mount_joint,tilt_joint)):
        raise ValueError("Quad camera mount changed; fixed-mount planning requires verified camera kinematics")
    sensor=gimbal.find(".//sensor[@type='camera']")
    link=gimbal.find(".//link[@name='tilt_link']")
    model=gimbal.find("./model")
    if sensor is None or link is None or model is None:
        raise ValueError("Missing quad optical frame")
    poses=[[float(value) for value in node.findtext("pose","0 0 0 0 0 0").split()]
           for node in (sensor,link,model,mount)]
    if any(len(pose)!=6 for pose in poses):
        raise ValueError("Invalid quad camera transform")
    axis=(1.,0.,0.)  # Gazebo camera boresight is local +X.
    for pose in poses:
        axis=rotate_rpy(axis,pose)
    quad=camera(camera_path)
    quad.update(pitchDeg=round(math.degrees(math.atan2(axis[2],math.hypot(axis[0],axis[1]))),1),
                yawOffsetDeg=round(math.degrees(math.atan2(axis[1],axis[0])),1),
                mountType="fixed",gimbalActuated=False,pitchIsPlanningAssumption=False,
                mountSource="sim/models/iris_with_ardupilot/model.sdf",
                mountPoseRad=poses[-1][3:],opticalPoseRad=poses[0][3:])
    return quad


def build_profile(sim_root: Path, size: int = 49) -> dict:
    meta_path = sim_root / "out/fort_ross/terrain.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    half = float(meta["extent_m"]) / 2
    dem_path, height_path = meta_path.with_name("dem_clamped.tif"), meta_path.with_name("heightmap.png")
    with Image.open(dem_path) as source, Image.open(height_path) as rendered:
        dem, heightmap = source.copy(), rendered.convert("L")
    grid = sampled_grid(dem, heightmap, size=size, half_m=half,
                        zmin=float(meta["elevation_m"]["min"]), zrange=float(meta["elevation_m"]["range"]))
    world_path = sim_root / "sim/worlds/fort_ross.world"
    world = sdf(world_path)
    sources = [meta_path, dem_path, height_path, world_path,
               sim_root / "terrain/tower.py", sim_root / "terrain/course.py",
               sim_root / "terrain/make_world.py",
               sim_root / "sim/models/tower-1/model.sdf", sim_root / "sim/models/tower-2/model.sdf",
               sim_root / "sim/models/gimbal_small_2d/model.sdf", sim_root / "sim/models/iris_with_ardupilot/model.sdf",
               sim_root / "sim/models/skywalker_x8/model.sdf",
               sim_root / "sitl/params/tower.parm", sim_root / "sitl/params/copter.parm", sim_root / "sitl/params/plane.parm"]
    tower = camera(sim_root / "sim/models/tower-1/model.sdf")
    head_match = re.search(r"^HEAD_Z\s*=\s*([0-9.]+)",
                           (sim_root / "terrain/tower.py").read_text(encoding="utf-8"), re.MULTILINE)
    if head_match is None:
        raise ValueError("Missing source tower camera head height")
    tower_height = float(head_match.group(1))
    tower.update(pitchMinDeg=parameter(sim_root / "sitl/params/tower.parm", "PITCH_MIN"),
                 pitchMaxDeg=parameter(sim_root / "sitl/params/tower.parm", "PITCH_MAX"),
                 pitchDeg=0.0, yawRangeDeg=parameter(sim_root / "sitl/params/tower.parm", "YAW_RANGE"))
    second_tower = camera(sim_root / "sim/models/tower-2/model.sdf")
    if any(tower[key] != value for key, value in second_tower.items()):
        raise ValueError("Tower camera profiles differ; exporter requires separate sensor profiles")
    quad = fixed_quad_camera(sim_root)
    plane = camera(sim_root / "sim/models/skywalker_x8/model.sdf")
    plane_sensor = sdf(sim_root / "sim/models/skywalker_x8/model.sdf").find(".//sensor[@type='camera']")
    if plane_sensor is None:
        raise ValueError("Missing plane camera")
    plane_pose = [float(v) for v in plane_sensor.findtext("pose", "0 0 0 0 0 0").split()]
    plane.update(pitchDeg=round(-math.degrees(plane_pose[4]), 6),mountType="fixed",gimbalActuated=False)
    assets, tower_defaults = [], []
    for include in [*world.findall(".//world/include"), *world.findall(".//world/model")]:
        name = include.get("name") or include.findtext("name", "")
        if name not in ("quadcopter", "fixed-wing", "tower-1", "tower-2"):
            continue
        pose = [float(v) for v in include.findtext("pose", "").split()]
        if len(pose) != 6:
            raise ValueError(f"Invalid world pose for {name}")
        sensor = "tower" if name.startswith("tower-") else "quad" if name == "quadcopter" else "plane"
        assets.append({"id": name, "sensor": sensor, "x": pose[0], "y": pose[1], "spawnZM": pose[2]})
        if sensor == "tower":
            tower_defaults.append({"id": name, "x": pose[0], "y": pose[1], "groundM": pose[2],
                                   "headingDeg": round((90 - math.degrees(pose[5])) % 360, 6)})
    if len(assets) != 4 or len(tower_defaults) != 2:
        raise ValueError("Expected two tower and two aircraft default poses")
    revision = subprocess.run(["git", "-c", f"safe.directory={sim_root.as_posix()}", "-C", str(sim_root), "rev-parse", "HEAD"],
                              capture_output=True, text=True, check=True).stdout.strip()
    convergence = float(meta["convergence_deg"])
    return {
        "schemaVersion": 1, "site": "Fort Ross", "halfM": half,
        "origin": {"lat": float(world.findtext(".//spherical_coordinates/latitude_deg", "nan")),
                   "lon": float(world.findtext(".//spherical_coordinates/longitude_deg", "nan"))},
        "frame": {"name": "ArcticSim world XY, rotated EPSG:3413 grid axes",
                  "positiveYTrueBearingDeg": convergence, "northBearingDeg": -convergence,
                  "scaleFactor": meta["scale_factor"], "trueScale": meta["true_scale"],
                  "rowDirection": "Increasing world Y; row zero is the south edge",
                  "headingConvention": "Degrees clockwise from world +Y"},
        "grid": grid, "sensors": {"tower": tower, "quad": quad, "plane": plane},
        "towerDefaults": tower_defaults, "assets": assets,
        "assetHeightsM": {"tower": tower_height, "quad": 60.0, "plane": 120.0},
        "speedsMps": {"boat": float(world.findtext(".//plugin[@name='vessel_path']/speed", "nan")),
                      "quad": parameter(sim_root / "sitl/params/copter.parm", "WPNAV_SPEED") / 100,
                      "plane": parameter(sim_root / "sitl/params/plane.parm", "AIRSPEED_CRUISE")},
        "source": {"repository": "arctic-sim", "revision": revision,
                   "files": [{"path": str(p.relative_to(sim_root)).replace("\\", "/"),
                              "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in sources],
                   "demGrid": meta["grid"], "sourceSpacingM": meta["spacing_m"],
                   "heightmapBits": meta["heightmap_bits"], "terrainMaxM": meta["elevation_m"]["max"],
                   "sourceWaterFraction": meta["water"]["water_fraction"]},
        "assumptions": [
            "An offline geometric planning model, not calibrated camera detection or live ArcticSim results.",
            "Camera far clip is a rendering limit, not a guarantee of recognition at 1500 m.",
            "VFOV derives from square pixels and source image aspect ratio.",
            f"Tower camera center is {tower_height:g} m above the candidate ground. Default groundM values are source world base poses.",
            "Quad/plane heights 60/120 m above terrain are planning clearances, not source autopilot cruise settings.",
            "Quad camera is fixed approximately 20 degrees below body forward, derived from iris mount and optical-frame rotations; both mount joints are fixed and no independent gimbal aim is modeled. Aircraft roll/pitch dynamics remain unmodeled.",
            "Aircraft speeds are configured waypoint/cruise references; wind, acceleration, turns, and climb performance require a dynamics model.",
            "Water comes from the float DEM <=0.05 m, never the quantized heightmap. At least 25 m shore clearance uses conservative square erosion.",
            "Water graph edges are undirected, densely checked against the buffered full-resolution DEM mask, and forbid diagonal corner cutting.",
            "Grid elevations sample the rendered 8-bit heightmap. Min/max envelopes cover each graph node's half-cell footprint; coarse visibility remains approximate.",
            "Tower candidates require source DEM land around the mast and local slope <=15 degrees; this does not establish construction feasibility.",
            "World XY axes are rotated relative to geographic north/east. Use frame metadata when displaying headings.",
            "Terrain geometry is from local generated assets whose hashes are recorded; this exporter does not verify the currently running simulator image.",
        ],
    }


def write_terrain_preview(sim_root: Path, destination: Path) -> str:
    """Numerical terrain map; original raster orientation, water from float DEM."""
    with Image.open(sim_root / "out/fort_ross/dem_clamped.tif") as source, Image.open(sim_root / "out/fort_ross/heightmap.png") as surface:
        dem, heightmap = source.copy(), surface.convert("L")
    low, high, water = (0x52, 0x61, 0x72), (0xAA, 0xB4, 0xB7), (0x16, 0x23, 0x31)
    colors = [tuple(round(a + (b - a) * (value / 255) ** 0.7) for a, b in zip(low, high))
              for value in range(256)]
    preview = Image.new("RGB", dem.size)
    preview.putdata([water if z <= 0.05 else colors[int(value)]
                     for z, value in zip(image_values(dem), image_values(heightmap))])
    destination.parent.mkdir(parents=True, exist_ok=True)
    preview.save(destination, optimize=True)
    return hashlib.sha256(destination.read_bytes()).hexdigest()


def main() -> None:
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sim-root", type=Path, default=root.parent / "arctic-sim")
    parser.add_argument("--output", type=Path, default=root / "frontend/public/experiments/arctic-profile.json")
    parser.add_argument("--grid-size", type=int, default=49)
    args = parser.parse_args()
    profile = build_profile(args.sim_root.resolve(), args.grid_size)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    image_path = args.output.with_name("fort-ross-terrain.png")
    profile["mapImage"] = "/experiments/fort-ross-terrain.png"
    profile["source"]["previewSha256"] = write_terrain_preview(args.sim_root.resolve(), image_path)
    args.output.write_text(json.dumps(profile, separators=(",", ":"), allow_nan=False) + "\n", encoding="utf-8")
    grid = profile["grid"]
    print(json.dumps({"output": str(args.output), "grid": grid["size"], "waterNodes": sum(grid["water"]),
                      "waterEdges": len(grid["waterEdges"]), "landCandidates": len(grid["landCandidates"]),
                      "sourceRevision": profile["source"]["revision"]}))


if __name__ == "__main__":
    main()
