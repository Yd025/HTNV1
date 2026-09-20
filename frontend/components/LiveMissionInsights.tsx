import { useMemo } from "react";
import { assetLabel, type GraphReplay } from "../lib/graphExperiment";
import { computeLiveMetrics, liveSeries, missionStatusAt } from "../lib/graphLiveMetrics";
import styles from "./GraphTrainingDemo.module.css";

const percent = (value: number) => `${value.toFixed(1)}%`;
const format = (value: number | null, suffix: string) => value === null ? "No estimate yet" : `${value.toFixed(1)}${suffix}`;

function LivePlot({ title, rows, series, horizonS, elapsedS, maxY, unit }: {
  title: string; rows: { t: number; values: (number | null)[] }[];
  series: { name: string; color: string; dashed?: boolean }[];
  horizonS: number; elapsedS: number; maxY: number; unit: string;
}) {
  const x = (t: number) => 44 + t / horizonS * 408;
  const y = (value: number) => 179 - Math.min(maxY, Math.max(0, value)) / maxY * 150;
  return <figure className={styles.plot}>
    <figcaption>{title}</figcaption>
    <svg viewBox="0 0 480 225" role="img" aria-label={`${title}; observations through ${rows.at(-1)?.t ?? 0} seconds`}>
      {[0, .25, .5, .75, 1].map(tick => <g key={tick}><line x1="44" x2="452" y1={y(tick * maxY)} y2={y(tick * maxY)} className={styles.chartGrid} /><text x="35" y={y(tick * maxY) + 4} textAnchor="end">{Math.round(tick * maxY)}{unit}</text></g>)}
      <line x1={x(elapsedS)} x2={x(elapsedS)} y1="25" y2="179" className={styles.timeCursor} />
      {series.map((item, i) => {
        const values = rows.flatMap(row => row.values[i] === null ? [] : [{ t: row.t, value: row.values[i]! }]);
        const latest = values.at(-1);
        return <g key={item.name}><polyline data-series={item.name} points={values.map(row => `${x(row.t)},${y(row.value)}`).join(" ")} fill="none" stroke={item.color} strokeWidth="2.5" strokeDasharray={item.dashed ? "5 4" : undefined} />{latest && <circle cx={x(latest.t)} cy={y(latest.value)} r="3.2" fill={item.color} />}</g>;
      })}
      <text x="44" y="200">0 s</text><text x="452" y="200" textAnchor="end">{horizonS} s</text><text x="248" y="220" textAnchor="middle">Mission time · only observations so far</text>
    </svg>
    <div className={styles.chartLegend}>{series.map(item => <span key={item.name}><i style={{ borderColor: item.color, borderStyle: item.dashed ? "dashed" : "solid" }} />{item.name}</span>)}</div>
  </figure>;
}

