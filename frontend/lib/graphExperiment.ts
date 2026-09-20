export interface XY { x: number; y: number }
export type GraphAlgorithm = "tower-first-v2" | "coordinated-surveillance-v1";
export interface FlightPolicy {
  laneSpacingM: number; routePhase: number; quadSearchRadiusM: number;
  lookaheadS: number; supportOffsetM: number; reacquireWidthM: number;
}
export const algorithmLabel = (algorithm?: string) => algorithm === "coordinated-surveillance-v1" ? "Coordinated surveillance" : "Tower-first response";
export interface GraphTower extends XY { id: string; z: number; heading: number }
export interface GraphDrone extends XY { id: string; z: number; heading: number; pitch?: number; cameraHeading?: number; cameraPitch?: number; missionRole?: string; goal?: XY; path?: XY[] }
export interface MissionEvent { type: string; t: number; source?: string; receivers?: string[] }
export interface GraphFrame {
  t: number; boat: XY; drones: GraphDrone[]; sources: string[];
  coveragePct?: number; estimate?: XY | null; trackingSource?: string | null; towerHeadings?: number[];
  phase?: string; custodian?: string | null; uncertaintyM?: number | null;
  towerConfirmed?: boolean; handoffConfirmed?: boolean; events?: MissionEvent[];
  acceptedSources?: string[]; towerPitches?: number[]; observationAgeS?: number | null;
  towerVisible?: boolean;
  observations?: { source: string; x: number; y: number; sigmaM: number; confidence: number; timestamp: number; accepted: boolean }[];
  targetConfirmed?: boolean; targetHandoffConfirmed?: boolean; targetCustody?: boolean;
}
export interface GraphMetrics {
  episodes?: number;
  detectionRate: number; meanCappedS: number; p90CappedS: number;
  coveragePct: number; custodyPct: number; rmseM: number | null;
  estimateAvailabilityPct: number; distanceM: number; handoffs: number;
  bySource?: Record<string, number>;
  towerAcquisitionRate?: number; handoffRate?: number; postTowerCustodyPct?: number | null;
  falseConfirmations?: number; handoffDelayS?: number | null;
  longestGapS?: number; anySensorCustodyPct?: number; flightDistanceByAssetM?: Record<string, number>;
}
export interface GraphReplay { seed: number; algorithm?: GraphAlgorithm; missionVersion?: string; flightPolicy?: FlightPolicy; condition?: string; towers?: GraphTower[]; frames: GraphFrame[]; metrics: GraphMetrics; firstDetectionS?: number | null }
export interface GraphTrainingPreview {
  id: string; phase: "training" | "validation" | "test"; candidateIndex: number | null;
  episodeIndex: number; episodeTotal: number; policy?: "baseline" | "untrained" | "trained";
  replay: GraphReplay;
}
export interface GraphCandidate { index: number; algorithm?: GraphAlgorithm; flightPolicy?: FlightPolicy; towers: GraphTower[]; weights?: number[]; train: GraphMetrics; validation?: GraphMetrics; accepted?: boolean; preview?: GraphTrainingPreview }
export interface GraphReport {
  schemaVersion: number; seed: number; profileHash: string;
  missionVersion?: string;
  algorithm?: GraphAlgorithm;
  selectedIndex: number;
  protocol: { motionTrajectories: number; trainEpisodes: number; validationEpisodes: number; testEpisodes: number; candidates: number; horizonS: number; stepS: number; freshnessS: number };
  trained: { towers: GraphTower[]; weights: number[]; candidateIndex?: number; algorithm?: GraphAlgorithm; flightPolicy?: FlightPolicy };
  baseline: { towers: GraphTower[] };
  history: GraphCandidate[];
  metrics: { baseline: GraphMetrics; untrained: GraphMetrics; trained: GraphMetrics };
  detectionCurve: { t: number; baseline: number; untrained: number; trained: number }[];
  replays: GraphReplay[]; limitations: string[];
  comparison?: { meanSecondsSaved: number; pairedBootstrap95S: number[]; detectionRateGain: number; testUsedForSelection: boolean };
}
export interface ArcticSensor { hfovDeg: number; vfovDeg: number; farClipM: number; nearClipM?: number; pitchDeg: number; width?: number; height?: number }
export interface ArcticProfile {
  grid: { size: number; halfM: number; cellM: number; elevations: number[]; water: boolean[]; landCandidates: number[]; waterEdges: number[][] };
  sensors: Record<string, ArcticSensor>;
  towerDefaults: GraphTower[];
  frame?: Record<string, unknown>;
}
export interface GraphJob { id: string; kind: "train" | "replay"; status: "running" | "complete" | "failed"; error?: string; progress?: {
  algorithm?: GraphAlgorithm;
  seed?: number; phase?: string; completed?: number; total?: number; testCompleted?: number; testTotal?: number;
  validationCompleted?: number; validationTotal?: number;
  history?: GraphCandidate[]; evaluatingPolicy?: string;
  activeCandidate?: { index: number | null; towers: GraphTower[]; weights: number[]; algorithm?: GraphAlgorithm; flightPolicy?: FlightPolicy };
  candidateCompleted?: number; candidateEpisodes?: number; candidateMetrics?: GraphMetrics | null;
  bestCandidate?: number | null; preview?: GraphTrainingPreview | null;
  partialMetrics?: Partial<Record<"baseline" | "untrained" | "trained", GraphMetrics>>;
  partialDetectionCurve?: { t: number; baseline: number | null; untrained: number | null; trained: number | null }[];
}; result?: GraphReport | GraphReplay }

