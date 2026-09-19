import Head from "next/head";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import BackendEvidence from "../components/BackendEvidence";
import MissionObservability from "../components/MissionObservability";
import CameraRail from "../components/CameraRail";
import SimulatorWorld from "../components/SimulatorWorld";
import { BrandMark, Icon } from "../components/ui/Icons";
import { useMissionTelemetry } from "../hooks/useMissionTelemetry";
import { DEFAULT_ARENA, llToNe } from "../lib/geo";
import { themes, themeStyle, type ThemeId } from "../lib/theme";
import type { SwarmState, TelemetrySample } from "../lib/types";
import s from "../styles/BackendPreview.module.css";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
const READ_API = "/api/backend-preview";
const SIM_VIEWER = process.env.NEXT_PUBLIC_SIM_VIEWER_URL ?? "http://127.0.0.1:8080";
const Scene = dynamic(() => import("../components/TacticalScene"), { ssr: false, loading: () => <p className={s.empty}>Loading the 3D arena…</p> });
type Health = { backend?: string; database_status?: string; advisor_status?: string; sentry?: boolean; deployed?: boolean };
type Simulator = { site: { ok?: boolean; name?: string; extent_m?: number }; assets: { ok?: boolean; assets?: { name: string; rostered: boolean; mavlink: boolean; camera: boolean }[] }; status: { state?: string; detail?: string } };
const number = (value: unknown, digits = 1) => typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—";
const percent = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? `${Math.round(value * 100)}%` : "Unavailable";

