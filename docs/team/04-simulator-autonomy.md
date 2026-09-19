# Person 4 — Simulator, geometry and autonomy

**Branch:** `codex/simulator-autonomy`. Extend the existing adapter and behavior system so camera observations can drive a real handoff. Read [AGENTS.md](../../AGENTS.md), [CONTRACT.md](CONTRACT.md), [Git workflow](GIT_WORKFLOW.md) and [tracking research](../research/TRACKING_RESEARCH.md).

## Ownership

Own `backend/sim/**` except the coordinated `types.py`, `backend/mavlink_connection.py`, `allocator.py`, `agents/**`, and `behaviors/**`. Put camera/calibration/projection helpers under `backend/sim/`. Coordinate common geo/types changes with Person 2. Person 3 owns detector and target filter; do not add another world tracker.

The current `WhiteoutAdapter` connects to quadcopter/fixed-wing/towers and can command flight. Its `poll_detections()` still returns an empty list. This is the key integration gap. Existing code is a starting point, not proof that head-pose calibration or optical tracking works.

## First 90–120 minutes

1. Inspect real camera JPEGs and own-sensor telemetry without starting another controller. Initial tower and copter views may not contain a useful vessel view.
2. Add a persistent latest-frame camera reader, sensor/frame IDs, receipt-time provenance and buffered pose. Bound queues and keep inference out of the adapter's fast poll path.
3. Verify tower head angle/control against actual image movement. Distinguish base orientation from moving head orientation.
4. Validate pixel-to-water geometry with known reference points at multiple headings/ranges. Manual pixel clicks are a development check, not autonomous detections.
5. Agree the raw-detection interface with Person 3. Call their detector worker and convert accepted raw pixels into existing `Detection` objects returned by `poll_detections()`.

Camera URLs on the simulator host:

| Sensor | MAVLink host UDP | JPEG / stream port |
|---|---:|---:|
| Quadcopter | 14550 | 8600 |
| Fixed-wing | 14560 | 8610 |
| Tower 1 | 14580 | 8630 |
| Tower 2 | 14590 | 8640 |

Use `/snapshot.jpg` or `/stream` on each camera port. UDP uses `udpout`, not a passive listener at both ends. From Compose, the existing adapter defaults to `host.docker.internal`; from a host process use the configured simulator address.

## Geometry gate

Own the intrinsics, optical/body/world rotations, camera offset, mean-sea-level height, polar-grid convergence and scale correction. Reuse the actual ArcticSim terrain transform; preserve this application's public lat/lon and true north/east conventions at the adapter boundary.

Project a defensible water-contact pixel from a raw detector observation, not a smoothed/predicted tracking box. Return uncertainty or explicit rejection. Current `Detection` needs optional covariance/identity/time metadata extensions through Person 2. A classified boat is not automatically an accurate geographical measurement.

In the inspected ArcticSim checkout camera far clipping is 1.5 km, whereas this app currently configures tower range as 2.5 km. Person 4 validates and corrects adapter camera/range configuration, then supplies the geometry to Person 3 for corresponding changes in `metrics.py`. The copter gimbal is fixed. MJPEG has no capture timestamps; receipt time is approximate and a snapshot may be cached. Declare timing uncertainty and reject unreliable geometry during rapid motion.

Proceed to geographic handoff only if uncertainty fits the receiving camera's acquisition region. Otherwise show bearing/unknown position and continue calibration. Never use hidden boat pose as the detection source.

## Handoff and recovery

First prove a compact tower-plus-copter scenario using existing `MissionCommand`, allocator and platform agents. Keep existing role/phase names compatible until a coordinated extension lands.

Implement a reactive baseline and a predictive policy with the same detector, tracker and controls. The predictive policy estimates view exit and receiver acquisition time, then chooses a feasible view with useful geometry. Keep the current observer active until receiver confirmation when possible. Log why a candidate was chosen and when real receiver evidence arrives.

All movement remains behind `SimAdapter.send_command()`. Coordinate deduplication, bounded retry and acknowledgement handling with Person 2; repeated tick outputs must not cause command spam. An acknowledged command is not a confirmed handoff. The fixed-wing search extension is later work after the two-sensor path works.

## Validation and done

Pure checks: known ray/plane intersection; near-horizon/upward-ray rejection; coordinate round trip; delayed/mismatched pose rejection; unreachable sensor candidate; repeated command identity. Local kinematic comparison: from `backend/`, `python eval.py --seconds 30 --profile all`, then the team's paired handoff scenarios.

Live validation must separately prove camera pose, projection, an acknowledged action and its observed outcome. The existing `ADAPTER=whiteout` path can arm and fly the simulator; run only one controlling process. Keep `ADAPTER=local` for general teammate development, and avoid the optional SITL Compose profile beside ArcticSim because host ports overlap.

Done when a real camera-backed target measurement enters the existing tracker and one receiver acquires contact, with failures and uncertainty visible. Record the ArcticSim revision and any required local configuration without credentials.

## Kickoff prompt

> Work on codex/simulator-autonomy in Yd025/HTNV1. Read AGENTS.md, docs/team/04-simulator-autonomy.md and CONTRACT.md. Extend existing SimAdapter/WhiteoutAdapter and owned agents/allocator/behaviors; preserve one controller and the local default. First implement verified camera/own-pose input and calibrated projection, connecting Person 3's raw detector observations to poll_detections(). Coordinate shared dataclasses/geo with Person 2. Then add reactive versus predictive two-sensor handoff with bounded commands and receiver visual confirmation. Keep hidden target truth out of runtime perception/planning, verify pure geometry and live effects separately, and prepare small PRs into dev.