export const assetLabel = (id: string) => id.includes("tower") ? (id.endsWith("2") ? "Tower 2" : "Tower 1") : /quad|copter/.test(id) ? "Quadcopter" : "Fixed-wing";
export const isQuad = (id: string) => /quad|copter/.test(id);
export function gridPoint(profile: ArcticProfile, index: number): XY {
  return { x: -profile.grid.halfM + (index % profile.grid.size) * profile.grid.cellM, y: -profile.grid.halfM + Math.floor(index / profile.grid.size) * profile.grid.cellM };
}
export function nearestCell(profile: ArcticProfile, point: XY, water: boolean): number {
  const connected = new Set(profile.grid.waterEdges.flat());
  const candidates = water ? profile.grid.water.flatMap((valid, index) => valid && connected.has(index) ? [index] : []) : profile.grid.landCandidates;
  if (!candidates.length) throw new Error("No valid terrain cells are available.");
  return candidates.reduce((best, index) => {
    const a = gridPoint(profile, best), b = gridPoint(profile, index);
    return (b.x - point.x) ** 2 + (b.y - point.y) ** 2 < (a.x - point.x) ** 2 + (a.y - point.y) ** 2 ? index : best;
  }, candidates[0]);
}
export function nearestSource(frame: GraphFrame, towers: GraphTower[], visibleOnly: boolean) {
  const contact = visibleOnly && frame.phase ? frame.estimate : frame.boat;
  if (!contact) return null;
  const candidates = [...towers, ...frame.drones].filter(source => !visibleOnly || (frame.acceptedSources ?? frame.sources).includes(source.id));
  return candidates.map(source => ({ source, distanceM: Math.hypot(source.x - contact.x, source.y - contact.y) }))
    .sort((a, b) => a.distanceM - b.distanceM || a.source.id.localeCompare(b.source.id))[0] ?? null;
}

export function isTowerFirstReport(value: GraphReport): boolean {
  return value?.missionVersion === "tower-first-v2" && Array.isArray(value.replays)
    && value.replays.length > 0 && value.replays.every(replay => replay.frames.length > 0 && typeof replay.frames[0].targetConfirmed === "boolean");
}

export function isMissionReport(value: GraphReport): boolean {
  return ["tower-first-v2", "coordinated-surveillance-v1"].includes(value?.missionVersion ?? "")
    && Array.isArray(value.replays) && value.replays.length > 0
    && value.replays.every(replay => Array.isArray(replay.frames) && replay.frames.length > 0 && typeof replay.frames[0].targetConfirmed === "boolean");
}

