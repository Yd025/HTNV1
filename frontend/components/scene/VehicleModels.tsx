/** Display geometry baked from the existing ArcticSim models; no simulator code runs here. */
import { useEffect, useMemo } from "react";
import { Box3, BoxGeometry, BufferGeometry, CylinderGeometry, Float32BufferAttribute, Matrix4, MeshStandardMaterial, SphereGeometry, Vector3 } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { ScenePalette } from "../../lib/theme";
import type { VehicleClass } from "../../lib/types";
import modelData from "./simModels.json";

type MaterialName = "body" | "panel" | "metal" | "accent";
type SourcePart = {
  name: string;
  type: "mesh" | "box" | "cylinder" | "sphere";
  material: MaterialName;
  positions?: number[];
  indices?: number[];
  matrix?: number[];
  size?: number[];
  radius?: number;
  length?: number;
};
type SourceModel = { name: string; source: string; origin: string; authors: string[]; parts: SourcePart[] };
const sourceModels = modelData as unknown as Record<VehicleClass, SourceModel>;
const DISPLAY_SIZE: Record<VehicleClass, number> = { plane: 9.5, copter: 6.8, rover: 4.1, tower: 8.7 };

// Simulator body frame: +X forward, +Y left, +Z up. UI model nose points toward -Z.
// Telemetry world coordinates continue to use the unchanged lib/geo.ts conversion.
const bodyToScene = new Matrix4().set(0, -1, 0, 0, 0, 0, 1, 0, -1, 0, 0, 0, 0, 0, 0, 1);

function buildGeometry(kind: VehicleClass) {
  const parts = sourceModels[kind].parts.map((part) => {
    let geometry: BufferGeometry;
    if (part.type === "mesh") {
      geometry = new BufferGeometry();
      geometry.setAttribute("position", new Float32BufferAttribute(part.positions!, 3));
      geometry.setIndex(part.indices!);
      geometry.computeVertexNormals();
    } else {
      if (part.type === "box") geometry = new BoxGeometry(part.size![0], part.size![1], part.size![2]);
      else if (part.type === "cylinder") {
        geometry = new CylinderGeometry(part.radius, part.radius, part.length, 16);
        geometry.rotateX(Math.PI / 2);
      } else geometry = new SphereGeometry(part.radius, 16, 10);
      geometry.applyMatrix4(new Matrix4().fromArray(part.matrix!).transpose());
    }
    geometry.deleteAttribute("uv");
    geometry.applyMatrix4(bodyToScene);
    geometry.computeBoundingBox();
    // Lift the X8's continuous airframe to sea gray so its actual contours remain legible.
    const material = kind === "plane" && part.name === "base_link_visual" ? "metal" : part.material;
    return { material, geometry };
  });
  const bounds = parts.reduce((box, part) => box.union(part.geometry.boundingBox!), new Box3());
  const extent = bounds.getSize(new Vector3());
  const scale = DISPLAY_SIZE[kind] / Math.max(extent.x, extent.y, extent.z);
  const center = bounds.getCenter(new Vector3());
  const groups = new Map<MaterialName, BufferGeometry[]>();
  parts.forEach(({ material, geometry }) => {
    geometry.translate(-center.x, -bounds.min.y, -center.z);
    geometry.scale(scale, scale, scale);
    const existing = groups.get(material) ?? [];
    existing.push(geometry);
    groups.set(material, existing);
  });
  // Static source parts merge into at most four draw calls per vehicle.
  return [...groups].map(([material, geometries]) => {
    const geometry = mergeGeometries(geometries)!;
    geometry.computeBoundingSphere();
    geometries.forEach((part) => part.dispose());
    return { material, geometry };
  });
}

const geometryCache = new Map<VehicleClass, ReturnType<typeof buildGeometry>>();

export const vehicleModelInfo = Object.fromEntries(Object.entries(sourceModels).map(([kind, model]) => [kind, {
  name: model.name, source: model.source, origin: model.origin,
}])) as Record<VehicleClass, { name: string; source: string; origin: string }>;

export function useVehicleMaterials(colors: ScenePalette) {
  const materials = useMemo(() => ({
    body: new MeshStandardMaterial({ color: colors.ink, roughness: 0.54, metalness: 0.24 }),
    panel: new MeshStandardMaterial({ color: colors.chalk, roughness: 0.68, metalness: 0.08 }),
    metal: new MeshStandardMaterial({ color: colors.muted, roughness: 0.5, metalness: 0.45 }),
    accent: new MeshStandardMaterial({ color: colors.rust, roughness: 0.65, metalness: 0.08 }),
  }), [colors.ink, colors.chalk, colors.muted, colors.rust]);
  useEffect(() => () => Object.values(materials).forEach((material) => material.dispose()), [materials]);
  return materials;
}

export function VehicleModel({ kind, materials }: { kind: VehicleClass; materials: ReturnType<typeof useVehicleMaterials> }) {
  if (!geometryCache.has(kind)) geometryCache.set(kind, buildGeometry(kind));
  return <group dispose={null}>
    {geometryCache.get(kind)!.map(({ material, geometry }) => <mesh key={material} geometry={geometry} material={materials[material]} />)}
  </group>;
}
