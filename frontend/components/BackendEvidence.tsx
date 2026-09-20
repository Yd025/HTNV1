import { useState, type ReactNode } from "react";
import type { SwarmState } from "../lib/types";
import styles from "./BackendEvidence.module.css";

type Row = Record<string, unknown>;

function record(value: unknown): Row {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function records(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter(item => item !== null && typeof item === "object" && !Array.isArray(item)) as Row[] : [];
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function text(value: unknown, fallback = "Unavailable"): string {
  if (typeof value === "string" && value.length) return value;
  if (finite(value)) return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return fallback;
}

function number(value: unknown, digits = 0, unit = ""): string {
  return finite(value) ? `${value.toLocaleString("en-GB", { maximumFractionDigits: digits })}${unit}` : "Unavailable";
}

function date(value: unknown): string {
  const millis = finite(value) ? value * 1000 : typeof value === "string" && value.length ? Date.parse(value) : NaN;
  if (!Number.isFinite(millis)) return "Time unavailable";
  const parsed = new Date(millis);
  if (!Number.isFinite(parsed.getTime())) return "Time unavailable";
  return `${parsed.toLocaleString("en-GB", { timeZone: "UTC", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" })} UTC`;
}

function age(observation: Row, heartbeat: unknown): string {
  if (finite(observation.age_s) && observation.age_s >= 0) return number(observation.age_s, 1, " s");
  if (finite(heartbeat) && finite(observation.timestamp) && ["receipt_unix", "capture_unix"].includes(text(observation.timestamp_basis, ""))) {
    const seconds = heartbeat - observation.timestamp;
    if (seconds >= 0) return number(seconds, 1, " s");
  }
  return "Unavailable";
}

function Id({ value }: { value: unknown }) {
  const label = text(value);
  return <span className={styles.id} title={label}>{label}</span>;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}

function Panel({ id, title, detail, count, children }: { id: string; title: string; detail: string; count?: number; children: ReactNode }) {
  return <section className={styles.panel} aria-labelledby={id}>
    <header className={styles.heading}>
      <div><h2 id={id}>{title}</h2><p>{detail}</p></div>
      {count !== undefined && <span className={styles.count}>{count}</span>}
    </header>
    {children}
  </section>;
}

function Empty({ children }: { children: ReactNode }) {
  return <p className={styles.empty}>{children}</p>;
}

function PayloadDetails({ label, value }: { label: string; value: unknown }) {
  const [open, setOpen] = useState(false);
  return <details className={styles.details} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{label}</summary>
    {open && <pre tabIndex={0} aria-label={label}>{JSON.stringify(value, null, 2)}</pre>}
  </details>;
}

export default function BackendEvidence({ state }: { state: SwarmState }) {
  const payload = record(state);
  const observations = record(payload.observations);
  const detections = records(state.detections);
  const rejections = Array.isArray(observations.rejected) ? observations.rejected : [];
  const commands = records(state.commands);
  const outcomes = records(payload.command_outcomes);
  const activity = records(state.blackboard).slice().reverse();
  const advisor = record(state.advisor);
  const roles = Object.entries(record(advisor.role_bias));
  const run = record(payload.run);
  const recording = record(payload.recording);

  return <div className={styles.evidence}>
    <div className={styles.grid}>
      <Panel id="backend-observations" title="Latest observations" detail="Detection reports in the current state frame." count={detections.length}>
        <dl className={styles.stats}>
          <Fact label="Received this tick">{number(observations.received)}</Fact>
          <Fact label="Forwarded to tracker">{number(observations.forwarded)}</Fact>
          <Fact label="Rejected this tick">{Array.isArray(observations.rejected) ? rejections.length : "Unavailable"}</Fact>
        </dl>
        {detections.length ? <div className={styles.scroll} tabIndex={0} role="region" aria-label="Current observations">
          <table className={styles.table}>
            <thead><tr><th scope="col">Source / observation</th><th scope="col">Classification</th><th scope="col">Confidence</th><th scope="col">Age at snapshot</th></tr></thead>
            <tbody>{detections.map((item, index) => <tr key={`${text(item.observation_id, text(item.source_id, "observation"))}-${index}`}>
              <td><strong>{text(item.source_id)}</strong><Id value={item.observation_id} /><small>{text(item.provenance, "Provenance unavailable")}</small><PayloadDetails label="Observation details" value={item} /></td>
              <td>{text(item.class_hint)}<small>{finite(item.lat) && finite(item.lon) ? `${item.lat.toFixed(5)}, ${item.lon.toFixed(5)}` : "Position unavailable"}</small></td>
              <td>{finite(item.confidence) ? `${number(item.confidence * 100, 1)}%` : "Unavailable"}<small>{number(item.range_m, 1, " m range")}</small></td>
              <td>{age(item, state.heartbeat)}<small>{text(item.timestamp_basis, "Clock unavailable")}</small></td>
            </tr>)}</tbody>
          </table>
        </div> : <Empty>{Array.isArray(state.detections) ? "No detection reports in this frame. This does not establish that the arena is empty." : "Detection reports have not been supplied."}</Empty>}
        <p className={styles.footnote}>Confidence is reported by the detector. {text(observations.basis, "Observation timing basis is unavailable.")}</p>
        {rejections.length > 0 && <PayloadDetails label={`Inspect ${rejections.length} rejected observation${rejections.length === 1 ? "" : "s"}`} value={rejections} />}
      </Panel>

      <Panel id="backend-commands" title="Commands & dispatch" detail="Current planner output and matching adapter dispatch results." count={commands.length}>
        {commands.length ? <ul className={styles.commands}>{commands.map((command, index) => {
          const commandId = text(command.command_id, "");
          const outcome = outcomes.find(item => commandId ? item.command_id === commandId : item.vehicle_id === command.vehicle_id);
          const status = text(outcome?.status, "Unavailable");
          return <li key={`${text(command.vehicle_id, "command")}-${index}`}>
            <div className={styles.commandTop}><div><strong>{text(command.vehicle_id)}</strong><span>{text(command.type).replaceAll("_", " ")}</span></div><span className={styles.status} data-status={status}>{status}</span></div>
            <p className={styles.position}>{finite(command.lat) && finite(command.lon) ? `${command.lat.toFixed(5)}, ${command.lon.toFixed(5)}` : "Destination unavailable"}{finite(command.alt) ? ` · ${number(command.alt, 1)} m altitude` : ""}</p>
            <Id value={command.command_id} />
            {outcome?.error != null && <p className={styles.error}>{text(outcome.error)}</p>}
          </li>;
        })}</ul> : <Empty>{Array.isArray(state.commands) ? "No commands in this frame." : "Command data has not been supplied."}</Empty>}
        <p className={styles.footnote}>Dispatched means submitted to the adapter; it does not confirm execution. Suppressed commands were withheld by dispatch deduplication.</p>
      </Panel>

      <Panel id="backend-activity" title="Mission activity" detail="Recent blackboard messages, newest first." count={activity.length}>
        {activity.length ? <ol className={styles.activity}>{activity.map((entry, index) => {
          const body = record(entry.body);
          const summary = text(body.intent, text(body.rationale, ""));
          const movement = typeof body.from === "string" && typeof body.to === "string" ? `${body.from} → ${body.to}` : "";
          return <li key={`${text(entry.t, text(entry.ts, "message"))}-${text(entry.sender, "source")}-${index}`}>
            <div className={styles.activityTop}><strong>{text(entry.kind)}</strong><time>{date(entry.t ?? entry.ts)}</time></div>
            <p className={styles.route}>{text(entry.sender)} <span aria-hidden="true">→</span> {text(entry.recipient)}</p>
            {movement && <p className={styles.message}>{movement}</p>}
            {summary && <p className={styles.message}>{summary}</p>}
            {finite(body.range_m) && <p className={styles.message}>Range {number(body.range_m, 1, " m")}{typeof body.class_hint === "string" ? ` · ${body.class_hint}` : ""}</p>}
            <PayloadDetails label="Message details" value={entry.body} />
          </li>;
        })}</ol> : <Empty>{Array.isArray(state.blackboard) ? "No mission messages have been reported yet." : "Mission activity is unavailable."}</Empty>}
      </Panel>

      <Panel id="backend-advisor" title="Advisor rationale" detail="Slow strategy advice supplied to the role allocator.">
        {Object.keys(advisor).length ? <div className={styles.advisor}>
          <p className={styles.rationale}>{text(advisor.rationale, "The advisor has not supplied a rationale.")}</p>
          <p className={styles.date}>Updated {date(advisor.ts)}</p>
          <h3>Suggested roles</h3>
          {roles.length ? <dl className={styles.roles}>{roles.map(([platform, role]) => <div key={platform}><dt>{platform}</dt><dd>{text(role)}</dd></div>)}</dl> : <p className={styles.note}>No role suggestions supplied.</p>}
          {typeof advisor.assigned_vehicle === "string" && <p className={styles.note}>Assigned vehicle: {advisor.assigned_vehicle}</p>}
          {typeof advisor.radio_script === "string" && advisor.radio_script && <PayloadDetails label="Radio script" value={advisor.radio_script} />}
        </div> : <Empty>No advisor output has been supplied. The deterministic mission loop can operate without it.</Empty>}
        <p className={styles.footnote}>Advisor suggestions are planning inputs. Actual fleet roles appear in the fleet view.</p>
      </Panel>

      <Panel id="backend-provenance" title="Run provenance" detail="Source and identity reported by this backend process.">
        <dl className={styles.facts}>
          <Fact label="Run ID"><Id value={run.run_id} /></Fact>
          <Fact label="Mode">{text(run.mode)}</Fact>
          <Fact label="Source">{text(run.source, text(state.adapter))}</Fact>
          <Fact label="Frame sequence">{number(run.sequence)}</Fact>
          <Fact label="Evaluation truth">{typeof run.evaluation_truth_available === "boolean" ? run.evaluation_truth_available ? "Available for evaluation" : "Unavailable" : "Unreported"}</Fact>
          <Fact label="Source run ID"><Id value={run.source_run_id ?? (typeof run.mode === "string" && run.mode !== "replay" ? "Not a replay" : "Unavailable")} /></Fact>
          <Fact label="Clock convention">{text(run.clock)}</Fact>
          <Fact label="Snapshot timestamp">{date(state.heartbeat)}</Fact>
        </dl>
      </Panel>

      <Panel id="backend-recording" title="Recording" detail="Evidence capture status reported by the backend.">
        <dl className={styles.facts}>
          <Fact label="Capture">{typeof recording.enabled === "boolean" ? recording.enabled ? text(recording.state, "Enabled") : "Disabled" : "Unavailable"}</Fact>
          {recording.enabled === true && <>
            <Fact label="Written records">{number(recording.written_records)}</Fact>
            <Fact label="Accepted records">{number(recording.accepted_records)}</Fact>
            <Fact label="Dropped records">{number(recording.dropped_records)}</Fact>
            <Fact label="Queue depth">{number(recording.queue_depth)}</Fact>
            <Fact label="Bytes written">{number(recording.bytes_written)}</Fact>
            <Fact label="Complete">{text(recording.complete)}</Fact>
            <Fact label="Recording path"><Id value={recording.path} /></Fact>
          </>}
        </dl>
        {recording.enabled === false && <p className={styles.footnote}>This run is streaming telemetry without saving a recording.</p>}
        {recording.error != null && <p className={styles.recordingError}>{text(recording.error)}</p>}
      </Panel>
    </div>
    <section className={styles.snapshot} aria-label="Complete telemetry snapshot">
      <PayloadDetails label="Inspect full telemetry snapshot" value={state} />
      <p>All fields from the received mission state, including nested advisor data, arena configuration and coverage cells.</p>
    </section>
  </div>;
}
