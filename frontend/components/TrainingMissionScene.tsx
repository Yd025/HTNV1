import { Html, Line, OrbitControls, useTexture } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import { Component, Suspense, useEffect, useLayoutEffect, useMemo, useRef, type ElementRef, type ReactNode } from "react";
import { BufferGeometry, Float32BufferAttribute, PerspectiveCamera, SRGBColorSpace, Vector3 } from "three";
import { assetLabel, cameraFootprint, isQuad, type ArcticProfile, type GraphFrame, type GraphTower } from "../lib/graphExperiment";
import { acceptedSensorReport, cropSensorPoint, scenePosition, sensorAspect, sensorDirection, sensorPose, sensorReportCrop, terrainHeight, type SensorCrop, type TrainingSensorPose } from "../lib/trainingScene";
import { sceneColors } from "../lib/theme";
import { VehicleModel, useVehicleMaterials } from "./scene/VehicleModels";

export type TrainingMissionSceneProps = {
  profile: ArcticProfile;
  frame: GraphFrame;
  towers: GraphTower[];
  mode?: "orbit" | "sensor";
  sensorId?: string;
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  compact?: boolean;
  digitalZoom?: number;
};

/** A view of the overview's replay, with no simulation clock or control commands. */
export default function TrainingMissionScene({ profile, frame, towers, mode = "orbit", sensorId, selectedId, onSelect, compact = false, digitalZoom = 1 }: TrainingMissionSceneProps) {
  const pose = mode === "sensor" ? sensorPose(profile, frame, towers, sensorId ?? "") : null;
  const crop = pose && digitalZoom > 1 ? sensorReportCrop(frame, pose, digitalZoom) : null;
  const wideReport = pose ? acceptedSensorReport(frame, pose) : null;
  const report = crop ? cropSensorPoint(wideReport, crop) : wideReport;
  const opticalCenter = crop ? cropSensorPoint({ x: .5, y: .5 }, crop) : { x: .5, y: .5 };
  if (mode === "sensor" && !pose) return <SceneUnavailable>Camera pose is unavailable for this mission sample.</SceneUnavailable>;
  return <div style={{ position: "relative", width: "100%", ...(pose ? { aspectRatio: sensorAspect(pose.sensor) } : { height: "100%", minHeight: compact ? 240 : 420 }), background: sceneColors.void }}>
    <SceneBoundary>
      <Canvas frameloop="demand" dpr={[1, 1.5]} gl={{ antialias: true, powerPreference: "low-power" }}
        camera={{ fov: 42, near: .05, far: 25000, position: [4500, 4500, 5500] }}
        aria-label={pose ? `Modeled ${assetLabel(pose.id)} camera at the current overview time${crop ? `, ${crop.zoom} times digital crop` : ", full field of view"}` : "Fort Ross 3D view of the current overview mission"}
        fallback={<SceneUnavailable>3D rendering is unavailable on this device. The 2D overview remains available.</SceneUnavailable>}>
        <color attach="background" args={[pose ? "#8b9aa5" : sceneColors.void]} />
        <hemisphereLight args={["#e2e7ea", "#5b6670", 2.3]} />
        <directionalLight position={[-3000, 5000, 2000]} intensity={2} />
        <Suspense fallback={<Html center><span style={{ color: sceneColors.chalk, whiteSpace: "nowrap" }}>Loading Fort Ross terrain…</span></Html>}>
          <Terrain profile={profile} />
          <Boat frame={frame} />
          {pose ? <SensorCamera pose={pose} crop={crop} /> : <>
            <OrbitCamera half={profile.grid.halfM} />
            <MissionSymbols profile={profile} frame={frame} towers={towers} selectedId={selectedId} onSelect={onSelect} />
          </>}
        </Suspense>
      </Canvas>
    </SceneBoundary>
    {pose ? <div aria-hidden="true" style={{ position: "absolute", inset: 0, pointerEvents: "none", display: "grid", placeItems: "center" }}>
      {opticalCenter && <svg style={{ position: "absolute", left: `${opticalCenter.x * 100}%`, top: `${opticalCenter.y * 100}%`, transform: "translate(-50%, -50%)" }} width="30" height="30" viewBox="0 0 30 30" fill="none"><path d="M15 2v8m0 10v8M2 15h8m10 0h8" stroke="#e2e7ea" strokeWidth="1" opacity=".8" /></svg>}
      {report && <div style={{ position: "absolute", left: `${report.x * 100}%`, top: `${report.y * 100}%`, transform: "translate(-50%, -50%)", width: 26, height: 26, color: "#e2e7ea" }}>
        <svg width="26" height="26" viewBox="0 0 26 26" fill="none"><path d="M1 9V1h8m8 0h8v8m0 8v8h-8m-8 0H1v-8" stroke="#182232" strokeWidth="3" /><path d="M1 9V1h8m8 0h8v8m0 8v8h-8m-8 0H1v-8" stroke="currentColor" strokeWidth="1.5" /></svg>
      </div>}
      {report && <span style={{ position: "absolute", left: 7, top: 7, background: "#182232", color: "#e2e7ea", padding: "3px 5px", fontSize: 10, whiteSpace: "nowrap" }}>Reported position · {report.timestamp.toFixed(0)} s</span>}
    </div> : <div style={{ position: "absolute", bottom: 12, left: 12, color: sceneColors.chalk, background: sceneColors.ink, padding: "5px 8px", fontSize: 11, pointerEvents: "none" }}>Drag to orbit · scroll to zoom · asset symbols enlarged</div>}
  </div>;
}

