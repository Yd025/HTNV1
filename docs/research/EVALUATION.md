# Evaluation protocol

For this repository, Person 3 extends `backend/eval.py` and `backend/metrics.py`, Person 2 handles run logging/replay, and Person 4 supplies paired policy scenarios. Preserve the existing kinematic evaluation as a baseline. The wire-field examples below are proposed research records; coordinate additions through [the shared team contract](../team/CONTRACT.md).

This is a proposed project evaluation, not the official WHITEOUT scoring formula. No performance results have been measured yet.

## Separate three questions

1. **Detection:** is the boat found in the image? Use precision/recall and AP on held-out labeled frames; report image resolution, minimum target size and FPS.
2. **Estimation:** is the geographical track correct through noisy or missing observations? Compare methods on identical recorded measurements.
3. **Control policy:** do predictive handoffs cause better future observations? Compare paired simulator runs; recordings alone cannot test changed camera actions.

Per-camera association can also be measured using [TrackEval](https://github.com/JonathonLuiten/TrackEval). HOTA separates detection and association quality; inspect DetA/AssA, with IDF1 secondary. MOTA is useful context but should not stand alone. These are image-tracking metrics, not metres of world error or recovery time. [HOTA paper](https://arxiv.org/html/2009.07736v2)

## Five primary project measures

| Measure | Definition | Report alongside it |
|---|---|---|
| World position error | `sqrt(mean((x_est-x_true)^2 + (y_est-y_true)^2))` at synchronized evaluation ticks; also p95 Euclidean error | Missing-output fraction and errors split by observed/predicted state; never hide missing tracks by reporting only low RMSE |
| Correct-track availability | Fraction of all evaluation ticks with an estimate inside a predeclared distance tolerance | Fresh-observation availability separately; a coasted prediction is not visual contact |
| Reacquisition | Time from an injected outage ending to sustained correct confirmation; also success fraction within the recovery deadline | All failures/censored runs, outage duration, and number of attempts |
| False confirmed tracks | Newly confirmed false-track events per minute of evaluated mission time | False-track duration; flickering IDs must not hide repeated mistakes |
| Processing latency | Median/p95 frame receipt to published estimate on this hardware | Queue depth, input/processed FPS, dropped/late frames; true capture latency remains unknown in current MJPEG |

Additional policy measures: longest tracking gap, successful handoffs / attempted handoffs, travel distance, command count, and time to first sustained correct detection. Avoid calling elapsed mission time with a prediction “tracking continuity” without defining accuracy and freshness.

## Freeze operational definitions before held-out evaluation

Suggested starting values for development, **not measured guarantees or official thresholds**:

- Evaluation grid: 5 Hz in simulator time where a reliable simulator clock is available.
- Correct position tolerance: 50 m.
- Fresh observation: accepted real detection no older than 2 simulation seconds.
- Confirmed/reacquired: at least 3 accepted actual observations spanning at least 1 second, with correct positions under the evaluation tolerance. Measure recovery delay at the final confirming observation.
- Outage durations: 5, 15, and 30 seconds; 30 seconds allowed after restoration to reacquire.
- Prediction limit: stop representing an unobserved track as current after a declared maximum age/uncertainty; keep its history for recovery.

Tune these on development episodes to fit the sensor rate and geometry, then freeze them. If simulator timing cannot be aligned, use a documented wall-clock protocol for every method and report that limitation. Do not mix wall seconds, SITL boot time and simulator seconds implicitly.

Evaluate estimates at their stated state timestamp using independently aligned truth. Prefer publishing a prediction to the current evaluation time so latency cannot be disguised as a precise but old position. Do not give future truth or future measurements to an online algorithm.

## Experiment A: perception and estimation replay

Use separate development recordings to choose settings. For the held-out run, freeze detector weights, preprocessing, resolution, thresholds, class mapping, input detections, noise settings and compute limits.

| Variant | Purpose |
|---|---|
| A0: latest valid projected observation held constant | Minimal reference; age continues to increase |
| A1: constant-velocity Kalman filter with fixed observation noise | Conventional tracking baseline |
| A2: same filter with geometry-aware measurement noise and rejection | Isolates the proposed measurement-quality treatment |

Use actual recorded detections, including misses and false candidates. A synthetic test can prove implementation behavior, but cannot prove detector performance. Save every variant's output, including missing tracks and rejected observations.

For association specifically, run ByteTrack and the alternative on the same SeaDronesSee public detections and same clips. Preserve the challenge's merged-class protocol when comparing official scores. A boat-only subset is a separate experiment and must be labeled accordingly. Source: [SeaDronesSee MOT challenge](https://seadronessee.cs.uni-tuebingen.de/wacv23_SeaDronesSee_tracking).

## Experiment B: closed-loop handoff

Use the same detector and estimator for both policies:

- B0: react after the active observer loses contact; use the nearest feasible next observer.
- B1: predict impending view loss and prepare an observer according to geometry, uncertainty reduction and acquisition time.

Run both on identical permitted vessel seeds, starting positions, hardware limits and fault schedules. Keep the target route independent of the observation policy. Reset controller and sensor state between runs. A fixed seed does not guarantee identical real-time execution; repeat a small number of paired runs if time permits.

Aim for nine held-out episodes: three ordinary travel, three clutter/turning, and three forced observation gaps of different lengths. This is a hackathon-sized test, not a generalization study. Report each pair and the median paired difference. Include the worst case and unsuccessful recoveries. If the deadline limits the sample, report the actual count.

An estimator replay comparison and a control-policy comparison answer different questions. Do not claim a better handoff from replaying unchanged footage alone.

## Evidence to save

Store a run manifest with scenario ID/seed, code revision, model name and weight hash, thresholds, hardware, frame resolution, processing budget, clock convention, and whether the run is live/replay/synthetic. Keep raw observations separate from estimates and decision logs.

Suggested observation record (field contract, not an implemented API):

```text
run_id, sensor_id, frame_id, detection_id
capture_sim_time_s [nullable], receive_monotonic_time_s
pose_time_s, time_basis, capture_time_uncertainty_s
bbox_xyxy, detector_score, water_contact_pixel
camera_pose, calibration_id
position_xy_m [nullable], measurement_covariance_2x2 [nullable]
observed_or_predicted, projection_rejection_reason
```

Only genuinely observed image detections may produce new filter measurements. Give decisions `decision_id`, referenced observation IDs, old/new observing asset, candidate scores, command acknowledgement and observed outcome. Ground truth belongs in a separate evaluator data source.

Use [results-template.csv](results-template.csv) for episode summaries. It intentionally contains no example result numbers. If target truth is unavailable or disallowed, leave world-error measures unavailable; do not substitute detector confidence.

## Uncertainty sanity checks

During a true observation gap, process uncertainty should grow. Large unexplained jumps should be gated or widen uncertainty, not make the tracker certain. Examine residuals by sensor, distance and viewing angle. If claiming a 95% uncertainty region, measure its empirical coverage; otherwise call it an estimated uncertainty ellipse. Data-calibrated detector confidence and track existence probability are distinct from position covariance.
