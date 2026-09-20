import dynamic from "next/dynamic";
import { useState } from "react";
import { assetLabel, type ArcticProfile, type GraphFrame, type GraphTower } from "../lib/graphExperiment";
import { sensorAspect, sensorPose, sensorReplayDetail, sensorReplayView } from "../lib/trainingScene";
import styles from "./TrainingMissionViews.module.css";

const TrainingMissionScene = dynamic(() => import("./TrainingMissionScene"), {
  ssr: false,
  loading: () => <div className={styles.loading} role="status">Loading mission view…</div>,
});

interface Props {
  surface: "overview" | "cameras" | "lab";
  profile: ArcticProfile;
  frame: GraphFrame;
  frames: GraphFrame[];
  towers: GraphTower[];
  elapsedS: number;
  running: boolean;
  pending: boolean;
  calculating?: boolean;
}

type ViewProps = Pick<Props, "profile" | "frame" | "frames" | "towers" | "elapsedS" | "running">;
const degrees = (value: number) => `${value.toFixed(1)}°`;
const meters = (value: number) => `${Math.round(value).toLocaleString()} m`;
const xy = (x: number, y: number) => `${Math.round(x).toLocaleString()}, ${Math.round(y).toLocaleString()}`;

function reportStatus(frame: GraphFrame, source: string) {
  const observations = frame.observations?.filter(item => item.source === source) ?? [];
  const accepted = observations.some(item => item.accepted);
  return {
    accepted,
    label: accepted ? "Modeled report" : observations.length ? "Report rejected" : "No accepted report",
  };
}

function SensorView({ profile, frame, frames, towers, elapsedS, running, sensorId, compact = false }: ViewProps & { sensorId: string; compact?: boolean }) {
  const [requestedZoom, setRequestedZoom] = useState(12);
  const [playback, setPlayback] = useState({ running, settledSampleS: frame.t });
  if (playback.running !== running) setPlayback({ running, settledSampleS: frame.t });
  // Pause/seek settles the crop. Resume must not replay that sample's earlier transition.
  const animate = running && playback.running && frame.t > playback.settledSampleS;
  const pose = sensorPose(profile, frame, towers, sensorId);
  const detail = pose ? sensorReplayDetail(profile, frames, towers, pose, elapsedS, requestedZoom, animate) : null;
  const view = sensorReplayView(detail, elapsedS, requestedZoom);
  const digitalZoom = view.zoom;
  const status = reportStatus(frame, sensorId);
  return <figure className={`${styles.sensor} ${compact ? styles.compactSensor : ""}`} aria-label={`${assetLabel(sensorId)} modeled camera view`}>
    <figcaption className={styles.sensorHeading}>
      <h3>{assetLabel(sensorId)}</h3>
      <span className={styles.reportStatus} data-accepted={status.accepted}>{status.label}</span>
    </figcaption>
    {pose ? <>
      <div className={styles.sensorMedia}>
        <div className={styles.sensorControls} role="group" aria-label={`${assetLabel(sensorId)} camera magnification`}>
          <button type="button" aria-pressed={digitalZoom === 1} onClick={() => setRequestedZoom(1)}>Wide</button>
          {[12, 24].map(zoom => <button key={zoom} type="button" aria-pressed={digitalZoom === zoom} disabled={!view.available} onClick={() => setRequestedZoom(zoom)}
            title={view.available ? "Magnify this camera's recent reported position" : "Detail resumes when a recent report is inside the camera crop"}>{zoom}× detail</button>)}
        </div>
        <div className={styles.sensorImage}>
          <div className={styles.sensorViewport} style={compact ? { maxWidth: `${180 * sensorAspect(pose.sensor)}px` } : undefined}>
            <TrainingMissionScene profile={profile} frame={frame} towers={towers} mode="sensor" sensorId={sensorId} digitalZoom={digitalZoom} sensorCrop={view.crop} />
          </div>
        </div>
        <p className={styles.sensorViewMode}>{digitalZoom > 1 ? `${digitalZoom}× digital crop · ${view.status}` : `Wide · ${degrees(pose.sensor.hfovDeg)} horizontal view${requestedZoom > 1 ? ` · ${view.status}` : ""}`}</p>
      </div>
      {!compact && <dl className={styles.sensorReadout}>
        <div><dt>Camera heading</dt><dd>{degrees(((pose.heading % 360) + 360) % 360)}</dd></div>
        <div><dt>Camera pitch</dt><dd>{degrees(pose.pitch)}</dd></div>
        <div><dt>Horizontal view</dt><dd>{degrees(pose.sensor.hfovDeg)}</dd></div>
        <div><dt>Grid X, Y · m</dt><dd>{xy(pose.x, pose.y)}</dd></div>
        <div><dt>Elevation</dt><dd>{meters(pose.z)}</dd></div>
        <div><dt>Report sample</dt><dd>{frame.t.toFixed(1)} s</dd></div>
      </dl>}
    </> : <p className={styles.loading}>This sensor has no pose in this mission sample.</p>}
  </figure>;
}