export default function BackendPreview() {
  const telemetry = useMissionTelemetry();
  const { state, isFresh, hasReceived } = telemetry;
  const [theme, setTheme] = useState<ThemeId>("ink");
  const [viewChoice, setView] = useState<"simulator" | "2d" | "3d" | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [truth, setTruth] = useState(false);
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [simulator, setSimulator] = useState<Simulator | null>(null);
  const [simulatorError, setSimulatorError] = useState(false);
  const [viewerAttempt, setViewerAttempt] = useState(0);
  const monitorRef = useRef<HTMLDivElement>(null);
  const [monitorExpanded, setMonitorExpanded] = useState(false);
  const [monitorError, setMonitorError] = useState<string | null>(null);
  const isSimulator = state.adapter === "whiteout";
  const view = viewChoice ?? (isSimulator ? "simulator" : "2d");
  const simulatorAssets = simulator?.assets.assets?.filter(asset => asset.rostered) ?? [];
  const fleet = Object.values(state.fleet ?? {});
  const asset = selected ? state.fleet?.[selected] : null;
  const track = state.track;
  const mode = state.run?.mode ?? (state.adapter === "local" ? "synthetic" : state.adapter ?? "waiting");
  const status = isFresh ? "Live connection" : state.status === "complete" ? "Replay complete" : hasReceived ? "Telemetry paused or stale" : "Connecting to backend";

  useEffect(() => {
    try { const saved = localStorage.getItem("overwatch-theme"); if (saved && saved in themes) setTheme(saved as ThemeId); } catch {}
  }, []);
  useEffect(() => {
    const changed = () => setMonitorExpanded(document.fullscreenElement === monitorRef.current);
    document.addEventListener("fullscreenchange", changed);
    return () => document.removeEventListener("fullscreenchange", changed);
  }, []);
  useEffect(() => {
    if (!isSimulator) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController;
    const poll = async () => {
      controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 7000);
      try {
        const [site, assets, status] = await Promise.all(["site", "assets", "status"].map(async resource => {
          const response = await fetch(`${READ_API}/simulator/${resource}`, { signal: controller.signal, cache: "no-store" });
          if (!response.ok) throw new Error("Simulator status unavailable");
          return response.json();
        }));
        if (!site || !assets || !status || !Array.isArray(assets.assets)) throw new Error("Invalid simulator status");
        if (!stopped) { setSimulator({ site, assets, status }); setSimulatorError(false); }
      } catch { if (!stopped) setSimulatorError(true); }
      finally { clearTimeout(timeout); if (!stopped) timer = setTimeout(poll, 10000); }
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); controller?.abort(); };
  }, [isSimulator]);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController;
    const poll = async () => {
      controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 2500);
      try {
        const response = await fetch(`${READ_API}/health`, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error("Health unavailable");
        const payload = await response.json();
        if (!payload || typeof payload.backend !== "string") throw new Error("Invalid health response");
        if (!stopped) { setHealth(payload); setHealthError(false); }
      } catch { if (!stopped) setHealthError(true); }
      finally { clearTimeout(timeout); if (!stopped) timer = setTimeout(poll, 3000); }
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); controller?.abort(); };
  }, []);
  useEffect(() => { if (selected && !state.fleet?.[selected]) setSelected(null); }, [selected, state.fleet]);

  function download() {
    try {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = `overwatch-${state.run?.sequence ?? "snapshot"}.json`; anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000); setDownloadError(null);
    } catch { setDownloadError("Snapshot download failed. You can still inspect the full payload below."); }
  }

  async function expandMonitor() {
    setMonitorError(null);
    try {
      if (document.fullscreenElement === monitorRef.current) await document.exitFullscreen();
      else if (monitorRef.current?.requestFullscreen) await monitorRef.current.requestFullscreen();
      else throw new Error("Fullscreen unavailable");
    } catch {
      setMonitorError("This browser could not expand the monitor. Open this page in a wider browser window to view the world and cameras side by side.");
    }
  }

  return <>
    <MissionObservability telemetry={telemetry} />
    <Head><title>Overwatch | Backend live preview</title><meta name="description" content="Overwatch mission telemetry, sensor cameras, and the connected ArcticSim world." /></Head>
    <main className={s.page} style={themeStyle(theme)}>
      <header className={s.header}>
        <a href="/" className={s.brand}><BrandMark /><span>OVERWATCH</span></a>
        <nav aria-label="Preview sections"><a href="#arena">World</a><a href="#cameras">Cameras</a><a href="#fleet">Fleet</a><a href="#evidence">Evidence</a><a href="#services">System</a><a href="/sentry">Sentry</a></nav>
        <label className={s.theme}>Appearance<select value={theme} onChange={e => setTheme(e.target.value as ThemeId)}>{Object.values(themes).map(t => <option value={t.id} key={t.id}>{t.name}</option>)}</select></label>
      </header>

      <div className={s.content}>
        <div className={s.titleRow}>
          <div><h1>Backend, in view.</h1><p>A live view of the fleet, its decisions, and the evidence behind them.</p></div>
          <div className={s.titleActions}><span className={`${s.status} ${isFresh ? s.online : s.warning}`}><span />{status}</span><button onClick={download} disabled={!hasReceived}>Save snapshot</button></div>
        </div>
        <div className={s.context}><span className={s.mode}>{isSimulator ? "ArcticSim simulation" : mode === "synthetic" ? "Synthetic simulation" : `${mode} mode`}</span><span>Temporary preview · {isSimulator ? "simulator + mission telemetry" : "read only"}</span><span>{number(telemetry.receivedHz)} frames/s</span><span>Frame age {number(telemetry.ageSeconds)} s</span><span>Sequence {state.run?.sequence?.toLocaleString() ?? "—"}</span></div>
        {!isFresh && <p className={s.notice} role="status">{hasReceived ? "Showing the last received state. Values are not current until telemetry resumes." : `Waiting for the backend telemetry stream. This page reconnects automatically.`}</p>}
        {downloadError && <p className={s.notice} role="alert">{downloadError}</p>}

        <div id="arena" className={s.monitor} ref={monitorRef}>
          <div className={s.monitorTools}><span>World and camera feeds</span><button type="button" onClick={() => void expandMonitor()} aria-pressed={monitorExpanded}>{monitorExpanded ? "Exit expanded view" : "Expand monitor"}</button></div>
          {monitorError && <p className={s.notice} role="status">{monitorError}</p>}
        <section className={s.operational} aria-labelledby="arena-title">
          <div className={s.arenaColumn}>
            <div className={`${s.sectionHead} ${s.worldHead}`}><div><h2 id="arena-title">{view === "simulator" ? "Simulator world" : "Operational picture"}</h2><p>{view === "simulator" ? `${simulator?.site.name?.replace(/_/g, " ") ?? "ArcticSim"} · native terrain, live objects and mission tags` : "Schematic view · stand-in arena, not Dominion terrain"}</p></div><div className={s.switch} aria-label="World view">{isSimulator && <button aria-pressed={view === "simulator"} onClick={() => setView("simulator")}>Simulator world</button>}<button aria-pressed={view === "2d"} onClick={() => setView("2d")}>2D plot</button><button aria-pressed={view === "3d"} onClick={() => setView("3d")}>3D schematic</button></div></div>
            <div className={`${s.map} ${view === "simulator" ? s.simulatorMap : ""}`}>
              {view === "simulator" ? <SimulatorWorld key={viewerAttempt} state={state} isFresh={isFresh} selected={selected} onSelect={setSelected} colors={themes[theme].colors} /> : !hasReceived ? <div className={s.empty}>The arena appears when the first state arrives.</div> : view === "2d" ? <ArenaPlot state={state} selected={selected} select={setSelected} showTruth={truth} /> : <Scene fleet={state.fleet ?? {}} track={track ?? null} truth={truth ? state.truth ?? null : null} heatmap={state.heatmap ?? []} strategy={telemetry.strategy} arena={state.arena} scene={themes[theme].scene} selectedVehicleId={selected} onSelectVehicle={setSelected} />}
            </div>
            <div className={s.worldFooter}>{view === "simulator" ? <><div className={s.simulatorStatus}><span className={simulatorError ? s.warning : ""}>{simulatorError ? "Simulator status unavailable · retrying" : simulator?.site.ok ? `Site: ${simulator.site.name?.replace(/_/g, " ")} · ${number((simulator.site.extent_m ?? 0) / 1000)} km terrain` : "Connecting to simulator status…"}</span>{simulator && !simulatorError && <span>{simulatorAssets.filter(asset => asset.mavlink).length}/{simulatorAssets.length} vehicle links · {simulatorAssets.filter(asset => asset.camera).length} camera endpoints</span>}{simulator?.status.state && simulator.status.state !== "idle" && <span>{simulator.status.state}: {simulator.status.detail}</span>}</div><div className={s.viewerActions}><span>Select a tag to inspect live telemetry. Target estimates and coverage remain in the schematic.</span><button onClick={() => { setViewerAttempt(attempt => attempt + 1); }}>Reload world</button><a href={SIM_VIEWER} target="_blank" rel="noreferrer">Open full viewer</a></div></> : <div className={s.mapFooter}><span><i className={s.targetKey} />Target estimate</span><span><i className={s.coverageKey} />Observed cells</span><label><input type="checkbox" checked={truth} disabled={!state.truth} onChange={e => setTruth(e.target.checked)} />Evaluation truth</label><span>{number((state.arena?.half_m ?? 0) * 2 / 1000)} km arena</span></div>}</div>
          </div>
          <section id="cameras" className={s.cameras} aria-labelledby="cameras-title">
            <div className={s.sectionHead}><div><h2 id="cameras-title">Camera feeds</h2><p>{isSimulator ? "Live sensor images from the same ArcticSim world." : "Cameras supplied by the active adapter."}</p></div></div>
            <CameraRail apiUrl={READ_API} adapter={state.adapter} />
            <p className={s.cameraNote}>All available feeds refresh together while visible. Each timestamp marks the latest received image.</p>
          </section>
        </section>
        </div>

        <section className={s.trackPanel} aria-labelledby="target-title">
          <div className={s.trackIntro}>
            <div className={s.sectionHead}><h2 id="target-title">Target track</h2><Icon name="target" /></div>
            <div className={s.trackState}>{!isFresh && track ? "Last received estimate" : track ? (track.age_s != null && track.age_s > .5 ? "Predicting through a gap" : "Recent observation") : "Searching for contact"}</div>
            <p>{track ? `${track.class_hint ?? "Unknown class"} · existing shared target filter` : "No target estimate is being reported."}</p>
            <p className={s.explainer}>Confidence and uncertainty are filter estimates, not measured accuracy.</p>
          </div>
            <dl className={s.readings}>
              <Reading label="Latitude" value={number(track?.lat, 5)} /><Reading label="Longitude" value={number(track?.lon, 5)} />
              <Reading label="Speed" value={`${number(track?.speed_mps)} m/s`} /><Reading label="Filter age" value={`${number(track?.age_s)} s`} />
              <Reading label="Heuristic confidence" value={percent(track?.confidence)} /><Reading label="Scalar uncertainty" value={`${number(track?.sigma_m)} m σ`} />
              <Reading label="North / east velocity" value={`${number(track?.vn)} / ${number(track?.ve)} m/s`} />
            </dl>
            <div className={s.intent}><span>Mission intent · {state.c2?.phase ?? "waiting"}</span><strong>{state.c2?.intent ?? "Waiting for mission tasking."}</strong></div>
        </section>

        <section className={s.scores} aria-label="Mission scores">
          <Score label="Coverage" value={state.scores?.coverage} note={`${state.scores?.cells_seen ?? "—"} / ${state.scores?.cells_total ?? "—"} cells observed`} />
          <Score label="Collaboration" value={state.scores?.collaboration} note={`${state.scores?.unique_roles ?? "—"} distinct roles · ${percent(state.scores?.overlap_ratio)} overlap`} />
          <Score label="Efficiency" value={state.scores?.efficiency} note={`${number(state.scores?.meters_flown, 0)} m traveled · ${state.scores?.commands_issued ?? "—"} sends`} />
          <Score label="Tracking accuracy" value={state.scores?.tracking} note={state.scores?.tracking == null ? "No independent truth available" : `${number(state.scores?.track_error_m)} m error against evaluation truth`} />
        </section>

        <section id="fleet" className={s.fleet}>
          <div className={s.sectionHead}><div><h2>Fleet & current intent</h2><p>Select an asset to inspect its telemetry. Locate it in the simulator world, 2D plot or 3D schematic.</p></div><span>{fleet.length} assets</span></div>
          <div className={s.tableWrap}><table><thead><tr><th>Asset</th><th>Role</th><th>Intent</th><th>Altitude</th><th>Speed</th><th>Heading</th><th>Battery</th><th>Position</th></tr></thead><tbody>{fleet.map(v => <tr key={v.vehicle_id} data-selected={selected === v.vehicle_id}><th><button onClick={() => setSelected(selected === v.vehicle_id ? null : v.vehicle_id)} aria-pressed={selected === v.vehicle_id}><Icon name={v.vehicle_class ?? "fleet"} />{v.vehicle_id}</button><small>{v.vehicle_class} · {v.mavlink ? "MAVLink" : isSimulator ? "Disconnected" : "local"}</small></th><td>{v.role ?? "Unassigned"}</td><td>{state.intents?.[v.vehicle_id] ?? "—"}</td><td>{number(v.alt)} m</td><td>{number(v.groundspeed)} m/s</td><td>{number(v.heading, 0)}°</td><td>{typeof v.battery_remaining === "number" && v.battery_remaining >= 0 ? `${number(v.battery_remaining, 0)}%` : "Unavailable"}</td><td>{number(v.lat, 4)}, {number(v.lon, 4)}</td></tr>)}</tbody></table>{!fleet.length && <p className={s.empty}>Fleet telemetry has not arrived.</p>}</div>
          {asset && <div className={s.selection}><strong>{asset.vehicle_id}</strong><span>Mode {asset.mode ?? "unknown"}</span><span>{asset.armed == null ? "Arming status unavailable" : asset.armed ? "Armed" : "Disarmed"}</span><span>System ID {asset.sysid ?? "—"}</span><button onClick={() => setSelected(null)}>Clear selection</button></div>}
        </section>

        <section id="services" className={s.services} aria-labelledby="services-title">
          <div><h2 id="services-title">System pulse</h2><p>{healthError ? "Health endpoint unavailable. Service details may be stale." : "Service health refreshes every three seconds."}</p></div>
          <div className={s.serviceRows}><Service name="Controller" value={healthError ? "Unavailable" : health?.backend ?? "Checking"} detail={`${number(state.tick_hz)} Hz`} /><Service name="Database" value={healthError ? "Unavailable" : health?.database_status ?? "Checking"} detail="Optional storage" /><Service name="Advisor" value={healthError ? "Unavailable" : health?.advisor_status ?? "Checking"} detail="Outside the control loop" /><Service name="Telemetry" value={telemetry.connection} detail={`${telemetry.frameCount.toLocaleString()} received · ${telemetry.reconnects} reconnects`} /></div>
        </section>
        <div id="evidence"><BackendEvidence state={state} /></div>
        <footer className={s.footer}><span>Connected to {API} · existing /ws/telemetry stream</span><a href="/">Open the full mission dashboard</a></footer>
      </div>
    </main>
  </>;
}

