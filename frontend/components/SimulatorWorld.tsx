import { useEffect, useRef, useState } from "react";
import * as Sentry from "@sentry/nextjs";
import { SENTRY_BASE } from "../lib/sentry";
import type { ThemeColors } from "../lib/theme";
import type { SwarmState, TelemetrySample, VehicleClass } from "../lib/types";
import { Icon } from "./ui/Icons";
import s from "./SimulatorWorld.module.css";

type Props = {
  state: SwarmState;
  isFresh: boolean;
  selected: string | null;
  onSelect: (id: string | null) => void;
  colors: ThemeColors;
};
const CAMERA_VIEWS = [
  { id: "orbit", label: "Follow ship", detail: "Drag to orbit · scroll to zoom" },
  { id: "free", label: "Free", detail: "Unlink the camera and navigate manually" },
] as const;
const ROLE_LABELS: Record<string, string> = { search: "Search area", cue: "Cue sensors", track: "Track ship", confirm: "Confirm contact", reserve: "Stand by" };
const CLASS_LABELS: Record<string, string> = { tower: "Sensor tower", plane: "Search plane", copter: "Quadcopter", rover: "Ground rover" };
type CameraMode = typeof CAMERA_VIEWS[number]["id"];
type NativeAsset = { id: string; vehicleClass: VehicleClass };
type ViewerStatus = { connected: boolean; matched: string[]; assets?: NativeAsset[]; shipAvailable?: boolean; followingShip?: boolean; cameraMode?: CameraMode };
type CaptureWindow = Window & { __overwatchCaptureCanvas?: (canvas: HTMLCanvasElement) => void };
const format = (value: unknown, unit = "") => typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(1)}${unit}` : "Unavailable";

/** Reuses mission telemetry; the embedded native viewer owns all model poses. */
export default function SimulatorWorld({ state, isFresh, selected, onSelect, colors }: Props) {
  const frame = useRef<HTMLIFrameElement>(null);
  const nativeIds = useRef<string[]>([]);
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
  const reportedFleet = state.adapter === "whiteout" ? Object.values(state.fleet ?? {}) : [];
  const fleet: TelemetrySample[] = [...reportedFleet, ...(viewer.assets ?? []).filter(item => !reportedFleet.some(vehicle => vehicle.vehicle_id === item.id)).map(item => ({ vehicle_id: item.id, vehicle_class: item.vehicleClass, lat: null, lon: null }))];
  const asset = fleet.find(vehicle => vehicle.vehicle_id === selected);
  const assetHasTelemetry = reportedFleet.some(vehicle => vehicle.vehicle_id === selected);
  const canLocate = (id: string) => ready && viewer.connected && (viewer.matched.includes(id) || (viewer.assets ?? []).some(item => item.id === id));

  function sendState() {
    const current = latest.current;
    // gzweb's existing message listener expects strings.
    frame.current?.contentWindow?.postMessage(JSON.stringify({
      type: "overwatch:telemetry", version: 1, fresh: current.isFresh && current.state.adapter === "whiteout",
      selected: current.selected, tags, colors: current.colors,
      fleet: (current.state.adapter === "whiteout" ? Object.values(current.state.fleet ?? {}) : []).map(vehicle => ({
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
        const assets: NativeAsset[] = Array.isArray(message.assets) ? message.assets.slice(0, 128).filter((item: NativeAsset) => item && typeof item.id === "string" && item.id.length <= 100 && Object.hasOwn(CLASS_LABELS, item.vehicleClass)) : [];
        nativeIds.current = assets.map(item => item.id);
        setViewer({ connected: message.connected === true, matched: message.matched.filter((id: unknown) => typeof id === "string"), assets, shipAvailable: message.shipAvailable === true, followingShip: message.followingShip === true, cameraMode: reportedMode });
      }
      if (message.type === "overwatch:select" && typeof message.id === "string" &&
        (nativeIds.current.includes(message.id) || latest.current.state.adapter === "whiteout" && Object.values(latest.current.state.fleet ?? {}).some(vehicle => vehicle.vehicle_id === message.id))) onSelect(message.id);
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

  function focus(id: string) {
    onSelect(id);
    chooseCamera("free");
    frame.current?.contentWindow?.postMessage(JSON.stringify({ type: "overwatch:focus", version: 1, id }), window.location.origin);
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
      <button type="button" aria-pressed={cameraMode === "orbit"} disabled={!ready} onClick={() => { onSelect(null); chooseCamera("orbit"); }}>Follow ship</button>
      <button type="button" onClick={() => void toggleReplay()} disabled={!ready || !captureAvailable || replayBusy}>{replayBusy ? "Updating replay…" : recording ? "Stop replay recording" : "Record this view"}</button>
      {replayId && <a href={`${SENTRY_BASE}/replays/${replayId}/`} target="_blank" rel="noreferrer">Open replay ↗</a>}
      <details className={s.options}><summary>View options</summary><div><label className={s.tags}><input type="checkbox" checked={tags} onChange={event => setTags(event.target.checked)} />Object labels</label><button type="button" disabled={!ready} onClick={() => chooseCamera("free")}>Free camera</button><a href={process.env.NEXT_PUBLIC_SIM_VIEWER_URL ?? "http://127.0.0.1:8080"} target="_blank" rel="noreferrer">Full simulator controls ↗</a></div></details>
      <span className={s.sync} role="status">{!ready ? failed ? "Viewer unavailable · reload below" : "Connecting to world…" : !viewer.connected ? "World connection lost" : state.adapter !== "whiteout" ? `${fleet.length} native objects · mission assignments unavailable` : `${viewer.matched.length}/${reportedFleet.length} objects linked · ${isFresh ? "live tags" : "tags stale"}`}</span>
    </div>
    <section className={s.assets} aria-label="Mission assets and assigned roles">
      <div className={s.assetHeading}><strong>Mission assets</strong><span>{state.adapter !== "whiteout" ? "Native objects" : !isFresh ? "Last received assignments" : "Assigned roles"} · select to locate</span></div>
      <div className={s.assetList}>{fleet.map(vehicle => {
        const located = canLocate(vehicle.vehicle_id);
        const reports = state.adapter === "whiteout" ? state.detections?.filter(detection => detection.source_id === vehicle.vehicle_id).length ?? 0 : 0;
        return <button key={vehicle.vehicle_id} type="button" aria-pressed={selected === vehicle.vehicle_id} aria-label={`${located ? "Locate" : "Inspect"} ${vehicle.vehicle_id}, ${CLASS_LABELS[vehicle.vehicle_class ?? ""] ?? "asset"}, assigned to ${ROLE_LABELS[vehicle.role ?? ""] ?? "unassigned"}`} onClick={() => located ? focus(vehicle.vehicle_id) : onSelect(vehicle.vehicle_id)} data-role={vehicle.role}>
          <Icon name={vehicle.vehicle_class ?? "fleet"} /><span><strong>{vehicle.vehicle_id}</strong><small>{CLASS_LABELS[vehicle.vehicle_class ?? ""] ?? "Asset"} · {ROLE_LABELS[vehicle.role ?? ""] ?? "Assignment unavailable"}</small><small>{!located ? "World position unavailable" : reports ? `${reports} detection report${reports === 1 ? "" : "s"} in ${isFresh ? "current" : "last"} frame` : "Locate in world ↗"}</small></span>
        </button>;
      })}{!fleet.length && <p>Waiting for fleet assignments.</p>}</div>
    </section>
    <div className={s.cameraStatus} role="status">
      <span>{cameraStatus}. Native simulator position · observer view.</span>
      {replayMessage && <span>{replayMessage}</span>}
    </div>
    <div className={s.viewport}>
      <iframe ref={frame} src="/api/simulator-viewer" title="ArcticSim live 3D terrain, fleet and mission tags" allow="fullscreen" allowFullScreen />
      {!ready && !failed && <div className={s.loading} role="status">Loading terrain and live object tags…</div>}
      {asset && <section className={s.inspector} aria-label={`Selected object ${asset.vehicle_id}`}>
        <div className={s.inspectorHead}><strong>{asset.vehicle_id}</strong><span>{CLASS_LABELS[asset.vehicle_class ?? ""] ?? "Asset"} · {ROLE_LABELS[asset.role ?? ""] ?? "Assignment unavailable"}</span><button type="button" onClick={() => onSelect(null)} aria-label="Close object details">Close</button></div>
        {assetHasTelemetry ? <>
        <dl><div><dt>Altitude</dt><dd>{format(asset.alt, " m")}</dd></div><div><dt>Speed</dt><dd>{format(asset.groundspeed, " m/s")}</dd></div><div><dt>Heading</dt><dd>{format(asset.heading, "°")}</dd></div><div><dt>Battery</dt><dd>{typeof asset.battery_remaining === "number" && asset.battery_remaining >= 0 ? format(asset.battery_remaining, "%") : "Unavailable"}</dd></div></dl>
        <p>{!isFresh ? "Last received telemetry · " : ""}{asset.mavlink ? "MAVLink connected" : "Vehicle link unavailable"} · {asset.mode ?? "Mode unavailable"}{asset.armed == null ? "" : asset.armed ? " · Armed" : " · Disarmed"}</p>
        <p>Intent: {state.intents?.[asset.vehicle_id] ?? "Unavailable"}{!canLocate(asset.vehicle_id) ? " · Waiting for this object in the world" : ""}</p>
        <p>Assigned task only; visual contact is not confirmed by a role.</p>
        </> : <p>Located from the native scene. Mission telemetry and assigned role are unavailable for this object.</p>}
      </section>}
    </div>
  </div>;
}
