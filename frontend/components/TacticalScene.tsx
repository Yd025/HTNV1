/** Schematic local arena; all plotted positions come from telemetry. */
import { Html, Line, OrbitControls } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ElementRef } from "react";
import { Box3, Color, Group, InstancedMesh, Object3D, PerspectiveCamera, Vector3 } from "three";
import { DEFAULT_ARENA, SCENE_SCALE, toScene, type ArenaRef } from "../lib/geo";
import { sceneColors, type ScenePalette } from "../lib/theme";
import type { HeatCell, StrategyPlan, TelemetrySample, TrackState, VehicleClass } from "../lib/types";
import { VehicleModel, useVehicleMaterials, vehicleModelInfo } from "./scene/VehicleModels";

type Props = {
  fleet: Record<string, TelemetrySample>;
  track: TrackState | null;
  truth: { lat: number; lon: number } | null;
  heatmap: HeatCell[];
  strategy: StrategyPlan | null;
  arena?: ArenaRef;
  scene?: ScenePalette;
  selectedVehicleId?: string | null;
  onSelectVehicle?: (id: string | null) => void;
};

export default function TacticalScene({ fleet, track, truth, heatmap, strategy, arena, scene = sceneColors, selectedVehicleId, onSelectVehicle }: Props) {
  const arenaRef = arena ?? DEFAULT_ARENA;
  const half = arenaRef.half_m * SCENE_SCALE;
  const [resetView, setResetView] = useState(0);
  const [internalSelection, setInternalSelection] = useState<string | null>(null);
  const [cameraFocus, setCameraFocus] = useState<[number, number, number] | null>(null);
  const selectedId = selectedVehicleId === undefined ? internalSelection : selectedVehicleId;
  const setSelectedId = useCallback((id: string | null) => {
    setInternalSelection(id);
    onSelectVehicle?.(id);
  }, [onSelectVehicle]);
  const vehicles = Object.values(fleet).filter((vehicle) => Number.isFinite(vehicle.lat) && Number.isFinite(vehicle.lon));
  const selected = selectedId ? fleet[selectedId] : undefined;

  return (
    <div className="relative h-full min-h-[340px] w-full overflow-hidden" style={{ background: scene.void }}>
      <Canvas frameloop="demand" dpr={[1, 1.75]} camera={{ position: [half * 1.18, half * 1.34, half * 1.48], fov: 43, near: 0.1, far: half * 12 }} onPointerMissed={() => setSelectedId(null)} gl={{ antialias: true }} aria-label="Interactive 3D stand-in arena. Drag to orbit and scroll to zoom." fallback={<div className="p-6 text-sm" style={{ color: scene.chalk }}>3D is unavailable on this device. Use the 2D map to inspect telemetry.</div>}>
        <color attach="background" args={[scene.void]} />
        <hemisphereLight args={[scene.chalk, scene.ink, 2.3]} />
        <directionalLight position={[-half, half * 2, half * 0.7]} intensity={3.1} />
        <directionalLight position={[half, half, -half]} intensity={0.6} color={scene.chalk} />
        <SceneControls half={half} resetView={resetView} focus={cameraFocus} />
        <ArenaPlate half={half} colors={scene} />
        <Heatmap cells={heatmap} arena={arenaRef} colors={scene} />
        <Fleet vehicles={vehicles} arena={arenaRef} colors={scene} selectedId={selectedId} onSelect={setSelectedId} />
        {track && <Contact kind="track" lat={track.lat} lon={track.lon} arena={arenaRef} history={track.history} sigma={track.sigma_m} colors={scene} />}
        {truth && <Contact kind="truth" lat={truth.lat} lon={truth.lon} arena={arenaRef} colors={scene} />}
        {strategy?.intercept && track && <InterceptLine from={[track.lat, track.lon]} to={[strategy.intercept.lat, strategy.intercept.lon]} arena={arenaRef} colors={scene} />}
      </Canvas>
      <div className="pointer-events-none absolute left-4 top-4 max-w-[calc(100%-8rem)] text-[10px] leading-relaxed" style={{ color: scene.chalk }}>
        <div className="inline-block px-2 py-1" style={{ background: scene.ink }}>Stand-in arena · not Dominion terrain</div>
        <div className="mt-1 inline-block px-2 py-1" style={{ background: scene.ink }}>Simulator vehicle geometry · enlarged for visibility</div>
      </div>
      <div className="absolute right-4 top-4 flex flex-col gap-1.5">
        <button type="button" onClick={() => { setCameraFocus(null); setResetView((value) => value + 1); }} className="flex min-h-9 items-center gap-2 rounded-sm border px-3 text-[11px] transition-opacity hover:opacity-80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" style={{ color: scene.chalk, background: scene.ink, borderColor: scene.muted, outlineColor: scene.chalk }}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 5a5.5 5.5 0 1 1-1 5M3 1v4h4" stroke="currentColor" strokeWidth="1.4" /></svg>Fit arena
        </button>
        {selected && Number.isFinite(selected.lat) && Number.isFinite(selected.lon) && <button type="button" onClick={() => setCameraFocus(toScene(selected.lat!, selected.lon!, selected.alt ?? 0, arenaRef))} className="min-h-9 rounded-sm border px-3 text-[11px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" style={{ color: scene.chalk, background: scene.ink, borderColor: scene.muted, outlineColor: scene.chalk }}>Focus vehicle</button>}
      </div>
      <div className="pointer-events-none absolute bottom-4 left-4 right-4 flex flex-wrap items-end justify-between gap-2 text-[10px]" style={{ color: scene.chalk }}>
        <div className="flex flex-wrap gap-x-4 gap-y-2 px-2 py-1.5" style={{ background: scene.ink }}>
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rotate-45" style={{ background: scene.rust }} />Target estimate</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 rounded-full border" style={{ borderColor: scene.chalk }} />Evaluation truth</span>
          <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2" style={{ background: scene.muted }} />Observed cells</span>
        </div>
        <span className="px-2 py-1.5" style={{ background: scene.ink }}>Drag to orbit · scroll to zoom</span>
      </div>
      {selected && <div className="absolute bottom-16 right-4 w-52 rounded-sm border p-3 shadow-lg" style={{ color: scene.chalk, background: scene.ink, borderColor: scene.muted }}>
        <div className="flex items-start justify-between gap-3"><div><div className="text-sm font-semibold">{selected.vehicle_id}</div><div className="mt-0.5 text-[11px] capitalize">{selected.vehicle_class ? vehicleModelInfo[selected.vehicle_class].name : "Vehicle"} / {selected.role ?? "Role unavailable"}</div></div><button type="button" aria-label="Close vehicle details" onClick={() => setSelectedId(null)} className="flex h-6 w-6 items-center justify-center rounded-sm focus-visible:outline focus-visible:outline-2"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m2 2 8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" /></svg></button></div>
        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-[11px]">
          <dt style={{ color: scene.chalk }}>Altitude</dt><dd className="text-right tabular-nums" style={{ color: scene.chalk }}>{formatValue(selected.alt, "m")}</dd>
          <dt style={{ color: scene.chalk }}>Speed</dt><dd className="text-right tabular-nums" style={{ color: scene.chalk }}>{formatValue(selected.groundspeed, "m/s")}</dd>
          <dt style={{ color: scene.chalk }}>Heading</dt><dd className="text-right tabular-nums" style={{ color: scene.chalk }}>{formatValue(selected.heading, "°")}</dd>
        </dl>
      </div>}
    </div>
  );
}