function Score({ label, value, note }: { label: string; value?: number | null; note: string }) {
  const valid = typeof value === "number" && Number.isFinite(value);
  return <div className={s.score}><span>{label}</span><strong>{valid ? Math.round(value * 100) : "—"}<small>{valid ? "/ 100" : "Unavailable"}</small></strong><div className={s.meter} aria-hidden="true"><div style={{ width: `${valid ? Math.max(0, Math.min(100, value * 100)) : 0}%` }} /></div><p>{note}</p></div>;
}
function Reading({ label, value }: { label: string; value: string }) { return <div><dt>{label}</dt><dd>{value}</dd></div>; }
function Service({ name, value, detail }: { name: string; value: string; detail: string }) { return <div><span>{name}</span><strong>{value}</strong><small>{detail}</small></div>; }

function ArenaPlot({ state, selected, select, showTruth }: { state: SwarmState; selected: string | null; select: (id: string | null) => void; showTruth: boolean }) {
  const arena = state.arena ?? DEFAULT_ARENA;
  const half = Math.max(1, arena.half_m);
  const point = (lat: number, lon: number) => { const { north, east } = llToNe(lat, lon, arena); return [430 + east / half * 220, 258 - north / half * 220]; };
  const vehicles = Object.values(state.fleet ?? {}).filter(v => typeof v.lat === "number" && typeof v.lon === "number");
  const target = state.track ? point(state.track.lat, state.track.lon) : null;
  const history = state.track?.history?.map(([lat, lon]) => point(lat, lon).join(",")).join(" ");
  return <svg className={s.plot} viewBox="150 0 560 530" role="img" aria-label="Live fleet positions and target trail in the local stand-in arena">
    <defs><clipPath id="preview-arena-clip"><rect x="210" y="38" width="440" height="440" /></clipPath></defs>
    <rect x="210" y="38" width="440" height="440" fill="var(--canvas)" stroke="var(--line-strong)" />
    {[0, 1, 2, 3, 4, 5, 6].map(i => <g key={i} stroke="var(--line)" strokeWidth=".7"><path d={`M${210 + i * 440 / 6} 38V478 M210 ${38 + i * 440 / 6}H650`} /></g>)}
    <g clipPath="url(#preview-arena-clip)">{state.heatmap?.map((cell, i) => { const [x, y] = point(cell.lat, cell.lon); return <rect key={i} x={x - 9} y={y - 9} width="18" height="18" fill="var(--text-muted)" opacity={Math.max(.05, Math.min(.35, cell.heat * .35))} />; })}
      {history && <polyline points={history} fill="none" stroke="var(--accent-text)" strokeWidth="2" opacity=".65" />}
      {target && <circle cx={target[0]} cy={target[1]} r={Math.max(4, (state.track?.sigma_m ?? 0) / half * 220)} fill="var(--accent-soft)" fillOpacity=".4" stroke="var(--accent-text)" strokeDasharray="3 4" />}
    </g>
    <text x="430" y="24" textAnchor="middle">NORTH</text><text x="430" y="505" textAnchor="middle">{number(half * 2 / 1000)} km · east / west</text><text x="199" y="44" textAnchor="end">+{number(half / 1000)} km</text><text x="199" y="262" textAnchor="end">0</text><text x="199" y="478" textAnchor="end">−{number(half / 1000)} km</text>
    {showTruth && state.truth && (() => { const [x, y] = point(state.truth.lat, state.truth.lon); return <g><circle cx={x} cy={y} r="9" fill="none" stroke="var(--text)" strokeWidth="1.5" /><title>Local evaluation truth</title></g>; })()}
    {vehicles.map((v: TelemetrySample) => { const [x, y] = point(v.lat!, v.lon!); return <g key={v.vehicle_id} className={s.assetMark} tabIndex={0} role="button" aria-label={`Select ${v.vehicle_id}`} aria-pressed={selected === v.vehicle_id} onClick={() => select(selected === v.vehicle_id ? null : v.vehicle_id)} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(v.vehicle_id); } }}>
      <circle cx={x} cy={y} r="19" fill="transparent" />{selected === v.vehicle_id && <circle cx={x} cy={y} r="15" fill="var(--accent-soft)" stroke="var(--accent-text)" />}
      {v.vehicle_class === "tower" ? <rect x={x - 5} y={y - 5} width="10" height="10" fill="var(--text)" /> : <path d={`M${x} ${y - 8}l6 13-6-3-6 3Z`} fill="var(--text)" transform={`rotate(${v.heading ?? 0} ${x} ${y})`} />}
      <text x={x + 13} y={y + (v.vehicle_class === "rover" ? 34 : v.vehicle_class === "copter" ? -24 : -9)} className={s.plotLabel}>{v.vehicle_id}</text>
    </g>; })}
    {target && <g><path d={`M${target[0]} ${target[1] - 7}l7 7-7 7-7-7Z`} fill="var(--accent-text)" /><text x={target[0] - 13} y={target[1] + 20} textAnchor="end" className={s.targetLabel}>Target estimate</text></g>}
  </svg>;
}
