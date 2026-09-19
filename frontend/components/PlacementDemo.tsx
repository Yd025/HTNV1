import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import data from "../lib/placementDemoData.json";
import randomEvidence from "../lib/placementRandomEvidence.json";
import { boatPosition, clampPoint, evaluateRoute, towerHeading, type BoatRoute, type DemoTower, type Point } from "../lib/placementDemo";
import { advanceExperiment, createExperiment, nearestTower, randomRoute, type Experiment } from "../lib/placementExperiments";
import PlacementExperimentPanel from "./PlacementExperimentPanel";
import { Icon } from "./ui/Icons";
import styles from "./PlacementDemo.module.css";

type EditMode = "start" | "end" | "tower0" | "tower1";
type Layout = "learned" | "baseline" | "custom" | "candidate";
const HALF = data.halfM;
const HORIZON = data.benchmark.deadlineS;
const INITIAL_SEED = 190926;
const DEFAULT_ROUTE = randomRoute(INITIAL_SEED, 1000);
const project = (point: Point) => ({ x: 360 + point.east * 0.2, y: 340 - point.north * 0.2 });
const toolLabels: Record<EditMode, string> = { start: "Boat start", end: "Destination", tower0: "Tower 1", tower1: "Tower 2" };

function wedge(tower: DemoTower, elapsed: number) {
  const centre = project(tower);
  const heading = towerHeading(tower, elapsed, data.scanPeriodS);
  const point = (angle: number) => {
    const radians = angle * Math.PI / 180;
    return `${centre.x + Math.sin(radians) * tower.rangeM * 0.2},${centre.y - Math.cos(radians) * tower.rangeM * 0.2}`;
  };
  return `M${centre.x},${centre.y} L${point(heading - tower.fovDeg / 2)} A${tower.rangeM * 0.2},${tower.rangeM * 0.2} 0 0 1 ${point(heading + tower.fovDeg / 2)} Z`;
}

