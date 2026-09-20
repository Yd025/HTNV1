"""Simulator blob baseline and shared pixel-to-water projection.

Learned vessel detection is selected by vision.vessel.CameraDetector. Projection
requires camera altitude above the water plane, calibrated intrinsics and camera
orientation; a bounding-box bottom is only an approximate hull water contact.
"""

from __future__ import annotations

import io
import math
from dataclasses import dataclass

from PIL import Image

from geo import ne_to_ll
from sim.cameras import CameraSpec
from sim.types import Detection, VehicleState


@dataclass
class PixelHit:
    u: float
    v: float
    width: float
    height: float
    confidence: float
    class_hint: str
    bbox: tuple[float, float, float, float] | None = None
    detector: str = "simulator_blob"


def detect_jpeg(jpeg: bytes) -> PixelHit | None:
    try:
        im = Image.open(io.BytesIO(jpeg)).convert("RGB")
    except Exception:
        return None
    return detect_image(im)


def detect_image(im: Image.Image) -> PixelHit | None:
    w0, h0 = im.size
    if w0 < 8 or h0 < 8:
        return None
    w = 280
    h = max(8, int(h0 * w / w0))
    small = im.resize((w, h), Image.BILINEAR)
    pix = small.load()

    water = [[False] * w for _ in range(h)]
    sky = [[False] * w for _ in range(h)]
    red = [[False] * w for _ in range(h)]
    for y in range(h):
        for x in range(w):
            r, g, b = pix[x, y][:3]
            lum = 0.30 * r + 0.59 * g + 0.11 * b
            is_sky = lum > 168 and b + 6 >= r
            sky[y][x] = is_sky
            if lum < 70 and b + 14 >= r and not is_sky:
                water[y][x] = True
            sat = max(r, g, b) - min(r, g, b)
            if r > g + 28 and r > b + 22 and 45 < lum < 190 and sat > 28:
                red[y][x] = True

    sea = _large_components(water, min_area=max(400, w * h // 18))
    # Land touches the frame. Foam sparkles are bright islands — ignore those.
    landish = [[
        (not sea[y][x] and not sky[y][x] and 48 < (0.30 * pix[x, y][0] + 0.59 * pix[x, y][1] + 0.11 * pix[x, y][2]) < 135)
        for x in range(w)
    ] for y in range(h)]
    from_border = _flood_from_border(landish)
    islands = [[landish[y][x] and not from_border[y][x] and _near(sea, x, y, 2) for x in range(w)] for y in range(h)]
    rust = [[red[y][x] and _near(sea, x, y, 5) for x in range(w)] for y in range(h)]
    marked = [[islands[y][x] or rust[y][x] for x in range(w)] for y in range(h)]
    blobs = _components(marked)
    best: tuple[float, float, float, int, tuple[int, int, int, int]] | None = None
    for cells in blobs:
        area = len(cells)
        if area < 24 or area > 280:
            continue
        xs = [c[0] for c in cells]
        ys = [c[1] for c in cells]
        if min(ys) < h * 0.10:
            continue
        bw = max(xs) - min(xs) + 1
        bh = max(ys) - min(ys) + 1
        if bw * bh == 0:
            continue
        fill = area / (bw * bh)
        if fill < 0.22:
            continue
        if area < 14 and bh <= 2:
            continue
        cx = sum(xs) / area
        cy = sum(ys) / area
        score = area * fill
        if best is None or score > best[0]:
            best = (score, cx, cy, area, (min(xs), min(ys), max(xs) + 1, max(ys) + 1))
    if best is None:
        return None
    _, cx, cy, area, bbox = best
    conf = max(0.35, min(0.92, 0.28 + area / 400.0))
    return PixelHit(
        u=cx * (w0 / w),
        v=min(h0 - 1.0, bbox[3] * (h0 / h)),
        width=float(w0),
        height=float(h0),
        confidence=conf,
        class_hint="vessel",
        bbox=(bbox[0] * w0 / w, bbox[1] * h0 / h, bbox[2] * w0 / w, bbox[3] * h0 / h),
    )


def project_hit(
    hit: PixelHit,
    spec: CameraSpec,
    pose: VehicleState,
    now: float,
    roll_rad: float = 0.0,
    pitch_rad: float = 0.0,
) -> Detection | None:
    heading = float(pose.heading or 0.0)
    pitch = math.degrees(pitch_rad)
    roll = math.degrees(roll_rad)
    alt = float(pose.alt or 0.0)
    if alt < 1.2:
        return None
    ground = _ground_hit(
        hit.u, hit.v, hit.width, hit.height, spec.hfov_rad,
        heading, pitch, roll, alt, mount_pitch_deg=spec.pitch_bias_deg,
    )
    if ground is None:
        return None
    gn, ge, rng = ground
    lat, lon = ne_to_ll(gn, ge, pose.lat, pose.lon)
    return Detection(
        source_id=pose.vehicle_id,
        lat=lat,
        lon=lon,
        class_hint=hit.class_hint,
        confidence=hit.confidence,
        timestamp=now,
        bearing=(math.degrees(math.atan2(ge, gn)) + 360.0) % 360.0,
        range_m=rng,
        provenance=f"{hit.detector}:bbox_waterline:flat_sea_pinhole",
    )


def _ground_hit(
    u: float, v: float, width: float, height: float, hfov: float,
    heading_deg: float, pitch_deg: float, roll_deg: float, alt_m: float,
    mount_pitch_deg: float = 0.0,
) -> tuple[float, float, float] | None:
    values = (u, v, width, height, hfov, heading_deg, pitch_deg, roll_deg, alt_m, mount_pitch_deg)
    if not all(math.isfinite(value) for value in values):
        return None
    if width <= 0 or height <= 0 or not (0 < hfov < math.pi) or not (0 <= u < width and 0 <= v < height) or alt_m <= 0:
        return None
    fx = width / (2.0 * math.tan(hfov / 2.0))
    fy = fx
    # body: X fwd, Y right, Z down
    x = 1.0
    y = (u - width / 2.0) / fx
    z = (v - height / 2.0) / fy
    # Camera-to-body rotation precedes the measured body attitude. Adding the
    # mount angle to body pitch alone is incorrect while the aircraft banks.
    mount = math.radians(mount_pitch_deg)
    x, z = x * math.cos(mount) + z * math.sin(mount), -x * math.sin(mount) + z * math.cos(mount)
    n, e, d = _body_to_ned(x, y, z, heading_deg, pitch_deg, roll_deg)
    if d <= 0.035:
        return None
    t = alt_m / d
    rng = math.hypot(n * t, e * t, alt_m)
    if rng < 25.0 or rng > 1500.0:
        return None
    return n * t, e * t, rng


def _body_to_ned(x: float, y: float, z: float, yaw_deg: float, pitch_deg: float, roll_deg: float) -> tuple[float, float, float]:
    yaw = math.radians(yaw_deg)
    pit = math.radians(pitch_deg)
    rol = math.radians(roll_deg)
    y1 = y * math.cos(rol) - z * math.sin(rol)
    z1 = y * math.sin(rol) + z * math.cos(rol)
    x2 = x * math.cos(pit) + z1 * math.sin(pit)
    z2 = -x * math.sin(pit) + z1 * math.cos(pit)
    n = x2 * math.cos(yaw) - y1 * math.sin(yaw)
    e = x2 * math.sin(yaw) + y1 * math.cos(yaw)
    return n, e, z2


def _bearing(heading_deg: float, u: float, width: float, hfov: float) -> float:
    az = math.degrees((u / width - 0.5) * hfov)
    return (heading_deg + az + 360.0) % 360.0


def _large_components(mask: list[list[bool]], min_area: int) -> list[list[bool]]:
    out = [[False] * len(mask[0]) for _ in mask]
    for cells in _components(mask):
        if len(cells) < min_area:
            continue
        for x, y in cells:
            out[y][x] = True
    return out


def _flood_from_border(mask: list[list[bool]]) -> list[list[bool]]:
    h, w = len(mask), len(mask[0])
    seen = [[False] * w for _ in range(h)]
    stack: list[tuple[int, int]] = []
    for x in range(w):
        stack.append((x, 0))
        stack.append((x, h - 1))
    for y in range(h):
        stack.append((0, y))
        stack.append((w - 1, y))
    while stack:
        x, y = stack.pop()
        if not (0 <= x < w and 0 <= y < h) or seen[y][x] or not mask[y][x]:
            continue
        seen[y][x] = True
        stack.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))
    return seen


def _near(mask: list[list[bool]], x: int, y: int, radius: int) -> bool:
    h, w = len(mask), len(mask[0])
    for dy in range(-radius, radius + 1):
        for dx in range(-radius, radius + 1):
            yy, xx = y + dy, x + dx
            if 0 <= yy < h and 0 <= xx < w and mask[yy][xx]:
                return True
    return False


def _components(mask: list[list[bool]]) -> list[list[tuple[int, int]]]:
    h, w = len(mask), len(mask[0])
    seen = [[False] * w for _ in range(h)]
    blobs: list[list[tuple[int, int]]] = []
    for y in range(h):
        for x in range(w):
            if not mask[y][x] or seen[y][x]:
                continue
            stack = [(x, y)]
            seen[y][x] = True
            cells: list[tuple[int, int]] = []
            while stack:
                cx, cy = stack.pop()
                cells.append((cx, cy))
                for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    nx, ny = cx + dx, cy + dy
                    if 0 <= nx < w and 0 <= ny < h and mask[ny][nx] and not seen[ny][nx]:
                        seen[ny][nx] = True
                        stack.append((nx, ny))
            blobs.append(cells)
    return blobs
