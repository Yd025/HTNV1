import { useEffect, useId, useMemo, useState } from "react";
import {
  assetLabel, drawFrame, isQuad, nearestSource,
  type ArcticProfile, type GraphCandidate, type GraphFrame, type GraphJob,
  type GraphReplay, type GraphTower, type GraphTrainingPreview, type XY,
} from "../lib/graphExperiment";
import LiveMissionInsights from "./LiveMissionInsights";
import TrainingMissionViews from "./TrainingMissionViews";
import mapStyles from "./GraphTrainingDemo.module.css";
import styles from "./TrainingRunMonitor.module.css";

const MAP = { x: 24, y: 24, span: 552 };
const percent = (value: number | undefined) => value === undefined ? "Awaiting results" : `${value.toFixed(1)}%`;
const number = (value: number | null | undefined, suffix = "") => value == null ? "—" : `${value.toFixed(1)}${suffix}`;
const color = (id: string) => id.includes("tower") ? "var(--status)" : isQuad(id) ? "var(--warning)" : "var(--text)";
const policyLabel = (policy: string | undefined) => policy === "baseline" ? "Reference strategy" : policy === "untrained" ? "Default strategy" : "Selected strategy";

function sweepPath(radius: number, fov: number) {
  const angle = fov * Math.PI / 360, x = Math.sin(angle) * radius, y = -Math.cos(angle) * radius;
  return `M0,0 L${-x},${y} A${radius},${radius} 0 ${fov > 180 ? 1 : 0} 1 ${x},${y} Z`;
}