export default function PlacementDemo() {
  const uniqueId = useId().replace(/:/g, "");
  const [layout, setLayout] = useState<Layout>("learned");
  const [towers, setTowers] = useState<DemoTower[]>(data.learned.towers);
  const [route, setRoute] = useState<BoatRoute>(DEFAULT_ROUTE);
  const [edit, setEdit] = useState<EditMode>("start");
  const [elapsed, setElapsed] = useState(0);
  const [running, setRunning] = useState(false);
  const [playback, setPlayback] = useState(8);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [experiment, setExperiment] = useState<Experiment | null>(null);
  const [searching, setSearching] = useState(false);
  const [selectedCandidate, setSelectedCandidate] = useState<number | null>(null);
  const [spawnIndex, setSpawnIndex] = useState(0);
  const [replayIndex, setReplayIndex] = useState<number | null>(null);
  const [autoReplay, setAutoReplay] = useState(false);
  const [experimentError, setExperimentError] = useState<string | null>(null);
  const dragging = useRef<{ mode: EditMode; offset: Point; clientX: number; clientY: number; moved: boolean } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const result = useMemo(() => evaluateRoute(towers, route), [towers, route]);
  const original = useMemo(() => evaluateRoute(data.baseline.towers, route), [route]);
  const recommended = experiment?.phase === "complete" ? experiment.bestTowers : data.learned.towers;
  const learned = useMemo(() => evaluateRoute(recommended, route), [recommended, route]);
  const boat = boatPosition(route, elapsed);
  const acquired = result.detectedAt !== null && elapsed >= result.detectedAt;
  const sightLine = nearestTower(towers, boat, elapsed, true);
  const nearest = sightLine ?? nearestTower(towers, boat, elapsed, false);
  const visible = sightLine !== null;
  const activePoint = edit === "start" ? route.start : edit === "end" ? route.end : towers[edit === "tower0" ? 0 : 1];
  const firstTower = towers.find((tower) => tower.id === result.sourceId);
  const replayStop = autoReplay && result.detectedAt !== null ? result.detectedAt : HORIZON;
  const spawnCloud = useMemo(() => experiment?.testRoutes ?? (experiment ? Array.from({ length: 80 }, (_, i) => randomRoute(experiment.seed, i)) : []), [experiment?.seed, experiment?.testRoutes]);

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(preference.matches);
    update();
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!running) return;
    let frame = 0;
    let previous: number | null = null;
    const tick = (now: number) => {
      if (previous !== null) {
        const delta = document.hidden ? 0 : Math.min((now - previous) / 1000, 0.1) * playback;
        setElapsed((value) => Math.min(replayStop, value + delta));
      }
      previous = now;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [running, playback, replayStop]);

  useEffect(() => {
    if (!running || elapsed < replayStop) return;
    if (autoReplay && replayIndex !== null && experiment?.testRoutes && replayIndex + 1 < experiment.testRoutes.length) {
      // Keep towers fixed across the unseen boats; only the boat changes.
      // Hold the detection line (or the miss) long enough to read before spawning.
      const timer = window.setTimeout(() => {
        const next = replayIndex + 1;
        setReplayIndex(next);
        setRoute(experiment.testRoutes![next]);
        setElapsed(0);
      }, 1200);
      return () => window.clearTimeout(timer);
    } else { setRunning(false); setAutoReplay(false); }
  }, [elapsed, running, replayStop, autoReplay, replayIndex, experiment]);

  useEffect(() => {
    if (!searching || !experiment || experiment.phase === "complete") return;
    const timer = window.setTimeout(() => {
      try {
        const next = advanceExperiment(experiment);
        setExperiment(next);
        const candidate = next.phase === "complete" ? next.candidates[next.winnerIndex!] : next.candidates[next.candidates.length - 1];
        setTowers(candidate.towers.map((tower) => ({ ...tower })));
        setSelectedCandidate(candidate.index);
        setLayout(next.phase === "complete" ? "learned" : "candidate");
        setRoute(next.phase === "complete" ? next.testRoutes![0] : randomRoute(next.seed, candidate.index % 80));
        setElapsed(0);
        if (next.phase === "complete") { setSearching(false); setReplayIndex(0); setPlayback(32); setAutoReplay(true); setRunning(true); }
      } catch (error) {
        setSearching(false);
        setExperimentError(error instanceof Error ? error.message : "The placement search could not finish.");
      }
    }, reducedMotion ? 0 : 180);
    return () => window.clearTimeout(timer);
  }, [searching, experiment, reducedMotion]);

  const resetTime = () => { setRunning(false); setAutoReplay(false); setElapsed(0); };
  const stopAutomation = () => { setSearching(false); setAutoReplay(false); setRunning(false); };
  const revealMap = () => svg.current?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
  const startSearch = () => {
    resetTime();
    revealMap();
    setExperimentError(null);
    if (!experiment || experiment.phase === "complete") {
      try {
        const next = createExperiment(experiment ? experiment.seed + 1 : INITIAL_SEED, towers);
        setExperiment(next);
        setSelectedCandidate(0);
        setLayout("candidate");
        setReplayIndex(null);
        setRoute(randomRoute(next.seed, 0));
      } catch (error) { setExperimentError(error instanceof Error ? error.message : "Could not start the search."); return; }
    }
    setSearching(true);
  };
  const selectCandidate = (index: number) => {
    const candidate = experiment?.candidates[index];
    if (!candidate) return;
    stopAutomation();
    setSelectedCandidate(index);
    setTowers(candidate.towers.map((tower) => ({ ...tower })));
    setLayout(index === experiment?.winnerIndex ? "learned" : "candidate");
    setElapsed(0);
    revealMap();
  };
  const spawnBoat = () => {
    stopAutomation();
    setReplayIndex(null);
    setSpawnIndex((index) => index + 1);
    setRoute(randomRoute(experiment?.seed ?? INITIAL_SEED, 1001 + spawnIndex));
    setElapsed(0);
  };
  const replayBoats = () => {
    if (!experiment?.testRoutes?.length || experiment.phase !== "complete") return;
    setSearching(false);
    setTowers(experiment.bestTowers.map((tower) => ({ ...tower })));
    setSelectedCandidate(experiment.winnerIndex!);
    setLayout("learned");
    setRoute(experiment.testRoutes[0]);
    setReplayIndex(0);
    setElapsed(0);
    setPlayback(32);
    setAutoReplay(true);
    setRunning(true);
    revealMap();
  };
  const selectTestBoat = (index: number) => {
    const next = experiment?.testRoutes?.[index];
    if (!next) return;
    stopAutomation();
    setReplayIndex(index);
    setRoute(next);
    setElapsed(0);
  };
  const chooseLayout = (next: "learned" | "baseline") => {
    stopAutomation();
    setLayout(next);
    setTowers((next === "learned" ? recommended : data.baseline.towers).map((tower) => ({ ...tower })));
    setSelectedCandidate(next === "learned" ? experiment?.winnerIndex ?? null : null);
    resetTime();
  };
  const movePoint = (mode: EditMode, next: Point) => {
    const point = clampPoint(next, HALF);
    stopAutomation();
    resetTime();
    if (mode === "start" || mode === "end") { setReplayIndex(null); setRoute((value) => ({ ...value, [mode]: point })); }
    else {
      const index = mode === "tower0" ? 0 : 1;
      setTowers((value) => value.map((tower, i) => i === index ? { ...tower, ...point } : tower));
      setLayout("custom");
      setSelectedCandidate(null);
    }
  };
  const mapPoint = (event: PointerEvent<SVGSVGElement>): Point | null => {
    const matrix = svg.current?.getScreenCTM();
    if (!matrix || !svg.current) return null;
    const point = svg.current.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const local = point.matrixTransform(matrix.inverse());
    return { north: (340 - local.y) / 0.2, east: (local.x - 360) / 0.2 };
  };
  const pointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    const handleElement = (event.target as Element).closest("[data-edit]");
    const handle = handleElement?.getAttribute("data-edit") as EditMode | undefined;
    const mode = handle ?? edit;
    setEdit(mode);
    const point = mapPoint(event);
    if (!point) return;
    const origin = mode === "start" ? (handleElement?.hasAttribute("data-moving-boat") ? boat : route.start) : mode === "end" ? route.end : towers[mode === "tower0" ? 0 : 1];
    dragging.current = { mode, offset: handle ? { north: origin.north - point.north, east: origin.east - point.east } : { north: 0, east: 0 }, clientX: event.clientX, clientY: event.clientY, moved: !handle };
    event.currentTarget.setPointerCapture(event.pointerId);
    if (!handle) movePoint(mode, point);
  };
  const mapKey = (event: KeyboardEvent<SVGSVGElement>) => {
    const step = event.shiftKey ? 10 : 50;
    const delta: Record<string, Point> = { ArrowUp: { north: step, east: 0 }, ArrowDown: { north: -step, east: 0 }, ArrowLeft: { north: 0, east: -step }, ArrowRight: { north: 0, east: step } };
    if (delta[event.key]) {
      event.preventDefault();
      movePoint(edit, { north: activePoint.north + delta[event.key].north, east: activePoint.east + delta[event.key].east });
    }
  };
  const timeLabel = (time: number | null) => time === null ? "No sighting" : `${time.toFixed(0)} s`;
  const start = project(route.start), end = project(route.end), ship = project(boat);
  const boatAngle = Math.atan2(route.end.east - route.start.east, route.end.north - route.start.north) * 180 / Math.PI;

  return (
    <section className={styles.demo} aria-labelledby="placement-demo-heading" id="placement-demo">
      <header className={styles.heading}>
        <div>
          <h2 id="placement-demo-heading">Put the towers to the test.</h2>
          <p>Random boats. Better placements. See which tower finds them.</p>
        </div>
        <span className={styles.modelLabel}><Icon name="arena" /> Local placement demo</span>
      </header>
      <div className={styles.workbench}>
        <div className={styles.stage}>
          <div className={styles.stageToolbar}>
            <div className={styles.layoutButtons} role="group" aria-label="Tower placement">
              <button type="button" aria-pressed={layout === "learned"} onClick={() => chooseLayout("learned")}>{experiment?.phase === "complete" ? "Best from round" : "Learned placement"}</button>
              <button type="button" aria-pressed={layout === "baseline"} onClick={() => chooseLayout("baseline")}>Original placement</button>
            </div>
            {layout === "custom" && <span className={styles.customLabel}>Custom placement</span>}
            {layout === "candidate" && <span className={styles.customLabel}>Placement {(selectedCandidate ?? 0) + 1}</span>}
            <button type="button" className={styles.playButton} onClick={() => { setSearching(false); if (elapsed >= HORIZON) setElapsed(0); setRunning((value) => !value); }}>
              <svg viewBox="0 0 20 20" width="17" height="17" fill="currentColor" aria-hidden="true">{running ? <path d="M5 3h3v14H5zm7 0h3v14h-3z" /> : <path d="m5 2 12 8-12 8z" />}</svg>
              {running ? "Pause" : elapsed > 0 && elapsed < HORIZON ? "Resume test" : "Run test"}
            </button>
          </div>
          <div className={styles.trialToolbar}>
            <button type="button" onClick={spawnBoat}>Spawn random boat</button>
            <button type="button" onClick={startSearch}>{searching ? `Testing ${experiment?.completed} / 48…` : "Improve tower placement"}</button>
            {searching && <button type="button" onClick={() => setSearching(false)}>Pause search</button>}
            <span>{replayIndex !== null ? `Test boat ${replayIndex + 1} / 200` : layout === "candidate" ? "Learning preview" : `Random scene ${spawnIndex + 1}`}</span>
          </div>
          {experiment?.phase === "complete" && <div className={styles.replayToolbar}>
            <button type="button" onClick={replayBoats}>Watch random boats</button>
            <label>Test boat <select aria-label="Test boat to replay" value={replayIndex ?? ""} onChange={(event) => selectTestBoat(Number(event.target.value))}>
              <option value="" disabled>Choose a boat</option>
              {experiment.testRoutes?.map((_, index) => <option key={index} value={index}>{index + 1}</option>)}
            </select></label>
            <button type="button" onClick={() => selectTestBoat(((replayIndex ?? -1) + 1) % 200)}>Next boat</button>
            {autoReplay && <span>{running ? "Playing all 200" : "Replay paused"} · towers fixed</span>}
          </div>}
          <div className={styles.mapWrap}>
            <div className={styles.mapTopline}><span>3 × 3 km test arena</span><span>North ↑</span></div>
            <svg ref={svg} className={styles.map} viewBox="0 0 720 680" role="group" tabIndex={0}
              aria-label={`Interactive placement map. Editing ${toolLabels[edit]}. Use arrow keys to move it.`}
              aria-describedby="placement-map-help" onKeyDown={mapKey} onPointerDown={pointerDown}
              onPointerMove={(event) => {
                const drag = dragging.current;
                if (!drag) return;
                if (!drag.moved && Math.hypot(event.clientX - drag.clientX, event.clientY - drag.clientY) < 3) return;
                const point = mapPoint(event);
                if (point) { drag.moved = true; movePoint(drag.mode, { north: point.north + drag.offset.north, east: point.east + drag.offset.east }); }
              }}
              onPointerUp={(event) => { dragging.current = null; if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
              onPointerCancel={() => { dragging.current = null; }}>
              <defs>
                <pattern id={`${uniqueId}-grid`} width="60" height="60" patternUnits="userSpaceOnUse" x="60" y="40"><path d="M60 0H0V60" fill="none" stroke="currentColor" strokeWidth="1" /></pattern>
                <clipPath id={`${uniqueId}-bounds`}><rect x="60" y="40" width="600" height="600" /></clipPath>
              </defs>
              <rect className={styles.grid} x="60" y="40" width="600" height="600" fill={`url(#${uniqueId}-grid)`} />
              <path className={styles.axes} d="M360 40V640M60 340H660" />
              <rect className={styles.boundary} x="60" y="40" width="600" height="600" fill="none" />
              <g clipPath={`url(#${uniqueId}-bounds)`}>
                <g className={styles.spawnCloud} aria-hidden="true">{spawnCloud.map((sample, index) => { const point = project(sample.start); return <circle key={index} cx={point.x} cy={point.y} r="2.5" />; })}</g>
                {towers.map((tower, index) => {
                  const { x, y } = project(tower);
                  return <g key={tower.id} className={index === 0 ? styles.sensorOne : styles.sensorTwo}>
                    <circle cx={x} cy={y} r={tower.rangeM * 0.2} className={styles.range} />
                    <circle cx={x} cy={y} r={tower.rangeM * 0.1} className={styles.innerRange} />
                    {!reducedMotion && [0, 0.5].map((offset) => {
                      const phase = ((elapsed / 5 + offset) % 1);
                      return <circle key={offset} cx={x} cy={y} r={Math.max(1, phase * tower.rangeM * 0.2)} className={styles.pulse} style={{ opacity: (1 - phase) * 0.48 }} />;
                    })}
                    <path d={wedge(tower, elapsed)} className={styles.wedge} data-testid={`tower-sweep-${index}`} />
                  </g>;
                })}
                <path className={styles.route} d={`M${start.x} ${start.y}L${end.x} ${end.y}`} />
                <path className={styles.traveled} d={`M${start.x} ${start.y}L${ship.x} ${ship.y}`} />
                {nearest && (() => {
                  const source = project(nearest.tower);
                  return <g className={visible ? styles.trackingLink : styles.nearestLink} pointerEvents="none" data-testid="tower-boat-link">
                    <path d={`M${source.x} ${source.y}L${ship.x} ${ship.y}`} />
                    <text x={Math.max(110, Math.min(610, (source.x + ship.x) / 2))} y={(source.y + ship.y) / 2 - 10}>{`${nearest.tower.label} · ${Math.round(nearest.distanceM)} m`}</text>
                  </g>;
                })()}
                <g data-edit="end" className={styles.destination} transform={`translate(${end.x} ${end.y})`}>
                  <circle r="24" fill="transparent" stroke="none" /><circle r="9" /><path d="M-18 0H18M0-18V18" />
                </g>
                <g data-edit="start" className={styles.start} transform={`translate(${start.x} ${start.y})`}><circle r="24" fill="transparent" stroke="none" /><circle r="7" /></g>
                {acquired && result.position && (() => {
                  const found = project(result.position);
                  return <g className={styles.acquisition} transform={`translate(${found.x} ${found.y})`}><circle r="19" /><path d="m-7 0 5 5 10-11" /></g>;
                })()}
              </g>
              {towers.map((tower, index) => {
                const { x, y } = project(tower);
                return <g key={tower.id} data-edit={`tower${index}`} className={`${styles.tower} ${index === 0 ? styles.sensorOne : styles.sensorTwo}`} transform={`translate(${x} ${y})`}>
                  <title>{`${tower.label}: ${tower.north.toFixed(0)} m north, ${tower.east.toFixed(0)} m east. Drag to move.`}</title>
                  <circle r="29" className={styles.towerBase} />
                  <path d="M-12 15 0-17 12 15M-8 6H8M-12 15H12M0-17V16" />
                  <circle cy="-17" r="3" />
                  <text x="32" y="8" className={styles.markerLabel}>{index + 1}</text>
                </g>;
              })}
              <g data-edit="start" data-moving-boat className={`${styles.boat} ${visible ? styles.boatVisible : ""}`} transform={`translate(${ship.x} ${ship.y})`}>
                <title>{`Test boat. ${visible ? "Inside a tower view" : "Outside current tower views"}.`}</title>
                <circle r="31" className={styles.boatAura} />
                <g transform={`rotate(${boatAngle})`}><path className={styles.hull} d="M0-20 11-5 9 17H-9L-11-5Z" /><path d="M-5-3H5V9H-5Z" className={styles.cabin} /></g>
              </g>
            </svg>
            <div className={styles.mapLegend}><span><i className={styles.legendRange} />600 m range limit</span><span><i className={styles.legendView} />40° camera view</span><span><i className={styles.legendRoute} />Boat route</span></div>
            <p className={styles.linkHelp}>{visible ? `Shortest visible link: ${sightLine!.tower.label}, ${Math.round(sightLine!.distanceM)} m.` : `Nearest tower: ${nearest?.tower.label}, ${Math.round(nearest?.distanceM ?? 0)} m. No camera view now.`} Solid line = visible contact. Dashed = distance guide.</p>
          </div>
          <div className={styles.transport}>
            <button type="button" className={styles.resetButton} onClick={resetTime} aria-label="Reset test"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M4 10a8 8 0 1 1 1 7M4 4v6h6" /></svg></button>
            <label className={styles.timeline}><span>Test time <strong>{elapsed.toFixed(0)} / {HORIZON} s</strong></span><input aria-label="Test time" type="range" min="0" max={HORIZON} step="1" value={elapsed} onChange={(event) => { stopAutomation(); setElapsed(Number(event.target.value)); }} /></label>
            <label className={styles.playback}><span>Playback</span><select aria-label="Playback speed" value={playback} onChange={(event) => setPlayback(Number(event.target.value))}><option value={1}>1×</option><option value={4}>4×</option><option value={8}>8×</option><option value={32}>32×</option></select></label>
          </div>
        </div>
        <aside className={styles.controls} aria-label="Placement test controls">
          <div className={styles.editGroup}>
            <h3>Set the scene</h3>
            <p id="placement-map-help">Choose what to move, then click or drag on the map. Arrow keys move the selected point by 50 m.</p>
            <div className={styles.tools} role="group" aria-label="Object to place">
              {(Object.keys(toolLabels) as EditMode[]).map((mode) => <button key={mode} type="button" aria-pressed={edit === mode} onClick={() => setEdit(mode)}><Icon name={mode.startsWith("tower") ? "signal" : "target"} />{toolLabels[mode]}</button>)}
            </div>
            <div className={styles.coordinates}>
              <label>North (m)<input aria-label={`${toolLabels[edit]} north position`} type="number" min={-HALF} max={HALF} step="50" value={Math.round(activePoint.north)} onChange={(event) => { const next = event.currentTarget.valueAsNumber; if (Number.isFinite(next)) movePoint(edit, { ...activePoint, north: next }); }} /></label>
              <label>East (m)<input aria-label={`${toolLabels[edit]} east position`} type="number" min={-HALF} max={HALF} step="50" value={Math.round(activePoint.east)} onChange={(event) => { const next = event.currentTarget.valueAsNumber; if (Number.isFinite(next)) movePoint(edit, { ...activePoint, east: next }); }} /></label>
            </div>
            <label className={styles.speed}><span>Boat speed <strong>{route.speedMps.toFixed(1)} m/s</strong></span><input aria-label="Boat speed" type="range" min="0" max="20" step="0.1" value={route.speedMps} onChange={(event) => { stopAutomation(); setReplayIndex(null); setRoute((value) => ({ ...value, speedMps: Number(event.target.value) })); resetTime(); }} /></label>
          </div>
          <div className={styles.liveResult} data-visible={visible}>
            <div className={styles.signalLabel}><span className={styles.signalDot} />{visible ? `${sightLine!.tower.label} has a view` : acquired ? "Contact seen earlier" : "Searching for the boat"}</div>
            <div className={styles.resultValue}>{acquired ? `${result.detectedAt!.toFixed(0)} s` : elapsed >= HORIZON ? "No sighting" : "—"}</div>
            <p aria-live="polite">{acquired ? `First sighting by ${firstTower?.label ?? "a tower"}, checked every second.` : elapsed >= HORIZON ? "No sighting at the 1-second checks within 180 seconds." : "Run or scrub the test. Sightings are checked every second."}</p>
          </div>
          <div className={styles.comparison}>
            <h3>Same route, two layouts</h3>
            <p>First sighting, checked every second</p>
            <dl>
              <div><dt>Original</dt><dd>{timeLabel(original.detectedAt)}</dd></div>
              <div className={styles.learnedResult}><dt>{experiment?.phase === "complete" ? "Best from round" : "Learned"}</dt><dd>{timeLabel(learned.detectedAt)}</dd></div>
              {(layout === "custom" || layout === "candidate") && <div><dt>{layout === "custom" ? "Your placement" : `Placement ${(selectedCandidate ?? 0) + 1}`}</dt><dd>{timeLabel(result.detectedAt)}</dd></div>}
            </dl>
            <span className={styles.deadline}>No sighting = no sample inside a tower view within 180 s.</span>
          </div>
        </aside>
      </div>
      {experimentError && <p role="alert" className={styles.experimentError}>{experimentError} Pause the search and try again.</p>}
      <PlacementExperimentPanel experiment={experiment} busy={searching} selectedCandidate={selectedCandidate} onStart={startSearch} onCancel={() => setSearching(false)} onSelectCandidate={selectCandidate} onReplay={replayBoats} />
      <footer className={styles.footer}>
        <div><Icon name="check" /><p><strong>{randomEvidence.learned.detected} / {randomEvidence.learned.episodes.toLocaleString("en-US")} random boats found in five saved rounds.</strong> Saved pair: {randomEvidence.baseline.detected} found. Capped mean: {randomEvidence.baseline.meanCappedS.toFixed(1)} → {randomEvidence.learned.meanCappedS.toFixed(1)} s. One round regressed. Tower-only synthetic tests.</p></div>
        <p>This interactive test shows ideal tower visibility only. Flat local arena; terrain, camera misses and vehicle search are excluded. Learned positions are the best tested pair, pending ArcticSim validation.</p>
      </footer>
    </section>
  );
}