/** Interpolate drawing poses only; detections and estimates remain at the last observed sample. */
export function drawFrame(replay: GraphReplay, elapsedS: number): GraphFrame {
  const index = Math.max(0, replay.frames.findIndex(frame => frame.t > elapsedS) - 1);
  const a = elapsedS >= replay.frames[replay.frames.length - 1].t ? replay.frames[replay.frames.length - 1] : replay.frames[index];
  const b = replay.frames[index + 1];
  if (!b || elapsedS >= replay.frames[replay.frames.length - 1].t) return a;
  const fraction = Math.max(0, Math.min(1, (elapsedS - a.t) / Math.max(.001, b.t - a.t)));
  if (fraction === 0) return a;
  const mix = (x: number, y: number) => x + fraction * (y - x);
  const heading = (x: number, y: number) => (x + fraction * (((y - x + 540) % 360) - 180) + 360) % 360;
  return { ...a, boat: { x: mix(a.boat.x, b.boat.x), y: mix(a.boat.y, b.boat.y) },
    drones: a.drones.map(drone => {
      const next = b.drones.find(item => item.id === drone.id);
      if (!next) return drone;
      const drawn = { ...drone, x: mix(drone.x, next.x), y: mix(drone.y, next.y), z: mix(drone.z, next.z), heading: heading(drone.heading, next.heading) };
      if (drone.pitch !== undefined && next.pitch !== undefined) drawn.pitch = mix(drone.pitch, next.pitch);
      if (drone.cameraHeading !== undefined || next.cameraHeading !== undefined) {
        drawn.cameraHeading = heading(drone.cameraHeading ?? drone.heading, next.cameraHeading ?? next.heading);
      }
      // Older samples can use body pitch. Without either recorded endpoint,
      // keep the existing mount fallback instead of inventing a camera angle.
      const pitchA = drone.cameraPitch ?? drone.pitch, pitchB = next.cameraPitch ?? next.pitch;
      if ((drone.cameraPitch !== undefined || next.cameraPitch !== undefined) && pitchA !== undefined && pitchB !== undefined) {
        drawn.cameraPitch = mix(pitchA, pitchB);
      }
      return drawn;
    }),
    towerHeadings: a.towerHeadings?.map((value, i) => heading(value, b.towerHeadings?.[i] ?? value)),
    towerPitches: a.towerPitches?.map((value, i) => mix(value, b.towerPitches?.[i] ?? value)),
  };
}

/** Camera frustum intersected with the sea plane, before terrain occlusion.
 * Far clipping is optical-axis depth, not a circular distance guarantee. */
export function cameraFootprint(pose: XY & { z: number; heading: number; pitch?: number }, sensor: ArcticSensor, halfM = 3250): XY[] {
  const heading = pose.heading * Math.PI / 180, pitch = (pose.pitch ?? sensor.pitchDeg) * Math.PI / 180;
  const horizontal = Math.tan(sensor.hfovDeg * Math.PI / 360), vertical = Math.tan(sensor.vfovDeg * Math.PI / 360);
  const coordinates = (p: XY) => {
    const dx = p.x - pose.x, dy = p.y - pose.y, dz = 1.5 - pose.z;
    const axial = dx * Math.sin(heading) + dy * Math.cos(heading);
    return { forward: axial * Math.cos(pitch) + dz * Math.sin(pitch), side: dx * Math.cos(heading) - dy * Math.sin(heading), up: dz * Math.cos(pitch) - axial * Math.sin(pitch) };
  };
  const planes = [
    (p: XY) => coordinates(p).forward - (sensor.nearClipM ?? .1),
    (p: XY) => sensor.farClipM - coordinates(p).forward,
    (p: XY) => coordinates(p).forward * horizontal - coordinates(p).side,
    (p: XY) => coordinates(p).forward * horizontal + coordinates(p).side,
    (p: XY) => coordinates(p).forward * vertical - coordinates(p).up,
    (p: XY) => coordinates(p).forward * vertical + coordinates(p).up,
  ];
  let polygon = [{ x: -halfM, y: -halfM }, { x: halfM, y: -halfM }, { x: halfM, y: halfM }, { x: -halfM, y: halfM }];
  for (const distance of planes) {
    const clipped: XY[] = [];
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i], b = polygon[(i + 1) % polygon.length], da = distance(a), db = distance(b);
      if (da >= 0) clipped.push(a);
      if ((da >= 0) !== (db >= 0)) { const t = da / (da - db); clipped.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) }); }
    }
    polygon = clipped;
  }
  return polygon;
}