function TrainingMap({ profile, towers, replay, frame, elapsedS = 0 }: {
  profile: ArcticProfile; towers: GraphTower[]; replay?: GraphReplay; frame?: GraphFrame; elapsedS?: number;
}) {
  const unique = useId().replace(/:/g, "");
  const halfM = profile.grid.halfM, widthM = halfM * 2;
  const project = (p: XY) => ({ x: MAP.x + (p.x + halfM) / widthM * MAP.span, y: MAP.y + (halfM - p.y) / widthM * MAP.span });
  const points = (route: XY[]) => route.map(point => { const p = project(point); return `${p.x},${p.y}`; }).join(" ");
  const observedFrames = useMemo(() => replay?.frames.filter(frame => frame.t <= elapsedS) ?? [], [replay, elapsedS]);
  const recordedFrame = observedFrames.at(-1);
  const drones = frame?.drones ?? [];
  const sources = [...towers, ...drones];
  const reported = frame ? nearestSource(frame, towers, true) : null;
  const guide = reported ?? (frame ? nearestSource(frame, towers, false) : null);
  const boat = frame ? project(frame.boat) : null;
  const guideEnd = reported && frame?.phase && frame.estimate ? project(frame.estimate) : boat;
  const sensorFor = (id: string) => profile.sensors[id.includes("tower") ? "tower" : isQuad(id) ? "quad" : "plane"];
  return <div className={styles.mapArea}>
    <div className={styles.mapHeading}><span>Fort Ross · {(widthM / 1000).toFixed(1)} × {(widthM / 1000).toFixed(1)} km</span><span>{frame ? `${Math.floor(elapsedS)} s · recorded example` : "Proposed tower positions"}</span></div>
    <svg className={styles.map} viewBox="0 0 600 616" role="img" aria-label={frame ? "Training example showing the candidate towers, both drone routes, random boat route, and nearest reporting sensor" : "Proposed tower placement on the Fort Ross terrain while its first mission is calculated"}>
      <defs>
        <clipPath id={`${unique}-map`}><rect x={MAP.x} y={MAP.y} width={MAP.span} height={MAP.span} /></clipPath>
        {sources.map(source => <radialGradient key={source.id} id={`${unique}-sweep-${source.id}`}><stop offset="0%" stopColor={color(source.id)} stopOpacity=".03" /><stop offset="60%" stopColor={color(source.id)} stopOpacity=".22" /><stop offset="100%" stopColor={color(source.id)} stopOpacity=".03" /></radialGradient>)}
      </defs>
      <g clipPath={`url(#${unique}-map)`}>
        <rect x={MAP.x} y={MAP.y} width={MAP.span} height={MAP.span} fill="#162331" />
        <image href="/experiments/fort-ross-terrain.png" x={MAP.x} y={MAP.y} width={MAP.span} height={MAP.span} />
        {sources.map((source, i) => {
          const p = project(source), sensor = sensorFor(source.id);
          if (!sensor) return null;
          const range = sensor.farClipM / widthM * MAP.span;
          const heading = source.id.includes("tower") ? frame?.towerHeadings?.[i] ?? source.heading : (source as { cameraHeading?: number }).cameraHeading ?? source.heading;
          return <g key={`${source.id}-view`} style={{ color: color(source.id) }}>
            {source.id.includes("tower") && <circle cx={p.x} cy={p.y} r={range} className={mapStyles.range} />}
            <g transform={`translate(${p.x} ${p.y}) rotate(${heading})`}>
              <path d={sweepPath(range, sensor.hfovDeg)} fill={`url(#${unique}-sweep-${source.id})`} />
              <path d={sweepPath(range, sensor.hfovDeg)} className={mapStyles.sweepEdge} />
              <line x1="0" y1="-15" x2="0" y2={-range} className={mapStyles.sweepRay} />
            </g>
          </g>;
        })}
        {frame && <polyline points={points(observedFrames.map(item => item.boat))} className={mapStyles.boatTrail} />}
        {drones.map(drone => <g key={`${drone.id}-route`} style={{ color: color(drone.id) }}>
          <polyline points={points(observedFrames.flatMap(item => { const match = item.drones.find(candidate => candidate.id === drone.id); return match ? [match] : []; }))} className={mapStyles.droneTrail} />
          {drone.path && <polyline points={points([drone, ...drone.path.slice(1)])} className={mapStyles.plannedPath} />}
        </g>)}
        {guide && guideEnd && <g className={reported ? mapStyles.sightLine : mapStyles.guideLine}><line x1={project(guide.source).x} y1={project(guide.source).y} x2={guideEnd.x} y2={guideEnd.y} /><text x={(project(guide.source).x + guideEnd.x) / 2} y={(project(guide.source).y + guideEnd.y) / 2 - 10}>{Math.round(guide.distanceM)} m</text></g>}
        {towers.map((tower, i) => { const p = project(tower); return <g key={tower.id} transform={`translate(${p.x} ${p.y})`} className={mapStyles.tower}><circle r="13" /><path d="M-6 7 L0-9 L6 7 M-4 3 H4 M-2-2 H2" /><text x="18" y="4">T{i + 1}</text></g>; })}
        {drones.map(drone => { const p = project(drone); return <g key={drone.id} transform={`translate(${p.x} ${p.y})`} className={mapStyles.drone} style={{ color: color(drone.id) }}><circle r="12" /><g transform={`rotate(${drone.heading})`}>{isQuad(drone.id) ? <path d="M-6-6 L6 6 M-6 6 L6-6 M-7-8 H-4 M4-8 H7 M-7 8 H-4 M4 8 H7" /> : <path d="M0-10 L3-1 L10 4 L10 6 L2 3 L2 8 L5 10 L-5 10 L-2 8 L-2 3 L-10 6 L-10 4 L-3-1 Z" />}</g><text x="17" y="5">{isQuad(drone.id) ? "Q" : "F"}</text></g>; })}
        {boat && <g transform={`translate(${boat.x} ${boat.y})`} className={mapStyles.boat}><circle r="16" /><path d="M0-11 L6-4 L5 10 L-5 10 L-6-4 Z" /><text x="20" y="5">Boat</text></g>}
        {recordedFrame?.estimate && <g transform={`translate(${project(recordedFrame.estimate).x} ${project(recordedFrame.estimate).y})`} className={mapStyles.estimate}><path d="M-6 0 H6 M0-6 V6" /></g>}
      </g>
      <rect x={MAP.x} y={MAP.y} width={MAP.span} height={MAP.span} className={mapStyles.mapBorder} />
      <g className={mapStyles.scale}><path d={`M42 557 H${42 + MAP.span * 1000 / widthM} M42 553 V561 M${42 + MAP.span * 1000 / widthM} 553 V561`} /><text x="42" y="546">1 km</text></g>
      <text x="300" y="600" textAnchor="middle" className={mapStyles.axisText}>−X ← projected Arctic grid → +X · +Y is up</text>
    </svg>
    {frame && <p className={styles.reportLine}>{reported ? `${assetLabel(reported.source.id)} supplied an accepted contact report at the ${recordedFrame?.t ?? 0} s sample.` : `No sensor report at ${recordedFrame?.t ?? 0} s. Dashed line shows the nearest sensor.`}</p>}
    <p className={styles.mapNote}>Sweeps show scan direction; rings are a distance guide. Detection uses camera geometry and terrain. Boat truth is visible here for evaluation only.</p>
  </div>;
}

