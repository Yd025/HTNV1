import { useEffect, useMemo, useRef } from "react";
import type { GameDashboard, LiveFrame, PathSample } from "../lib/gameLearningTypes";
import styles from "./GameLearning.module.css";

const seconds = (value: number) => `${value.toFixed(1)} s`;
const percent = (value: number) => `${Math.round(value * 100)}%`;
const outcomeName = { caught: "Captured", escaped: "Escaped", abandoned: "Abandoned" };
const ingestionName = { pending: "Waiting to upload", uploaded: "In Sentry · awaiting import", imported: "Available to model", error: "Needs attention" };

function sentryUrl(value: string | undefined) {
  if (!value) return undefined;
  try { const url = new URL(value); return url.protocol === "https:" && (url.hostname === "sentry.io" || url.hostname.endsWith(".sentry.io")) && !url.username && !url.password ? url.toString() : undefined; }
  catch { return undefined; }
}

export default function Preview({ data, now, connectionStale }: { data: GameDashboard; now: number; connectionStale: boolean }) {
  const live = data.live;
  const frame = live?.frame;
  const age = live ? Math.max(0, Math.floor((now - Date.parse(live.receivedAt)) / 1000)) : null;
  const ended = frame && ["caught", "escaped", "abandoned"].includes(frame.status);
  const stale = connectionStale || !!live?.stale || (age != null && age > 8);
  const label = !live ? "Next layout" : ended ? "Last attempt" : stale ? "Stale preview" : frame?.status === "paused" ? "Paused" : "Live";
  const attempts = data.attempts.map((attempt, i) => ({ ...attempt, number: data.totals.attempts - data.attempts.length + i + 1 })).slice(-10).reverse();
  return <>
    <section className={styles.sentryRecordings} aria-labelledby="game-recordings-heading">
      <div className={styles.recordingsHeading}><div><h3 id="game-recordings-heading">Recordings &amp; model data</h3><p>Gameplay → Sentry → tower-placement model</p></div><span className={styles.status} data-stale={data.sentry?.status === "error"}>{!data.sentry ? "Checking connection" : data.sentry.status === "unconfigured" ? "Setup needed" : data.sentry.status === "syncing" ? "Syncing attempts" : data.sentry.status === "error" ? "Needs attention" : "Connected"}</span></div>
      <p className={styles.note}>{data.sentry?.message ?? "Restart the updated game service to connect Sentry recordings and attempt data."}</p>
      {data.sentry && <dl className={styles.ingestionCounts}><div><dt>Waiting for import</dt><dd>{data.sentry.pending}</dd></div><div><dt>Imported from Sentry</dt><dd>{data.sentry.imported}</dd></div><div><dt>Needs attention</dt><dd>{data.sentry.failed}</dd></div></dl>}
      {attempts.length ? <div className={styles.tableWrap}><table><caption>Latest {attempts.length} opening runs · visual playback opens in Sentry</caption><thead><tr><th>Run</th><th>Outcome</th><th>Time</th><th>Model data</th><th>Recording</th></tr></thead><tbody>{attempts.map(attempt => {
        const replay = sentryUrl(attempt.sentry?.replayUrl);
        const modelStatus = attempt.sentry?.state === "imported" && (!attempt.verified || attempt.outcome === "abandoned") ? "Imported · excluded from learning" : attempt.sentry ? ingestionName[attempt.sentry.state] : "Waiting to upload";
        return <tr key={attempt.id}><th>{attempt.number}<small>Layout {attempt.layoutVersion}</small></th><td>{outcomeName[attempt.outcome]}</td><td>{seconds(attempt.seconds)}</td><td>{modelStatus}{attempt.sentry?.error && <small>{attempt.sentry.error}</small>}</td><td>{replay ? <a href={replay} target="_blank" rel="noopener noreferrer" aria-label={`Open Sentry replay for run ${attempt.number}`}>Open replay <span aria-hidden="true">↗</span></a> : <span className={styles.recordingUnavailable}>{attempt.sentry?.replayId ? "Replay recorded · link pending" : "No Sentry replay"}</span>}</td></tr>;
      })}</tbody></table></div> : <p className={styles.recordingEmpty}>Start a game to collect the first recording. Completed attempts will appear here with their Sentry replay link and import status.</p>}
      <p className={styles.note}>The model learns from recorded controls, positions, and outcomes retrieved from Sentry. Visual replays let you inspect the gameplay. Earlier runs retain their attempt data, but cannot gain a Sentry visual recording retroactively.</p>
    </section>
    <div className={styles.previewHeader}><div><h3 id="game-preview-heading">Opening stretch · 2D game preview</h3><p>{live ? `Layout ${live.layoutVersion} · ${seconds(frame!.time)} elapsed${ended ? ` · ${outcomeName[frame!.status as keyof typeof outcomeName]}` : ""}` : `Layout ${data.layout.version} is ready for the next player.`}</p></div><span className={styles.status} data-stale={stale && !ended} data-live={label === "Live"}>{label}</span></div>
    <div className={styles.previewLayout}><GameMap data={data} frame={frame} path={live?.path ?? []} /><aside className={styles.previewInfo}>
      <h4>{live ? "Player’s opening run" : "Waiting for a player"}</h4><p>{!live ? "Open the game and start a run. Ship and aircraft positions will appear here as the player moves." : ended ? "The final frame and route are shown here. Use the recordings above to review gameplay in Sentry, or watch this view for the next live player." : stale ? "Position updates have stopped. This is the last received frame; it is not moving live." : frame?.status === "paused" ? "The player paused the game. The run clock and tower layout are held." : "Receiving ship, tower, drone, and plane positions from the game."}</p>
      <dl><div><dt>Radar contact</dt><dd>{frame ? frame.detected ? "Detected" : "Clear" : "Awaiting play"}</dd></div><div><dt>Drone capture progress</dt><dd>{frame ? percent(frame.tagProgress) : "—"}</dd></div><div><dt>Last frame received</dt><dd>{age == null ? "—" : `${age} s ago`}</dd></div><div><dt>Protected start</dt><dd>{data.policy.spawnProtectionMetres} m tower-free</dd></div></dl>
      <p className={styles.note}>Terrain comes from the game’s height map. Radar sectors show their 60° field of view; terrain can block visibility inside a sector.</p>
    </aside></div>
    <div className={styles.mapLegend}><span><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2L16 16 10 13 4 16Z" fill="#edc68a" /></svg>Ship &amp; route</span><span><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="5" y="5" width="10" height="10" fill="none" stroke="#b6d4b2" strokeWidth="2" /></svg>Tower &amp; radar</span><span><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 4l12 12M16 4L4 16" stroke="#cad7ee" strokeWidth="2" /></svg>Drone</span><span><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 1v17M2 10h16M6 17h8" stroke="#cad7ee" strokeWidth="2" /></svg>Plane</span><span>Dashed circle: protected start</span></div>
  </>;
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
