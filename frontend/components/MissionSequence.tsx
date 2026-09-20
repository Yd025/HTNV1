import { assetLabel, type GraphFrame } from "../lib/graphExperiment";
import styles from "./GraphTrainingDemo.module.css";

const phases: Record<string, { title: string; step: number; detail: string }> = {
  tower_watch: { title: "Towers watching", step: 1, detail: "The aircraft wait for a confirmed tower sighting." },
  tower_scan: { title: "Towers watching", step: 1, detail: "The aircraft wait for a confirmed tower sighting." },
  tower_confirm: { title: "Verifying the sighting", step: 1, detail: "Repeated, consistent observations are needed before dispatch." },
  dispatch: { title: "Drones dispatched", step: 2, detail: "The aircraft approach the estimated position. Visual handoff is still pending." },
  drone_track: { title: "Drone contact tracking", step: 3, detail: "Modeled aircraft reports confirm the track. Inspect the ship in the camera detail views; a report marker alone is not an image-confirmed lock." },
  air_track: { title: "Drone tracking confirmed", step: 3, detail: "Fresh modeled aircraft reports maintain the track, including outside tower view. Camera detail views magnify the reported position." },
  coasting: { title: "Predicting between sightings", step: 2, detail: "The position is predicted; uncertainty grows until another sensor observes the boat." },
  reacquire: { title: "Reacquiring the boat", step: 2, detail: "Aircraft search around the last observation and predicted motion." },
  lost: { title: "Contact lost", step: 1, detail: "The estimate expired. Towers watch for a new confirmed sighting." },
};

export default function MissionSequence({ frame, pending = false }: { frame?: GraphFrame; pending?: boolean }) {
  const state = pending ? { title: "Placement ready to test", step: 0, detail: "Run this placement to fix the towers and evaluate detection, dispatch, and tracking." }
    : frame?.targetCustody && frame.towerVisible === false ? { title: "Drone tracking beyond tower view", step: 3, detail: "Evaluation confirms the aircraft are maintaining the boat track while both towers lack a view." }
    : frame?.phase ? phases[frame.phase] ?? { title: frame.phase.replaceAll("_", " "), step: 1, detail: "Mission state reported by the controller." }
    : { title: "Previous search experiment", step: 0, detail: "Retrain to evaluate tower confirmation and drone handoff with the updated mission." };
  return <section className={styles.missionSequence} aria-label="Tower-to-drone mission sequence">
    <ol>{["Place towers", "Confirm boat", "Dispatch drones", "Maintain track"].map((label, index) => <li key={label} aria-current={index === state.step ? "step" : undefined} data-complete={index < state.step}><span>{index + 1}</span>{label}</li>)}</ol>
    <div className={styles.missionState}><div><h3>{state.title}</h3><p>{state.detail}</p></div>{!pending && frame?.phase && <dl><div><dt>Track held by</dt><dd>{frame.custodian ? assetLabel(frame.custodian) : "No current observer"}</dd></div><div><dt>Position uncertainty</dt><dd>{frame.uncertaintyM != null && Number.isFinite(frame.uncertaintyM) ? `${Math.round(frame.uncertaintyM)} m` : "Unavailable"}</dd></div></dl>}</div>
  </section>;
}
