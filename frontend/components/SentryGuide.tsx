import type { TickSummary } from "../lib/tickWindow";
import { sentryLink } from "../lib/sentry";
import TickPerformance from "./TickPerformance";
import s from "../styles/SentryPanel.module.css";

export default function SentryGuide({ summary, isFresh }: { summary: TickSummary; isFresh: boolean }) {
  return <section className={s.panel} id="sentry-guide" aria-labelledby="sentry-guide-title">
    <div className={s.hero}>
      <div><span className={s.eyebrow}>Sentry / demo guide</span><h2 id="sentry-guide-title">Show the mission. Explain the slow tick.</h2><p>Use the ship view to tell the story, then use measured controller timings to explain what happened.</p></div>
      <div className={s.heroActions}><a className={s.primary} href="/sentry">Open Sentry tools ↗</a><span>Delivery checks, logs &amp; replay</span></div>
    </div>
    <ol className={s.guideSteps}>
      <li><span>01 / Show</span><h3>Follow the ship</h3><p>Locate a tower or aircraft from the asset strip. Explain its assigned role; a task assignment does not prove it sees the ship.</p></li>
      <li><span>02 / Explain</span><h3>Find the expensive stage</h3><p>Let the timing window fill. Pause the summary and inspect the worst trace to see where that tick spent its time.</p></li>
      <li><span>03 / Investigate</span><h3>Connect the evidence</h3><p>Open logs for the same run. For a camera or UI problem, use Record this view, reproduce it, stop recording and open the replay.</p></li>
    </ol>
    <TickPerformance summary={summary} isFresh={isFresh} />
    <details className={s.guideDetails}>
      <summary>When should I use Sentry?</summary>
      <div className={s.guideLinks}>
        <a href={sentryLink("traces")} target="_blank" rel="noreferrer"><strong>Slow control loop → Traces ↗</strong><span>Compare adapter reads, target fusion and command dispatch. A long stage identifies where to investigate.</span></a>
        <a href={sentryLink("logs", summary.runId ? `run.id:${summary.runId}` : undefined)} target="_blank" rel="noreferrer"><strong>Missing observations or commands → Logs ↗</strong><span>Look for rejected observations or dispatch failures in the same run.</span></a>
        <a href={sentryLink("issues")} target="_blank" rel="noreferrer"><strong>Exception → Issues ↗</strong><span>Inspect the stack and context. Use Send test event on the Sentry page once before presenting to check browser delivery.</span></a>
        <a href={sentryLink("replays")} target="_blank" rel="noreferrer"><strong>Camera or interaction problem → Replay ↗</strong><span>Review recorded browser behavior and native canvas frames. A replay is not target-tracking ground truth.</span></a>
      </div>
      <p className={s.caption}>Run ID: <code>{summary.runId ?? "Awaiting telemetry"}</code>. Local timings do not require cloud delivery. Traces are sampled; a local trace may not appear in Sentry.</p>
      <p className={s.caption}>Reference: <a href="https://docs.sentry.io/product/issues/issue-details/" target="_blank" rel="noreferrer">Sentry’s issue, trace and replay workflow ↗</a></p>
    </details>
  </section>;
}
