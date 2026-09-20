import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from "react";
import { algorithmLabel, assetLabel, cameraFootprint, drawFrame, gridPoint, isQuad, isMissionReport, nearestCell, nearestSource, type ArcticProfile, type FlightPolicy, type GraphAlgorithm, type GraphCandidate, type GraphJob, type GraphMetrics, type GraphReplay, type GraphReport, type GraphTower, type XY } from "../lib/graphExperiment";
import LiveMissionInsights from "./LiveMissionInsights";
import TrainingRunMonitor from "./TrainingRunMonitor";
import MissionSequence from "./MissionSequence";
import TrainingMissionViews from "./TrainingMissionViews";
import styles from "./GraphTrainingDemo.module.css";

const INITIAL_SEED = 190926;
const MAP = { x: 120, y: 30, span: 530, half: 3250 };
const project = (p: XY) => ({ x: MAP.x + (p.x + MAP.half) / (MAP.half * 2) * MAP.span, y: MAP.y + (MAP.half - p.y) / (MAP.half * 2) * MAP.span });
const color = (id: string) => id.includes("tower") ? "var(--status)" : isQuad(id) ? "var(--warning)" : "var(--text)";
const pct = (value: number | null | undefined) => value != null && Number.isFinite(value) ? `${value.toFixed(1)}%` : "—";
const num = (value: number | null | undefined, suffix = "") => value != null && Number.isFinite(value) ? `${value.toFixed(1)}${suffix}` : "—";
function points(route: XY[]) { return route.map(p => { const q = project(p); return `${q.x},${q.y}`; }).join(" "); }
function sweepPath(radius: number, fov: number) {
  const angle = fov * Math.PI / 360, x = Math.sin(angle) * radius, y = -Math.cos(angle) * radius;
  return `M0,0 L${-x},${y} A${radius},${radius} 0 0 1 ${x},${y} Z`;
}
async function readJSON(url: string, init?: RequestInit) {
  const response = await fetch(url, { cache: "no-store", ...init });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `The experiment could not be loaded (HTTP ${response.status}).`);
  return result;
}

function Plot({ label, rows, series, xLabel, maxX }: { label: string; rows: { x: number; values: (number | null)[] }[]; series: { label: string; color: string; dash?: string }[]; xLabel: string; maxX: number }) {
  const x = (v: number) => 42 + v / Math.max(1, maxX) * 422;
  const y = (v: number) => 180 - Math.max(0, Math.min(100, v)) * 1.5;
  return <figure className={styles.plot}>
    <figcaption>{label}</figcaption>
    <svg viewBox="0 0 490 220" role="img" aria-label={label}>
      {[0, 25, 50, 75, 100].map(tick => <g key={tick}><line x1="42" x2="464" y1={y(tick)} y2={y(tick)} className={styles.chartGrid} /><text x="32" y={y(tick) + 4} textAnchor="end">{tick}%</text></g>)}
      {series.map((item, i) => <polyline key={item.label} points={rows.filter(row => row.values[i] !== null).map(row => `${x(row.x)},${y(row.values[i]!)}`).join(" ")} fill="none" stroke={item.color} strokeWidth="2.5" strokeDasharray={item.dash} />)}
      <text x="42" y="201">0</text><text x="464" y="201" textAnchor="end">{maxX}</text><text x="253" y="215" textAnchor="middle">{xLabel}</text>
    </svg>
    <div className={styles.chartLegend}>{series.map(item => <span key={item.label}><i style={{ borderColor: item.color, borderStyle: item.dash ? "dashed" : "solid" }} />{item.label}</span>)}</div>
  </figure>;
}

function MetricTable({ report }: { report: GraphReport }) {
  const coordinated = report.algorithm === "coordinated-surveillance-v1";
  const rows: { label: string; value: (m: GraphMetrics) => string; title: string }[] = [
    { label: "Confirmed boats", value: m => pct(m.detectionRate), title: "Percentage of all test missions with repeated accepted sensor observations confirming the boat under each policy." },
    { label: "Time to detection", value: m => num(m.meanCappedS, " s"), title: "Mean delay including misses at the mission deadline. Lower is better." },
    { label: "Slowest 10%", value: m => num(m.p90CappedS, " s"), title: "90th percentile capped delay, including misses." },
    { label: "Water observed", value: m => pct(m.coveragePct), title: "Mean cumulative fraction of valid water grid cells seen during a mission." },
    { label: "Tracking custody", value: m => pct(m.custodyPct), title: `Fraction of the full mission with confirmed aircraft evidence no older than ${report.protocol.freshnessS} seconds and an estimate matching evaluation truth.` },
    { label: "Longest contact gap", value: m => num(m.longestGapS, " s"), title: "Mean longest gap after first confirmed detection; undetected missions receive the full mission deadline. Lower is better." },
    { label: "All-sensor tracking", value: m => pct(m.anySensorCustodyPct), title: "Fraction of mission samples with a fresh accepted estimate matching evaluation truth, from any sensor." },
    { label: "Position error", value: m => num(m.rmseM, " m"), title: "RMSE against evaluation truth when an estimate is available. Synthetic observation noise; not camera calibration." },
    { label: "Estimate available", value: m => pct(m.estimateAvailabilityPct), title: "Fraction of mission samples with a reported position estimate." },
    { label: "Drone travel", value: m => num(m.distanceM / 1000, " km"), title: "Mean total horizontal distance traveled by the two drones." },
    { label: coordinated ? "Aircraft custody acquired" : "Confirmed drone handoff", value: m => pct(m.handoffRate), title: coordinated ? "Missions with two fresh observations from the same aircraft matching the boat, including aircraft-first acquisition." : "Missions with a true tower acquisition followed by two fresh receiving-aircraft observations matching the boat." },
    { label: "Custody outside tower view", value: m => pct(m.postTowerCustodyPct), title: "Aircraft custody after tower visibility ends, as defined in the saved protocol." },
    { label: "False confirmed cues", value: m => m.falseConfirmations == null ? "—" : String(Math.round(m.falseConfirmations * report.protocol.testEpisodes)), title: "Confirmed contacts that did not match the boat, summed across the test missions." },
  ];
  return <div className={styles.tableWrap}><table><caption>The same {report.protocol.testEpisodes} unseen missions · {report.protocol.horizonS} seconds each</caption><thead><tr><th scope="col">Measure</th><th scope="col">{coordinated ? "Tower-first baseline" : "Sweep baseline"}</th><th scope="col">{coordinated ? "Default flight policy" : "Unoptimized towers"}</th><th scope="col">{coordinated ? "Trained surveillance" : "Selected placement"}</th></tr></thead><tbody>{rows.map(row => <tr key={row.label}><th scope="row" title={row.title}>{row.label}</th><td>{row.value(report.metrics.baseline)}</td><td>{row.value(report.metrics.untrained)}</td><td>{row.value(report.metrics.trained)}</td></tr>)}</tbody></table></div>;
}