const MODEL_DESCRIPTIONS: Record<VehicleClass, { name: string; role: string; description: string }> = {
  plane: { name: "Skywalker X8", role: "Wide-area search", description: "Simulator flying-wing geometry with swept wings, elevons and a rear pusher propeller. Enlarged for inspection." },
  copter: { name: "3DR Iris", role: "Contact tracking", description: "Simulator Iris airframe, rotor assemblies, landing standoffs and camera gimbal. Small CAD details are simplified for the dashboard." },
  rover: { name: "Tracked rover", role: "Close confirmation", description: "Simulator skid-steer chassis with tread belts, road wheels and forward camera. Visual geometry follows the existing rover model." },
  tower: { name: "EO/IR tripod", role: "Fixed-site cueing", description: "Simulator three-leg mast with pan-tilt housing and dual lenses. The displayed head is a static model; gimbal angles are unavailable." },
};

export function FleetModelPreview({ scene = sceneColors }: { scene?: ScenePalette }) {
  const [kind, setKind] = useState<VehicleClass>("plane");
  const model = MODEL_DESCRIPTIONS[kind];
  return <div className="flex h-full min-h-[420px] flex-col overflow-hidden" style={{ background: scene.void, color: scene.chalk }}>
    <p className="shrink-0 px-4 py-2 text-[10px]" style={{ background: scene.ink, color: scene.chalk }}>
      Simulator model reference · display models, not telemetry
    </p>
    <div className="relative min-h-0 flex-1">
      <Canvas frameloop="demand" dpr={[1, 1.75]} camera={{ position: [10, 8, 12], fov: 38 }} aria-label={`Interactive ${model.name} simulator model`} fallback={<div className="p-6 text-sm">3D model rendering is unavailable on this device.</div>}>
        <color attach="background" args={[scene.void]} />
        <hemisphereLight args={[scene.chalk, scene.ink, 2.6]} />
        <directionalLight position={[-8, 12, 5]} intensity={3.3} />
        <directionalLight position={[8, 4, -8]} intensity={1.2} />
        <ModelSpecimen kind={kind} colors={scene} />
      </Canvas>
    </div>
    <div className="shrink-0 border-t px-4 py-3" style={{ background: scene.ink, borderColor: scene.muted }}>
      <div className="grid grid-cols-2 gap-1 sm:flex sm:flex-wrap" role="group" aria-label="Choose a simulator vehicle model">
        {(Object.keys(MODEL_DESCRIPTIONS) as VehicleClass[]).map((value) => (
          <button key={value} type="button" aria-pressed={kind === value} onClick={() => setKind(value)} className="min-h-9 rounded-sm border px-3 text-[11px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" style={{ color: kind === value ? scene.ink : scene.chalk, background: kind === value ? scene.chalk : scene.ink, borderColor: kind === value ? scene.chalk : scene.muted, outlineColor: scene.chalk }}>
            {MODEL_DESCRIPTIONS[value].name}
          </button>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-base font-semibold" style={{ color: scene.chalk }}>{model.name}</h3>
        <p className="text-[11px]" style={{ color: scene.chalk }}>{model.role}</p>
        <span className="text-[10px] sm:ml-auto" style={{ color: scene.chalk }}>Drag to inspect · scroll to zoom</span>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed" style={{ color: scene.chalk }}>{model.description}</p>
    </div>
  </div>;
}

function ModelSpecimen({ kind, colors }: { kind: VehicleClass; colors: ScenePalette }) {
  const materials = useVehicleMaterials(colors);
  const specimen = useRef<Group>(null);
  const controls = useRef<ElementRef<typeof OrbitControls>>(null);
  const { camera, size, invalidate } = useThree();
  const plinthRadius = { plane: 5.3, copter: 4.1, rover: 2.7, tower: 3.5 }[kind];

  useLayoutEffect(() => {
    if (!specimen.current || !(camera instanceof PerspectiveCamera)) return;
    // Fit projected corners rather than a sphere: flat aircraft need much less headroom.
    const bounds = new Box3().setFromObject(specimen.current);
    const center = bounds.getCenter(new Vector3());
    const aspect = Math.max(0.1, size.width / Math.max(1, size.height));
    const tangentY = Math.tan(camera.fov * Math.PI / 360) * 0.88;
    const tangentX = tangentY * aspect;
    const viewDirection = new Vector3(10, 8, 12).normalize();
    const right = new Vector3(0, 1, 0).cross(viewDirection).normalize();
    const up = viewDirection.clone().cross(right).normalize();
    let distance = 0;
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
      const corner = new Vector3(x, y, z).sub(center);
      const depth = corner.dot(viewDirection);
      distance = Math.max(distance, Math.abs(corner.dot(right)) / tangentX + depth, Math.abs(corner.dot(up)) / tangentY + depth);
    }
    camera.position.copy(center).addScaledVector(viewDirection, distance);
    camera.lookAt(center);
    camera.updateProjectionMatrix();
    if (controls.current) {
      controls.current.target.copy(center);
      controls.current.minDistance = distance * 0.55;
      controls.current.maxDistance = distance * 2;
      controls.current.update();
    }
    invalidate();
  }, [camera, kind, size.width, size.height, invalidate]);

  return <>
    <OrbitControls ref={controls} makeDefault enableDamping={false} enablePan={false} minPolarAngle={0.15} maxPolarAngle={Math.PI / 2.1} />
    <group ref={specimen}>
      <VehicleModel kind={kind} materials={materials} />
      <mesh position={[0, -0.3, 0]}><cylinderGeometry args={[plinthRadius, plinthRadius + 0.15, 0.25, 64]} /><meshStandardMaterial color={colors.surface} roughness={0.88} /></mesh>
      <mesh position={[0, -0.08, 0]} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[plinthRadius - 0.25, plinthRadius - 0.22, 80]} /><meshBasicMaterial color={colors.grid} /></mesh>
    </group>
  </>;
}

function formatValue(value: number | null | undefined, unit: string) { return value == null || !Number.isFinite(value) ? "Unavailable" : `${value.toFixed(1)} ${unit}`; }

function SceneControls({ half, resetView, focus }: { half: number; resetView: number; focus: [number, number, number] | null }) {
  const controls = useRef<ElementRef<typeof OrbitControls>>(null);
  const { camera, size, invalidate } = useThree();
  useEffect(() => {
    if (!(camera instanceof PerspectiveCamera)) return;
    const target = focus ? new Vector3(focus[0], focus[1] + 2.5, focus[2]) : new Vector3(0, 0, 0);
    const aspect = Math.max(0.1, size.width / Math.max(1, size.height));
    const tangentY = Math.tan(camera.fov * Math.PI / 360);
    const tangentX = tangentY * aspect;
    const direction = new Vector3(1.15, 1.3, 1.5).normalize();
    const right = new Vector3(0, 1, 0).cross(direction).normalize();
    const up = direction.clone().cross(right).normalize();
    let distance = 0;
    if (focus) {
      distance = 7 / Math.min(tangentX, tangentY) + 7;
    } else {
      // Fit all arena corners in the actual canvas, including narrow monitor layouts.
      for (const x of [-half - 4, half + 4]) for (const z of [-half - 4, half + 4]) for (const y of [-2, 12]) {
        const point = new Vector3(x, y, z);
        const depth = point.dot(direction);
        distance = Math.max(distance, Math.abs(point.dot(right)) / tangentX + depth, Math.abs(point.dot(up)) / tangentY + depth);
      }
      distance *= 1.1;
    }
    camera.far = Math.max(half * 12, distance * 4);
    camera.position.copy(target).addScaledVector(direction, distance);
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    if (controls.current) {
      controls.current.minDistance = 8;
      controls.current.maxDistance = Math.max(half * 5, distance * 2);
      controls.current.target.copy(target);
      controls.current.update();
    }
    invalidate();
  }, [camera, half, resetView, focus, size.width, size.height, invalidate]);
  return <OrbitControls ref={controls} makeDefault enableDamping={false} minPolarAngle={0.12} maxPolarAngle={Math.PI / 2.2} />;
}

function ArenaPlate({ half, colors }: { half: number; colors: ScenePalette }) {
  const boundary = useMemo<[number, number, number][]>(() => [[-half, 0.15, -half], [half, 0.15, -half], [half, 0.15, half], [-half, 0.15, half], [-half, 0.15, -half]], [half]);
  return <group>
    <mesh position={[0, -0.9, 0]}><boxGeometry args={[half * 2, 1.7, half * 2]} /><meshStandardMaterial color={colors.surfaceEdge} roughness={0.92} /></mesh>
    <mesh rotation={[-Math.PI / 2, 0, 0]}><planeGeometry args={[half * 2, half * 2]} /><meshStandardMaterial color={colors.surface} roughness={0.92} metalness={0.02} /></mesh>
    <gridHelper args={[half * 2, 24, colors.grid, colors.grid]} position={[0, 0.045, 0]} />
    <Line points={boundary} color={colors.muted} lineWidth={1} />
    <Line points={[[-half, 0.12, 0], [half, 0.12, 0]]} color={colors.muted} lineWidth={0.7} dashed dashSize={1.1} gapSize={1} />
    <Line points={[[0, 0.12, -half], [0, 0.12, half]]} color={colors.muted} lineWidth={0.7} dashed dashSize={1.1} gapSize={1} />
    <Html center position={[0, 0, -half - 4]} style={{ pointerEvents: "none" }}><span className="rounded-sm px-1 py-0.5 text-[11px] font-semibold" style={{ color: colors.chalk, background: colors.ink }}>N</span></Html>
    <Html center position={[half + 4, 0, 0]} style={{ pointerEvents: "none" }}><span className="rounded-sm px-1 py-0.5 text-[11px]" style={{ color: colors.chalk, background: colors.ink }}>E</span></Html>
    <Html center position={[-half, -1, half + 5]} style={{ pointerEvents: "none" }}><span className="whitespace-nowrap rounded-sm px-1 py-0.5 text-[10px] tabular-nums" style={{ color: colors.chalk, background: colors.ink }}>{((half * 2) / SCENE_SCALE / 1000).toFixed(1)} km arena</span></Html>
  </group>;
}

function Fleet({ vehicles, arena, colors, selectedId, onSelect }: { vehicles: TelemetrySample[]; arena: ArenaRef; colors: ScenePalette; selectedId: string | null; onSelect: (id: string) => void }) {
  const materials = useVehicleMaterials(colors);
  return <>{vehicles.map((vehicle) => {
    const position = toScene(vehicle.lat as number, vehicle.lon as number, vehicle.alt ?? 0, arena);
    const kind = vehicle.vehicle_class ?? "copter";
    const selected = selectedId === vehicle.vehicle_id;
    return <group key={vehicle.vehicle_id} position={position}>
      {position[1] > 0.5 && <Line points={[[0, 0, 0], [0, -position[1] + 0.2, 0]]} color={colors.ink} lineWidth={0.7} dashed dashSize={0.5} gapSize={0.5} transparent opacity={0.5} />}
      <group rotation={[0, -((vehicle.heading ?? 0) * Math.PI) / 180, 0]} onClick={(event) => { event.stopPropagation(); onSelect(vehicle.vehicle_id); }}><VehicleModel kind={kind} materials={materials} /></group>
      {selected && <mesh position={[0, -position[1] + 0.2, 0]} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[3.6, 3.9, 48]} /><meshBasicMaterial color={colors.rust} /></mesh>}
      <Html center position={[0, kind === "tower" ? 10 : 4.4, 0]} zIndexRange={[20, 0]}>
        <button type="button" aria-label={`Inspect ${vehicle.vehicle_id}, ${vehicle.role ?? "role unavailable"}`} aria-pressed={selected} onClick={() => onSelect(vehicle.vehicle_id)} className="whitespace-nowrap rounded-sm border px-2 py-1 text-[10px] leading-tight shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" style={{ color: colors.chalk, background: colors.ink, borderColor: selected ? colors.rust : colors.muted, outlineColor: colors.chalk }}><span className="font-semibold">{vehicle.vehicle_id}</span><span className="ml-1.5 opacity-80">{vehicle.role ?? "Unassigned"}</span></button>
      </Html>
    </group>;
  })}</>;
}

