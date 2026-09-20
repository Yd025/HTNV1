import { useEffect, useState } from "react";
import type { AttemptSummary, GameDashboard, LearningRound } from "../lib/gameLearningTypes";
import { LEGACY_RULES_VERSION } from "../lib/gameLearningTypes";
import Preview from "./GamePreview";
import styles from "./GameLearning.module.css";

const GAME_URL = process.env.NEXT_PUBLIC_GAME_URL || "http://localhost:3100";
const seconds = (value: number | null) => value == null ? "—" : `${value.toFixed(1)} s`;
const percent = (value: number | null) => value == null ? "—" : `${Math.round(value * 100)}%`;
const outcomeName = { caught: "Captured", escaped: "Escaped", abandoned: "Abandoned" };

function isDashboard(value: unknown): value is GameDashboard {
  if (!value || typeof value !== "object") return false;
  const data = value as GameDashboard;
  return !!data.layout && Array.isArray(data.layout.towers) && !!data.learning && !!data.totals
    && Array.isArray(data.attempts) && Array.isArray(data.rounds) && !!data.policy
    && !!data.world && Array.isArray(data.world.heights) && data.world.size > 1 && data.world.half > 0
    && data.world.heights.length === data.world.size * data.world.size;
}

export default function GameLearning() {
  const [data, setData] = useState<GameDashboard | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [receivedAt, setReceivedAt] = useState<number | null>(null);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | null = null;
    const poll = async () => {
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 7000);
      try {
        const response = await fetch("/api/game-learning", { signal: controller.signal, cache: "no-store" });
        const payload: unknown = await response.json();
        if (!response.ok || !isDashboard(payload)) throw new Error("Game service unavailable");
        if (!disposed) { setData(payload); setError(""); setReceivedAt(Date.now()); setNow(Date.now()); }
      } catch {
        if (!disposed) setError("The game connection is unavailable. Start the game service, then retry. We’ll also reconnect automatically.");
      } finally {
        clearTimeout(timeout);
        if (!disposed) timer = setTimeout(poll, 2000);
      }
    };
    void poll();
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => { disposed = true; clearTimeout(timer); clearInterval(clock); controller?.abort(); };
  }, [retry]);

  const stale = !!error || (receivedAt != null && now - receivedAt > 8000);
  const completed = data?.sentry && data.learning.status !== "training" ? data.learning.completed : 0;
  return (
    <div className={styles.game}>
      <div className={styles.heading}>
        <div><h2>Learn from every escape</h2><p>Opening stretch · Fort Ross · Optimize time to actual drone capture.</p></div>
        <a className={styles.play} href={GAME_URL} target="_blank" rel="noopener noreferrer">Open Cant Catch Me <span aria-hidden="true">↗</span><span className={styles.srOnly}> in a new tab</span></a>
      </div>
      {error && <div className={styles.notice} role="alert"><p>{error}{data && " Showing the last received data."}</p><button onClick={() => setRetry(value => value + 1)}>Retry connection</button></div>}
      {!data ? <div className={styles.empty} role="status"><h3>{error ? "Waiting for the game service" : "Connecting to the game…"}</h3><p>Player attempts, learned tower positions, and the live opening stretch will appear here when the game connects.</p></div> : <>
        <section className={styles.learning} aria-label="Tower learning status">
          <div className={styles.learningTitle}><h3>Layout {data.layout.version}</h3><span className={styles.status} data-stale={stale}>{stale ? "Connection stale" : data.learning.status === "collecting" ? "Collecting player attempts" : data.learning.status === "training" ? "Evaluating placements" : data.learning.status === "error" ? "Evaluation needs attention" : "Ready for the next player"}</span></div>
          <p>{data.learning.message}</p>
          {data.rulesVersion !== LEGACY_RULES_VERSION && <p>New games use overhead-only aircraft spotting: within 65 m with a clear view. Tower sightings can still send them to investigate. Earlier recordings and runs already in progress keep their original rules; the model learns only from runs using the new rules.</p>}
          {data.learning.status === "training" ? <label className={styles.progress}>Evaluating candidate layouts · {data.learning.completed} / {data.learning.total}<progress max={Math.max(1, data.learning.total)} value={data.learning.completed} /></label> : completed < data.policy.minimumAttempts ? <label className={styles.progress}>{completed} / {data.policy.minimumAttempts} completed runs imported from Sentry before evaluation<progress max={data.policy.minimumAttempts} value={completed} /></label> : null}
          <dl className={styles.summary}>
            <div><dt>Player attempts</dt><dd>{data.totals.attempts}</dd></div>
            <div><dt>Captured</dt><dd>{data.totals.captured}</dd></div>
            <div><dt>Escaped opening</dt><dd>{data.totals.escaped}</dd></div>
            <div><dt>Abandoned</dt><dd>{data.totals.abandoned}</dd></div>
            <div><dt>Observed capture rate</dt><dd>{percent(data.totals.captureRate)}</dd></div>
            <div><dt>Mean capture time</dt><dd>{seconds(data.totals.meanCaptureSeconds)}</dd></div>
          </dl>
          <p className={styles.note}>Results include all saved runs, including earlier spotting rules. Each player keeps the layout they started with. Capture rate excludes abandoned runs; mean capture time includes captures only. The model changes only tower positions.</p>
          <details className={styles.data}><summary>View next-run tower positions</summary><div className={styles.tableWrap}><table><caption>Layout {data.layout.version} · game coordinates in metres</caption><thead><tr><th>Tower</th><th>X</th><th>Z</th></tr></thead><tbody>{data.layout.towers.map((tower, i) => <tr key={tower.id}><th>T{i + 1}</th><td>{tower.x.toFixed(1)}</td><td>{tower.z.toFixed(1)}</td></tr>)}</tbody></table></div></details>
        </section>
        <div className={styles.charts}>
          <section className={styles.chartSection}><h3>Player outcomes over attempts</h3><p>Actual time spent in the opening stretch.</p><AttemptChart attempts={data.attempts} total={data.totals.attempts} /></section>
          <section className={styles.chartSection}><h3>Observed captures by layout</h3><p>Player results, with sample size shown for each layout.</p><LayoutChart attempts={data.attempts} /></section>
        </div>
        <section className={styles.replay}><div><h3>Replay validation</h3><p>Estimated capture time when recorded controls are replayed through candidate tower layouts under the current game rules. These estimates are separate from live player outcomes.</p></div><ReplayChart rounds={data.rounds.filter(round => (round.rulesVersion ?? LEGACY_RULES_VERSION) === data.rulesVersion)} maxSeconds={data.policy.maxSeconds} /></section>
        <section className={styles.preview} aria-labelledby="game-preview-heading">
          <Preview data={data} now={now} connectionStale={stale} />
        </section>
        <details className={styles.method}><summary>How learning stays playable</summary><p>The first evaluation needs {data.policy.minimumAttempts} completed opening runs imported from Sentry. The optimizer compares tower positions by time to actual drone capture. Radar range, drone speed, and other game rules stay fixed.</p><p>Tower sites stay on land, at least {data.policy.spawnProtectionMetres} m from the start and {data.policy.minimumTowerSeparation} m apart. Replay validation rejects new or earlier captures under {data.policy.minimumCaptureSeconds} s and applies a capture-rate ceiling of {percent(data.policy.maximumValidationCaptureRate)}. Existing early captures can remain unchanged. This preserves an escape guard in recorded play; it cannot guarantee an escape route or the same difficulty for every future player.</p><p>Abandoned runs are recorded separately and do not count toward the first evaluation. Layout {data.layout.version}: {data.layout.reason}</p><p className={styles.version}>Game rules: {data.rulesVersion} · World: {data.worldVersion}</p></details>
      </>}
    </div>
  );
}

