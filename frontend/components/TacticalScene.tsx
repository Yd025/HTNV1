/**
 * Fake stand-in arena. Not WHITEOUT terrain.
 *
 * ASTRA RESTYLE TARGET — change ARENA_LOOK and the meshes only.
 * Poses / heatmap / track come from live WebSocket props. Do not invent contacts.
 */
import { Html, Line, OrbitControls } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { useMemo } from "react";
import { DEFAULT_ARENA, SCENE_SCALE, toScene, type ArenaRef } from "../lib/geo";
import type { HeatCell, StrategyPlan, TelemetrySample, TrackState } from "../lib/types";

export const ARENA_LOOK = {
  ice: "#c5dce6",
  iceDark: "#8eafbd",
  void: "#070b10",
  grid: "#4a6d7a",
  origin: "#64748b",
  track: "#e11d48",
  truth: "#fde047",
  intercept: "#fbbf24",
};

const ROLE_HEX: Record<string, string> = {
  search: "#14b8a6",
  track: "#f59e0b",
  confirm: "#f43f5e",
  cue: "#8b5cf6",
  reserve: "#64748b",
};

type Props = {
  fleet: Record<string, TelemetrySample>;
  track: TrackState | null;
  truth: { lat: number; lon: number } | null;
  heatmap: HeatCell[];
  strategy: StrategyPlan | null;
  arena?: ArenaRef;
};

export default function TacticalScene({ fleet, track, truth, heatmap, strategy, arena }: Props) {
  const ref = arena ?? DEFAULT_ARENA;
  const half = ref.half_m * SCENE_SCALE;
  const vehicles = Object.values(fleet).filter((v) => v.lat != null && v.lon != null);

  return (
    <div className="relative h-full w-full bg-ice-950">
      <Canvas camera={{ position: [half * 1.15, half * 0.72, half * 1.15], fov: 42 }} shadows>
        <color attach="background" args={[ARENA_LOOK.void]} />
        <fog attach="fog" args={[ARENA_LOOK.void, half * 1.4, half * 4.2]} />
        <ambientLight intensity={0.55} />
        <directionalLight position={[half, half * 2, half * 0.4]} intensity={1.1} />
        <OrbitControls enablePan makeDefault minDistance={40} maxDistance={half * 4} maxPolarAngle={Math.PI / 2.05} />

        <IceSheet half={half} />
        <gridHelper args={[half * 2, 12, ARENA_LOOK.grid, ARENA_LOOK.grid]} position={[0, 0.05, 0]} />

        {heatmap.slice(0, 60).map((cell, i) => (
          <HeatPatch key={`h-${i}`} cell={cell} arena={ref} />
        ))}

        {vehicles.map((v) => (
          <Craft key={v.vehicle_id} vehicle={v} arena={ref} />
        ))}

        {track && <Contact kind="track" lat={track.lat} lon={track.lon} arena={ref} history={track.history} sigma={track.sigma_m} />}
        {truth && <Contact kind="truth" lat={truth.lat} lon={truth.lon} arena={ref} />}
        {strategy?.intercept && track && (
          <InterceptLine from={[track.lat, track.lon]} to={[strategy.intercept.lat, strategy.intercept.lon]} arena={ref} />
        )}
      </Canvas>
      <div className="pointer-events-none absolute left-3 top-3 rounded border border-slate-700/80 bg-ice-950/80 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-slate-400">
        Stand-in arena · not Dominion terrain
      </div>
    </div>
  );
}

function IceSheet({ half }: { half: number }) {
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[half * 2, half * 2, 1, 1]} />
        <meshStandardMaterial color={ARENA_LOOK.ice} roughness={0.85} metalness={0.05} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.4, 0]}>
        <planeGeometry args={[half * 2.4, half * 2.4]} />
        <meshStandardMaterial color={ARENA_LOOK.iceDark} />
      </mesh>
    </group>
  );
}

