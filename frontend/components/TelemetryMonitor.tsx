import type { MissionTelemetry } from "../hooks/useMissionTelemetry";

export default function TelemetryMonitor({ telemetry }: { telemetry: MissionTelemetry }) {
  const { state, connection, isFresh, hasReceived, ageSeconds, receivedHz, frameCount, reconnects, lastReceived, error } = telemetry;
  const transport = connection === "live" ? "Socket open" : connection === "connecting" ? (reconnects ? "Reconnecting" : "Connecting") : "Disconnected";
  const readiness = isFresh ? "State available" : hasReceived ? "Stale state retained" : "Awaiting state";
  const deployment = typeof state.deployed !== "boolean" ? "Unreported" : state.deployed ? (isFresh ? "Reported deployed" : "Last reported deployed") : (isFresh ? "Reported inactive" : "Last reported inactive");
  const source = state.adapter === "local" ? "Local simulation" : state.adapter === "whiteout" ? "WHITEOUT adapter" : state.adapter ?? "Awaiting source";

  return (
    <section className="telemetry-monitor" aria-labelledby="telemetry-monitor-title">
      <div className="monitor-heading">
        <div>
          <h2 id="telemetry-monitor-title">Telemetry monitor</h2>
          <p>Observed traffic from the mission stream.</p>
        </div>
        <span className={`monitor-state ${isFresh ? "is-fresh" : ""}`} role="status">
          <span className="monitor-state-dot" aria-hidden="true" />
          {isFresh ? "Receiving" : hasReceived ? "Stale" : connection === "live" ? "Waiting for telemetry" : transport}
        </span>
      </div>
      <dl className="monitor-grid">
        <Metric label="Transport" value={transport} detail={`${reconnects} reconnect attempt${reconnects === 1 ? "" : "s"}`} />
        <Metric label="Backend state" value={readiness} detail={source} />
        <Metric label="Received rate" value={receivedHz === null ? (hasReceived ? "Measuring" : "Unavailable") : `${receivedHz.toFixed(1)} Hz`} detail="Observed state frames · last 10 s" />
        <Metric label="Frame age" value={formatAge(ageSeconds)} detail={lastReceived === null ? "No state frame received" : `Received ${new Date(lastReceived).toLocaleTimeString("en-GB")}`} />
        <Metric label="Accepted frames" value={frameCount.toLocaleString()} detail="This browser session" />
        <Metric label="Mission process" value={deployment} detail="Deployment reported by the backend" />
      </dl>
      {error && <p className="monitor-error" role="status"><MonitorIcon />{error}</p>}
      {connection === "live" && !isFresh && (
        <p className="monitor-note">{hasReceived ? "The socket is open. Waiting for a current mission state; the last received state remains visible." : "The connection is open. Waiting for the first valid mission state."}</p>
      )}
    </section>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="monitor-metric"><dt>{label}</dt><dd>{value}</dd><p>{detail}</p></div>;
}

function formatAge(seconds: number | null) {
  if (seconds === null) return "Unavailable";
  if (seconds < 1) return "Under 1 s";
  if (seconds < 60) return `${Math.floor(seconds)} s`;
  return `${Math.floor(seconds / 60)} min ${Math.floor(seconds % 60)} s`;
}

function MonitorIcon() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m12 3 10 18H2L12 3Z" /><path d="M12 9v5m0 3v.1" /></svg>;
}