function RecordedExample({ profile, preview, freshnessS, stepS }: {
  profile: ArcticProfile; preview: GraphTrainingPreview; freshnessS: number; stepS: number;
}) {
  const [elapsedS, setElapsedS] = useState(0);
  const [running, setRunning] = useState(true);
  const [reducedMotion, setReducedMotion] = useState(false);
  const { replay } = preview;
  const horizonS = replay.frames.at(-1)?.t ?? 0;
  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => { setReducedMotion(preference.matches); if (preference.matches) setRunning(false); };
    update(); preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (!running || horizonS <= 0) return;
    let last: number | null = null, request = 0;
    const tick = (now: number) => {
      if (last === null || document.hidden) last = now;
      if (now - last >= 1000 / 30) {
        const delta = Math.min(.15, (now - last) / 1000) * 32;
        last = now; setElapsedS(value => Math.min(horizonS, value + delta));
      }
      request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(request);
  }, [running, horizonS]);
  useEffect(() => { if (elapsedS >= horizonS) setRunning(false); }, [elapsedS, horizonS]);
  const onToggle = () => { if (elapsedS >= horizonS) setElapsedS(0); setRunning(value => !value); };
  const onSeek = (seconds: number) => { setRunning(false); setElapsedS(seconds); };
  const frame = useMemo(() => reducedMotion
    ? replay.frames.filter(sample => sample.t <= elapsedS).at(-1) ?? replay.frames[0]
    : drawFrame(replay, elapsedS), [replay, elapsedS, reducedMotion]);
  const towers = replay.towers ?? [];
  return <>
    <div className={styles.recordedViews}>
      <TrainingMap profile={profile} towers={towers} replay={replay} frame={frame} elapsedS={elapsedS} />
      <TrainingMissionViews surface="overview" profile={profile} frame={frame} frames={replay.frames} towers={towers} elapsedS={elapsedS} running={running && !reducedMotion} pending={false} />
    </div>
    <div className={styles.exampleStats}>
      <div className={styles.exampleLabel}><strong>Recorded example · training continues</strong><span>Mission {preview.episodeIndex + 1} of {preview.episodeTotal} · seed {replay.seed} · playback at 32×</span><p>The map, 3D lab, cameras and charts share this recorded mission and playback time. Placement results include every completed mission.</p></div>
      <LiveMissionInsights replay={replay} elapsedS={elapsedS} horizonS={horizonS} stepS={stepS} freshnessS={freshnessS} running={running} pending={false} onToggle={onToggle} onSeek={onSeek} />
    </div>
  </>;
}

