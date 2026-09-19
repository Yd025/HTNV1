# Person 2 — Backend, API and integration

**Branch:** `codex/backend`. Start from the existing FastAPI + `SwarmBrain` application. Your job is to connect the other three workstreams, make evidence replayable, and keep the current WebSocket contract reliable.

Read [AGENTS.md](../../AGENTS.md), [team ownership](README.md), [CONTRACT.md](CONTRACT.md) and [Git workflow](GIT_WORKFLOW.md).

## Ownership

Own `backend/main.py`, `brain.py`, `world.py`, `db.py`, `agent.py`, and integration/recording additions. You coordinate `backend/requirements.txt`, Dockerfiles, `docker-compose.yml`, `.env.example`, `backend/sim/types.py`, `backend/geo.py`, and paired frontend type updates. Coordinate changes in the optional `ai_orchestrator.py`/`radio.py` without bringing them into the fast loop.

Person 3 owns target tracking and metric implementation. Person 4 owns adapters, geometry and decisions/control. Person 1 owns the frontend. Do not add another detector, target filter or controller to glue them together.

## Existing startup

From the repository root, create local configuration if not already present:

```powershell
Copy-Item .env.example .env
docker compose up --build backend
```

Keep `ADAPTER=local`, `FORCE_KINEMATIC=1`. Compose starts Postgres as a dependency. Health is `http://localhost:8000/health`; existing state is `http://localhost:8000/telemetry/latest`; UI consumes `ws://localhost:8000/ws/telemetry`. Do not start a second backend/controller on the same ports/fleet. `Copy-Item` is for first setup; preserve an existing teammate's `.env`.

## First 90 minutes

1. Start the local backend and save one real kinematic snapshot as a clearly labeled development fixture. Inspect the actual fields with Person 1.
2. Give all owners the existing dataclass/track/WS contracts. Agree optional observation identity, timestamps/covariance, and track-status additions before separate implementations diverge.
3. Add a bounded run logger for detections, accepted estimates, decisions and outcomes. Keep enough provenance to distinguish local synthetic, replay, and real-camera runs.
4. Establish a replay path that feeds the same internal input contract. Make the mode explicit; never silently fall back to synthetic detections in real mode.
5. Merge a small PR containing the contract/fixture or logger, with a smoke-check description.

## Main work

Keep `SwarmBrain.tick()` as the single deterministic control path. The adapter drains already-computed camera measurements; inference does not stall a 10 Hz tick. Coordinate with Person 4 on bounded workers, lifecycle and command IDs/acknowledgements. HTTP reads must not create detections or send commands.

Continue publishing the current state stream, with additive fields for observation freshness, estimated uncertainty, mode/provenance and handoff outcome once their owners define them. Preserve the current HUD until the frontend update lands. `confidence` and `sigma_m` are not independently measured accuracy.

Store a manifest with model/settings/version, scenario and clock convention for every evaluated run. Person 3 supplies metric computation; you expose/store those results and keep missing truth-dependent values unavailable. Hide or separately label local evaluation truth and exclude it from deployed advisor inputs. This is especially important because current snapshots contain a local `truth` field.

The existing Sentry, TimescaleDB and slow advisor integrations can support the demo after the core path works. Do not add a second database or replace infrastructure simply to match the earlier standalone research sketch. Model/service delays must not stop the target filter or controller.

## Completion and checks

- A teammate can start local backend + UI from documented commands.
- Camera-backed `Detection` reaches the existing tracker and WebSocket without duplicate observations.
- Run logs/replay preserve mode, timing and evidence IDs.
- Warming state, disconnected cameras and missing metrics reach the HUD honestly.
- One command producer controls the fleet; HTTP polling cannot cause duplicate actuation.
- Optional external integrations do not block the brain.

Use the existing kinematic evaluation from `backend/`: `python eval.py --seconds 30 --profile all`. Pair that smoke run with focused integration tests around the input/output contract, event/run reset, and idempotent dispatch. Test app startup separately from algorithm accuracy. Avoid claiming an unrun live-camera test passed.

## Kickoff prompt

> Work on `codex/backend` in Yd025/HTNV1. Read AGENTS.md and docs/team/02-backend.md plus CONTRACT.md. Reuse existing FastAPI, SwarmBrain, SimAdapter and /ws/telemetry. Own the backend/API/composition and coordinated shared contracts; do not duplicate Person 3's tracker or Person 4's control/geometry. Start in local kinematic mode, capture a labeled state fixture, add bounded logging/replay and agree additive observation/status fields. Keep inference and slow integrations outside the deterministic control tick. Preserve current consumers, document checks, and prepare small PRs into dev.