function Heatmap({ cells, arena, colors }: { cells: HeatCell[]; arena: ArenaRef; colors: ScenePalette }) {
  const mesh = useRef<InstancedMesh>(null);
  const size = arena.half_m * SCENE_SCALE * 2 / 24;
  const capacity = Math.max(1, cells.length);
  useLayoutEffect(() => {
    if (!mesh.current) return;
    const transform = new Object3D();
    const color = new Color();
    const base = new Color(colors.surface);
    const observed = new Color(colors.muted);
    transform.rotation.x = -Math.PI / 2;
    transform.scale.set(size * 0.96, size * 0.96, 1);
    cells.forEach((cell, index) => {
      const [x, , z] = toScene(cell.lat, cell.lon, 0, arena);
      transform.position.set(x, 0.09, z);
      transform.updateMatrix();
      mesh.current!.setMatrixAt(index, transform.matrix);
      color.copy(base).lerp(observed, Math.max(0, Math.min(1, cell.heat)));
      mesh.current!.setColorAt(index, color);
    });
    mesh.current.count = cells.length;
    mesh.current.instanceMatrix.needsUpdate = true;
    if (mesh.current.instanceColor) mesh.current.instanceColor.needsUpdate = true;
    mesh.current.computeBoundingSphere();
  }, [cells, arena, colors.surface, colors.muted, size]);
  // One draw call for the received cells. Cell width follows the existing default 24 × 24 grid.
  return <instancedMesh ref={mesh} args={[undefined, undefined, capacity]}>
    <planeGeometry args={[1, 1]} />
    <meshBasicMaterial transparent opacity={0.42} depthWrite={false} />
  </instancedMesh>;
}