function ObservationTable({ frame }: Pick<Props, "frame">) {
  const observations = frame.observations ?? [];
  return <section className={styles.observations} aria-label="Mission camera observations">
    <div className={styles.observationHeading}>
      <h3>Camera observations</h3>
      <span>Mission sample · {frame.t.toFixed(1)} s</span>
    </div>
    <p className={styles.observationNote}>Synthetic sensor reports used by the 2D mission. Accepted reports are modeled measurements, not proof of a visual lock; rendering the boat does not create a detection.</p>
    {observations.length ? <div className={styles.tableWrap} tabIndex={0} aria-label="Camera observations table, scroll horizontally if needed">
      <table>
        <caption>Positions use the projected Arctic grid in metres.</caption>
        <thead><tr><th scope="col">Source</th><th scope="col">Decision</th><th scope="col">Confidence</th><th scope="col">Grid X, Y · m</th><th scope="col">Uncertainty</th><th scope="col">Report time</th></tr></thead>
        <tbody>{observations.map((item, index) => <tr key={`${item.source}-${item.timestamp}-${index}`}>
          <th scope="row">{assetLabel(item.source)}</th>
          <td><span className={styles.reportStatus} data-accepted={item.accepted}>{item.accepted ? "Accepted" : "Rejected"}</span></td>
          <td>{Math.round(item.confidence * 100)}%</td>
          <td>{xy(item.x, item.y)}</td>
          <td>{meters(item.sigmaM)}</td>
          <td>{item.timestamp.toFixed(1)} s</td>
        </tr>)}</tbody>
      </table>
    </div> : <p className={styles.emptyReports}>No camera reports in this sample. The mission continues searching with the recorded camera poses.</p>}
  </section>;
}

export default function TrainingMissionViews({ surface, profile, frame, frames, towers, elapsedS, running, pending, calculating = false }: Props) {
  const sensors = [...towers.map(tower => tower.id), ...frame.drones.map(drone => drone.id)];
  const [selectedSensor, setSelectedSensor] = useState<string | null>(null);
  const selectedId = selectedSensor && sensors.includes(selectedSensor) ? selectedSensor : sensors[0];
  if (surface === "overview") return <section className={`${styles.views} ${styles.overview}`} aria-label="Synchronized simulation lab and cameras">
    <div className={styles.overviewHeading}><h3>Simulation lab &amp; cameras</h3><span>{pending ? "Placement pending" : `${elapsedS.toFixed(1)} s · same mission`}</span></div>
    {pending ? <div className={styles.pending} role="status"><h3>{calculating ? "Calculating the mission…" : "Run this placement to update all views"}</h3><p>{calculating ? "All views will resume together when the new route and camera observations are ready." : "The placement has changed. Run it to calculate matching aircraft routes and camera observations."}</p></div> : <>
      <div className={styles.overviewScene}><TrainingMissionScene profile={profile} frame={frame} towers={towers} mode="orbit" compact selectedId={selectedId} onSelect={setSelectedSensor} /></div>
      <p className={styles.overviewHelp}>Drag to orbit · scroll to zoom · modeled replay imagery</p>
      <div className={styles.cameraGrid}>{sensors.map(sensorId => <SensorView key={sensorId} profile={profile} frame={frame} frames={frames} towers={towers} elapsedS={elapsedS} running={running} sensorId={sensorId} compact />)}</div>
      <p className={styles.overviewNote}>Cameras return to Wide when a report leaves the crop or is over 10 s old. Detail resumes on a recent report. A reported position is not a current visual lock. Imagery shows evaluation truth at the {frame.t.toFixed(1)} s sample.</p>
    </>}
  </section>;
  return <div className={styles.views}>
    <div className={styles.intro}>
      <div>
        <h3>{surface === "cameras" ? "Mission cameras" : "Mission in 3D"}</h3>
        <p>{surface === "cameras" ? "Tower and aircraft perspectives from the same terrain, boat route, and camera poses as the 2D overview." : "Explore the 2D mission in the simulation lab. Select an observer to compare its camera view with the scene."}</p>
      </div>
      <div className={styles.replayTime}><strong>{pending ? "Placement pending" : `${elapsedS.toFixed(1)} s`}</strong><span>{pending ? "Awaiting mission run" : "Shared mission time"}</span></div>
    </div>
    {pending ? <div className={styles.pending} role="status">
      <h3>{calculating ? "Calculating the mission…" : "Run this placement to update the views"}</h3>
      <p>{calculating ? "All views will resume together when the new route and camera observations are ready." : "The tower sites or boat start have changed. Use “Run this placement” in the overview to calculate matching cameras, aircraft routes, and observations."}</p>
    </div> : <>
      {surface === "cameras" ? <div className={styles.cameraGrid}>
        {sensors.map(sensorId => <SensorView key={sensorId} profile={profile} frame={frame} frames={frames} towers={towers} elapsedS={elapsedS} running={running} sensorId={sensorId} />)}
      </div> : <div className={styles.lab}>
        <div className={styles.labWorld}>
          <div className={styles.labScene}>
            <TrainingMissionScene profile={profile} frame={frame} towers={towers} mode="orbit" selectedId={selectedId} onSelect={setSelectedSensor} />
          </div>
          <p className={styles.sceneHelp}>Drag to orbit · scroll to zoom. The boat shows evaluation truth; camera reports determine the track.</p>
        </div>
        <aside className={styles.labObserver} aria-label="Observer camera">
          <div className={styles.sensorSelector} role="group" aria-label="Choose observer camera">
            {sensors.map(sensorId => <button type="button" key={sensorId} aria-pressed={selectedId === sensorId} onClick={() => setSelectedSensor(sensorId)}>{assetLabel(sensorId)}</button>)}
          </div>
          {selectedId ? <SensorView profile={profile} frame={frame} frames={frames} towers={towers} elapsedS={elapsedS} running={running} sensorId={selectedId} /> : <p className={styles.emptyReports}>No observer poses in this mission sample.</p>}
        </aside>
      </div>}
      <p className={styles.modelNote}>Modeled replay imagery · cameras return to Wide when a report leaves the crop or is over 10 s old. Your detail setting resumes when a recent report is visible in the crop. Last reports do not imply a current visual lock. This is synthetic imagery, not a live camera feed.</p>
      <ObservationTable frame={frame} />
    </>}
  </div>;
}