function AttemptChart({ attempts, total }: { attempts: AttemptSummary[]; total: number }) {
  const shown = [...attempts].sort((a, b) => a.endedAt.localeCompare(b.endedAt)).slice(-60);
  if (!shown.length) return <EmptyChart>Complete the opening stretch to see capture and escape times. Leaving early will be shown as an abandoned attempt.</EmptyChart>;
  const start = Math.max(1, total - shown.length + 1);
  const max = Math.max(30, Math.ceil(Math.max(...shown.map(item => item.seconds)) / 30) * 30);
  const x = (i: number) => shown.length === 1 ? 260 : 55 + i / (shown.length - 1) * 410;
  const y = (value: number) => 195 - value / max * 155;
  return <figure className={styles.figure}>
    <svg viewBox="0 0 500 250" role="img" aria-label={`Actual outcomes for attempts ${start} to ${start + shown.length - 1}; duration in seconds. Exact values in the table below.`}>
      <ChartGrid max={max} unit="Time (s)" />
      {shown.map((item, i) => <g key={item.id} className={styles[item.outcome]}><title>{`Attempt ${start + i}: ${outcomeName[item.outcome]}, ${seconds(item.seconds)}, layout ${item.layoutVersion}`}</title><line x1={x(i)} y1="195" x2={x(i)} y2={y(item.seconds)} opacity=".3" />{item.outcome === "caught" ? <circle cx={x(i)} cy={y(item.seconds)} r="4" /> : item.outcome === "escaped" ? <path d={`M${x(i)},${y(item.seconds) - 5}l5,5 -5,5 -5,-5Z`} /> : <path d={`M${x(i) - 4},${y(item.seconds) - 4}l8,8m-8,0 8,-8`} fill="none" strokeWidth="2" />}</g>)}
      <text x={x(0)} y="215" textAnchor="middle">{start}</text>{shown.length > 1 && <text x="465" y="215" textAnchor="middle">{start + shown.length - 1}</text>}<text x="260" y="240" textAnchor="middle">Player attempt</text>
    </svg>
    <div className={styles.legend}><span className={styles.caught}><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4" /></svg>Captured</span><span className={styles.escaped}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3l5 5-5 5-5-5Z" /></svg>Escaped</span><span className={styles.abandoned}><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8m-8 0 8-8" fill="none" strokeWidth="2" /></svg>Abandoned</span></div>
    <figcaption>Latest {shown.length} recorded attempts. Abandoned times are not capture times.</figcaption>
    <details className={styles.data}><summary>View attempt data</summary><div className={styles.tableWrap}><table><caption>Actual player outcomes</caption><thead><tr><th>Attempt</th><th>Layout</th><th>Outcome</th><th>Time</th></tr></thead><tbody>{shown.map((item, i) => <tr key={item.id}><th>{start + i}</th><td>{item.layoutVersion}</td><td>{outcomeName[item.outcome]}</td><td>{seconds(item.seconds)}</td></tr>)}</tbody></table></div></details>
  </figure>;
}