function SceneUnavailable({ children }: { children: ReactNode }) {
  return <div role="status" style={{ color: "var(--text-muted)", padding: 24, minHeight: 160, display: "grid", placeItems: "center", background: "var(--canvas)" }}>{children}</div>;
}

class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <SceneUnavailable>The 3D view could not load. Reopen this view to retry; the 2D mission is still available.</SceneUnavailable> : this.props.children; }
}

function Terrain({ profile }: { profile: ArcticProfile }) {
  const texture = useTexture("/experiments/fort-ross-terrain.png");
  texture.colorSpace = SRGBColorSpace;
  const geometry = useMemo(() => {
    const { size, halfM, cellM, elevations, water } = profile.grid;
    const points: number[] = [], uv: number[] = [], indices: number[] = [];
    for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
      const index = row * size + col;
      // The water mask has a shore buffer; its omitted sea-level vertices also need separation.
      const height = water[index] || elevations[index] === 0 ? -2 : elevations[index];
      points.push(-halfM + col * cellM, height, halfM - row * cellM);
      // Image north is at the top; row zero in the profile is the south edge.
      uv.push(col / (size - 1), row / (size - 1));
      if (row < size - 1 && col < size - 1) indices.push(index, index + 1, index + size, index + 1, index + size + 1, index + size);
    }
    const mesh = new BufferGeometry();
    mesh.setAttribute("position", new Float32BufferAttribute(points, 3));
    mesh.setAttribute("uv", new Float32BufferAttribute(uv, 2));
    mesh.setIndex(indices); mesh.computeVertexNormals();
    return mesh;
  }, [profile]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  const width = profile.grid.halfM * 2;
  return <>
    <mesh geometry={geometry}><meshStandardMaterial map={texture} color="#e2e7ea" roughness={1} /></mesh>
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, .03, 0]}><planeGeometry args={[width, width]} /><meshStandardMaterial color="#293e4d" roughness={.62} metalness={.16} /></mesh>
  </>;
}

/** Six metre synthetic vessel, matching the offline sensor model's target length. */
function Boat({ frame }: { frame: GraphFrame }) {
  return <group position={scenePosition(frame.boat)}>
    <mesh position={[0, .3, 0]} rotation={[Math.PI / 2, 0, 0]}><capsuleGeometry args={[.9, 4.2, 4, 8]} /><meshStandardMaterial color="#9c4135" roughness={.8} /></mesh>
    <mesh position={[0, 1.05, .35]}><boxGeometry args={[1.25, 1.15, 2]} /><meshStandardMaterial color="#e2e7ea" roughness={.8} /></mesh>
    <mesh position={[0, 1.25, -.68]}><boxGeometry args={[1.05, .5, .05]} /><meshStandardMaterial color="#182232" roughness={.45} /></mesh>
  </group>;
}

function SensorCamera({ pose, crop }: { pose: TrainingSensorPose; crop: SensorCrop | null }) {
  const { camera, invalidate, size } = useThree();
  useLayoutEffect(() => {
    if (!(camera instanceof PerspectiveCamera)) return;
    const position = scenePosition(pose), direction = sensorDirection(pose.heading, pose.pitch);
    camera.position.set(...position);
    camera.up.set(0, 1, 0);
    camera.lookAt(position[0] + direction[0], position[1] + direction[1], position[2] + direction[2]);
    camera.fov = pose.sensor.vfovDeg;
    // The wrapper uses the source image aspect, so both FOV axes retain the recorded optics.
    camera.aspect = sensorAspect(pose.sensor);
    camera.near = pose.sensor.nearClipM ?? .05;
    camera.far = pose.sensor.farClipM;
    if (crop) {
      // Re-render a crop of the recorded sensor optics. Neither the vehicle nor
      // the optical axis is turned toward evaluation truth or the report.
      const height = pose.sensor.height ?? 720, width = height * sensorAspect(pose.sensor);
      camera.setViewOffset(width, height, crop.x * width, crop.y * height, crop.width * width, crop.height * height);
    } else camera.clearViewOffset();
    camera.updateProjectionMatrix();
    invalidate();
  }, [camera, invalidate, pose, crop, size.width, size.height]);
  return null;
}

