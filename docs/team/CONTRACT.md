# Shared implementation contract

**The existing code is the starting contract.** This document maps the four owners onto it. Do not introduce the earlier standalone NORTHSTAR API or a second frontend/backend.

## Existing interfaces

| Interface | Source of truth | Owner/coordinator |
|---|---|---|
| `VehicleState`, `Detection`, `Command`, `Arena`, `SimAdapter` | `backend/sim/types.py` | Person 2 coordinates; Persons 3/4 consume/extend |
| `TargetTracker.update(detections, now=None)` / `Track.as_dict()` | `backend/tracker.py` | Person 3 |
| Brain tick and snapshot | `backend/brain.py` | Person 2 |
| Browser `SwarmState`, `TrackState`, `TelemetrySample` | `frontend/lib/types.ts` | Person 1 with Person 2 |
| WGS84 / local north-east conversion | `backend/geo.py`, `frontend/lib/geo.ts` | Persons 2/4 coordinate with Person 1 |
| Actual adapter I/O | `backend/sim/whiteout.py`, `mavlink_connection.py` | Person 4 |
| Existing combined detector/projection | `backend/sim/detector.py` | Person 3 edits; Person 4 supplies geometry corrections |

Python runs with **cwd `backend/`**, so current imports use `from sim.types import Detection`, not `from backend.sim.types ...`.

## Existing HTTP/WebSocket surface

Backend defaults to port 8000; Next.js frontend defaults to 3000.

- `GET /health`: deployed/adapter/heartbeat/scores and service health.
- `GET /telemetry/latest`: latest state or `{status:"warming"}`.
- `GET /strategy/latest`: advisor output or `{status:"none"}`.
- `GET /cameras`: current adapter's camera catalog (empty for adapters without it).
- `GET /cameras/{cam_id}/snapshot.jpg`: JPEG, 204 for unavailable image, or 404 for unknown camera.
- `POST /strategy/run`: invokes the existing slow advisor; it may call a configured model provider.
- `WS /ws/telemetry`: existing state stream plus strategy messages.

Preserve this stream and the current camera endpoints. There is no new `/api/state` or required polling service in this plan. Recording/replay APIs and added status fields are future coordinated extensions. UI must not assume proposed fields already exist.

The current state contains `adapter`, `deployed`, `heartbeat`, `tick_hz`, `scores`, `fleet`, nullable `track`, `detections`, `truth`, `heatmap`, `blackboard`, `advisor`, `c2`, `intents`, `commands`, and `arena`. Consult `SwarmBrain.snapshot()` for actual JSON and `frontend/lib/types.ts` for browser types. Several browser fields are optional; handle missing/warming state.

## Perception handoff

The intended path is:

```text
Person 4 camera reader + own-sensor pose
  -> Person 3 detector / per-camera association
  -> Person 4 calibrated pixel-to-water projection
  -> Detection objects returned by WhiteoutAdapter.poll_detections()
  -> existing TargetTracker.update()
  -> existing brain snapshot and WebSocket
```

The baseline already has `sim/cameras.py`, `sim/detector.py` (`PixelHit`, `detect_jpeg`, `project_hit`) and the WHITEOUT background grabber. Evaluate and extend this path. Person 3 is the single editing owner for the currently combined detector/projection file; Person 4 provides calibrated geometry corrections through Person 3. Optional new image modules go under `backend/vision/`. Person 4 owns acquisition/pose and adapter integration. Extend the raw-observation record with agreed frame/observation IDs, water-contact estimate and timestamp provenance. Do not create a parallel detection path.

Current `Detection` requires `source_id`, `lat`, `lon`, `class_hint`, `confidence`, and `timestamp`, with optional `bearing` and `range_m`. These are target observations, not own-vehicle positions. It currently lacks unique observation IDs, clock metadata, covariance, and calibration provenance. Add these compatibly with defaults through Person 2, updating `as_dict`, consumers and fixtures together.

Only actual detector observations become world measurements. A per-camera tracker prediction or smoothed box is not a new independent observation. The image tracker ID is local to its camera; the shared vessel filter owns world identity. Deduplicate actual frame/observation IDs and reject stale or incompatible data. In the included baseline, `poll_detections()` can return the same cached observation on successive ticks for up to four seconds; Persons 3/4 must fix that lifecycle together rather than treat each poll as fresh evidence.

## Coordinates, time and uncertainty

Keep the public geographic `lat/lon` and `vn/ve` conventions compatible. Person 4 converts ArcticSim's projected/scale-corrected world and camera optical/body axes correctly before creating `Detection`. Do not relabel polar-grid XY as north/east. Never use home-relative altitude directly as sea-plane height.

The existing code mixes wall-clock event timestamps and monotonic update clocks; agree and document conversion before enabling timestamp-aware fusion. Current ArcticSim MJPEG has no capture timestamps, so receipt time is an approximation. Retain that provenance and pose uncertainty; do not silently treat it as synchronized capture time.

Current `Track` exposes `confidence`, `age_s`, and scalar `sigma_m`. These are baseline heuristics, not a calibrated existence probability or a complete covariance matrix. Explicit observed/predicted/lost status, observation IDs and covariance are proposed additive changes. Person 3 owns their semantics; Person 2 propagates them; Person 1 displays them only when supplied. Keep existing fields while consumers migrate.

## Control and evaluation

All vehicle commands go through `SimAdapter.send_command`. Person 4 owns `MissionCommand`, allocator, platform behaviors and adapter execution. Person 2 owns their call order in the single brain. No frontend, model API or second background controller bypasses that path.

The current brain may produce commands on each tick; a metrics counter is not command deduplication. Person 4 and Person 2 coordinate bounded dispatch/acknowledgement behavior. An acknowledgement does not prove visual handoff; require fresh receiver evidence.

The existing local snapshot includes target `truth` for stand-in evaluation. Never feed this into the detector, estimator, planner or a deployed model advisor. If displayed locally, label it explicitly as evaluation truth. The real adapter returns no truth; no-truth tracking accuracy must remain unavailable rather than substituting detector confidence or filter sigma.

Keep local kinematic mode as the default. `ADAPTER=whiteout` can arm/fly assets, so use it deliberately for the simulator integration checks, not as a generic frontend startup step. One process controls the fleet at a time.

## Change protocol

Person 2 coordinates the shared dataclasses, TypeScript types, requirements, Docker/config and snapshot changes. The producer and consumer owners review an additive contract PR before dependent feature PRs. Keep the 10 Hz loop deterministic and cheap; camera inference, database work and slow model calls must not block it.
