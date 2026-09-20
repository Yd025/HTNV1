# Contributing to Freeze

Freeze's final release lives on **[`main`](https://github.com/Yd025/HTNV1/tree/main)**. Start with the [root README](../../README.md) for setup, measured results, and dashboard/game launch paths. The repository contains the complete shared application; no separate NORTHSTAR frontend or API is needed.

These documents began as four-person hackathon handoffs. They remain useful ownership and design context, but references to starting from `dev`, unimplemented baseline features, or the Saturday workshop are historical. Use `main` for the final release and current source for implemented interfaces. Preserve [`release/0.2`](https://github.com/Yd025/HTNV1/tree/release/0.2) as the frozen benchmark reference.

## Working on the final release

1. Read [AGENTS.md](../../AGENTS.md), the relevant handoff below, and the [shared contract](CONTRACT.md).
2. Create a focused `codex/` feature branch from current `origin/main`, using separate clones or worktrees for concurrent work.
3. Run the local kinematic demo first. Use ArcticSim integration when your task needs it, with one controller process for the fleet.
4. Coordinate shared types, dependencies, configuration, and wire-format changes before editing them.
5. Run relevant [validation commands](../../README.md#validation-and-replay), document limitations, and submit the reviewed change into `main`.

The [Git workflow](GIT_WORKFLOW.md) covers cloning the release, creating a feature branch, and reviewing changes into `main`. Earlier handoffs that target `dev` describe the historical hackathon workflow.

## Responsibilities

| Workstream | Handoff / historical branch | Primary files |
| --- | --- | --- |
| UI and mission control | [UI](01-ui.md) · `codex/ui` | `frontend/**` |
| Backend and integration | [Backend](02-backend.md) · `codex/backend` | `backend/main.py`, `brain.py`, `world.py`, `db.py`, deployment, shared contracts |
| Vision, tracking, and evaluation | [Vision/tracking](03-vision-tracking.md) · `codex/vision-tracking` | `backend/tracker.py`, `metrics.py`, `eval.py`, `sim/detector.py`, `vision/**` |
| Simulator, geometry, and autonomy | [Simulator/autonomy](04-simulator-autonomy.md) · `codex/simulator-autonomy` | `backend/sim/**` except shared types/detector, `mavlink_connection.py`, `allocator.py`, `agents/**`, `behaviors/**` |

Backend filenames are relative to `backend/` where not fully qualified. The integrator coordinates `backend/sim/types.py`, coordinate transforms, `frontend/lib/types.ts`, dependency files, Docker configuration, and the telemetry contract. Vision owns the combined detector/projection file; simulator contributors coordinate geometry changes with that owner. Agree on separate ownership for game engine, badge, learning, or graph-experiment work before parallel edits.

## Runtime boundaries

```text
Adapter camera frames + own-platform pose
  -> vessel detection and projection
  -> timestamped Detection observations
  -> target-only tracker
  -> SwarmBrain roles and platform behaviors
  -> SimAdapter commands
  -> existing WebSocket dashboard and recorded evidence
```

- Keep one deterministic control loop, normally 10 Hz. Camera inference and optional slow model advice stay outside it.
- Preserve `/ws/telemetry`, `/health`, `/telemetry/latest`, and camera catalog/snapshot endpoints. Check `SwarmBrain.snapshot()` and browser types for the current schema; historical contract prose is not a substitute for source.
- Use `SimAdapter` for vehicle I/O. ArduPilot estimates vehicle state; `TargetTracker` estimates the ship from accepted observations.
- Fresh receiving-aircraft observations establish custody. Predictions, commands, role labels, and proximity do not. Reject stale, duplicate, implausible, or disconnected-source observations.
- Keep evaluator truth out of planning, filtering, and model-advisor inputs. Without truth, measured tracking error stays unavailable.
- Keep `ADAPTER=local` and `FORCE_KINEMATIC=1` as generic development defaults. `ADAPTER=whiteout` starts the simulated fleet's arm/takeoff controller; use it deliberately.
- Keep game physics, game learning, graph experiments, and operational telemetry distinct. Game replays cannot command ArcticSim's fleet.

Python imports expect the working directory to be `backend/`; use `from sim.types ...`, not new `backend.*` package prefixes. The frontend is Next.js 14 **Pages Router**.

## Preserve the evidence

The final revision's [paired comparison](../../frontend/public/experiments/release-comparison.json) and [200-mission report](../../frontend/public/experiments/surveillance-report.json) use separate test sets. Keep models, source fingerprints, misses, and per-mission results together. The 400-mission comparison supports improved aircraft custody, while detection/gap intervals include zero; position error, false contacts, and coverage regressions remain part of the result.

Offline changes do not automatically change runtime controllers. Runtime policy loading imports six bounded flight settings, not graph tower coordinates or synthetic sensor rules. Do not claim live gains from synthetic tests. Further tuning needs fresh disjoint evaluation missions; rerunning a published benchmark is reproduction.

Historical models and recordings retain their original rules. The game pins policy/layout per attempt, and promotions must retain escape and early-capture safeguards. Sentry upload, verified import, visual replay, and accepted promotion are separate states. September 20 release evidence has no promoted game strategy; physical badge testing and calibrated live-camera validation also remain outstanding.

## Useful references

- [Setup, architecture, validation, and replay](../../README.md)
- [Game, badge controls, and recording contract](../../cant-catch-me/README.md)
- [Final submission](../../DEVPOST_FREEZE.md) and [pitch/Q&A](../../FREEZE_PITCH_AND_QA.md)
- [Tracking research](../research/TRACKING_RESEARCH.md) and [evaluation protocol](../research/EVALUATION.md)
- [Terrain, camera, and search research](../research/TOWER_SEARCH_RESEARCH.md)
- [Historical workshop checklist](../SATURDAY_WORKSHOP.md)
