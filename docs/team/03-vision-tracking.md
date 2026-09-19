# Person 3 — Vision, target tracking, and evidence

**Deliverable:** real camera detections feeding the existing target tracker, with honest uncertainty and measured behavior through observation gaps.

Branch: `codex/vision-tracking`, based on current `dev`. Own `backend/tracker.py`, `backend/metrics.py`, `backend/eval.py`, `backend/sim/detector.py`, new `backend/vision/**`, and `backend/tests/test_tracking*` / `test_vision*`. Read [AGENTS.md](../../AGENTS.md) and [tracking research](../research/TRACKING_RESEARCH.md) first. Submit small pull requests into `dev`.

## Extend what exists

Keep `TargetTracker.update(list[Detection], now)` as the integration point. It already tracks the target in `(n, e, vn, ve)` and returns `Track`; improve this implementation instead of adding a second world filter or service. Preserve current `Track.as_dict()` fields for the HUD and allocator.

`sim/detector.py` already provides a Pillow color/blob baseline: `detect_jpeg` / `detect_image` return a `PixelHit`, and `project_hit` produces a geographical `Detection`. Preserve and evaluate this path before considering a pretrained upgrade. `PixelHit.u/v` are a blob centroid; `width/height` are image dimensions, not bounding-box dimensions.

Person 4 owns camera acquisition, aligned pose, calibration, and `WhiteoutAdapter`, whose background camera loop now calls the detector and projection before caching detections. You own the mixed detector/projection file: Person 4 supplies projection fixes **through you** to avoid simultaneous edits. Any future extraction is coordinated, not a prerequisite. Your tracker continues consuming `Detection`s through the adapter/brain flow.

Person 2 owns shared contract changes in `sim/types.py`; Person 4 coordinates geometry changes in `geo.py` with Person 2. `Detection` currently has source, latitude/longitude, class, confidence, timestamp, and optional bearing/range. Observation IDs, clock basis, position covariance, and lifecycle fields do **not** exist yet: propose backward-compatible optional additions with defaults. Do not silently assume them or change teammate files. Keep imports relative to a `backend/` working directory, without `backend.` prefixes.

## First 90 minutes

1. **0–20 minutes:** run the local baseline below; save its code revision, settings, and outputs. Create deterministic `unittest` fixtures for straight motion, irregular timestamps, gaps, duplicates, and outliers.
2. **20–50 minutes:** test the current tracker against those fixtures. Agree timestamp, observation identity, and noise contracts with Persons 2/4. Prioritize correct elapsed time and observation freshness before tuning scores.
3. **50–90 minutes:** evaluate the existing blob detector on visible simulator boats, empty water, and shoreline clutter. Give Person 4 callable examples and sample hits; label synthetic fixtures separately. Measure misses and false positives before considering a pretrained alternative under `vision/`. Preserve background inference outside the deterministic control tick.

Use PowerShell from the repository root:

```powershell
Set-Location backend
$env:ADAPTER = 'local'
$env:FORCE_KINEMATIC = '1'
python eval.py --seconds 30 --profile all
python -m unittest discover -s tests -p "test_tracking*.py"
python -m unittest discover -s tests -p "test_vision*.py"
```

The evaluation runs `straight`, `weave`, and `stop_and_go` for 30 seconds each. Test commands apply after your test files exist. The kinematic baseline needs no vision packages; preserve that property. Do not run the WHITEOUT agent for these tests: that adapter can arm and fly the fleet.

## Concrete implementation work

The current tracker ignores `Detection.timestamp`, clamps prediction time to one second, treats `now=0` as missing, and hardcodes correction `dt=0.2`. Fix timing coherently and define late-data handling. Camera detections use epoch `time.time()` while tracker ticks use `time.monotonic()`; agree a conversion or common basis before using timestamps.

Coordinate deduplication with Person 4 immediately: `poll_detections()` can return the **same cached Detection every tick for up to four seconds**, and empty scans retain the old cache. Repeated polls must not add hits, reset observation age, or shrink uncertainty. A scan timestamp is not a verified image capture timestamp. Add stable observation provenance and cache/new-event semantics through the shared contract.

Replace arbitrary uncertainty scaling with a documented model. The current tracker uses a fixed 220 m gate and measurement-noise constant; improve these using innovation uncertainty and geometry-aware noise when supplied, with a conservative fallback for existing local detections. Keep the loop cheap and stdlib-first; a library change needs evidence and Person 2's dependency coordination.

If adding ByteTrack, maintain separate state per camera. Its IDs are camera-local. Project actual observed pixel hits or matched **raw detector boxes**; smoothed boxes and predictions are not new sensor evidence. Coordinate the water-contact point with Person 4. Detector confidence is not a location variance.

Distinguish tentative contact, fresh observation, prediction, and loss through coordinated additive fields. Gaps must increase observation age and uncertainty. Agree confirmation/reacquisition thresholds and loss limits; preserve compatibility with existing `confidence`, `age_s`, and `sigma_m` consumers.

In metrics, remove the implication that `sigma_m` is measured position error when truth is absent. Report unavailable error as null and uncertainty separately. Local scores are development proxies; do not present them as verified official scoring. Add episode aggregates for error, missing/fresh-track availability, and reacquisition with failures included. Truth stays in evaluation, never detector/filter inputs.

## Acceptance and review evidence

- Gap tests prove correct prediction, age growth, uncertainty growth, and eventual loss.
- Timestamp/duplicate tests prove no state rewind or repeated confirmation, including `now=0`, irregular intervals, and repeated cached detections after an empty scan.
- Outlier tests prove rejection logging and recovery on subsequent plausible detections.
- Before/after local profiles retain a working full pipeline; measured errors stay unavailable without truth. Record actual sample count and runtime. Do not claim detector accuracy from synthetic XY fixtures.

SeaDronesSee comparison, detector retraining, and multi-vessel tracking follow the working simulator integration.

## Coding-agent kickoff prompt

> Read AGENTS.md and docs/team/03-vision-tracking.md. Implement Person 3's scope on codex/vision-tracking from dev, preserving TargetTracker.update and Track serialization. Own tracker.py, metrics.py, eval.py, sim/detector.py, vision modules, and tracking/vision tests. Evaluate the existing Pillow blob detector before upgrading it. Start with stdlib kinematic baselines and timing/gap/cached-duplicate/outlier tests. Coordinate Detection extensions with Person 2 and camera freshness/clock semantics with Person 4; apply their projection fixes yourself in the shared detector file. Keep background inference outside the control tick, truth out of tracking, and no-truth error null. Do not run WHITEOUT. Deliver a focused PR into dev with evidence and limitations.
