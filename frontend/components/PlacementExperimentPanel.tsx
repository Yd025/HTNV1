import { useId } from "react";
import type { Experiment } from "../lib/placementExperiments";
import styles from "./PlacementExperimentPanel.module.css";

type Props = {
  experiment: Experiment | null;
  busy: boolean;
  selectedCandidate: number | null;
  onStart: () => void;
  onCancel: () => void;
  onSelectCandidate: (index: number) => void;
  onReplay: () => void;
};

const seconds = (value: number) => `${value.toFixed(1)} s`;

export default function PlacementExperimentPanel({
  experiment, busy, selectedCandidate, onStart, onCancel, onSelectCandidate, onReplay,
}: Props) {
  const headingId = useId();
  const complete = experiment?.phase === "complete";
  const total = experiment?.total ?? 48;
  const completed = experiment?.completed ?? 0;
  const selected = experiment?.candidates.find((candidate) => candidate.index === selectedCandidate);
  const results = complete ? experiment?.test : undefined;
  const winnerNumber = experiment?.winnerIndex === undefined ? null : experiment.winnerIndex + 1;
  const action = busy ? "Pause search" : complete ? "Run another round" : experiment ? "Resume search" : "Run 48 placements";

  return (
    <section className={styles.panel} aria-labelledby={headingId}>
      <div className={styles.heading}>
        <div>
          <h3 id={headingId}>Learn across random spawns</h3>
          <p>Try different tower pairs. Keep each pair fixed while boats start and travel in random places.</p>
        </div>
        <button type="button" className={styles.primary} onClick={busy ? onCancel : onStart}>{action}</button>
      </div>

      <div className={styles.method}>
        <span><strong>80</strong> training boats per placement</span>
        <span><strong>64</strong> validation boats to choose the winner</span>
        <span><strong>200</strong> unseen boats for the final test</span>
      </div>

      {experiment && <>
        <div className={styles.progressHeading}>
          <p role="status">{complete ? "Round complete" : busy ? "Testing placements" : "Search paused"} <strong>{completed} / {total}</strong></p>
          <span>Seed {experiment.seed}</span>
        </div>
        <div className={styles.progress} role="progressbar" aria-label="Placements tested" aria-valuemin={0} aria-valuemax={total} aria-valuenow={completed}>
          <span style={{ width: `${total ? completed / total * 100 : 0}%` }} />
        </div>
        <div className={styles.stripHeading}>
          <span>Select a placement to inspect it on the map</span>
          <span>Highlighted marks = training improvement</span>
        </div>
        <div className={styles.candidates} role="group" aria-label="Tested tower placements">
          {Array.from({ length: total }, (_, index) => {
            const candidate = experiment.candidates.find((item) => item.index === index);
            const winner = complete && index === experiment.winnerIndex;
            const label = candidate
              ? `Placement ${index + 1}: ${candidate.train.detected}/${candidate.train.episodes} found, ${seconds(candidate.train.meanCappedS)} capped mean${index === 0 ? "; starting layout" : candidate.accepted ? "; training best when tested" : ""}${winner ? "; validation winner" : ""}`
              : `Placement ${index + 1}: waiting to be tested`;
            return <button
              key={index}
              type="button"
              disabled={!candidate}
              aria-pressed={selectedCandidate === index}
              aria-label={label}
              title={label}
              data-improved={(index > 0 && candidate?.accepted) || undefined}
              data-winner={winner || undefined}
              onClick={() => onSelectCandidate(index)}
            >
              <span>{index + 1}</span>
              <small aria-hidden="true">{winner || (index > 0 && candidate?.accepted) ? <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">{winner ? <path d="m2 8 4 4 8-9" /> : <path d="M8 14V2M3 7l5-5 5 5" />}</svg> : candidate ? "·" : "—"}</small>
            </button>;
          })}
        </div>
      </>}

      <div className={styles.details}>
        <div className={styles.selected}>
          <h4>{selected ? `Placement ${selected.index + 1}` : experiment ? "Inspect a tested placement" : "One fair test for every pair"}</h4>
          {selected ? <>
            <p><strong>{selected.train.detected} / {selected.train.episodes}</strong> training boats found · <strong>{seconds(selected.train.meanCappedS)}</strong> capped mean</p>
            {selected.validation && <p><strong>{selected.validation.detected} / {selected.validation.episodes}</strong> validation boats found · <strong>{seconds(selected.validation.meanCappedS)}</strong> capped mean</p>}
            <span className={styles.note}>{selected.index === 0 ? "The tower layout at the start of this round." : selected.accepted ? "Improved the best training score when tested." : "Kept in the history so you can compare its placement."}</span>
          </> : <p>Starts and destinations are sampled uniformly across the arena. Every pair sees the same training routes; the final test uses unseen routes.</p>}
        </div>

        {results ? <div className={styles.results}>
          <div className={styles.resultHeading}>
            <h4>Winning placement {winnerNumber}</h4>
            <span>Saved result for this round</span>
          </div>
          <table>
            <caption className="sr-only">The starting tower layout compared with the winning placement on unseen random boat routes</caption>
            <thead><tr><th scope="col">Unseen boat test</th><th scope="col">Starting layout</th><th scope="col">Winner</th></tr></thead>
            <tbody>
              <tr><th scope="row">Boats found</th><td>{results.baseline.detected} / {results.baseline.episodes}</td><td>{results.learned.detected} / {results.learned.episodes}</td></tr>
              <tr><th scope="row">Capped mean</th><td>{seconds(results.baseline.meanCappedS)}</td><td>{seconds(results.learned.meanCappedS)}</td></tr>
              <tr><th scope="row">90th percentile</th><td>{seconds(results.baseline.p90CappedS)}</td><td>{seconds(results.learned.p90CappedS)}</td></tr>
              <tr><th scope="row">Missed boats</th><td>{results.baseline.episodes - results.baseline.detected}</td><td>{results.learned.episodes - results.learned.detected}</td></tr>
            </tbody>
          </table>
          <button type="button" className={styles.replay} onClick={onReplay}>Watch 200 random boats <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M2 8h12M9 3l5 5-5 5" /></svg></button>
          <p className={styles.note}>Best tested across random routes; towers stay fixed for each test. Editing the map does not change this saved result.</p>
        </div> : <p className={styles.awaiting}>The final comparison appears after all {total} placements are tested and the validation routes select a winner.</p>}
      </div>

      <p className={styles.limits}>The search favors more boats found, then faster detection. Two towers with 600 m range cannot cover every spawn in this 9 km² arena. Visibility is checked every second; missed boats count as 180 seconds. Synthetic tower-only test, with no terrain or camera errors.</p>
    </section>
  );
}
