/** Local north/east — same flattening as backend/geo.py. */

const M_PER_DEG_LAT = 111_111;

export type ArenaRef = {
  origin_lat: number;
  origin_lon: number;
  half_m: number;
};

export const DEFAULT_ARENA: ArenaRef = {
  origin_lat: 74.6973,
  origin_lon: -94.8297,
  half_m: 1500,
};

/** Scene meters → Three.js units. 1 unit ≈ 25 m. */
export const SCENE_SCALE = 0.04;

export function llToNe(lat: number, lon: number, arena: ArenaRef = DEFAULT_ARENA): { north: number; east: number } {
  const north = (lat - arena.origin_lat) * M_PER_DEG_LAT;
  const east =
    (lon - arena.origin_lon) * M_PER_DEG_LAT * Math.max(0.2, Math.abs(Math.cos((arena.origin_lat * Math.PI) / 180)));
  return { north, east };
}

/** Three.js: +X east, +Y up, −Z north. */
export function toScene(
  lat: number,
  lon: number,
  alt = 0,
  arena: ArenaRef = DEFAULT_ARENA,
): [number, number, number] {
  const { north, east } = llToNe(lat, lon, arena);
  return [east * SCENE_SCALE, alt * SCENE_SCALE, -north * SCENE_SCALE];
}
