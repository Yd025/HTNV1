import { useEffect, useMemo, useRef, useState } from "react";
import type { AttemptReplay, AttemptSummary, GameDashboard, LiveFrame, PathSample } from "../lib/gameLearningTypes";
import { LEGACY_RULES_VERSION } from "../lib/gameLearningTypes";
import { advancePlayback, frameIndexAtTime } from "../lib/gamePlayback";
import styles from "./GameLearning.module.css";

const seconds = (value: number) => `${value.toFixed(1)} s`;
const percent = (value: number) => `${Math.round(value * 100)}%`;
const outcomeName = { caught: "Captured", escaped: "Escaped", abandoned: "Left early" };
const ingestionName = { pending: "Waiting to save", uploaded: "Saved in Sentry", imported: "Ready for learning", error: "Needs attention" };
const isEarlierRun = (attempt: AttemptSummary, currentRules: string) => (attempt.rulesVersion ?? LEGACY_RULES_VERSION) !== currentRules;

export default function Preview({ data, now, connectionStale }: { data: GameDashboard; now: number; connectionStale: boolean }) {
  const attempts = data.attempts.map((attempt, i) => ({ ...attempt, number: data.totals.attempts - data.attempts.length + i + 1 })).reverse();
  const [chosenRun, setChosenRun] = useState<(AttemptSummary & { number: number }) | null>(() => attempts.find(attempt => attempt.replayAvailable) ?? null);
  const selection = chosenRun?.id ?? "live";
  const player = useRef<HTMLDivElement>(null);
  const selected = attempts.find(attempt => attempt.id === selection) ?? chosenRun;
  const choose = (id: string) => setChosenRun(attempts.find(attempt => attempt.id === id) ?? (id === chosenRun?.id ? chosenRun : null));
  const watch = (id: string) => {
    choose(id);
    player.current?.scrollIntoView({ block: "start", behavior: "auto" });
  };
  return <>
    <div ref={player} className={styles.recordingPlayer}>
      <div className={styles.previewHeader}>
        <div><h3 id="game-preview-heading">Player recordings · 2D replay</h3><p>Watch a saved opening run from above, or follow the current player live.</p></div>
        <label className={styles.attemptPicker}>Choose a run<select value={selection} onChange={event => choose(event.target.value)}>
          {selected && !attempts.some(attempt => attempt.id === selected.id) && <option value={selected.id}>Run {selected.number} · {outcomeName[selected.outcome]} · {seconds(selected.seconds)}</option>}
          {attempts.map(attempt => <option key={attempt.id} value={attempt.id} disabled={!attempt.replayAvailable}>Run {attempt.number} · {outcomeName[attempt.outcome]} · {seconds(attempt.seconds)}{isEarlierRun(attempt, data.rulesVersion) ? " · Earlier rules" : ""}{!attempt.replayAvailable ? " · Unavailable" : ""}</option>)}
          <option value="live">Live / next player</option>
        </select></label>
      </div>
      {selection === "live" ? <LivePreview data={data} now={now} connectionStale={connectionStale} /> : <RecordedPreview key={selection} attemptId={selection} runNumber={selected?.number} data={data} />}
      <MapLegend />
    </div>
    <section className={styles.sentryRecordings} aria-labelledby="game-recordings-heading">
      <div className={styles.recordingsHeading}><div><h3 id="game-recordings-heading">Saved player runs</h3><p>Choose a run to play it on the map above.</p></div><span className={styles.status} data-stale={data.sentry?.status === "error"}>{!data.sentry ? "Checking connection" : data.sentry.status === "unconfigured" ? "Setup needed" : data.sentry.status === "syncing" ? "Saving runs" : data.sentry.status === "error" ? "Needs attention" : "Connected to Sentry"}</span></div>
      {data.sentry && <dl className={styles.ingestionCounts}><div><dt>Waiting to sync</dt><dd>{data.sentry.pending}</dd></div><div><dt>Received from Sentry</dt><dd>{data.sentry.imported}</dd></div><div><dt>Needs attention</dt><dd>{data.sentry.failed}</dd></div></dl>}
      {attempts.length ? <div className={styles.tableWrap}><table><caption>Latest {Math.min(10, attempts.length)} opening runs</caption><thead><tr><th>Run</th><th>Result</th><th>Game time</th><th>Learning data</th><th>2D replay</th></tr></thead><tbody>{attempts.slice(0, 10).map(attempt => {
        const modelStatus = isEarlierRun(attempt, data.rulesVersion) ? "Earlier rules · kept for replay" : attempt.sentry?.state === "imported" && (!attempt.verified || attempt.outcome === "abandoned") ? "Saved · not used for learning" : attempt.sentry ? ingestionName[attempt.sentry.state] : "Waiting to save";
        return <tr key={attempt.id} data-selected={selection === attempt.id}><th>{attempt.number}<small>Layout {attempt.layoutVersion}</small></th><td>{outcomeName[attempt.outcome]}</td><td>{seconds(attempt.seconds)}</td><td>{modelStatus}</td><td>{attempt.replayAvailable ? <button onClick={() => watch(attempt.id)} aria-label={`Watch run ${attempt.number}`} aria-pressed={selection === attempt.id}>{selection === attempt.id ? "Selected" : "Watch run"}</button> : <span className={styles.recordingUnavailable}>Unavailable</span>}</td></tr>;
      })}</tbody></table></div> : <p className={styles.recordingEmpty}>Completed runs will appear here. Open the game to record the first one.</p>}
      <p className={styles.note}>The 2D replay recreates each run from the player’s saved controls and original tower positions and flight policy. The model learns from attempt data received from Sentry.</p>
    </section>
  </>;
}