function OrbitCamera({ half }: { half: number }) {
  const { camera, size, invalidate } = useThree();
  const controls = useRef<ElementRef<typeof OrbitControls>>(null);
  useLayoutEffect(() => {
    if (!(camera instanceof PerspectiveCamera)) return;
    const aspect = Math.max(.4, size.width / Math.max(1, size.height));
    const distance = half * 3.1 / Math.min(1, aspect);
    camera.fov = 42; camera.near = 10; camera.far = half * 12;
    camera.position.copy(new Vector3(.75, .95, 1).normalize().multiplyScalar(distance));
    camera.lookAt(0, 0, 0); camera.updateProjectionMatrix();
    controls.current?.target.set(0, 0, 0); controls.current?.update(); invalidate();
  }, [camera, half, size.width, size.height, invalidate]);
  return <OrbitControls ref={controls} makeDefault minDistance={30} maxDistance={half * 7} maxPolarAngle={Math.PI / 2.03} enableDamping={false} />;
}

function MissionSymbols({ profile, frame, towers, selectedId, onSelect }: Pick<TrainingMissionSceneProps, "profile" | "frame" | "towers" | "selectedId" | "onSelect">) {
  const materials = useVehicleMaterials(sceneColors);
  return <>
    {[...towers, ...frame.drones].map(asset => {
      const pose = sensorPose(profile, frame, towers, asset.id);
      if (!pose) return null;
      const tower = pose.kind === "tower", selected = selectedId === asset.id;
      const accepted = (frame.acceptedSources ?? frame.sources).includes(asset.id);
      const tint = accepted ? "#c0d0bb" : tower ? "#a4b0b7" : isQuad(asset.id) ? "#dcc49d" : "#e2e7ea";
      const footprint = cameraFootprint(pose, pose.sensor, profile.grid.halfM);
      const ground = terrainHeight(profile, asset), position = scenePosition({ ...asset, z: tower ? ground : asset.z });
      const route = frame.drones.find(drone => drone.id === asset.id)?.path;
      return <group key={asset.id}>
        {footprint.length > 2 && <Line points={[...footprint, footprint[0]].map(point => scenePosition({ ...point, z: 2 }))} color={tint} lineWidth={selected ? 1.7 : 1} transparent opacity={selected ? .7 : .25} />}
        <group position={position} rotation={[0, -asset.heading * Math.PI / 180, 0]} scale={tower ? 11 : 13}
          onClick={event => { event.stopPropagation(); onSelect?.(asset.id); }}>
          <VehicleModel kind={tower ? "tower" : isQuad(asset.id) ? "copter" : "plane"} materials={materials} />
        </group>
        <Html center position={[position[0], position[1] + 120, position[2]]} zIndexRange={[20, 0]}>
          <button type="button" aria-pressed={selected} onClick={() => onSelect?.(asset.id)} style={{ whiteSpace: "nowrap", border: `1px solid ${selected ? tint : "#5b6670"}`, borderRadius: 3, background: "#182232", color: tint, padding: "4px 7px", fontSize: 11, cursor: "pointer" }}>{assetLabel(asset.id)}{accepted ? " · report" : ""}</button>
        </Html>
        {route && route.length > 1 && <Line points={route.map(point => scenePosition({ ...point, z: asset.z }))} color={tint} transparent opacity={.4} lineWidth={1} dashed dashSize={35} gapSize={25} />}
      </group>;
    })}
    <mesh position={scenePosition({ ...frame.boat, z: 3 })} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[28, 36, 32]} /><meshBasicMaterial color="#dcc49d" /></mesh>
    <Html center position={scenePosition({ ...frame.boat, z: 110 })} zIndexRange={[19, 0]}><span style={{ whiteSpace: "nowrap", color: "#dcc49d", background: "#182232", padding: "4px 7px", borderRadius: 3, fontSize: 11, pointerEvents: "none" }}>Boat · evaluation truth</span></Html>
    {frame.estimate && <mesh position={scenePosition({ ...frame.estimate, z: 5 })} rotation={[-Math.PI / 2, 0, 0]}><ringGeometry args={[Math.max(8, frame.uncertaintyM ?? 12), Math.max(8, frame.uncertaintyM ?? 12) + 5, 48]} /><meshBasicMaterial color="#c0d0bb" transparent opacity={.8} /></mesh>}
  </>;
}
