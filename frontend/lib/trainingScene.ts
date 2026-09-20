import type { ArcticProfile, ArcticSensor, GraphFrame, GraphTower, XY } from "./graphExperiment";

export interface TrainingSensorPose extends XY {
  id: string;
  kind: "tower" | "quad" | "plane";
  z: number;
  heading: number;
  pitch: number;
  sensor: ArcticSensor;
}

/** Replay XY are projected world axes, not geographic north/east. */
export function scenePosition(point: XY & { z?: number }): [number, number, number] {
  return [point.x, point.z ?? 0, -point.y];
}

/** Clockwise from world +Y; a negative pitch looks below the horizon. */
export function sensorDirection(heading: number, pitch: number): [number, number, number] {
  const yaw = heading * Math.PI / 180, tilt = pitch * Math.PI / 180;
  return [Math.sin(yaw) * Math.cos(tilt), Math.sin(tilt), -Math.cos(yaw) * Math.cos(tilt)];
}

export function sensorAspect(sensor: ArcticSensor): number {
  return sensor.width && sensor.height ? sensor.width / sensor.height
    : Math.tan(sensor.hfovDeg * Math.PI / 360) / Math.tan(sensor.vfovDeg * Math.PI / 360);
}

/** Normalized image coordinates (top left = 0,0), clipped by the recorded optics. */
export function projectSensorPoint(pose: TrainingSensorPose, point: XY & { z?: number }): { x: number; y: number; depthM: number } | null {
  const heading = pose.heading * Math.PI / 180, pitch = pose.pitch * Math.PI / 180;
  const dx = point.x - pose.x, dy = point.y - pose.y, dz = (point.z ?? 1.5) - pose.z;
  const axial = dx * Math.sin(heading) + dy * Math.cos(heading);
  const depthM = axial * Math.cos(pitch) + dz * Math.sin(pitch);
  const side = dx * Math.cos(heading) - dy * Math.sin(heading);
  const up = dz * Math.cos(pitch) - axial * Math.sin(pitch);
  const horizontal = side / (depthM * Math.tan(pose.sensor.hfovDeg * Math.PI / 360));
  const vertical = up / (depthM * Math.tan(pose.sensor.vfovDeg * Math.PI / 360));
  if (![depthM, horizontal, vertical].every(Number.isFinite) || depthM < (pose.sensor.nearClipM ?? .05)
    || depthM > pose.sensor.farClipM || Math.abs(horizontal) > 1 || Math.abs(vertical) > 1) return null;
  return { x: (horizontal + 1) / 2, y: (1 - vertical) / 2, depthM };
}

/** Locate only this sensor's newest accepted measurement; never substitute boat truth. */
export function acceptedSensorReport(frame: GraphFrame, pose: TrainingSensorPose) {
  const report = frame.observations?.filter(observation => observation.source === pose.id && observation.accepted)
    .sort((a, b) => b.timestamp - a.timestamp)[0];
  if (!report) return null;
  const projection = projectSensorPoint(pose, report);
  return projection ? { ...projection, timestamp: report.timestamp } : null;
}

/** Recorded optical poses only. The boat position never steers a sensor camera. */
export function sensorPose(profile: ArcticProfile, frame: GraphFrame, towers: GraphTower[], id: string): TrainingSensorPose | null {
  const towerIndex = towers.findIndex(tower => tower.id === id);
  const asset = towerIndex >= 0 ? towers[towerIndex] : frame.drones.find(drone => drone.id === id);
  if (!asset) return null;
  const kind = towerIndex >= 0 ? "tower" : /quad|copter/.test(id) ? "quad" : "plane";
  const sensor = profile.sensors[kind];
  if (!sensor) return null;
  const drone = towerIndex < 0 ? frame.drones.find(item => item.id === id) : undefined;
  return {
    id, kind, x: asset.x, y: asset.y, z: asset.z, sensor,
    heading: towerIndex >= 0 ? frame.towerHeadings?.[towerIndex] ?? asset.heading : drone?.cameraHeading ?? asset.heading,
    pitch: towerIndex >= 0 ? frame.towerPitches?.[towerIndex] ?? sensor.pitchDeg : drone?.cameraPitch ?? drone?.pitch ?? sensor.pitchDeg,
  };
}

/** Bilinear height on the same sampled grid used by the mission overview. */
export function terrainHeight(profile: ArcticProfile, point: XY): number {
  const { size, halfM, cellM, elevations } = profile.grid;
  const x = Math.max(0, Math.min(size - 1, (point.x + halfM) / cellM));
  const y = Math.max(0, Math.min(size - 1, (point.y + halfM) / cellM));
  const left = Math.floor(x), bottom = Math.floor(y), right = Math.min(size - 1, left + 1), top = Math.min(size - 1, bottom + 1);
  const a = elevations[bottom * size + left], b = elevations[bottom * size + right];
  const c = elevations[top * size + left], d = elevations[top * size + right];
  return (a + (b - a) * (x - left)) * (1 - (y - bottom)) + (c + (d - c) * (x - left)) * (y - bottom);
}
