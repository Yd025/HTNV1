import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import data from "../lib/placementDemoData.json";
import { boatPosition, clampPoint, evaluateRoute, inTowerView, towerHeading, type BoatRoute, type DemoTower, type Point } from "../lib/placementDemo";
import { Icon } from "./ui/Icons";
import styles from "./PlacementDemo.module.css";

type EditMode = "start" | "end" | "tower0" | "tower1";
type Layout = "learned" | "baseline" | "custom";
const HALF = data.halfM;
const HORIZON = data.benchmark.deadlineS;
const DEFAULT_ROUTE: BoatRoute = { start: { north: -900, east: -150 }, end: { north: 900, east: 150 }, speedMps: 12 };
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
  const dragging = useRef<{ mode: EditMode; offset: Point; clientX: number; clientY: number; moved: boolean } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const result = useMemo(() => evaluateRoute(towers, route), [towers, route]);
  const original = useMemo(() => evaluateRoute(data.baseline.towers, route), [route]);
  const learned = useMemo(() => evaluateRoute(data.learned.towers, route), [route]);
  const boat = boatPosition(route, elapsed);
  const acquired = result.detectedAt !== null && elapsed >= result.detectedAt;
  const visible = towers.some((tower) => inTowerView(tower, boat, elapsed, data.scanPeriodS));
  const activePoint = edit === "start" ? route.start : edit === "end" ? route.end : towers[edit === "tower0" ? 0 : 1];
  const firstTower = towers.find((tower) => tower.id === result.sourceId);

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
        setElapsed((value) => Math.min(HORIZON, value + delta));
      }
      previous = now;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [running, playback]);

  useEffect(() => { if (elapsed >= HORIZON) setRunning(false); }, [elapsed]);

  const resetTime = () => { setRunning(false); setElapsed(0); };
  const chooseLayout = (next: "learned" | "baseline") => {
    setLayout(next);
    setTowers(data[next].towers.map((tower) => ({ ...tower })));
    resetTime();
  };
  const movePoint = (mode: EditMode, next: Point) => {
    const point = clampPoint(next, HALF);
    resetTime();
    if (mode === "start" || mode === "end") setRoute((value) => ({ ...value, [mode]: point }));
    else {
      const index = mode === "tower0" ? 0 : 1;
      setTowers((value) => value.map((tower, i) => i === index ? { ...tower, ...point } : tower));
      setLayout("custom");
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
          <p>Move the boat. Watch the sweeps. Find the blind spots.</p>
        </div>
        <span className={styles.modelLabel}><Icon name="arena" /> Local placement demo</span>
      </header>
      <div className={styles.workbench}>
        <div className={styles.stage}>
          <div className={styles.stageToolbar}>
            <div className={styles.layoutButtons} role="group" aria-label="Tower placement">
              <button type="button" aria-pressed={layout === "learned"} onClick={() => chooseLayout("learned")}>Learned placement</button>
              <button type="button" aria-pressed={layout === "baseline"} onClick={() => chooseLayout("baseline")}>Original placement</button>
            </div>
            {layout === "custom" && <span className={styles.customLabel}>Custom placement</span>}
            <button type="button" className={styles.playButton} onClick={() => { if (elapsed >= HORIZON) setElapsed(0); setRunning((value) => !value); }}>
              <svg viewBox="0 0 20 20" width="17" height="17" fill="currentColor" aria-hidden="true">{running ? <path d="M5 3h3v14H5zm7 0h3v14h-3z" /> : <path d="m5 2 12 8-12 8z" />}</svg>
              {running ? "Pause" : elapsed > 0 && elapsed < HORIZON ? "Resume test" : "Run test"}
            </button>
          </div>
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
          </div>
          <div className={styles.transport}>
            <button type="button" className={styles.resetButton} onClick={resetTime} aria-label="Reset test"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M4 10a8 8 0 1 1 1 7M4 4v6h6" /></svg></button>
            <label className={styles.timeline}><span>Test time <strong>{elapsed.toFixed(0)} / {HORIZON} s</strong></span><input aria-label="Test time" type="range" min="0" max={HORIZON} step="1" value={elapsed} onChange={(event) => { setRunning(false); setElapsed(Number(event.target.value)); }} /></label>
            <label className={styles.playback}><span>Playback</span><select aria-label="Playback speed" value={playback} onChange={(event) => setPlayback(Number(event.target.value))}><option value={1}>1×</option><option value={4}>4×</option><option value={8}>8×</option></select></label>
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
            <label className={styles.speed}><span>Boat speed <strong>{route.speedMps} m/s</strong></span><input aria-label="Boat speed" type="range" min="0" max="20" step="1" value={route.speedMps} onChange={(event) => { setRoute((value) => ({ ...value, speedMps: Number(event.target.value) })); resetTime(); }} /></label>
          </div>
          <div className={styles.liveResult} data-visible={visible}>
            <div className={styles.signalLabel}><span className={styles.signalDot} />{visible ? "In camera view now" : acquired ? "Contact seen earlier" : "Searching for the boat"}</div>
            <div className={styles.resultValue}>{acquired ? `${result.detectedAt!.toFixed(0)} s` : elapsed >= HORIZON ? "No sighting" : "—"}</div>
            <p aria-live="polite">{acquired ? `First sighting by ${firstTower?.label ?? "a tower"}, checked every second.` : elapsed >= HORIZON ? "No sighting at the 1-second checks within 180 seconds." : "Run or scrub the test. Sightings are checked every second."}</p>
          </div>
          <div className={styles.comparison}>
            <h3>Same route, two layouts</h3>
            <p>First sighting, checked every second</p>
            <dl>
              <div><dt>Original</dt><dd>{timeLabel(original.detectedAt)}</dd></div>
              <div className={styles.learnedResult}><dt>Learned</dt><dd>{timeLabel(learned.detectedAt)}</dd></div>
              {layout === "custom" && <div><dt>Your placement</dt><dd>{timeLabel(result.detectedAt)}</dd></div>}
            </dl>
            <span className={styles.deadline}>No sighting = no sample inside a tower view within 180 s.</span>
          </div>
        </aside>
      </div>
      <footer className={styles.footer}>
        <div><Icon name="check" /><p><strong>{data.benchmark.percentFaster.toFixed(1)}% lower capped detection time.</strong> Two towers + vehicles, {data.benchmark.episodes} unseen synthetic scenarios. Misses count as 180 s.</p></div>
        <p>This interactive test shows ideal tower visibility only. Flat local arena; terrain, camera misses and vehicle search are excluded. Learned positions are the best tested pair, pending ArcticSim validation.</p>
      </footer>
    </section>
  );
}