function RecordedPreview({ attemptId, runNumber, data }: { attemptId: string; runNumber?: number; data: GameDashboard }) {
  const [replay, setReplay] = useState<AttemptReplay | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    const timeout = setTimeout(() => controller.abort(), 22000);
    setReplay(null);
    setError("");
    void (async () => {
      try {
        const response = await fetch(`/api/game-learning?attemptId=${encodeURIComponent(attemptId)}`, { signal: controller.signal, cache: "no-store" });
        const result: AttemptReplay = await response.json();
        if (!response.ok || result.attempt?.id !== attemptId || !result.layout || !Array.isArray(result.frames) || !result.frames.length) throw new Error("Recording unavailable");
        if (!disposed) setReplay(result);
      } catch {
        if (!disposed) setError("This run could not be loaded. Try again or choose another run.");
      } finally { clearTimeout(timeout); }
    })();
    return () => { disposed = true; controller.abort(); clearTimeout(timeout); };
  }, [attemptId, retry]);
  if (!replay) return <div className={styles.recordingState} role={error ? "alert" : "status"}><p>{error || "Loading the saved run…"}</p>{error && <button onClick={() => setRetry(value => value + 1)}>Try again</button>}</div>;
  return <ReplayPlayer replay={replay} runNumber={runNumber} data={data} />;
}