function LayoutChart({ attempts }: { attempts: AttemptSummary[] }) {
  const layouts = new Map<number, { captured: number; escaped: number; abandoned: number }>();
  for (const item of attempts) {
    const count = layouts.get(item.layoutVersion) || { captured: 0, escaped: 0, abandoned: 0 };
    if (item.outcome === "caught") count.captured++;
    else if (item.outcome === "escaped") count.escaped++;
    else count.abandoned++;
    layouts.set(item.layoutVersion, count);
  }
  const rows = [...layouts.entries()].sort(([a], [b]) => a - b).slice(-8);
  if (!rows.length) return <EmptyChart>The first completed player attempt will establish an observed capture rate for the starting layout.</EmptyChart>;
  const height = 65 + rows.length * 45;
  return <figure className={styles.figure}>
    <svg viewBox={`0 0 500 ${height}`} role="img" aria-label="Observed capture rate by tower layout. Each row shows completed sample size; abandoned attempts are excluded.">
      {[0, 25, 50, 75, 100].map(value => <g key={value}><line className={styles.grid} x1={85 + value * 2.7} y1="20" x2={85 + value * 2.7} y2={height - 35} /><text x={85 + value * 2.7} y={height - 15} textAnchor="middle">{value}%</text></g>)}
      {rows.map(([version, count], i) => { const n = count.captured + count.escaped; const rate = n ? count.captured / n : null; return <g key={version}><text x="65" y={40 + i * 45} textAnchor="end">v{version}</text><rect x="85" y={27 + i * 45} width="270" height="18" className={styles.barTrack} />{rate != null && <rect x="85" y={27 + i * 45} width={270 * rate} height="18" className={styles.bar} />}<text x="370" y={40 + i * 45}>{rate == null ? "No completed runs" : `${percent(rate)} · n=${n}`}</text></g>; })}
    </svg>
    <figcaption>Most recent {rows.length} layouts in the available attempt history. More attempts improve the estimate; different players can change it.</figcaption>
    <details className={styles.data}><summary>View layout data</summary><div className={styles.tableWrap}><table><caption>Results in available attempt history</caption><thead><tr><th>Layout</th><th>Captured</th><th>Escaped</th><th>Abandoned</th><th>Rate</th></tr></thead><tbody>{rows.map(([version, count]) => <tr key={version}><th>{version}</th><td>{count.captured}</td><td>{count.escaped}</td><td>{count.abandoned}</td><td>{percent(count.captured + count.escaped ? count.captured / (count.captured + count.escaped) : null)}</td></tr>)}</tbody></table></div></details>
  </figure>;
}

