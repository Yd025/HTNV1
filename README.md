# Operation: Overwatch — teammate start

Hack the North WHITEOUT base. This repo already contains the shared intelligence loop, simulator adapter, and HUD.

**Four-person team: start with [docs/team/README.md](docs/team/README.md).** The shared setup is on `dev`; each person works on their assigned branch and opens small PRs into `dev`. Tracking research and the proposed predictive handoff are in [docs/research/TRACKING_RESEARCH.md](docs/research/TRACKING_RESEARCH.md).

**Agents (Cursor/Codex/etc.): read [AGENTS.md](AGENTS.md) first** — architecture, file map, invariants, arctic-sim adapter. Humans: this README is the 10-minute bring-up.

```
Adapter (local SITL / kinematic, or Saturday WHITEOUT)
    → World model + coverage grid + target tracker
    → C2 roles + per-class platform agents (10 Hz)      ← flies the fleet
    → Slow DAG advisor (15 s, optional LLM)             ← does not send gotos
    → TimescaleDB + WebSocket scoreboard HUD
```

## Bring-up (anyone, first 10 minutes)

```bash
cp .env.example .env          # already has FORCE_KINEMATIC=1
docker compose up --build
```

| What | Where |
| --- | --- |
| Scoreboard HUD | http://localhost:3000 |
| Health / deploy flag | http://localhost:8000/health |
| Headless agent | Separate controller; use the exclusive headless example below |
| Four-score eval | `docker compose exec backend python eval.py --seconds 15` |

Kinematic twins (plane, copter, rover) + virtual towers + a weaving target run **without waiting on ArduPilot**. Optional SITL:

```bash
docker compose --profile sitl up --build
# then set FORCE_KINEMATIC=0 in .env
```

## Backend development, recording and replay

For native Windows development, run the following from the repository root with Python 3.12. The API can run without Postgres; `DATABASE_ENABLED=0` disables database storage. Leave it enabled and configure `DATABASE_URL` when using TimescaleDB.

```powershell
cd backend
python -m venv ../.venv
../.venv/Scripts/Activate.ps1
python -m pip install -r requirements.txt
$env:ADAPTER = "local"
$env:FORCE_KINEMATIC = "1"
$env:DATABASE_ENABLED = "0"
python -m uvicorn main:app --host 127.0.0.1 --port 8000 --workers 1
```

Health, current state and the existing stream remain `/health`, `/telemetry/latest` and `/ws/telemetry`. Use one API worker: each process owns a brain. Local kinematic mode creates synthetic target observations; optional local SITL is labeled `hybrid`, and WHITEOUT is `live`.

After stopping the API, record a short local headless run from `backend/`:

```powershell
python -m agent --adapter local --record-dir ../runs --seconds 3
python -m agent --replay ../runs/RUN_ID
```

Replace `RUN_ID` with the generated run directory name. Each directory contains a settings/provenance manifest and bounded tick evidence: adapter inputs, forwarded observations, estimates, decisions and dispatch outcomes. Queue or size limits, write failures and interrupted ticks make the evidence incomplete; replay rejects incomplete, truncated or integrity-invalid runs. Set `RUN_LOG_DIR` to enable the same recording in the API.

To inspect replay through the existing API and HUD instead of the headless command:

```powershell
$env:ADAPTER = "replay"
$env:REPLAY_PATH = "../runs/RUN_ID"
python -m uvicorn main:app --host 127.0.0.1 --port 8000 --workers 1
```

Replay reprocesses recorded inputs through the existing brain and captures commands without transmitting them. It does not recreate physical simulation or promise bitwise-identical results. Never run the live API and a headless controller against the same fleet simultaneously.

The state stream adds run mode/provenance, observation IDs and freshness/rejection details, command IDs and dispatch outcomes. Observation timestamps use Unix receipt time unless explicitly marked as capture time; receipt time is an approximation, and a camera poll does not prove a new captured frame. Dispatch reports a send attempt, not vehicle acknowledgement or visual acquisition. Without evaluation truth, `scores.tracking` and `scores.track_error_m` are `null`; confidence and sigma remain estimator outputs. Local `truth` is evaluation-only and excluded from advisor inputs.

A labeled synthetic example is in [the local kinematic recording](backend/tests/fixtures/local-kinematic/), with [a state snapshot](backend/tests/fixtures/local-state.json). Validate from `backend/`:

```powershell
python -B -m unittest discover -s tests -v
python -B eval.py --seconds 30 --profile all
```

These local checks do not validate ArcticSim camera calibration or the live fleet; those still require the simulator integration pass.

## Who owns what

| Person | Branch | Main files | Handoff |
| --- | --- | --- | --- |
| 1 — UI | `codex/ui` | `frontend/` | [UI setup](docs/team/01-ui.md) |
| 2 — backend / integration | `codex/backend` | `main.py`, `brain.py`, `world.py`, `db.py`, shared contracts/config | [Backend setup](docs/team/02-backend.md) |
| 3 — vision / tracking | `codex/vision-tracking` | `tracker.py`, `metrics.py`, `eval.py`, `sim/detector.py`, optional `backend/vision/` | [Vision setup](docs/team/03-vision-tracking.md) |
| 4 — simulator / autonomy | `codex/simulator-autonomy` | adapter/camera files under `backend/sim/`, `mavlink_connection.py`, `agents/`, `allocator.py`, `behaviors/` | [Simulator setup](docs/team/04-simulator-autonomy.md) |

Backend filenames above are relative to `backend/`. Shared-file coordination and exact ownership are in the [team contract](docs/team/CONTRACT.md). Everyone starts from the same foundation; [branch and merge instructions](docs/team/GIT_WORKFLOW.md) explain the flow to `dev`, then `main`.

## Non-negotiables (WHITEOUT scoring)

Live metrics: **coverage, collaboration, efficiency, tracking accuracy**, plus **one-command agent deploy**.

- Inner loop is deterministic BTs at `BRAIN_HZ` (default 10).
- LLM DAG only biases roles (`ai_orchestrator.py` `advise()`).
- No vehicle Kalman; ArduPilot owns own-ship. Tracker is **target-only**.
- Do not scatter `tcp:sitl:5760` — go through `SimAdapter`.

## Saturday / local arctic-sim

`WhiteoutAdapter` talks MAVLink `udpout` to the official four assets. With arctic-sim already up:

```bash
ADAPTER=whiteout docker compose up -d --no-deps --force-recreate backend
```

For a headless controller **instead of** the API backend, stop that backend first and run one separate process using its built image:

```bash
docker compose stop backend
docker compose run --rm --no-deps -e ADAPTER=whiteout backend python -m agent --adapter whiteout
```

Do not run the API controller and the headless controller against the same fleet simultaneously.

The baseline hull detector, projection, background camera polling and HUD camera panels are present. Validate their accuracy, timing and repeated-observation handling before claiming reliable tracking. Confirm the current competition's submission interface before implementing an assumed track-upload endpoint. Keep `ADAPTER=local` for kinematic eval. Do not start compose profile `sitl` alongside arctic-sim (host 5760 collides). Checklist: [docs/SATURDAY_WORKSHOP.md](docs/SATURDAY_WORKSHOP.md).
