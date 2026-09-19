import * as Sentry from "@sentry/nextjs";
import { useEffect, useRef, useState } from "react";
import type { MissionTelemetry } from "../hooks/useMissionTelemetry";
import { browserDsn, SENTRY_ORG, SENTRY_PROJECT, sentryLink } from "../lib/sentry";
import { Icon } from "./ui/Icons";
import SimulatorWorld from "./SimulatorWorld";
import { themes } from "../lib/theme";
import s from "../styles/SentryPanel.module.css";

type Exporter = { enabled?: boolean; closed?: boolean; processed_ticks?: number; dropped_ticks?: number; export_errors?: number; queue_depth?: number };
type Health = { sentry?: boolean; observability?: Exporter; backend?: string };
type ServerStatus = { configured: boolean; environment: string; release: string | null };
type Verification = { message: string; eventId?: string; accepted?: boolean };
const metric = (value: number | undefined, digits = 0) => typeof value === "number" && Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: digits }) : "Unavailable";

export default function SentryPanel({ telemetry }: { telemetry: MissionTelemetry }) {
  const [health, setHealth] = useState<Health | null>(null);
  const [server, setServer] = useState<ServerStatus | null>(null);
  const [healthError, setHealthError] = useState(false);
  const [browserReady, setBrowserReady] = useState(false);
  const [checking, setChecking] = useState(false);
  const [verification, setVerification] = useState<Verification | null>(null);
  const [showCamera, setShowCamera] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const sending = useRef(false);
  const mounted = useRef(true);
  const { state, isFresh, hasReceived } = telemetry;
  const runId = state.run?.run_id;
  const diagnostics = state.diagnostics;
  const exporter = healthError ? undefined : health?.observability;
  const logsQuery = runId ? `run.id:${runId}` : undefined;
  const stages = diagnostics?.stages?.filter(stage => Number.isFinite(stage.duration_ms)) ?? [];
  const longest = Math.max(1, ...stages.map(stage => stage.duration_ms));

  useEffect(() => {
    mounted.current = true;
    const client = Sentry.getClient();
    setBrowserReady(Boolean(client?.getDsn()) && client?.getOptions().enabled !== false);
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController;
    async function poll() {
      controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const read = async (url: string) => {
        const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
        if (!response.ok) throw new Error("Status unavailable");
        return response.json();
      };
      const [backend, sdk] = await Promise.allSettled([read("/api/backend-preview/health"), read("/api/sentry/status")]);
      clearTimeout(timeout);
      if (stopped) return;
      if (backend.status === "fulfilled" && typeof backend.value?.sentry === "boolean") {
        setHealth(backend.value); setHealthError(false);
      } else setHealthError(true);
      setServer(sdk.status === "fulfilled" && typeof sdk.value?.configured === "boolean" ? sdk.value : null);
      timer = setTimeout(poll, 10000);
    }
    void poll();
    return () => { stopped = true; mounted.current = false; clearTimeout(timer); controller?.abort(); };
  }, []);

  async function verify() {
    const client = Sentry.getClient();
    if (!client?.getDsn() || client.getOptions().enabled === false || sending.current) return;
    sending.current = true;
    setChecking(true);
    setVerification(null);
    let eventId: string | undefined;
    let responseStatus: number | undefined;
    const unsubscribe = client.on("afterSendEvent", (event, response) => {
      if (event.event_id === eventId) responseStatus = response?.statusCode;
    });
    try {
      await Sentry.startSpan({ name: "sentry.verify", op: "ui.action", forceTransaction: true }, async () => {
        Sentry.logger.info("Sentry verification requested from mission dashboard", {
          "event.name": "dashboard.sentry_verify", "run.id": runId ?? "awaiting",
        });
        eventId = Sentry.captureException(new Error("Overwatch Sentry verification"), {
          tags: { "verification.source": "sentry-tab", "run.id": runId ?? "awaiting" },
          fingerprint: ["overwatch-sentry-verification"],
        });
      });
      const flushed = await Sentry.flush(5000);
      const accepted = responseStatus !== undefined && responseStatus >= 200 && responseStatus < 300;
      if (mounted.current) setVerification({ eventId, accepted,
        message: accepted ? "Sentry accepted the test event. Open Issues to inspect it."
          : responseStatus ? `Sentry returned HTTP ${responseStatus}. Check your project and network.`
          : flushed ? "SDK queue flushed. Confirm the event in Sentry Issues."
          : "Delivery timed out. Check your network or browser blocker, then retry.",
      });
    } catch {
      if (mounted.current) setVerification({ eventId, message: "The test could not be sent. Check your Sentry configuration and retry." });
    } finally {
      unsubscribe(); sending.current = false;
      if (mounted.current) setChecking(false);
    }
  }

  return <div className={s.panel}>
    <section className={s.hero} aria-labelledby="sentry-title">
      <div><span className={s.eyebrow}>Observability / {SENTRY_PROJECT}</span><h2 id="sentry-title">See what shaped the mission.</h2><p>Follow a slow tick, inspect a broken flow, and connect each finding to the run that produced it.</p></div>
      <div className={s.heroActions}><a className={s.primary} href={sentryLink("issues")} target="_blank" rel="noreferrer">Open Sentry <span aria-hidden="true">↗</span></a><span>{SENTRY_ORG} / {SENTRY_PROJECT}</span></div>
    </section>

    <section className={s.statusGrid} aria-label="Sentry connection status">
      <Status label="Browser SDK" value={browserReady ? "Configured" : browserDsn ? "Not initialized" : "DSN missing"} ready={browserReady} detail="Errors, traces, logs & replay" />
      <Status label="Next.js server" value={server ? server.configured ? "Configured" : "DSN missing" : "Checking / unavailable"} ready={server?.configured} detail={server?.environment ?? "Server status endpoint"} />
      <Status label="Mission backend" value={healthError ? "Unavailable" : health ? health.sentry ? "Configured" : "Disabled" : "Checking"} ready={!healthError && health?.sentry} detail={exporter?.enabled ? "Logs & tracing exporter enabled" : "Reads the existing backend health"} />
    </section>
    <p className={s.caption}>Configured means the SDK is enabled. Use the test below to check delivery; published events are viewed in your Sentry project.</p>

    <section className={s.products} aria-label="Sentry products">
      {([
        ["traces", "route", "Tracing", "Find the slow stage", "Measured controller spans and browser request performance."],
        ["logs", "layers", "Logs", "Understand the decision", "Run IDs, rejected observations, dispatch failures and UI connection changes."],
        ["replays", "eye", "Session Replay", "Revisit the flow", "Follow the native ship camera, with browser text masked."],
      ] as const).map(([view, icon, title, heading, description]) => <a key={view} className={s.product} href={sentryLink(view, view === "logs" ? logsQuery : undefined)} target="_blank" rel="noreferrer"><div className={s.productLabel}><Icon name={icon} /><span>{title}</span><span aria-hidden="true">↗</span></div><h3>{heading}</h3><p>{description}</p></a>)}
    </section>

    <section className={s.card} aria-labelledby="ship-camera-title">
      <div className={s.cardHeading}><div><h3 id="ship-camera-title">Ship follow &amp; Replay</h3><p>Keep the ship in view as it moves through the native simulator. Use Record this view to retain a session for inspection.</p></div><button className={s.primary} onClick={() => setShowCamera(value => !value)}>{showCamera ? "Close ship camera" : "Open ship camera"}</button></div>
      {showCamera && <div className={s.shipCamera}><SimulatorWorld state={state} isFresh={isFresh} selected={selected} onSelect={setSelected} colors={themes.ink.colors} /></div>}
      <p className={s.caption}>The observer camera follows the simulator’s ship position. Mission tracking still uses detector estimates. Replay captures only this native canvas, up to two frames per second; other media stays blocked.</p>
    </section>

    <div className={s.columns}>
      <section className={s.card} aria-labelledby="verify-title">
        <div className={s.cardHeading}><h3 id="verify-title">Verify the connection</h3><span className={s.badge}>Browser → Sentry</span></div>
        <p>Send one labeled test error with a log and a performance trace. The dashboard stays usable throughout the test.</p>
        <button className={s.primary} disabled={!browserReady || checking} onClick={() => void verify()}>{checking ? "Sending test…" : "Send test event"}</button>
        {!browserReady && <p className={s.notice}>Set <code>NEXT_PUBLIC_SENTRY_DSN</code> in the frontend environment and restart Next.js to enable browser collection.</p>}
        {verification && <div className={s.result} role="status" data-accepted={verification.accepted}><p>{verification.message}</p>{verification.eventId && <><code>{verification.eventId}</code><a href={sentryLink("issues", verification.eventId)} target="_blank" rel="noreferrer">Find this event ↗</a></>}</div>}
        <p className={s.caption}>Normal traces and replays sample 10% of activity. Errors can retain a masked replay. The verification trace is always sampled.</p>
      </section>

      <section className={s.card} aria-labelledby="export-title">
        <div className={s.cardHeading}><h3 id="export-title">Mission data collection</h3><span className={s.badge}>{!hasReceived ? "Awaiting telemetry" : isFresh ? "Current run" : "Last received run"}</span></div>
        <dl className={s.readings}><Reading label="Processed ticks" value={metric(exporter?.processed_ticks)} /><Reading label="Queue depth" value={metric(exporter?.queue_depth)} /><Reading label="Dropped ticks" value={metric(exporter?.dropped_ticks)} /><Reading label="Export errors" value={metric(exporter?.export_errors)} /></dl>
        <div className={s.run}><span>Run ID</span><code>{runId ?? "No run received"}</code></div>
        <p className={s.caption}>{state.recording?.enabled ? `Run recording ${state.recording.state ?? "enabled"}. ${metric(state.recording.written_records)} ticks written for later analysis.` : "Full run recording is not reported as enabled. Enable RUN_LOG_DIR on the backend to retain optimizer inputs."}</p>
        {runId && <a className={s.textLink} href={sentryLink("logs", logsQuery)} target="_blank" rel="noreferrer">Open logs for this run ↗</a>}
      </section>
    </div>

    <section className={s.card} aria-labelledby="stages-title">
      <div className={s.cardHeading}><div><h3 id="stages-title">Inside the control tick</h3><p>{isFresh ? "Latest" : "Last received"} measured stage durations · {metric(diagnostics?.duration_ms, 2)} ms total · {metric(diagnostics?.budget_ms)} ms budget</p></div><span className={s.badge}>{diagnostics ? diagnostics.over_budget ? "Over budget" : "Within budget" : "Awaiting timings"}</span></div>
      {stages.length ? <div className={s.stages}>{stages.map((stage, i) => <div className={s.stage} key={`${stage.op}-${i}`}><div><strong>{stage.op}</strong><span>{stage.name !== stage.op ? stage.name : stage.status}</span></div><div className={s.bar} aria-hidden="true"><i style={{ width: `${Math.max(1, stage.duration_ms / longest * 100)}%` }} /></div><span>{metric(stage.duration_ms, 2)} ms</span></div>)}</div> : <p className={s.empty}>The active backend has not supplied tick timings yet. They appear here when its instrumented control loop publishes telemetry.</p>}
      {diagnostics && <div className={s.traceFooter}><code>{diagnostics.trace_id}</code><a href={sentryLink("traces", `trace:${diagnostics.trace_id}`)} target="_blank" rel="noreferrer">Find this trace ↗</a></div>}
      <p className={s.caption}>Timings come from mission telemetry. Cloud traces are sampled, so a local tick may have no stored Sentry trace. Full observations and positions remain in the run recording.</p>
    </section>
  </div>;
}

function Status({ label, value, detail, ready }: { label: string; value: string; detail: string; ready?: boolean }) {
  return <div className={s.status}><span>{label}</span><strong><i data-ready={Boolean(ready)} />{value}</strong><p>{detail}</p></div>;
}
function Reading({ label, value }: { label: string; value: string }) { return <div><dt>{label}</dt><dd>{value}</dd></div>; }
