import { useState } from "react";
import type { TickSummary } from "../lib/tickWindow";
import { sentryLink } from "../lib/sentry";
import s from "../styles/SentryPanel.module.css";

const ms = (value: number | null) => value == null ? "—" : `${value.toFixed(2)} ms`;
export default function TickPerformance({ summary, isFresh }: { summary: TickSummary; isFresh: boolean }) {
  const [frozen, setFrozen] = useState<{ summary: TickSummary; at: string } | null>(null);
  const paused = frozen?.summary.runId === summary.runId ? frozen : null;
  const view = paused?.summary ?? summary;
  const slowest = [...view.stages].sort((a, b) => b.share - a.share)[0];
  const budget = view.minBudget == null ? "Awaiting timings" : view.minBudget === view.maxBudget
    ? `${view.minBudget.toFixed(0)} ms core budget` : `${view.minBudget.toFixed(0)}–${view.maxBudget!.toFixed(0)} ms core budgets`;
  function download() {
    const blob = new Blob([JSON.stringify({ captured_at: paused?.at ?? new Date().toISOString(), source: "browser-observed core ticks", window_seconds: 60, ...view }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = "control-performance.json"; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <section className={s.card} aria-labelledby="stages-title" data-testid="tick-performance">
    <div className={s.cardHeading}><div><h3 id="stages-title">Control performance · last 60 seconds</h3><p>{paused ? `Paused at ${new Date(paused.at).toLocaleTimeString()}` : "Refreshes every 2 seconds"} · {view.count} received ticks spanning {view.spanSeconds.toFixed(0)} s · {budget}</p></div><span className={s.badge}>{paused ? "Summary paused" : !isFresh ? "Telemetry stale" : view.count ? "Collecting" : "Awaiting timings"}</span></div>
    <div className={s.performanceActions}><button onClick={() => setFrozen(paused ? null : { summary, at: new Date().toISOString() })} disabled={!view.count} aria-pressed={Boolean(paused)}>{paused ? "Resume summary" : "Pause summary"}</button><button onClick={download} disabled={!view.count}>Save summary</button></div>
    <dl className={s.readings}><div><dt>Typical tick · p50</dt><dd>{ms(view.p50)}</dd></div><div><dt>95th percentile</dt><dd>{ms(view.p95)}</dd></div><div><dt>Worst tick</dt><dd>{ms(view.max)}</dd></div><div><dt>Over core budget</dt><dd>{view.count ? `${view.overBudget} / ${view.count}` : "—"}</dd></div></dl>
    {view.count ? <>
      <p className={s.notice}>{view.overBudget ? `${view.overBudget} observed ticks exceeded their core budget. Inspect the worst tick below.` : "No observed ticks exceeded their core budget in this window."}{slowest ? ` ${slowest.op} used the largest share of measured tick time (${(slowest.share * 100).toFixed(1)}%).` : ""}</p>
      <div className={s.performanceTable}><table><caption>Stage time summed per tick</caption><thead><tr><th scope="col">Stage</th><th scope="col">p95</th><th scope="col">Max</th><th scope="col">Time share</th><th scope="col">Failed spans</th></tr></thead><tbody>{view.stages.map(stage => <tr key={stage.op}><th scope="row">{stage.op}</th><td>{ms(stage.p95)}</td><td>{ms(stage.max)}</td><td>{(stage.share * 100).toFixed(1)}%</td><td>{stage.errors}</td></tr>)}</tbody></table></div>
      {view.worst && <div className={s.traceFooter}><span>Worst tick · {ms(view.worst.duration_ms)}<br /><code>{view.worst.trace_id}</code></span><a href={sentryLink("traces", `trace:${view.worst.trace_id}`)} target="_blank" rel="noreferrer">Inspect worst trace ↗</a></div>}
    </> : <p className={s.empty}>Waiting for fresh tick timings. This window fills from the dashboard’s existing telemetry stream.</p>}
    <p className={s.caption}>Only ticks received by this browser are summarized; up to 1,200 are retained. Core timings exclude recording and telemetry export, so this is not a full deadline measurement. Repeated stages are summed per tick; rows stay in a stable order. Cloud traces are sampled, so the worst local tick may have no stored Sentry trace.</p>
  </section>;
}