function ReplayPlayer({ replay, runNumber, data }: { replay: AttemptReplay; runNumber?: number; data: GameDashboard }) {
  const [time, setTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [loop, setLoop] = useState(true);
  const playhead = useRef(0);
  const finishedAt = useRef<number | null>(null);
  const duration = replay.frames[replay.frames.length - 1].time;
  const seek = (value: number) => {
    // Native range inputs can round the final fractional game tick slightly down.
    const bounded = value >= duration - 0.000001 ? duration : Math.max(0, value);
    finishedAt.current = null;
    playhead.current = bounded;
    setTime(bounded);
  };
  useEffect(() => {
    if (!playing) return;
    let animation = 0;
    let previous: number | null = null;
    const tick = (now: number) => {
      const elapsed = previous == null ? 0 : (now - previous) / 1000;
      previous = now;
      const next = advancePlayback(playhead.current, elapsed * speed, duration, false);
      playhead.current = next.time;
      setTime(next.time);
      if (next.ended) {
        if (!loop) { setPlaying(false); return; }
        // Keep the actual terminal frame visible before repeating the run.
        if (finishedAt.current == null) finishedAt.current = now;
        if (now - finishedAt.current >= 1000) {
          playhead.current = 0;
          finishedAt.current = null;
          setTime(0);
        }
      } else finishedAt.current = null;
      animation = requestAnimationFrame(tick);
    };
    const pauseWhenHidden = () => { if (document.hidden) setPlaying(false); };
    document.addEventListener("visibilitychange", pauseWhenHidden);
    animation = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(animation); document.removeEventListener("visibilitychange", pauseWhenHidden); };
  }, [playing, speed, duration, loop]);
  const index = frameIndexAtTime(replay.frames, time);
  const frame = replay.frames[index];
  const path = useMemo(() => replay.frames.slice(0, index + 1).map(item => ({ t: item.time, x: item.boat.x, z: item.boat.z, detected: item.detected, tagProgress: item.tagProgress })), [replay.frames, index]);
  const atEnd = time >= duration;
  const earlierRules = isEarlierRun(replay.attempt, data.rulesVersion);
  const observers = [...frame.towers.flatMap((tower, i) => tower.detecting ? [`Tower ${i + 1}`] : []), ...frame.drones.filter(drone => drone.detecting).map(drone => drone.id), ...(frame.plane.detecting ? ["Plane"] : [])];
  const toggle = () => {
    if (!playing && atEnd) seek(0);
    setPlaying(value => !value);
  };
  const replayData = { ...data, layout: replay.layout };
  return <>
    {earlierRules && <div className={styles.notice} role="note"><p>This run keeps its original aircraft routes and spotting rules. New games use coordinated surveillance with overhead-only aircraft spotting.</p></div>}
    <div className={styles.playbackControls}>
      <div className={styles.playbackActions}>
        <button className={styles.primaryPlayback} onClick={toggle} disabled={duration <= 0} aria-label={playing ? "Pause replay" : "Play replay"}>{playing ? "Pause" : atEnd ? "Play again" : "Play"}</button>
        <button onClick={() => { seek(0); setPlaying(false); }} aria-label="Restart replay">Restart</button>
        <label className={styles.speedPicker}>Speed<select value={speed} onChange={event => setSpeed(Number(event.target.value))}><option value={0.5}>0.5×</option><option value={1}>1×</option><option value={2}>2×</option><option value={4}>4×</option></select></label>
        <label className={styles.repeatPicker}><input type="checkbox" checked={loop} onChange={event => setLoop(event.target.checked)} />Repeat</label>
        <span className={styles.status}>{atEnd ? playing && loop ? "Repeating shortly" : "End of recording" : playing ? "Playing recording" : time > 0 ? "Paused" : "Ready to play"}</span>
      </div>
      <div className={styles.playbackTimeline}><label htmlFor="game-replay-timeline" className={styles.srOnly}>Replay position</label><input id="game-replay-timeline" type="range" min={0} max={duration || 1} step="any" value={time} disabled={duration <= 0} aria-valuetext={`${seconds(time)} of ${seconds(duration)}`} onChange={event => seek(Number(event.target.value))} /><output htmlFor="game-replay-timeline" aria-live="off">{seconds(time)} / {seconds(duration)}</output></div>
    </div>
    <div className={styles.previewLayout}><GameMap data={replayData} frame={frame} path={path} /><aside className={styles.previewInfo}>
      <h4>{runNumber == null ? "Saved opening run" : `Run ${runNumber}`} · {outcomeName[replay.attempt.outcome]}</h4><p>Replay of the player’s saved controls with the towers and flight policy used in this run.</p>
      <dl><div><dt>At this moment</dt><dd>{atEnd ? outcomeName[replay.attempt.outcome] : "Ship moving through the opening"}</dd></div><div><dt>Seen by</dt><dd>{observers.length ? observers.join(", ") : "No current sighting"}</dd></div><div><dt>Capture progress</dt><dd>{percent(frame.tagProgress)}</dd></div><div><dt>Tower layout</dt><dd>{replay.layout.version}</dd></div><div><dt>First detected</dt><dd>{replay.attempt.firstDetectionSeconds == null ? "Not detected" : seconds(replay.attempt.firstDetectionSeconds)}</dd></div><div><dt>Aircraft spotting</dt><dd>{(replay.attempt.rulesVersion ?? LEGACY_RULES_VERSION) === LEGACY_RULES_VERSION ? "Forward camera · earlier rules" : "Overhead only · within 65 m"}</dd></div></dl>
      <p className={styles.note}>Drag the timeline to inspect any moment. Time is measured on the game clock. Repeat plays this run again automatically.</p>
    </aside></div>
  </>;
}