function Craft({ vehicle, arena }: { vehicle: TelemetrySample; arena: ArenaRef }) {
  const hex = ROLE_HEX[vehicle.role ?? "reserve"] ?? ROLE_HEX.reserve;
  const pos = toScene(vehicle.lat as number, vehicle.lon as number, vehicle.alt ?? 0, arena);
  const yaw = -((vehicle.heading ?? 0) * Math.PI) / 180;
  const kind = vehicle.vehicle_class ?? "copter";

  return (
    <group position={pos} rotation={[0, yaw, 0]}>
      {kind === "plane" && (
        <mesh>
          <boxGeometry args={[2.8, 0.35, 7.2]} />
          <meshStandardMaterial color={hex} />
        </mesh>
      )}
      {kind === "copter" && (
        <mesh>
          <octahedronGeometry args={[1.6, 0]} />
          <meshStandardMaterial color={hex} />
        </mesh>
      )}
      {kind === "rover" && (
        <mesh>
          <boxGeometry args={[2.2, 0.9, 3.1]} />
          <meshStandardMaterial color={hex} />
        </mesh>
      )}
      {kind === "tower" && (
        <mesh position={[0, 4, 0]}>
          <cylinderGeometry args={[0.45, 0.7, 8, 8]} />
          <meshStandardMaterial color={hex} />
        </mesh>
      )}
      <Html distanceFactor={48} position={[0, kind === "tower" ? 9 : 3.2, 0]} style={{ pointerEvents: "none" }}>
        <div className="whitespace-nowrap rounded bg-ice-950/80 px-1.5 py-0.5 font-mono text-[10px] text-slate-100">
          {vehicle.vehicle_id} [{vehicle.role}]
        </div>
      </Html>
    </group>
  );
}

function HeatPatch({ cell, arena }: { cell: HeatCell; arena: ArenaRef }) {
  const [x, , z] = toScene(cell.lat, cell.lon, 0, arena);
  const size = arena.half_m * SCENE_SCALE * 2 * (1 / 24);
  return (
    <mesh position={[x, 0.12, z]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[size * 1.05, size * 1.05]} />
      <meshStandardMaterial color="#22d3ee" transparent opacity={0.08 + cell.heat * 0.28} />
    </mesh>
  );
}

function Contact({
  kind,
  lat,
  lon,
  arena,
  history,
  sigma,
}: {
  kind: "track" | "truth";
  lat: number;
  lon: number;
  arena: ArenaRef;
  history?: [number, number][];
  sigma?: number;
}) {
  const pos = toScene(lat, lon, 2, arena);
  const color = kind === "track" ? ARENA_LOOK.track : ARENA_LOOK.truth;
  const points = useMemo(() => {
    if (!history || history.length < 2) return null;
    return history.map(([hLat, hLon]) => toScene(hLat, hLon, 2.2, arena));
  }, [history, arena]);

  return (
    <group>
      <mesh position={pos}>
        <sphereGeometry args={[kind === "truth" ? 1.1 : 1.6, 16, 16]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.35} />
      </mesh>
      {kind === "track" && sigma != null && (
        <mesh position={pos} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[Math.min(8, sigma * SCENE_SCALE * 0.15), Math.min(8.4, sigma * SCENE_SCALE * 0.15 + 0.25), 24]} />
          <meshBasicMaterial color={color} transparent opacity={0.45} />
        </mesh>
      )}
      {points && <TrailLine points={points} color={color} />}
      <Html distanceFactor={52} position={[pos[0], pos[1] + 3, pos[2]]} style={{ pointerEvents: "none" }}>
        <div className="font-mono text-[10px] uppercase" style={{ color }}>
          {kind}
        </div>
      </Html>
    </group>
  );
}

function TrailLine({ points, color }: { points: [number, number, number][]; color: string }) {
  return <Line points={points} color={color} lineWidth={1} />;
}

function InterceptLine({
  from,
  to,
  arena,
}: {
  from: [number, number];
  to: [number, number];
  arena: ArenaRef;
}) {
  const a = toScene(from[0], from[1], 3, arena);
  const b = toScene(to[0], to[1], 3, arena);
  return <Line points={[a, b]} color={ARENA_LOOK.intercept} lineWidth={1} dashed dashSize={2} gapSize={1.5} />;
}
