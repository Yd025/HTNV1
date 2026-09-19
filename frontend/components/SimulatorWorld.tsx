import { useEffect, useRef, useState } from "react";
import * as Sentry from "@sentry/nextjs";
import { SENTRY_BASE } from "../lib/sentry";
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
const CAMERA_VIEWS = [
  { id: "orbit", label: "Orbit", detail: "Follow while you orbit and zoom" },
  { id: "chase", label: "Chase", detail: "Starboard-aft chase aligned with heading" },
  { id: "stern", label: "Stern", detail: "Centered behind the ship" },
  { id: "bow", label: "Bow-on", detail: "Ahead of the bow, looking back" },
  { id: "port", label: "Port", detail: "Left-side profile" },
  { id: "starboard", label: "Starboard", detail: "Right-side profile" },
  { id: "portQuarter", label: "Port quarter", detail: "Left rear three-quarter view" },
  { id: "starboardQuarter", label: "Starboard quarter", detail: "Right rear three-quarter view" },
  { id: "waterline", label: "Waterline", detail: "Low side-on identification view" },
  { id: "overhead", label: "Overhead", detail: "Top-down movement and heading" },
  { id: "wide", label: "Wide aerial", detail: "High context view around the ship" },
  { id: "bridge", label: "Forward POV", detail: "Elevated view looking past the bow" },
  { id: "free", label: "Free", detail: "Unlink the camera and navigate manually" },
] as const;
type CameraMode = typeof CAMERA_VIEWS[number]["id"];
type ViewerStatus = { connected: boolean; matched: string[]; shipAvailable?: boolean; followingShip?: boolean; cameraMode?: CameraMode };
type CaptureWindow = Window & { __overwatchCaptureCanvas?: (canvas: HTMLCanvasElement) => void };
const format = (value: unknown, unit = "") => typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(1)}${unit}` : "Unavailable";

/** Reuses mission telemetry; the embedded native viewer owns all model poses. */
export default function SimulatorWorld({ state, isFresh, selected, onSelect, colors }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const latest = useRef({ state, isFresh, selected, colors });
  latest.current = { state, isFresh, selected, colors };
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [tags, setTags] = useState(true);
  const [cameraMode, setCameraMode] = useState<CameraMode>("orbit");
  const [recording, setRecording] = useState(false);
  const [replayBusy, setReplayBusy] = useState(false);
  const [replayId, setReplayId] = useState<string>();
  const [replayMessage, setReplayMessage] = useState("");
  const [captureAvailable, setCaptureAvailable] = useState(false);
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
        const reportedMode = CAMERA_VIEWS.some(view => view.id === message.cameraMode) ? message.cameraMode as CameraMode : undefined;
        setViewer({ connected: message.connected === true, matched: message.matched.filter((id: unknown) => typeof id === "string"), shipAvailable: message.shipAvailable === true, followingShip: message.followingShip === true, cameraMode: reportedMode });
      }
      if (message.type === "overwatch:select" && typeof message.id === "string" &&
        Object.values(latest.current.state.fleet ?? {}).some(vehicle => vehicle.vehicle_id === message.id)) onSelect(message.id);
    };
    window.addEventListener("message", receive);
    const timeout = window.setTimeout(() => setFailed(true), 15000);
    return () => { window.removeEventListener("message", receive); window.clearTimeout(timeout); };
  }, [onSelect]);

  useEffect(() => { if (ready) sendState(); }, [state, isFresh, selected, tags, colors, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (ready) frame.current?.contentWindow?.postMessage(JSON.stringify({ type: "overwatch:camera", version: 1, mode: cameraMode }), window.location.origin);
  }, [ready, cameraMode]);

  useEffect(() => {
    const target = frame.current?.contentWindow as CaptureWindow | null;
    if (!ready || !target) return;
    let active = true;
    const integration = Sentry.getClient()?.getIntegrationByName<ReturnType<typeof Sentry.replayCanvasIntegration>>("ReplayCanvas");
    setCaptureAvailable(Boolean(integration));
    target.__overwatchCaptureCanvas = (canvas) => {
      if (!integration || !Sentry.getReplay()?.getReplayId() || canvas.ownerDocument !== target.document) return;
      canvas.setAttribute("data-sentry-native-canvas", "true");
      void integration.snapshot(canvas, { skipRequestAnimationFrame: true }).catch(() => {
        if (active) setReplayMessage("Canvas capture unavailable. Browser interactions can still be recorded.");
      });
    };
    return () => { active = false; delete target.__overwatchCaptureCanvas; };
  }, [ready]);

  async function toggleReplay() {
    const replay = Sentry.getReplay();
    if (!replay || replayBusy) return;
    setReplayBusy(true);
    try {
      if (recording) {
        await replay.stop();
        setRecording(false);
        setReplayMessage("Replay stopped. Open it in Sentry to confirm uploaded segments.");
      } else {
        // flush promotes an error-only buffer to a full recording, or starts one.
        await replay.flush();
        const id = replay.getReplayId(true);
        setReplayId(id); setRecording(Boolean(id));
        setReplayMessage(id ? "Recording native camera frames and browser interactions." : "Replay could not start. Check Sentry configuration.");
        Sentry.addBreadcrumb({ category: "simulator.camera", message: "Record native ship view", level: "info" });
      }
    } catch { setReplayMessage("Replay request failed. Check your network and Sentry configuration."); }
    finally { setReplayBusy(false); }
  }

  function focus() {
    chooseCamera("free");
    frame.current?.contentWindow?.postMessage(JSON.stringify({ type: "overwatch:focus", version: 1, id: selected }), window.location.origin);
  }

  function chooseCamera(mode: CameraMode) {
    setCameraMode(mode);
    Sentry.addBreadcrumb({ category: "simulator.camera", message: `Camera view: ${mode}`, data: { mode }, level: "info" });
  }

  const selectedView = CAMERA_VIEWS.find(view => view.id === cameraMode)!;
  const cameraStatus = !ready ? "Waiting for native viewer"
    : cameraMode === "free" ? "Free camera · drag, pan and zoom manually"
    : !viewer.connected ? `${selectedView.label} paused · world disconnected`
    : !viewer.shipAvailable ? `${selectedView.label} waiting for target_vessel`
    : viewer.followingShip && viewer.cameraMode === cameraMode ? `${selectedView.label} active · ${selectedView.detail}`
    : `Switching to ${selectedView.label.toLowerCase()}`;

  return <div className={s.world}>
    <div className={s.toolbar}>
      <label className={s.tags}><input type="checkbox" checked={tags} onChange={event => setTags(event.target.checked)} />Object tags</label>
      <label className={s.picker}><span className={s.srOnly}>Inspect simulator asset</span><select value={asset?.vehicle_id ?? ""} onChange={event => onSelect(event.target.value || null)}><option value="">Inspect an object…</option>{fleet.map(vehicle => <option key={vehicle.vehicle_id} value={vehicle.vehicle_id}>{vehicle.vehicle_id}</option>)}</select></label>
      <button type="button" onClick={focus} disabled={!ready || !asset || !viewer.matched.includes(asset.vehicle_id)}>Locate</button>
      <button type="button" onClick={() => void toggleReplay()} disabled={!ready || !captureAvailable || replayBusy}>{replayBusy ? "Updating replay…" : recording ? "Stop replay recording" : "Record this view"}</button>
      {replayId && <a href={`${SENTRY_BASE}/replays/${replayId}/`} target="_blank" rel="noreferrer">Open replay ↗</a>}
      <span className={s.sync} role="status">{!ready ? failed ? "Viewer unavailable · reload below" : "Connecting to world…" : !viewer.connected ? "World connection lost" : `${viewer.matched.length}/${fleet.length} objects linked · ${isFresh ? "live tags" : "tags stale"}`}</span>
    </div>
    <div className={s.cameraViews}>
      <span>Ship camera views</span>
      <div role="group" aria-label="Ship camera views">{CAMERA_VIEWS.map(view => <button key={view.id} type="button" aria-pressed={cameraMode === view.id} title={view.detail} disabled={!ready} onClick={() => chooseCamera(view.id)}>{view.label}</button>)}</div>
    </div>
    <div className={s.cameraStatus} role="status">
      <span>{cameraStatus}. Native simulator position · observer view.</span>
      {replayMessage && <span>{replayMessage}</span>}
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