export default function LiveMissionInsights({ replay, elapsedS, horizonS, stepS, freshnessS, running, pending, onToggle, onSeek }: {
  replay: GraphReplay; elapsedS: number; horizonS: number; stepS: number; freshnessS: number;
  running: boolean; pending: boolean; onToggle: () => void; onSeek: (seconds: number) => void;
}) {
  const observedTime = Math.floor(elapsedS / stepS) * stepS;
  const metrics = useMemo(() => computeLiveMetrics(replay, observedTime, freshnessS), [replay, observedTime, freshnessS]);
  const mission = useMemo(() => missionStatusAt(replay, observedTime), [replay, observedTime]);
  const series = useMemo(() => liveSeries(replay, observedTime, freshnessS), [replay, observedTime, freshnessS]);
  const count = Object.values(metrics.bySource).reduce((sum, value) => sum + value, 0);
  const errorScale = Math.max(40, Math.ceil(Math.max(0, ...series.map(point => point.rmseM ?? 0)) / 20) * 20);
  const rows = [
    { label: "First detection", value: metrics.detectedAt === null ? elapsedS >= horizonS ? "Not detected" : "Searching…" : `${metrics.detectedAt} s` },
    { label: "Water observed", value: percent(metrics.coveragePct) },
    { label: "Tracking custody", value: percent(metrics.custodyPct) },
    { label: "Position error", value: format(metrics.rmseM, " m") },
    { label: "Estimate available", value: percent(metrics.estimateAvailabilityPct) },
    { label: "Drone travel", value: format(metrics.distanceM / 1000, " km") },
    { label: mission.frame?.phase ? "Confirmed drone handoffs" : "Reporting-source changes", value: String(metrics.handoffs) },
    { label: "Raw sensor reports", value: String(count) },
    ...(mission.frame?.phase ? [
      { label: "Tower confirmation", value: mission.towerConfirmed ? "Confirmed" : "Waiting for evidence" },
      { label: "Drone handoff", value: mission.handoffConfirmed ? "Confirmed by aircraft" : "Pending aircraft sighting" },
      { label: "Boat match (evaluation only)", value: mission.frame.targetHandoffConfirmed ? "Aircraft track verified" : mission.frame.targetConfirmed ? "Tower acquisition verified" : "Not verified" },
      { label: "Tower view (evaluation only)", value: mission.frame.towerVisible == null ? "Unavailable" : mission.frame.towerVisible ? "Within tower view" : "Outside both tower views" },
      { label: "Current observer", value: mission.frame.custodian ? assetLabel(mission.frame.custodian) : "None" },
      { label: "Custody outside tower view", value: metrics.postTowerCustodyPct === null ? "No qualifying samples" : percent(metrics.postTowerCustodyPct) },
    ] : []),
  ];
  return <section className={styles.liveInsights} aria-label="Live mission statistics">
    <div className={styles.liveHeader}>
      <div><h3>This mission, as it happens</h3><p><span className={styles.liveIndicator} data-running={running && !pending} />{pending ? "Run the edited placement to calculate new observations." : `${running ? "Playing" : elapsedS >= horizonS ? "Complete" : "Paused"} · ${Math.floor(elapsedS)} / ${horizonS} s · seed ${replay.seed}`}</p></div>
      <button disabled={pending} className={styles.primary} onClick={onToggle}>{running ? "Pause mission" : elapsedS >= horizonS ? "Replay mission" : "Resume mission"}</button>
    </div>
    {pending ? <div className={styles.liveEmpty}>The charts will restart with the new mission’s first observation when it is ready.</div> : <>
      <div className={styles.charts}>
        <LivePlot title="Coverage & tracking — live" rows={series.map(point => ({ t: point.t, values: [point.coveragePct, point.custodyPct] }))} series={[{ name: "Water observed", color: "var(--status)" }, { name: "Tracking custody", color: "var(--warning)", dashed: true }]} horizonS={horizonS} elapsedS={elapsedS} maxY={100} unit="%" />
        <LivePlot title="Position error — live" rows={series.map(point => ({ t: point.t, values: [point.rmseM] }))} series={[{ name: "Observed RMSE", color: "var(--text)" }]} horizonS={horizonS} elapsedS={elapsedS} maxY={errorScale} unit=" m" />
      </div>
      <label className={styles.liveTimeline}>Scrub the mission · charts and values follow<input aria-label="Live charts time" type="range" min="0" max={horizonS} step={stepS} value={elapsedS} onChange={event => onSeek(Number(event.target.value))} /></label>
      {mission.events.length > 0 && <ol className={styles.missionEvents} aria-label="Mission events so far">{mission.events.slice(-6).map((event, index) => <li key={`${event.t}-${event.type}-${index}`}><strong>{event.t} s</strong> · {event.type.replaceAll("_", " ")}{event.source ? ` · ${assetLabel(event.source)}` : ""}{event.receivers?.length ? ` → ${event.receivers.map(assetLabel).join(", ")}` : ""}</li>)}</ol>}
      <div className={styles.liveData}>
        <div className={styles.tableWrap}><table aria-label="Current mission measurements"><caption>Measured through {metrics.observedThroughS} s · {metrics.samples} observation steps</caption><thead><tr><th scope="col">Measure</th><th scope="col">This run so far</th></tr></thead><tbody>{rows.map(row => <tr key={row.label}><th scope="row">{row.label}</th><td>{row.value}</td></tr>)}</tbody></table></div>
        <div className={styles.liveSources}><h4>Reporting sensors, so far</h4><p>Share of raw reports, including possible clutter. Custody requires accepted aircraft evidence.</p>{Object.entries(metrics.bySource).map(([id, total]) => {
          const share = count ? total / count * 100 : 0;
          return <div key={id} className={styles.liveSourceRow}><div><span>{assetLabel(id)}</span><span>{total} samples · {percent(share)}</span></div><div className={styles.shareTrack}><i style={{ width: `${share}%` }} /></div></div>;
        })}<p className={styles.metricNote}>Readings update every {stepS} simulation seconds. Custody uses a {freshnessS}-second observation freshness limit. Rewinding removes later observations from every chart and value.</p></div>
      </div>
    </>}
  </section>;
}