function FlightSettings({ policy }: { policy?: FlightPolicy }) {
  if (!policy) return null;
  return <dl className={styles.flightSettings} aria-label="Learned flight policy">
    <div><dt>Sweep spacing</dt><dd>{num(policy.laneSpacingM, " m")}</dd></div>
    <div><dt>Patrol offset</dt><dd>{num(policy.routePhase * 100, "%")}</dd></div>
    <div><dt>Quad search radius</dt><dd>{num(policy.quadSearchRadiusM, " m")}</dd></div>
    <div><dt>Tracking lead</dt><dd>{num(policy.lookaheadS, " s")}</dd></div>
    <div><dt>Plane support distance</dt><dd>{num(policy.supportOffsetM, " m")}</dd></div>
    <div><dt>Reacquisition width</dt><dd>{num(policy.reacquireWidthM, " m")}</dd></div>
  </dl>;
}

export default function GraphTrainingDemo({ surface = "overview" }: { surface?: "overview" | "cameras" | "lab" | null }) {
  const unique = useId().replace(/:/g, "");
  const [profile, setProfile] = useState<ArcticProfile | null>(null);
  const [report, setReport] = useState<GraphReport | null>(null);
  const [replay, setReplay] = useState<GraphReplay | null>(null);
  const [towers, setTowers] = useState<GraphTower[]>([]);
  const [playhead, setPlayhead] = useState(0);
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(8);
  const [replayIndex, setReplayIndex] = useState<number | null>(0);
  const [seed, setSeed] = useState(INITIAL_SEED);
  const [trainingAlgorithm, setTrainingAlgorithm] = useState<GraphAlgorithm>("coordinated-surveillance-v1");
  const [randomSeed, setRandomSeed] = useState(INITIAL_SEED + 900000);
  const [mode, setMode] = useState<"inspect" | "boat" | "tower0" | "tower1">("inspect");
  const [custom, setCustom] = useState(false);
  const [boatStart, setBoatStart] = useState<XY | null>(null);
  const [routeStartOverride, setRouteStartOverride] = useState<XY | null>(null);
  const [autoSequence, setAutoSequence] = useState(false);
  const [job, setJob] = useState<GraphJob | null>(null);
  const [modelJob, setModelJob] = useState<string | undefined>();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [showCones, setShowCones] = useState(true);
  const [showFootprints, setShowFootprints] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [showGraph, setShowGraph] = useState(false);
  const [selectedCandidate, setSelectedCandidate] = useState<number | null>(null);
  const [inspectedTrainingIndex, setInspectedTrainingIndex] = useState<number | null>(null);
  const trainingMonitorRef = useRef<HTMLDivElement>(null);
  const allViewsRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const mapRef = useRef<SVGSVGElement>(null);
  const busy = starting || job?.status === "running";
  const training = job?.kind === "train" && job.status === "running";
  const frameIndex = replay ? Math.max(0, replay.frames.findIndex(item => item.t > playhead) === -1 ? replay.frames.length - 1 : replay.frames.findIndex(item => item.t > playhead) - 1) : 0;
  const frame = replay?.frames[frameIndex];
  const visualFrame = useMemo(() => replay && replay.frames.length ? drawFrame(replay, reducedMotion ? frame?.t ?? 0 : playhead) : null, [replay, playhead, reducedMotion, frame?.t]);
  const history = job?.kind === "train" && job.status === "running" ? job.progress?.history ?? [] : report?.history ?? [];
  const link = visualFrame && !custom ? nearestSource(visualFrame, towers, true) : null;
  const distanceGuide = link ?? (visualFrame && !custom ? nearestSource(visualFrame, towers, false) : null);
  const firstHit = replay?.frames.find(item => item.phase ? item.targetConfirmed : item.sources.length > 0)?.t;
  const currentPoint = mode === "boat" ? boatStart ?? replay?.frames[0]?.boat : mode.startsWith("tower") ? towers[mode === "tower0" ? 0 : 1] : null;
  const currentCandidate = selectedCandidate === null ? null : history.find(candidate => candidate.index === selectedCandidate);
  const inspectedCandidate = inspectedTrainingIndex === null ? null : history.find(candidate => candidate.index === inspectedTrainingIndex) ?? null;

  function useReplay(value: GraphReplay, newTowers?: GraphTower[]) {
    setReplay(value); setTowers(value.towers ?? newTowers ?? []); setPlayhead(0); setRunning(false); setCustom(false); setBoatStart(null);
  }
  function useReport(value: GraphReport) {
    if (!isMissionReport(value)) { setNotice("An incompatible experiment was not loaded. Train an algorithm to generate current results."); return false; }
    setError(null);
    setReport(value); setSeed(value.seed); setReplayIndex(0); setSelectedCandidate(null);
    setRouteStartOverride(null); setAutoSequence(false);
    if (value.replays.length) useReplay(value.replays[0], value.trained.towers);
    return true;
  }
  useEffect(() => {
    let active = true;
    Promise.all([readJSON("/experiments/arctic-profile.json"), readJSON("/experiments/surveillance-report.json").catch(() => readJSON("/experiments/graph-report.json")), readJSON("/api/graph-experiment?latestTraining=1").catch(() => null)]).then(([terrain, results, latest]) => {
      if (!active) return; setProfile(terrain); useReport(results);
      if (latest?.id && latest.status === "running") {
        setJob(latest); setNotice("Reconnected to the training run already in progress.");
        if (Number.isInteger(latest.progress?.seed)) setSeed(latest.progress.seed);
      } else if (latest?.id && latest.status === "complete" && latest.result) {
        if (useReport(latest.result)) setModelJob(latest.id);
      }
    }).catch(cause => { if (active) setError(`The saved experiment is unavailable. ${cause.message}`); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (training) trainingMonitorRef.current?.scrollIntoView({ behavior: reducedMotion ? "instant" : "smooth", block: "start" });
  }, [training, inspectedTrainingIndex]);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(preference.matches);
    update(); preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const update = () => setExpanded(document.fullscreenElement === allViewsRef.current);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);

  useEffect(() => {
    if (!job || job.status !== "running") return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value: GraphJob = await readJSON(`/api/graph-experiment?id=${job.id}`);
        if (!active) return;
        setJob(value);
        if (value.status === "complete" && value.result) {
          if (value.kind === "train") { if (useReport(value.result as GraphReport)) { setModelJob(value.id); setNotice("Training finished. The selected tower and flight policy is shown with its untouched test results."); } }
          else { useReplay(value.result as GraphReplay, towers); setReplayIndex(null); setRunning(true); setNotice("New water-route test ready. The boat position was hidden from the search policy."); }
        } else if (value.status === "failed") {
          if (value.kind === "train" && report) useReport(report);
          setError(value.error ?? "The experiment failed. Try again.");
        }
        else timer = setTimeout(poll, 1200);
      } catch (cause) { if (active) { setError(cause instanceof Error ? cause.message : "Cannot read experiment progress."); timer = setTimeout(poll, 3000); } }
    };
    timer = setTimeout(poll, 600);
    return () => { active = false; clearTimeout(timer); };
  }, [job?.id, job?.status]);

  useEffect(() => {
    if (!running || !replay || custom) return;
    const end = replay.frames[replay.frames.length - 1].t;
    let last: number | null = null, request = 0;
    const tick = (now: number) => {
      if (last === null || document.hidden) last = now;
      if (now - last >= 1000 / 30) { const delta = Math.min(.15, (now - last) / 1000) * speed; last = now; setPlayhead(value => Math.min(end, value + delta)); }
      request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(request);
  }, [running, replay, speed, custom]);

  useEffect(() => { if (replay && playhead >= replay.frames[replay.frames.length - 1].t) setRunning(false); }, [playhead, replay]);

  useEffect(() => {
    if (!autoSequence || !report || !replay || frameIndex < replay.frames.length - 1 || replayIndex === null) return;
    const timer = setTimeout(() => {
      if (replayIndex + 1 >= report.replays.length) { setAutoSequence(false); setNotice("All saved unseen missions have finished. Scores include the misses."); return; }
      chooseReplay(replayIndex + 1); setRunning(true); setAutoSequence(true);
    }, 900);
    return () => clearTimeout(timer);
  }, [autoSequence, frameIndex, replayIndex, replay, report]);

  async function startJob(kind: "train" | "replay", random = false) {
    setError(null); setStarting(true); setRunning(false); setAutoSequence(false);
    if (kind === "train") setInspectedTrainingIndex(null);
    const nextSeed = kind === "train" ? seed : random ? (randomSeed + 7919) % 2147483647 : replay?.seed ?? randomSeed;
    if (random) setRandomSeed(nextSeed);
    const requestedStart = random ? null : boatStart ?? routeStartOverride;
    try {
      const selected = currentCandidate ?? report?.trained;
      const algorithm = kind === "train" ? trainingAlgorithm : selected?.algorithm ?? report?.algorithm ?? "tower-first-v2";
      const flightPolicy = algorithm === "coordinated-surveillance-v1" && selected?.flightPolicy ? { flightPolicy: selected.flightPolicy } : {};
      const result = await readJSON("/api/graph-experiment", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, seed: nextSeed, algorithm, ...(kind === "replay" ? { modelJob, towers, ...flightPolicy, ...(requestedStart ? { boatStart: requestedStart } : {}) } : {}) }) });
      setJob(result);
      if (kind === "replay") setRouteStartOverride(requestedStart);
      setNotice(kind === "train" ? "Training on new episodes; the test set stays separate until selection finishes." : "Simulating both drones and the towers on the water graph…");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The experiment could not start."); }
    finally { setStarting(false); }
  }
  function changePoint(point: XY) {
    if (!profile || mode === "inspect" || busy) return;
    const index = nearestCell(profile, point, mode === "boat");
    const snapped = gridPoint(profile, index);
    if (mode === "boat") setBoatStart(snapped);
    else {
      const target = mode === "tower0" ? 0 : 1;
      const other = towers[1 - target];
      if (other && Math.hypot(other.x - snapped.x, other.y - snapped.y) < 250) { setNotice("Choose land at least 250 metres from the other tower."); return; }
      setTowers(value => value.map((tower, i) => i === target ? { ...tower, ...snapped, z: profile.grid.elevations[index] + 2.7 } : tower));
    }
    setCustom(true); setRunning(false); setAutoSequence(false); setPlayhead(0); setReplayIndex(null);
    setNotice(mode === "boat" ? "Boat snapped to navigable water. Run this placement to evaluate the new route." : "Tower snapped to suitable land. Run this placement to recalculate both drone routes and tracking.");
  }
  function mapClick(event: PointerEvent<SVGSVGElement>) {
    if (mode === "inspect" || !mapRef.current) return;
    const matrix = mapRef.current.getScreenCTM();
    if (!matrix) return;
    const p = mapRef.current.createSVGPoint(); p.x = event.clientX; p.y = event.clientY;
    const local = p.matrixTransform(matrix.inverse());
    if (local.x < MAP.x || local.x > MAP.x + MAP.span || local.y < MAP.y || local.y > MAP.y + MAP.span) return;
    changePoint({ x: (local.x - MAP.x) / MAP.span * 6500 - 3250, y: 3250 - (local.y - MAP.y) / MAP.span * 6500 });
  }
  function chooseReplay(index: number) {
    if (!report || !report.replays[index]) return;
    useReplay(report.replays[index], report.trained.towers); setReplayIndex(index); setSelectedCandidate(null); setMode("inspect"); setNotice("Saved held-out mission. Towers remain fixed for this entire test.");
    setRouteStartOverride(null); setAutoSequence(false);
  }
  function chooseCandidate(candidate: GraphCandidate) {
    if (training) { setInspectedTrainingIndex(candidate.index); return; }
    setTowers(candidate.towers); setSelectedCandidate(candidate.index); setCustom(true); setRunning(false); setAutoSequence(false); setPlayhead(0); setReplayIndex(null); setBoatStart(null);
    setNotice(`Placement ${candidate.index + 1}: ${pct(candidate.train.detectionRate)} training detection. Run this placement to test it with the selected model.`);
  }
  async function expandViews() {
    try {
      if (document.fullscreenElement === allViewsRef.current) await document.exitFullscreen();
      else if (allViewsRef.current?.requestFullscreen) await allViewsRef.current.requestFullscreen();
      else setNotice("Expand the browser window to see all views at a larger size.");
    } catch { setNotice("Fullscreen is unavailable in this browser. All views continue playing together here."); }
  }

  const graphEdges = useMemo(() => profile?.grid.waterEdges ?? [], [profile]);
  // This controller stays mounted while dashboard sections change. Every view
  // consumes its one selected replay and clock, including custom placements.
  if (surface === null) return null;
  if (!report || !profile || !frame) return <section className={styles.demo} aria-label="Arctic search learning"><div className={styles.heading}><h2>Search. Support. Track.</h2><p role={error ? "alert" : "status"}>{error ?? (busy ? "Training surveillance strategies and evaluating tracking…" : notice || "Loading the terrain, trained model, and test missions…")}</p></div>{profile && <button className={styles.reload} disabled={busy} onClick={() => startJob("train")}>Train algorithm</button>}{error && <button className={styles.reload} onClick={() => window.location.reload()}>Reload experiment</button>}</section>;
  const boat = project(boatStart ?? visualFrame!.boat);
  const guideEnd = link && frame.phase && frame.estimate ? project(frame.estimate) : boat;
  const displayDrones = custom ? replay!.frames[0].drones : visualFrame!.drones;
  const sensorFor = (id: string) => profile.sensors[id.includes("tower") ? "tower" : isQuad(id) ? "quad" : "plane"];
  const trainedRate = report.metrics.trained.detectionRate;
  const handoffExample = report.replays.findIndex(trial => trial.frames.some(sample => sample.targetHandoffConfirmed && sample.targetCustody && sample.towerVisible === false && sample.phase === "drone_track"));
  const difference = trainedRate - report.metrics.baseline.detectionRate;
  const coordinated = report.algorithm === "coordinated-surveillance-v1";
  const comparisonSeries = [
    { label: coordinated ? "Tower-first" : "Sweep", color: "var(--text-muted)", dash: "4 4" },
    { label: coordinated ? "Default flights" : "Unoptimized towers", color: "var(--warning)", dash: "8 3" },
    { label: "Trained", color: "var(--status)" },
  ];
  const liveCoordinated = (job?.progress?.algorithm ?? trainingAlgorithm) === "coordinated-surveillance-v1";
  const liveComparisonSeries = [
    { label: liveCoordinated ? "Tower-first" : "Sweep", color: "var(--text-muted)", dash: "4 4" },
    { label: liveCoordinated ? "Default flights" : "Unoptimized towers", color: "var(--warning)", dash: "8 3" },
    { label: "Trained", color: "var(--status)" },
  ];
  const progress = job?.progress;
  const progressTotal = progress?.phase === "validation" ? progress.validationTotal : progress?.testTotal ?? progress?.total;
  const progressCompleted = progress?.phase === "validation" ? progress.validationCompleted : progress?.testCompleted ?? progress?.completed;
  const togglePlayback = () => { if (frameIndex >= replay!.frames.length - 1) setPlayhead(0); setAutoSequence(false); setRunning(!running); };
  const seek = (seconds: number) => { setRunning(false); setAutoSequence(false); setPlayhead(seconds); };
  const displayFrame = custom ? { ...visualFrame!, boat: boatStart ?? visualFrame!.boat, drones: displayDrones, towerHeadings: towers.map(tower => tower.heading), towerPitches: undefined, sources: [], acceptedSources: [], observations: [], estimate: null } : visualFrame!;
  const missionToolbar = <div className={styles.toolbar}>
    <button disabled={busy} onClick={() => startJob("replay", true)}>Spawn random boat</button>
    <button disabled={busy || handoffExample < 0} onClick={() => { chooseReplay(handoffExample); setRunning(true); }}>Watch handoff example</button>
    <button disabled={busy} onClick={() => chooseReplay(((replayIndex ?? -1) + 1) % report.replays.length)}>Next saved test</button>
    <button disabled={busy} aria-pressed={autoSequence} onClick={() => { if (autoSequence) { setAutoSequence(false); setRunning(false); } else { chooseReplay(0); setSpeed(32); setRunning(true); setAutoSequence(true); } }}>{autoSequence ? "Stop sequence" : "Watch all tests"}</button>
    {surface === "overview" && <button onClick={() => void expandViews()} aria-pressed={expanded}>{expanded ? "Exit expanded view" : "Expand all views"}</button>}
    <label>Mission <select aria-label="Saved test mission" disabled={busy} value={replayIndex ?? "custom"} onChange={e => chooseReplay(Number(e.target.value))}>{replayIndex === null && <option value="custom">Custom test</option>}{report.replays.map((trial, i) => <option key={trial.seed} value={i}>Test {i + 1} · seed {trial.seed}</option>)}</select></label>
  </div>;
  const transport = <div className={styles.transport}><button disabled={busy || custom} className={styles.primary} onClick={togglePlayback}>{running ? "Pause replay" : "Play mission"}</button><label className={styles.timeline}>All views · {Math.floor(playhead)} / {replay!.frames[replay!.frames.length - 1].t} s<input aria-label="Mission time" type="range" min="0" max={replay!.frames[replay!.frames.length - 1].t} step={report.protocol.stepS} value={playhead} disabled={custom || busy} onChange={event => seek(Number(event.target.value))} /></label><label>Speed<select aria-label="Replay speed" value={speed} onChange={event => setSpeed(Number(event.target.value))}>{[1, 4, 8, 16, 32].map(value => <option key={value} value={value}>{value}×</option>)}</select></label></div>;

  if (surface !== "overview" && !training) return <section className={styles.demo} aria-label="Synchronized training mission">
    <header className={styles.heading}><div><h2>{surface === "cameras" ? "Mission cameras" : "Simulation lab"}</h2><p>The same mission and timeline as Overview. Switch views at any time.</p></div><span className={styles.modelTag}>Modeled replay imagery</span></header>
    <MissionSequence frame={frame} pending={custom || busy} />
    {missionToolbar}{transport}
    <TrainingMissionViews surface={surface} profile={profile} frame={displayFrame} frames={replay!.frames} towers={towers} elapsedS={playhead} running={running && !reducedMotion} pending={custom || busy} calculating={busy} />
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
  </section>;

  return <section className={styles.demo} aria-labelledby={`${unique}-title`}>
    <header className={styles.heading}><div><h2 id={`${unique}-title`}>Search. Support. Track.</h2><p>{algorithmLabel(training ? job?.progress?.algorithm ?? trainingAlgorithm : replay?.algorithm ?? report.algorithm)} · one mission across the map, flight paths and cameras.</p></div><span className={styles.modelTag}>Offline mission training · modeled camera observations</span></header>
    {!training && <MissionSequence frame={frame} pending={custom || busy} />}
    {!training && <><div ref={allViewsRef} className={styles.viewMonitor}>{missionToolbar}{transport}<div className={styles.allViews}>
      <div className={styles.stage}>
        <div className={styles.mapTitle}><strong>2D overview</strong><span>Fort Ross · 6.5 × 6.5 km</span></div>
        <svg ref={mapRef} className={styles.map} viewBox="0 0 770 605" role="img" aria-label="Fort Ross terrain map with two towers, a quadcopter, a fixed-wing drone, and a boat. Use placement controls to edit positions." onPointerDown={mapClick}>
          <defs><clipPath id={`${unique}-map`}><rect x={MAP.x} y={MAP.y} width={MAP.span} height={MAP.span} /></clipPath>
            {[...towers, ...displayDrones].map(source => <radialGradient key={source.id} id={`${unique}-sweep-${source.id}`}><stop offset="0%" stopColor={color(source.id)} stopOpacity=".03" /><stop offset="60%" stopColor={color(source.id)} stopOpacity=".22" /><stop offset="100%" stopColor={color(source.id)} stopOpacity=".03" /></radialGradient>)}
          </defs>
          <g clipPath={`url(#${unique}-map)`}>
            <rect x={MAP.x} y={MAP.y} width={MAP.span} height={MAP.span} fill="#162331" />
            <image href="/experiments/fort-ross-terrain.png" x={MAP.x} y={MAP.y} width={MAP.span} height={MAP.span} />
            {showGraph && graphEdges.map(([from, to], i) => { const a = project(gridPoint(profile, from)), b = project(gridPoint(profile, to)); return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#d4e3e7" strokeWidth=".5" opacity=".24" />; })}
            {[...towers, ...displayDrones].map((source, i) => {
              const p = project(source), sensor = sensorFor(source.id), range = sensor?.farClipM ?? 1500;
              const heading = source.id.includes("tower") ? (!custom ? visualFrame!.towerHeadings?.[i] : undefined) ?? source.heading : (source as { cameraHeading?: number }).cameraHeading ?? source.heading;
              const pitch = source.id.includes("tower") ? (!custom ? visualFrame!.towerPitches?.[i] : undefined) ?? sensor?.pitchDeg : (source as { cameraPitch?: number; pitch?: number }).cameraPitch ?? (source as { pitch?: number }).pitch;
              const visible = !custom && (frame.acceptedSources ?? frame.sources).includes(source.id);
              return <g key={`${source.id}-view`} style={{ color: color(source.id) }}>
                {source.id.includes("tower") && <><circle cx={p.x} cy={p.y} r={range / 6500 * MAP.span} className={styles.range} /><circle cx={p.x} cy={p.y} r={range / 6500 * MAP.span / 2} className={styles.innerRange} /></>}
                {showCones && sensor && <g transform={`translate(${p.x} ${p.y}) rotate(${heading})`} className={styles.radarSweep}>
                  <path d={sweepPath(range / 6500 * MAP.span, sensor.hfovDeg)} fill={`url(#${unique}-sweep-${source.id})`} />
                  <path d={sweepPath(range / 6500 * MAP.span, sensor.hfovDeg)} className={styles.sweepEdge} />
                  <line x1="0" y1="-15" x2="0" y2={-range / 6500 * MAP.span} className={styles.sweepRay} />
                </g>}
                {showFootprints && sensor && <polygon points={points(cameraFootprint({ ...source, heading, pitch }, sensor))} className={styles.cone} />}
                {visible && <circle cx={p.x} cy={p.y} r={reducedMotion ? 24 : (18 + (playhead % 3) * 8)} className={styles.pulse} style={{ opacity: reducedMotion ? .5 : Math.max(0, .65 - (playhead % 3) * .2) }} />}
              </g>;
            })}
            {!custom && <polyline points={points(replay!.frames.slice(0, frameIndex + 1).map(value => value.boat))} className={styles.boatTrail} />}
            {!custom && displayDrones.map(drone => <g key={`${drone.id}-path`} style={{ color: color(drone.id) }}><polyline points={points(replay!.frames.slice(0, frameIndex + 1).flatMap(value => { const item = value.drones.find(d => d.id === drone.id); return item ? [item] : []; }))} className={styles.droneTrail} />{drone.path && <polyline points={points([drone, ...drone.path.slice(1)])} className={styles.plannedPath} />}</g>)}
            {distanceGuide && <g className={link ? styles.sightLine : styles.guideLine}><line x1={project(distanceGuide.source).x} y1={project(distanceGuide.source).y} x2={guideEnd.x} y2={guideEnd.y} /><text x={(project(distanceGuide.source).x + guideEnd.x) / 2} y={(project(distanceGuide.source).y + guideEnd.y) / 2 - 9}>{Math.round(distanceGuide.distanceM)} m</text></g>}
            {towers.map((tower, i) => { const p = project(tower); return <g key={tower.id} transform={`translate(${p.x} ${p.y})`} className={styles.tower}><circle r="13" /><path d="M-6 7 L0-9 L6 7 M-4 3 H4 M-2-2 H2" /><text x="18" y="4">T{i + 1}</text></g>; })}
            {displayDrones.map(drone => { const p = project(drone); return <g key={drone.id} transform={`translate(${p.x} ${p.y})`} className={styles.drone} style={{ color: color(drone.id) }}><circle r="12" /><g transform={`rotate(${drone.heading})`}>{isQuad(drone.id) ? <path d="M-6-6 L6 6 M-6 6 L6-6 M-7-8 H-4 M4-8 H7 M-7 8 H-4 M4 8 H7" /> : <path d="M0-10 L3-1 L10 4 L10 6 L2 3 L2 8 L5 10 L-5 10 L-2 8 L-2 3 L-10 6 L-10 4 L-3-1 Z" />}</g><text x="17" y="5">{isQuad(drone.id) ? "Q" : "F"}</text></g>; })}
            <g transform={`translate(${boat.x} ${boat.y})`} className={styles.boat}><circle r="16" /><path d="M0-11 L6-4 L5 10 L-5 10 L-6-4 Z" /><text x="20" y="5">Boat</text></g>
            {!custom && frame.estimate && <g transform={`translate(${project(frame.estimate).x} ${project(frame.estimate).y})`} className={styles.estimate}><path d="M-6 0 H6 M0-6 V6" /></g>}
          </g>
          <rect x={MAP.x} y={MAP.y} width={MAP.span} height={MAP.span} className={styles.mapBorder} />
          <g className={styles.axisText}><text x="385" y="20" textAnchor="middle">+Y · projected Arctic grid</text><text x="385" y="586" textAnchor="middle">−X ← 6,500 metres → +X</text><text x="670" y="290">+Y</text><path d="M687 280 V245 M681 252 L687 245 L693 252" /></g>
          <g className={styles.scale}><path d="M140 535 H221 M140 531 V539 M221 531 V539" /><text x="140" y="525">1 km</text></g>
        </svg>
        <div className={styles.mapLegend}><span><i className={styles.solidLegend} />Accepted contact report · {frame.t} s sample</span><span><i className={styles.dashLegend} />Distance guide when unseen</span><span><i className={styles.routeLegend} />Planned drone route</span></div>
        <p className={styles.mapNote}>Camera scans use terrain visibility and a modeled sensor response. Rings are distance references. Boat position and distance guides are evaluation truth; the controller only receives observations. A handoff example is one successful test, not a success-rate claim.</p>
      </div>
      <TrainingMissionViews surface="overview" profile={profile} frame={displayFrame} frames={replay!.frames} towers={towers} elapsedS={playhead} running={running && !reducedMotion} pending={custom || busy} calculating={busy} />
    </div></div>
    <details className={styles.placementSettings}>
      <summary>Placement controls and camera guides</summary>
      <aside className={styles.controls} aria-label="Experiment controls">
        <div><h3>Test a strategy</h3><p>Choose fixed tower sites before starting. {report.algorithm === "coordinated-surveillance-v1" ? "Aircraft search complementary water; any sensor can confirm the boat and cue close tracking." : "Confirmed tower sightings dispatch the aircraft; drone observations maintain the track."}</p><div className={styles.tools}>{([['inspect', 'Inspect'], ['boat', 'Place boat'], ['tower0', 'Move tower 1'], ['tower1', 'Move tower 2']] as const).map(([value, label]) => <button key={value} disabled={busy} aria-pressed={mode === value} onClick={() => setMode(value)}>{label}</button>)}</div>
          {mode !== "inspect" && currentPoint && <div className={styles.coordinates}>{(["x", "y"] as const).map(axis => <label key={axis}>Grid {axis.toUpperCase()} (m)<input aria-label={`${mode === "boat" ? "Boat" : mode === "tower0" ? "Tower 1" : "Tower 2"} grid ${axis.toUpperCase()}`} type="number" min={-3250} max={3250} step={profile.grid.cellM} value={Math.round(currentPoint[axis])} disabled={busy} onChange={event => { if (event.target.value !== "" && Number.isFinite(event.target.valueAsNumber)) changePoint({ ...currentPoint, [axis]: event.target.valueAsNumber }); }} /></label>)}</div>}
          <button className={styles.wideButton} disabled={busy} onClick={() => startJob("replay")}>{busy && job?.kind === "replay" ? "Calculating mission…" : "Run this placement"}</button><button className={styles.textButton} disabled={busy} onClick={() => chooseReplay(0)}>Restore learned placement</button>
        </div>
        <div className={styles.currentResult}><h3>{custom ? "Ready for a new test" : link ? `Report: ${assetLabel(link.source.id)}` : "Searching for the boat"}</h3><dl><div><dt>First detection</dt><dd>{custom ? "Recalculate" : firstHit === undefined || frame.t < firstHit ? "Not yet" : `${firstHit} s`}</dd></div><div><dt>Current water coverage</dt><dd>{custom ? "—" : pct(frame.coveragePct)}</dd></div><div><dt>Reports at {frame.t} s</dt><dd>{custom ? "—" : frame.sources.length ? frame.sources.map(assetLabel).join(", ") : "None"}</dd></div></dl></div>
        <div className={styles.viewOptions}><label><input type="checkbox" checked={showCones} onChange={e => setShowCones(e.target.checked)} />Camera scan guides</label><label><input type="checkbox" checked={showFootprints} onChange={e => setShowFootprints(e.target.checked)} />Exact camera footprints</label><label><input type="checkbox" checked={showGraph} onChange={e => setShowGraph(e.target.checked)} />Navigable water graph</label></div>
        <div className={styles.sensorFacts}><h3>Verified configuration</h3><p>Towers 60° · quad 114.6° · plane 69° horizontal views.</p><p>Boat 3 m/s · quad 10 m/s · plane 15 m/s.</p><p>Camera performance depends on distance, target size, view, terrain and conditions. The sensor model is not field-calibrated.</p></div>
      </aside>
    </details></>}
    <div className={styles.notice} role="status" aria-live="polite">{notice || "Choose a saved unseen mission, spawn a new boat, or move the towers and rerun the test."}</div>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {training ? <div ref={trainingMonitorRef} style={{ scrollMarginTop: 80 }}><TrainingRunMonitor profile={profile} progress={job.progress} inspectedCandidate={inspectedCandidate} onFollow={() => setInspectedTrainingIndex(null)} stepS={report.protocol.stepS} freshnessS={report.protocol.freshnessS} /></div> : <LiveMissionInsights replay={replay!} elapsedS={playhead} horizonS={report.protocol.horizonS} stepS={report.protocol.stepS} freshnessS={report.protocol.freshnessS} running={running} pending={custom || busy} onToggle={togglePlayback} onSeek={seek} />}
    <div className={styles.learning}>
      <div className={styles.learningHeader}><div><h3>Train the surveillance algorithm</h3><p>Compare tower sites, plane sweeps and quad patrols. Select on validation missions, then measure the frozen strategy on unseen boats.</p></div><div className={styles.trainActions}><label>Algorithm to train<select aria-label="Algorithm to train" value={trainingAlgorithm} disabled={busy} onChange={event => setTrainingAlgorithm(event.target.value as GraphAlgorithm)}><option value="coordinated-surveillance-v1">Coordinated surveillance · towers + flights</option><option value="tower-first-v2">Tower-first response · tower positions</option></select></label><label>Training seed<input aria-label="Training seed" type="number" min="0" max="2147483647" step="1" value={seed} disabled={busy} onChange={e => setSeed(Math.max(0, Math.min(2147483647, Math.trunc(Number(e.target.value) || 0))))} /></label><button className={styles.primary} disabled={busy} onClick={() => startJob("train")}>{job?.kind === "train" && job.status === "running" ? "Training in progress…" : "Train algorithm"}</button></div></div>
      <p className={styles.historyNote}>Viewing {algorithmLabel(report.algorithm)} results. Training adjusts flight decisions and fixed tower sites; it does not train an image detector or command the live fleet.</p>
      <FlightSettings policy={currentCandidate?.flightPolicy ?? report.trained.flightPolicy} />
      {training && <div className={styles.progress}><progress aria-label="Model training progress" max={progressTotal ?? report.protocol.candidates} value={progressCompleted ?? 0} /><span>{progress?.phase === "test" ? "Testing frozen model" : progress?.phase === "validation" ? "Validating candidates" : "Learning candidates"} · {progressCompleted ?? 0} / {progressTotal ?? report.protocol.candidates}</span></div>}
      <div className={styles.protocol}><span>{report.protocol.motionTrajectories} motion trajectories</span><span>{report.protocol.trainEpisodes} training missions</span><span>{report.protocol.validationEpisodes} validation missions</span><span>{report.protocol.testEpisodes} untouched test missions</span></div>
      <div className={styles.candidates} aria-label="Learned surveillance strategies">{history.map(candidate => <button key={candidate.index} disabled={training ? !candidate.preview : busy} aria-pressed={(training ? inspectedTrainingIndex : selectedCandidate) === candidate.index} title={`Inspect placement ${candidate.index + 1}: ${pct(candidate.train.detectionRate)} training detection`} onClick={() => chooseCandidate(candidate)}><span>{candidate.index + 1}</span><i style={{ height: `${Math.max(3, candidate.train.detectionRate * .46)}px` }} /><small>{Math.round(candidate.train.detectionRate)}%</small></button>)}</div>
      <p className={styles.historyNote}>{training ? inspectedCandidate ? `Inspecting the recorded mission for placement ${inspectedCandidate.index + 1}. Training continues in the background; choose Follow current training to return.` : "Following the current training candidate. Select a completed placement to inspect its recorded mission and measured output." : currentCandidate ? `Inspecting placement ${currentCandidate.index + 1} · training ${pct(currentCandidate.train.detectionRate)} · capped delay ${num(currentCandidate.train.meanCappedS, " s")}. Run this placement to simulate it using the selected trained movement model.` : `Validation selected placement ${report.selectedIndex + 1}. Bars show training detection for every tested placement and policy. Select a placement to inspect it; saved test scores below remain tied to this winner.`}</p>
      <div className={styles.trainingChart}><Plot label={job?.kind === "train" && job.status === "running" ? "Training results arriving live" : "Completed training candidates"} rows={history.map(candidate => ({ x: candidate.index + 1, values: [candidate.train.detectionRate] }))} series={[{ label: "Candidate training detection", color: "var(--status)" }]} xLabel="Strategy candidate" maxX={Math.max(report.protocol.candidates, history.length)} /></div>
      {job?.kind === "train" && job.status === "running" && job.progress?.partialMetrics && <div className={styles.partialResults}>
        <h3>Unseen evaluation, arriving live</h3><p>Each column uses only the missions evaluated so far. The completed comparison is published after all three methods finish.</p>
        <div className={styles.trainingChart}><Plot label="Live evaluation: boats found over time" rows={(job.progress.partialDetectionCurve ?? []).map(row => ({ x: row.t, values: [row.baseline, row.untrained, row.trained] }))} series={liveComparisonSeries} xLabel="Mission seconds · partial evaluation" maxX={report.protocol.horizonS} /></div>
        <div className={styles.tableWrap}><table aria-label="Live training evaluation"><thead><tr><th scope="col">Evaluated so far</th><th scope="col">{liveCoordinated ? "Tower-first" : "Sweep"}</th><th scope="col">{liveCoordinated ? "Default flights" : "Unoptimized towers"}</th><th scope="col">Trained</th></tr></thead><tbody>{([['Missions', 'episodes'], ['Boats detected (%)', 'detectionRate'], ['Capped detection time (s)', 'meanCappedS'], ['Water observed (%)', 'coveragePct'], ['Tracking custody (%)', 'custodyPct'], ['Position error (m)', 'rmseM']] as const).map(([label, field]) => <tr key={field}><th scope="row">{label}</th>{(['baseline', 'untrained', 'trained'] as const).map(policy => <td key={policy}>{num(job.progress!.partialMetrics?.[policy]?.[field])}</td>)}</tr>)}</tbody></table></div>
      </div>}
    </div>
    <div className={styles.evidence}>
      <details className={styles.benchmark}><summary>Completed benchmark · {report.protocol.testEpisodes} unseen missions · {pct(trainedRate)} detected</summary>
      <div className={styles.resultHeading}><h3>What happened on unseen boats</h3><p><strong>{pct(trainedRate)}</strong> found · {difference >= 0 ? "+" : ""}{num(difference)} percentage points versus the {coordinated ? "tower-first" : "sweep"} baseline. Strategy selected on validation missions; compare tracking outcomes as well.</p></div>
      <p className={styles.metricNote}>This completed evaluation stays fixed while you play or edit a mission. The live charts above show the current run.</p>
      <div className={styles.trainingChart}><Plot label="Completed benchmark: unseen boats found over time" rows={report.detectionCurve.map(value => ({ x: value.t, values: [value.baseline, value.untrained, value.trained] }))} series={comparisonSeries} xLabel="Mission seconds · misses stay in denominator" maxX={report.protocol.horizonS} /></div>
      <MetricTable report={report} />
      {report.metrics.trained.postTowerCustodyPct != null && report.metrics.untrained.postTowerCustodyPct != null && report.metrics.trained.postTowerCustodyPct < report.metrics.untrained.postTowerCustodyPct && <p className={styles.metricNote}>Tracking tradeoff: custody outside tower view fell from {pct(report.metrics.untrained.postTowerCustodyPct)} with the default sites to {pct(report.metrics.trained.postTowerCustodyPct)} with the selected sites. This placement has not established better overall reliability.</p>}
      {report.comparison && <p className={styles.metricNote}>Mean capped delay difference versus the {coordinated ? "tower-first baseline" : "sweep"}: {num(report.comparison.meanSecondsSaved, " s")} saved; paired 95% bootstrap interval {num(report.comparison.pairedBootstrap95S[0])}–{num(report.comparison.pairedBootstrap95S[1], " s")}.{report.comparison.pairedBootstrap95S[0] <= 0 && report.comparison.pairedBootstrap95S[1] >= 0 ? " The interval includes zero, so a detection-time improvement is not established." : " Compare tracking continuity and position error alongside acquisition."}</p>}
      {report.metrics.trained.bySource && <div className={styles.contributions}><h4>Who contributed observations</h4><p>Share of raw sensor reports, including clutter, across the {report.protocol.testEpisodes} trained-policy test missions. Reports can be rejected by the tracker; these counts do not prove custody.</p>{Object.entries(report.metrics.trained.bySource).map(([id, count]) => { const total = Object.values(report.metrics.trained.bySource!).reduce((sum, value) => sum + value, 0); const share = total ? count / total * 100 : 0; return <div key={id}><span>{assetLabel(id)}</span><div className={styles.shareTrack}><i style={{ width: `${share}%`, background: color(id) }} /></div><strong>{pct(share)}</strong><small>{count.toLocaleString()} samples</small></div>; })}</div>}
      <p className={styles.metricNote}>These are local evaluation measures covering the slide’s scoring categories, not Dominion’s official score formula. Accuracy uses modeled noisy observations. Confirmed handoff requires receiving-aircraft evidence; reporting-source changes are a separate measure.</p>
      </details>
      <div className={styles.downloads}><a download="surveillance-report.json" href={modelJob ? `/api/graph-experiment?id=${modelJob}&download=result` : `/experiments/${report.algorithm === "coordinated-surveillance-v1" ? "surveillance" : "graph"}-report.json`}>Download measured results</a><a download="surveillance-model.json" href={modelJob ? `/api/graph-experiment?id=${modelJob}&download=model` : `/experiments/${report.algorithm === "coordinated-surveillance-v1" ? "surveillance" : "graph"}-model.json`}>Download trained model</a><a href="/experiments/arctic-profile.json" target="_blank" rel="noreferrer">View terrain & sensor sources</a><a href="https://github.com/Dominion-Dynamics/arctic-sim" target="_blank" rel="noreferrer">ArcticSim repository</a></div>
      <details className={styles.details}><summary>Model assumptions and research</summary><p>The model learns boat movement and tests tower sites and selected flight-policy settings for confirmed acquisition and continued tracking. A* finds a shortest route on the chosen graph to a selected search point; it does not prove the fastest unknown-target search or a globally optimal tower pair.</p><ul>{report.limitations.map((item, i) => <li key={i}>{item}</li>)}</ul><p>Based on <a href="https://ai.stanford.edu/~nilsson/OnlinePubs-Nils/PublishedPapers/astar.pdf" target="_blank" rel="noreferrer">Hart, Nilsson & Raphael’s A*</a>, <a href="https://arxiv.org/abs/1902.10182" target="_blank" rel="noreferrer">obstacle-aware informative search</a>, and <a href="https://arxiv.org/abs/2303.09003" target="_blank" rel="noreferrer">cooperative sensing and tracking</a>. The supplied ArcticSim slides define the four assets and scoring categories. Installed source provides current camera dimensions and terrain.</p><p>Local experiments do not reposition the live fleet. The live mission and camera feeds remain below.</p></details>
    </div>
  </section>;
}