function LivePreview({ data, now, connectionStale }: { data: GameDashboard; now: number; connectionStale: boolean }) {
  const live = data.live;
  const frame = live?.frame;
  const age = live ? Math.max(0, Math.floor((now - Date.parse(live.receivedAt)) / 1000)) : null;
  const ended = frame && ["caught", "escaped", "abandoned"].includes(frame.status);
  const stale = connectionStale || !!live?.stale || (age != null && age > 8);
  const label = !live ? "Waiting for a player" : ended ? "Run finished" : stale ? "Updates paused" : frame?.status === "paused" ? "Player paused" : "Live";
  return <div className={styles.previewLayout}><GameMap data={data} frame={frame} path={live?.path ?? []} /><aside className={styles.previewInfo}>
    <h4>{label}</h4><p>{!live ? "Start a game to see the player move through the opening." : ended ? "Choose a saved run above to replay it from the beginning." : stale ? "Showing the last received position while updates reconnect." : "Following the current player’s ship, towers, drones, and plane."}</p>
    {live && (live.rulesVersion ?? LEGACY_RULES_VERSION) !== data.rulesVersion && <p>This run keeps the flight and spotting rules it started with.</p>}
    <dl><div><dt>Game time</dt><dd>{frame ? seconds(frame.time) : "—"}</dd></div><div><dt>Radar contact</dt><dd>{frame ? frame.detected ? "Detected" : "Clear" : "Awaiting play"}</dd></div><div><dt>Capture progress</dt><dd>{frame ? percent(frame.tagProgress) : "—"}</dd></div><div><dt>Last update</dt><dd>{age == null ? "—" : `${age} s ago`}</dd></div></dl>
    <p className={styles.note}>New completed runs appear in the run picker. Saved playback stays on the run you choose.</p>
  </aside></div>;
}

function MapLegend() {
  return <div className={styles.mapLegend}><span><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2L16 16 10 13 4 16Z" fill="#edc68a" /></svg>Ship &amp; route</span><span><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="5" y="5" width="10" height="10" fill="none" stroke="#b6d4b2" strokeWidth="2" /></svg>Tower &amp; radar</span><span><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 4l12 12M16 4L4 16" stroke="#cad7ee" strokeWidth="2" /></svg>Drone</span><span><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 1v17M2 10h16M6 17h8" stroke="#cad7ee" strokeWidth="2" /></svg>Plane</span><span>Dashed circle: protected start</span><span>Dashed lines: aircraft next waypoints</span></div>;
}