function ReplayChart({ rounds, maxSeconds }: { rounds: LearningRound[]; maxSeconds: number }) {
  const shown = [...rounds].sort((a, b) => a.id - b.id).slice(-20);
  if (!shown.length) return <EmptyChart>No placement evaluation yet. After enough completed runs, this chart will compare the current and proposed layouts on held-out replays.</EmptyChart>;
  const max = Math.max(30, Math.ceil(Math.max(...shown.flatMap(round => [round.baseline.cappedMeanSeconds, round.candidate.cappedMeanSeconds])) / 30) * 30);
  const x = (i: number) => shown.length === 1 ? 260 : 55 + i / (shown.length - 1) * 410;
  const y = (value: number) => 195 - value / max * 155;
  return <figure className={`${styles.figure} ${styles.replayFigure}`}>
    <svg viewBox="0 0 500 250" role="img" aria-label="Replay estimated capped mean time to capture, baseline and candidate by evaluation round; lower is better. Exact values below."><ChartGrid max={max} unit="Estimated time (s)" />
      <polyline className={styles.baseline} fill="none" strokeWidth="2" strokeDasharray="5 4" points={shown.map((round, i) => `${x(i)},${y(round.baseline.cappedMeanSeconds)}`).join(" ")} />
      <polyline className={styles.candidate} fill="none" strokeWidth="2" points={shown.map((round, i) => `${x(i)},${y(round.candidate.cappedMeanSeconds)}`).join(" ")} />
      {shown.map((round, i) => <g key={round.id}><circle className={styles.baseline} cx={x(i)} cy={y(round.baseline.cappedMeanSeconds)} r="4" /><circle className={styles.candidate} cx={x(i)} cy={y(round.candidate.cappedMeanSeconds)} r="4" /><title>{`Round ${round.id}: baseline ${seconds(round.baseline.cappedMeanSeconds)}, candidate ${seconds(round.candidate.cappedMeanSeconds)}. ${round.promoted ? "Promoted" : "Kept existing layout"}.`}</title></g>)}
      <text x={x(0)} y="215" textAnchor="middle">{shown[0].id}</text>{shown.length > 1 && <text x="465" y="215" textAnchor="middle">{shown[shown.length - 1].id}</text>}<text x="260" y="240" textAnchor="middle">Evaluation round</text>
    </svg>
    <div className={styles.legend}><span><i className={styles.baselineLine} />Existing layout</span><span><i className={styles.candidateLine} />Candidate layout</span></div><figcaption>Replay estimate · lower is faster. Non-captures receive the {maxSeconds} s cap, so this includes escapes and censored replays.</figcaption>
    <details className={styles.data}><summary>View evaluation data and decisions</summary><div className={styles.tableWrap}><table><caption>Held-out replay validation; not actual player results</caption><thead><tr><th>Round</th><th>Replays</th><th>Existing</th><th>Candidate</th><th>Capture rate</th><th>Decision</th></tr></thead><tbody>{shown.map(round => <tr key={round.id}><th>{round.id}</th><td>{round.candidate.attempts}</td><td>{seconds(round.baseline.cappedMeanSeconds)}</td><td>{seconds(round.candidate.cappedMeanSeconds)}</td><td>{percent(round.candidate.captureRate)}</td><td>{round.promoted ? `Promoted v${round.selectedVersion}` : "Kept layout"}<small>{round.reason}</small></td></tr>)}</tbody></table></div></details>
  </figure>;
}

function ChartGrid({ max, unit }: { max: number; unit: string }) {
  return <><text x="55" y="18">{unit}</text>{[0, 1, 2, 3].map(i => <g key={i}><line x1="55" x2="465" y1={195 - i / 3 * 155} y2={195 - i / 3 * 155} className={styles.grid} /><text x="44" y={199 - i / 3 * 155} textAnchor="end">{Math.round(max * i / 3)}</text></g>)}</>;
}

function EmptyChart({ children }: { children: React.ReactNode }) { return <div className={styles.chartEmpty}><p>{children}</p></div>; }

