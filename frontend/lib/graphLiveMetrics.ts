import type { GraphReplay, MissionEvent, XY } from "./graphExperiment";

/** Mission facts from the observed prefix; never read the final evaluation. */
export function missionStatusAt(replay: GraphReplay, elapsedS: number) {
  validateTime(elapsedS, "elapsedS");
  const prefix = replay.frames.filter(frame => Number.isFinite(frame.t) && frame.t >= 0 && frame.t <= elapsedS).sort((a, b) => a.t - b.t);
  const frame = prefix.at(-1);
  const events: MissionEvent[] = [];
  const seen = new Set<string>();
  for (const sample of prefix) for (const event of sample.events ?? []) {
    if (!Number.isFinite(event.t) || event.t < 0 || event.t > sample.t) continue;
    const key = JSON.stringify([event.type, event.t, event.source, event.receivers]);
    if (!seen.has(key)) { seen.add(key); events.push(event); }
  }
  return { frame, events, towerConfirmed: frame?.towerConfirmed ?? false, handoffConfirmed: frame?.handoffConfirmed ?? false };
}

export interface LiveMetrics {
  observedThroughS: number;
  samples: number;
  detectedAt: number | null;
  detected: boolean;
  coveragePct: number;
  custodyPct: number;
  rmseM: number | null;
  estimateAvailabilityPct: number;
  distanceM: number;
  handoffs: number;
  bySource: Record<string, number>;
  postTowerCustodyPct: number | null;
}

export interface LiveMetricPoint {
  t: number;
  coveragePct: number;
  custodyPct: number;
  estimateAvailabilityPct: number;
  rmseM: number | null;
  distanceM: number;
}

function validPoint(value: XY | null | undefined): value is XY {
  return !!value && Number.isFinite(value.x) && Number.isFinite(value.y);
}

function validateTime(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be finite and nonnegative`);
}

/**
 * One pass over the observed prefix. Final replay scores, future detections and
 * future asset poses are deliberately never read. No shared cache can carry a
 * previous placement's statistics into a new replay or a rewind.
 */
function scan(replay: GraphReplay, elapsedS: number, freshnessS: number, withSeries: boolean) {
  validateTime(elapsedS, "elapsedS");
  validateTime(freshnessS, "freshnessS");
  const frames = replay.frames.filter(frame => Number.isFinite(frame.t) && frame.t >= 0 && frame.t <= elapsedS)
    .sort((a, b) => a.t - b.t);
  const bySource: Record<string, number> = Object.create(null);
  // Tower identities belong to the static layout, not to future observations.
  for (const tower of replay.towers ?? []) bySource[tower.id] = 0;
  let samples = 0;
  let detectedAt: number | null = null;
  let observedThroughS = 0;
  let coveragePct = 0;
  let lastObservationS: number | null = null;
  let lastReportingSource: string | null = null;
  let custodySamples = 0;
  let estimateSamples = 0;
  let postTowerSamples = 0, postTowerCustodySamples = 0;
  let errorSamples = 0;
  let squaredError = 0;
  let distanceM = 0;
  let handoffs = 0;
  let previousDrones = new Map<string, XY>();
  const series: LiveMetricPoint[] = [];

  const snapshot = (): LiveMetrics => ({
    observedThroughS,
    samples,
    detectedAt,
    detected: detectedAt !== null,
    coveragePct,
    custodyPct: samples ? custodySamples / samples * 100 : 0,
    rmseM: errorSamples ? Math.sqrt(squaredError / errorSamples) : null,
    estimateAvailabilityPct: samples ? estimateSamples / samples * 100 : 0,
    distanceM,
    handoffs,
    bySource: { ...bySource },
    postTowerCustodyPct: postTowerSamples ? postTowerCustodySamples / postTowerSamples * 100 : null,
  });

  for (const frame of frames) {
    samples += 1;
    observedThroughS = frame.t;
    if (Number.isFinite(frame.coveragePct)) coveragePct = Math.max(0, Math.min(100, frame.coveragePct!));
    const currentDrones = new Map<string, XY>();
    for (const drone of frame.drones) {
      if (!(drone.id in bySource)) bySource[drone.id] = 0;
      if (!validPoint(drone)) continue;
      const previous = previousDrones.get(drone.id);
      if (previous) distanceM += Math.hypot(drone.x - previous.x, drone.y - previous.y);
      currentDrones.set(drone.id, { x: drone.x, y: drone.y });
    }
    // Do not invent a straight transit across frames with a missing aircraft pose.
    previousDrones = currentDrones;
    const sources = new Set(frame.sources.filter(source => typeof source === "string" && source.length > 0));
    const towerMission = frame.phase !== undefined;
    if (towerMission && frame.targetConfirmed && detectedAt === null) detectedAt = frame.t;
    if (sources.size) {
      if (!towerMission && detectedAt === null) detectedAt = frame.t;
      lastObservationS = frame.t;
      const reports = frame.observations?.map(observation => observation.source) ?? [...sources];
      for (const source of reports) bySource[source] = (bySource[source] ?? 0) + 1;
      // The backend supplies the chosen reporting source. Missing source metadata
      // cannot justify inferring a handoff from source-array ordering.
      if (!towerMission && frame.trackingSource && sources.has(frame.trackingSource)) {
        if (lastReportingSource !== null && frame.trackingSource !== lastReportingSource) handoffs += 1;
        lastReportingSource = frame.trackingSource;
      }
    }
    const legacyFresh = lastObservationS !== null && frame.t - lastObservationS <= freshnessS && validPoint(frame.estimate);
    if (towerMission) {
      const droneFresh = frame.targetCustody ?? false;
      custodySamples += Number(droneFresh);
      if (frame.targetConfirmed && frame.towerVisible === false) { postTowerSamples += 1; postTowerCustodySamples += Number(droneFresh); }
      handoffs = frame.targetHandoffConfirmed ? 1 : 0;
    } else custodySamples += Number(legacyFresh);
    if (validPoint(frame.estimate) && (towerMission || legacyFresh)) {
      estimateSamples += 1;
      if (validPoint(frame.boat)) {
        squaredError += (frame.estimate.x - frame.boat.x) ** 2 + (frame.estimate.y - frame.boat.y) ** 2;
        errorSamples += 1;
      }
    }
    if (withSeries) {
      const current = snapshot();
      series.push({ t: frame.t, coveragePct: current.coveragePct, custodyPct: current.custodyPct,
        estimateAvailabilityPct: current.estimateAvailabilityPct, rmseM: current.rmseM, distanceM: current.distanceM });
    }
  }
  return { metrics: snapshot(), series };
}

/** Current statistics through the last recorded frame at or before elapsedS. */
export function computeLiveMetrics(replay: GraphReplay, elapsedS: number, freshnessS = 10): LiveMetrics {
  return scan(replay, elapsedS, freshnessS, false).metrics;
}

/** Prefix-only chart points; an eventual miss or hit cannot alter earlier points. */
export function liveSeries(replay: GraphReplay, elapsedS: number, freshnessS = 10): LiveMetricPoint[] {
  return scan(replay, elapsedS, freshnessS, true).series;
}