function GameMap({ data, frame, path }: { data: GameDashboard; frame?: LiveFrame; path: PathSample[] }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const world = data.world;
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    const raster = ctx.createImageData(world.size, world.size);
    for (let i = 0; i < world.heights.length; i++) {
      const elevation = world.heights[i] - world.waterLevel;
      const shade = Math.min(1, Math.max(0, elevation / 300));
      const color = elevation <= 0 ? [25, 49, 66] : [93 + shade * 50, 108 + shade * 49, 111 + shade * 49];
      raster.data[i * 4] = color[0]; raster.data[i * 4 + 1] = color[1]; raster.data[i * 4 + 2] = color[2]; raster.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(raster, 0, 0);
  }, [world]);
  const unit = 800 / (world.half * 2);
  const point = (value: number) => (value + world.half) * unit;
  const towers = frame?.towers ?? data.layout.towers;
  const boat = frame?.boat ?? world.spawn;
  const route = useMemo(() => path.map(p => `${(p.x + world.half) * unit},${(p.z + world.half) * unit}`).join(" "), [path, world.half, unit]);
  return <div className={styles.map}>
    <canvas ref={canvas} width={world.size} height={world.size} aria-hidden="true" />
    <svg viewBox="0 0 800 800" role="img" aria-label={`Top-down Fort Ross game terrain, positive X right and positive Z down. ${towers.length} towers. ${frame ? `Ship at X ${Math.round(boat.x)}, Z ${Math.round(boat.z)} metres.` : "Starting ship location and next tower layout."}`}>
      <defs><clipPath id="game-map-clip"><rect width="800" height="800" /></clipPath></defs>
      <g clipPath="url(#game-map-clip)">
        <circle cx={point(world.spawn.x)} cy={point(world.spawn.z)} r={data.policy.spawnProtectionMetres * unit} fill="none" stroke="#edc68a" strokeDasharray="6 6" strokeOpacity=".8" />
        {frame?.towers.map(tower => <path key={`sector-${tower.id}`} d={sector(point(tower.x), point(tower.z), tower.heading, tower.range * unit)} fill={tower.detecting ? "#edc68a" : "#b6d4b2"} fillOpacity={tower.detecting ? ".24" : ".12"} stroke={tower.detecting ? "#edc68a" : "#b6d4b2"} strokeOpacity=".6" />)}
        <polyline points={route} fill="none" stroke="#edc68a" strokeWidth="2.5" strokeOpacity=".8" />
        {frame && [...frame.drones, { ...frame.plane, id: "plane" }].map(aircraft => aircraft.target && <g key={`intent-${aircraft.id}`}><title>{`${aircraft.id}: ${aircraft.role?.replaceAll("-", " ") ?? "patrol"}; intended waypoint`}</title><line x1={point(aircraft.x)} y1={point(aircraft.z)} x2={point(aircraft.target.x)} y2={point(aircraft.target.z)} stroke="#cad7ee" strokeOpacity=".65" strokeWidth="1.5" strokeDasharray="5 5" /><circle cx={point(aircraft.target.x)} cy={point(aircraft.target.z)} r="4" stroke="#cad7ee" fill="none" /></g>)}
        {towers.map((tower, i) => <g key={tower.id} transform={`translate(${point(tower.x)} ${point(tower.z)})`}><title>{`Tower ${i + 1}: X ${Math.round(tower.x)}, Z ${Math.round(tower.z)} m`}</title><rect x="-7" y="-7" width="14" height="14" fill="#182232" stroke="#b6d4b2" strokeWidth="2.5" /><path d="M-4 4L0-4 4 4M-3 1h6" fill="none" stroke="#b6d4b2" strokeWidth="1.5" /><text className={styles.mapText} x="13" y="5">T{i + 1}</text></g>)}
        {frame?.drones.map((drone, i) => <g key={drone.id} transform={`translate(${point(drone.x)} ${point(drone.z)}) rotate(${-drone.heading * 180 / Math.PI})`}><title>{`Drone ${i + 1}${drone.detecting ? ", ship detected" : ""}`}</title><path d="M-6-6L6 6M6-6L-6 6M0 0v10" fill="none" stroke={drone.detecting ? "#edc68a" : "#cad7ee"} strokeWidth="2.5" />{[[-6,-6],[6,-6],[-6,6],[6,6]].map(([x,z]) => <circle key={`${x}-${z}`} cx={x} cy={z} r="3" fill="#182232" stroke="#cad7ee" strokeWidth="1.5" />)}</g>)}
        {frame && <g transform={`translate(${point(frame.plane.x)} ${point(frame.plane.z)}) rotate(${-frame.plane.heading * 180 / Math.PI})`}><title>Search plane</title><path d="M0 11L-3 1 -13-4 -13-6 -2-3 -1-10 -6-12 -6-14 0-12 6-14 6-12 1-10 2-3 13-6 13-4 3 1Z" fill="#cad7ee" stroke="#182232" strokeWidth="1" /></g>}
        <g transform={`translate(${point(boat.x)} ${point(boat.z)}) rotate(${-boat.heading * 180 / Math.PI})`}><title>{frame ? "Player ship" : "Ship start"}</title><path d="M0 13L-7-5 -5-10 5-10 7-5Z" fill="#edc68a" stroke="#182232" strokeWidth="2" /></g>
      </g>
      <g className={styles.mapText}><text x="22" y="30">−Z</text><text x="747" y="30">+X →</text><path d={`M25 754v8h${500 * unit}v-8`} fill="none" stroke="#e2e7ea" strokeWidth="2" /><text x="25" y="741">500 m</text><text x="740" y="780">+Z ↓</text></g>
    </svg>
  </div>;
}

/** Heading zero points down (+Z); preserve Three.js X/Z without mirroring. */
function sector(x: number, z: number, heading: number, radius: number) {
  const halfAngle = Math.PI / 6;
  const a = heading - halfAngle, b = heading + halfAngle;
  return `M${x},${z}L${x + Math.sin(a) * radius},${z + Math.cos(a) * radius}A${radius},${radius} 0 0 0 ${x + Math.sin(b) * radius},${z + Math.cos(b) * radius}Z`;
}
