import { useEffect, useRef, useState } from "react";
import type { ThemeColors } from "../lib/theme";
import type { SwarmState } from "../lib/types";
import s from "./SimulatorWorld.module.css";

type Props = {
  state: SwarmState;
  isFresh: boolean;
  selected: string | null;
  onSelect: (id: string | null) => void;
  colors: ThemeColors;
};
type ViewerStatus = { connected: boolean; matched: string[] };
const format = (value: unknown, unit = "") => typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(1)}${unit}` : "Unavailable";

/** Reuses mission telemetry; the embedded native viewer owns all model poses. */
export default function SimulatorWorld({ state, isFresh, selected, onSelect, colors }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const latest = useRef({ state, isFresh, selected, colors });
  latest.current = { state, isFresh, selected, colors };
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [tags, setTags] = useState(true);
  const [viewer, setViewer] = useState<ViewerStatus>({ connected: false, matched: [] });
  const fleet = Object.values(state.fleet ?? {});
  const asset = fleet.find(vehicle => vehicle.vehicle_id === selected);

  function sendState() {
    const current = latest.current;
    // gzweb's existing message listener expects strings.
    frame.current?.contentWindow?.postMessage(JSON.stringify({
      type: "overwatch:telemetry", version: 1, fresh: current.isFresh,
      selected: current.selected, tags, colors: current.colors,
      fleet: Object.values(current.state.fleet ?? {}).map(vehicle => ({
        id: vehicle.vehicle_id, role: vehicle.role, vehicleClass: vehicle.vehicle_class,
        alt: vehicle.alt, speed: vehicle.groundspeed, heading: vehicle.heading,
        battery: vehicle.battery_remaining, mode: vehicle.mode, linked: vehicle.mavlink,
      })),
    }), window.location.origin);
  }

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow) return;
      const message = event.data;
      if (!message || message.version !== 1) return;
      if (message.type === "overwatch:ready") { setReady(true); setFailed(false); }
      if (message.type === "overwatch:status" && Array.isArray(message.matched)) {
        setViewer({ connected: message.connected === true, matched: message.matched.filter((id: unknown) => typeof id === "string") });
      }
      if (message.type === "overwatch:select" && typeof message.id === "string" &&
        Object.values(latest.current.state.fleet ?? {}).some(vehicle => vehicle.vehicle_id === message.id)) onSelect(message.id);
    };
    window.addEventListener("message", receive);
    const timeout = window.setTimeout(() => setFailed(true), 15000);
    return () => { window.removeEventListener("message", receive); window.clearTimeout(timeout); };
  }, [onSelect]);

  useEffect(() => { if (ready) sendState(); }, [state, isFresh, selected, tags, colors, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  function focus() {
    frame.current?.contentWindow?.postMessage(JSON.stringify({ type: "overwatch:focus", version: 1, id: selected }), window.location.origin);
  }

  return <div className={s.world}>
    <div className={s.toolbar}>
      <label className={s.tags}><input type="checkbox" checked={tags} onChange={event => setTags(event.target.checked)} />Object tags</label>
      <label className={s.picker}><span className={s.srOnly}>Inspect simulator asset</span><select value={asset?.vehicle_id ?? ""} onChange={event => onSelect(event.target.value || null)}><option value="">Inspect an object…</option>{fleet.map(vehicle => <option key={vehicle.vehicle_id} value={vehicle.vehicle_id}>{vehicle.vehicle_id}</option>)}</select></label>
      <button type="button" onClick={focus} disabled={!ready || !asset || !viewer.matched.includes(asset.vehicle_id)}>Locate</button>
      <span className={s.sync} role="status">{!ready ? failed ? "Viewer unavailable · reload below" : "Connecting to world…" : !viewer.connected ? "World connection lost" : `${viewer.matched.length}/${fleet.length} objects linked · ${isFresh ? "live tags" : "tags stale"}`}</span>
    </div>
    <div className={s.viewport}>
      <iframe ref={frame} src="/api/simulator-viewer" title="ArcticSim live 3D terrain, fleet and mission tags" allow="fullscreen" allowFullScreen />
      {!ready && !failed && <div className={s.loading} role="status">Loading terrain and live object tags…</div>}
      {asset && <section className={s.inspector} aria-label={`Selected object ${asset.vehicle_id}`}>
        <div className={s.inspectorHead}><strong>{asset.vehicle_id}</strong><span>{asset.vehicle_class} · {asset.role ?? "Unassigned"}</span><button type="button" onClick={() => onSelect(null)} aria-label="Close object details">Close</button></div>
        <dl><div><dt>Altitude</dt><dd>{format(asset.alt, " m")}</dd></div><div><dt>Speed</dt><dd>{format(asset.groundspeed, " m/s")}</dd></div><div><dt>Heading</dt><dd>{format(asset.heading, "°")}</dd></div><div><dt>Battery</dt><dd>{typeof asset.battery_remaining === "number" && asset.battery_remaining >= 0 ? format(asset.battery_remaining, "%") : "Unavailable"}</dd></div></dl>
        <p>{!isFresh ? "Last received telemetry · " : ""}{asset.mavlink ? "MAVLink connected" : "Vehicle link unavailable"} · {asset.mode ?? "Mode unavailable"}{asset.armed == null ? "" : asset.armed ? " · Armed" : " · Disarmed"}</p>
        <p>Intent: {state.intents?.[asset.vehicle_id] ?? "Unavailable"}{!viewer.matched.includes(asset.vehicle_id) ? " · Waiting for this object in the world" : ""}</p>
      </section>}
    </div>
  </div>;
}