export default function TrainingRunMonitor({ profile, progress, inspectedCandidate, onFollow, freshnessS = 10, stepS = 5 }: {
  profile: ArcticProfile; progress: GraphJob["progress"]; inspectedCandidate?: GraphCandidate | null;
  onFollow: () => void; freshnessS?: number; stepS?: number;
}) {
  const history = progress?.history ?? [];
  const preview = inspectedCandidate ? inspectedCandidate.preview : progress?.preview;
  const validPreview = preview?.replay.frames.length ? preview : undefined;
  const candidateIndex = inspectedCandidate?.index ?? progress?.activeCandidate?.index ?? validPreview?.candidateIndex;
  const towers = inspectedCandidate?.towers ?? validPreview?.replay.towers ?? progress?.activeCandidate?.towers ?? [];
  const flightPolicy = inspectedCandidate?.flightPolicy ?? validPreview?.replay.flightPolicy ?? progress?.activeCandidate?.flightPolicy;
  const phase = progress?.phase;
  const testing = !inspectedCandidate && phase === "test";
  const metrics = inspectedCandidate?.train ?? (testing ? progress?.partialMetrics?.[progress?.evaluatingPolicy as "baseline" | "untrained" | "trained"] : progress?.candidateMetrics);
  const completed = inspectedCandidate ? inspectedCandidate.train.episodes : testing ? metrics?.episodes : progress?.candidateCompleted;
  const total = inspectedCandidate ? inspectedCandidate.train.episodes : testing ? validPreview?.episodeTotal : progress?.candidateEpisodes;
  const best = progress?.bestCandidate == null ? undefined : history.find(candidate => candidate.index === progress.bestCandidate);
  const selectionFinished = phase === "test";
  const bestMetrics = selectionFinished ? best?.validation : best?.train;
  const currentTitle = testing ? policyLabel(progress?.evaluatingPolicy) : candidateIndex == null ? "Preparing the next placement" : `${inspectedCandidate ? "Inspecting" : "Trying"} placement ${candidateIndex + 1}`;
  const phaseLabel = inspectedCandidate ? "Completed training candidate" : testing ? "Untouched test missions" : phase === "validation" ? "Validation missions" : "Training missions";
  return <section className={`${styles.monitor} ${validPreview ? styles.monitorWithReplay : ""}`} aria-label="Training placement monitor">
    <header className={styles.header}><div><h3>{currentTitle}</h3><p>{phaseLabel} · {inspectedCandidate ? "Inspect a finished candidate while the next placement continues training." : "Tower positions appear as each candidate starts. A measured example follows its first completed mission."}</p></div>{inspectedCandidate && <button onClick={onFollow}>Follow current training</button>}</header>
    <div className={styles.output}>
      <div className={styles.resultHeading}><h4>{currentTitle}</h4><p role="status">{phaseLabel}{completed !== undefined ? ` · ${completed}${total ? ` / ${total}` : ""} completed` : " · awaiting results"}</p></div>
      <dl className={styles.measurements}><div><dt>Boats detected</dt><dd>{percent(metrics?.detectionRate)}</dd></div><div><dt>Mean capped delay</dt><dd>{number(metrics?.meanCappedS, " s")}</dd></div><div><dt>Water observed</dt><dd>{percent(metrics?.coveragePct)}</dd></div><div><dt>Tracking custody</dt><dd>{percent(metrics?.custodyPct)}</dd></div></dl>
      {flightPolicy && <><h4>Candidate flight policy</h4><dl className={styles.measurements}><div><dt>Sweep spacing</dt><dd>{number(flightPolicy.laneSpacingM, " m")}</dd></div><div><dt>Patrol offset</dt><dd>{number(flightPolicy.routePhase * 100, "%")}</dd></div><div><dt>Quad search radius</dt><dd>{number(flightPolicy.quadSearchRadiusM, " m")}</dd></div><div><dt>Tracking lead</dt><dd>{number(flightPolicy.lookaheadS, " s")}</dd></div><div><dt>Support distance</dt><dd>{number(flightPolicy.supportOffsetM, " m")}</dd></div><div><dt>Reacquisition width</dt><dd>{number(flightPolicy.reacquireWidthM, " m")}</dd></div><div><dt>Longest contact gap</dt><dd>{number(metrics?.longestGapS, " s")}</dd></div><div><dt>Aircraft travel</dt><dd>{number(metrics?.distanceM, " m")}</dd></div></dl></>}
      <div className={styles.positions}><table aria-label="Candidate tower positions"><caption>Proposed tower coordinates · projected world metres</caption><thead><tr><th scope="col">Tower</th><th scope="col">X</th><th scope="col">Y</th><th scope="col">Camera height</th></tr></thead><tbody>{towers.length ? towers.map(tower => <tr key={tower.id}><th scope="row">{assetLabel(tower.id)}</th><td>{Math.round(tower.x).toLocaleString()}</td><td>{Math.round(tower.y).toLocaleString()}</td><td>{number(tower.z, " m")}</td></tr>) : <tr><td colSpan={4}>The next candidate will appear here when its positions are proposed.</td></tr>}</tbody></table><p>Camera height is world Z, including terrain elevation.</p></div>
      <p className={styles.best}>{best ? <>{selectionFinished ? "Validation-selected placement:" : "Best completed training candidate:"} <strong>placement {best.index + 1}</strong>{bestMetrics && <> · {percent(bestMetrics.detectionRate)} found · {number(bestMetrics.meanCappedS, " s")} capped delay on {selectionFinished ? "validation" : "training"} missions.</>}{!selectionFinished && " Validation chooses the final model."}</> : "Best-so-far comparison starts after the first candidate finishes its training missions."}</p>
      <p className={styles.metricNote}>Aggregate results use only completed missions; misses count at the mission deadline. Each placement is tested with random boat routes.</p>
    </div>
    {validPreview ? <RecordedExample key={validPreview.id} profile={profile} preview={validPreview} freshnessS={freshnessS} stepS={stepS} /> : <><TrainingMap profile={profile} towers={towers} /><p className={styles.waiting}>{inspectedCandidate ? "This earlier candidate has no recorded example. New training runs publish a mission example as soon as it is measured." : towers.length ? "Calculating the first mission for these positions. Boat and drone paths appear as soon as that mission finishes." : "Learning boat movement before proposing the first tower placement…"}</p></>}
  </section>;
}