function Contact({ kind, lat, lon, arena, history, sigma, colors }: { kind: "track" | "truth"; lat: number; lon: number; arena: ArenaRef; history?: [number, number][]; sigma?: number; colors: ScenePalette }) {
  const position = toScene(lat, lon, 0, arena);
  const color = kind === "track" ? colors.rust : colors.ink;
  const points = useMemo(() => history && history.length > 1 ? history.map(([hLat, hLon]) => toScene(hLat, hLon, 8, arena)) : null, [history, arena]);
  // Scalar heuristic in meters, not a calibrated confidence ellipse.
  const radius = sigma != null && Number.isFinite(sigma) && sigma > 0 ? sigma * SCENE_SCALE : 0;
  return <group>
    <group position={[position[0], 0.55, position[2]]}>{kind === "track" ? <mesh rotation={[0, Math.PI / 4, 0]}><boxGeometry args={[1.9, 0.8, 1.9]} /><meshStandardMaterial color={color} roughness={0.7} /></mesh> : <mesh rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[1.1, 1.45, 40]} /><meshBasicMaterial color={color} /></mesh>}</group>
    {kind === "track" && radius > 0 && <mesh position={[position[0], 0.25, position[2]]} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[Math.max(0, radius - 0.12), radius + 0.12, 80]} /><meshBasicMaterial color={color} transparent opacity={0.6} depthWrite={false} /></mesh>}
    {points && <Line points={points} color={color} lineWidth={1.4} />}
    <Html center position={[position[0], 3.3, position[2]]} zIndexRange={[15, 0]} style={{ pointerEvents: "none" }}><span className="whitespace-nowrap rounded-sm px-1.5 py-1 text-[10px]" style={{ color: colors.chalk, background: colors.ink }}>{kind === "track" ? "Target estimate" : "Evaluation truth"}{kind === "track" && radius > 0 ? ` · σ ${Math.round(sigma!)} m` : ""}</span></Html>
  </group>;
}

function InterceptLine({ from, to, arena, colors }: { from: [number, number]; to: [number, number]; arena: ArenaRef; colors: ScenePalette }) {
  return <Line points={[toScene(from[0], from[1], 9, arena), toScene(to[0], to[1], 9, arena)]} color={colors.rust} lineWidth={1} dashed dashSize={1.6} gapSize={1.4} />;
}
