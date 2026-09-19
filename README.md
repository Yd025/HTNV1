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

The dashboard is a read-only simulation monitor with **Overview**, **Fleet**, **Cameras**, **Activity**, and **System monitor** views. Appearance offers **Ink & rust**, **Field archive**, and **Cold slate**, using reusable UI and 3D tokens in `frontend/lib/theme.ts`. Fleet includes optimized Skywalker X8, 3DR Iris, tracked rover, and EO/IR tripod geometry baked from the existing simulator models. These display models remain separate from mission telemetry. The operational scene and 2D map use the existing `/ws/telemetry` stream; reconnects, frame age, observed receive rate, missing data, and stale state are explicit. Camera feeds use the existing GET catalog and snapshot proxy. No simulator command or advisor-trigger controls are exposed. IBM Plex Sans and its license are bundled under `frontend/public/fonts/`. Run `node --test tests/telemetry.test.cjs` from `frontend/` for parser/lifecycle checks; set `TELEMETRY_TEST_PYTHON` to a Python executable to include the backend serializer contract test.

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

## Learn two-tower placement and search

The main page's **Put the towers to the test** panel starts with the saved learned placement. Drag either tower, the boat start, or its destination; then choose **Run test** to see the moving boat, radial pulses, and rotating camera views. Compare **Learned placement**, **Original placement**, and your custom arrangement on the same route. Boat speed, playback speed, a time scrubber, numeric coordinates, and arrow-key placement are available. The first sighting is sampled once per second over 180 seconds; a boat holds at its destination.

This panel runs locally in the browser and does not move the live fleet. It models ideal tower visibility on a flat arena, excluding terrain, camera misses, and mobile vehicle search. Its separate 18.6% benchmark caption refers to the saved **two towers plus vehicles** experiment below. The learned pair is the best tested configuration, not a proven global optimum or verified ArcticSim placement. Geometry and benchmark provenance checks run from `frontend/` with `node --test tests/placementDemo*.test.cjs`.

The offline experiment repeatedly spawns a synthetic boat, tests two tower placements with the mobile fleet, and saves the best validated configuration. It compares a systematic sweep with probability-guided search; it does not train a language model. Read [the research and algorithm comparison](docs/research/TOWER_SEARCH_RESEARCH.md) for the objective, sensor assumptions, primary sources, and the separate ArcticSim validation steps.

The [verified local benchmark](docs/research/TOWER_SEARCH_RESEARCH.md#measured-results) reduced capped mean detection time from 121.45 to 98.82 seconds on 160 unseen episodes, with detection success increasing from 48.75% to 62.50%. A [saved example policy](docs/research/example-search-policy.json) is included; use `SEARCH_POLICY_FILE=../docs/research/example-search-policy.json` from `backend/` to preview it without first retraining. These are synthetic results, not confirmed ArcticSim camera performance.

From `backend/`, with Python 3.12 or later (no extra packages needed for training):

```powershell
python -B train_search.py --candidates 32 --train 32 --validation 48 --test 160 --output ../runs/tower-search
# Continue learning from the saved incumbent; use new untouched test episodes.
python -B train_search.py --resume ../runs/tower-search --candidates 32
```

The output directory contains `best_policy.json`, `latest_report.json`, and a separate report for each completed round. Training chooses candidates; validation selects the algorithm/placement without increasing validation misses; test results are never used for selection. Reports retain missed boats at the 180-second deadline, individual episode results, paired uncertainty intervals, source fingerprints, and towers-only/vehicles-only comparisons. The selected sweep is an explicit benchmark policy, not the pre-existing flight controller's exact patrol.

To preview a saved placement through the existing backend and HUD, start one **local** backend with:

```powershell
$env:ADAPTER = 'local'
$env:FORCE_KINEMATIC = '1'
$env:DATABASE_ENABLED = '0'
$env:SEARCH_POLICY_FILE = '../runs/tower-search/best_policy.json'
python -m uvicorn main:app --host 127.0.0.1 --port 8000 --workers 1
```

The two mounts and FIND policy load into the existing adapter and brain. After a detection, the existing handoff/tracking behavior takes over. Sampling follows the saved observation interval even though control runs at 10 Hz. This preview uses the ordinary local scripted target; the repeatable randomized benchmark runs through `train_search.py`. Stop a running backend before replacing it. Clear `SEARCH_POLICY_FILE` before using WHITEOUT, hybrid SITL or replay; synthetic policies are rejected there. No live tower repositioning or simulator reset is performed by training.

This is a flat 3 km local model with synthetic FOV observations. It does not establish the best positions on Fort Ross terrain, confirmed camera detection, or a global optimum. Target-motion boundary reflections and craft heading were corrected so the optimizer does not exploit a stuck boat or an incorrect camera bearing.

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

### Connected terrain and camera preview

Open `/backend` on the frontend for the combined ArcticSim world, four camera feeds, fleet telemetry, and backend evidence. The **Simulator world** view embeds the actual Gazebo scene; selectable object tags add live mission roles, altitude and speed to native Gazebo poses. Select a tag for heading, battery, link status and intent, or use Locate to centre the view. Stale telemetry is marked explicitly. The optional 2D plot and 3D schematic retain estimated targets and coverage. The world and four feeds share a side-by-side monitor on wide windows, with a 2×2 camera grid below the world on narrower screens. **Expand monitor** opens the combined view in fullscreen; Escape returns to the dashboard. Camera images refresh while their panels are visible. The embedded simulator retains its own pause/reset controls.

For this Windows workspace the preview is at `http://127.0.0.1:3002/backend`, the backend at port 8000, the terrain viewer at 8080, and simulator status at 8090. Start the existing configured four-asset simulator before the backend:

```powershell
docker start arctic-sim arctic-control arctic-sim-quadcopter arctic-sim-fixed-wing arctic-sim-tower-1 arctic-sim-tower-2
```

Stop any existing API or headless controller before starting its replacement. From the backend checkout's `backend` directory, with dependencies installed in the checkout's `.venv`:

```powershell
$env:ADAPTER = 'whiteout'
$env:ARCTIC_HOST = '127.0.0.1'
$env:DATABASE_ENABLED = '0'
..\.venv\Scripts\python.exe -B -m uvicorn main:app --host 127.0.0.1 --port 8000 --workers 1
```

This starts the existing simulated flight controller, including its arm/takeoff sequence. The configured world contains a quadcopter, fixed-wing aircraft, and two sensor towers; the rover container is not part of this world. Verify `/health` reports `adapter: whiteout` and `/cameras` lists four sources. For a frontend started separately, set `NEXT_PUBLIC_WS_URL=ws://127.0.0.1:8000/ws/telemetry` and `NEXT_PUBLIC_API_URL=http://127.0.0.1:8000`; run `npm run dev -- --hostname 127.0.0.1 --port 3002` from `frontend`. `NEXT_PUBLIC_SIM_VIEWER_URL` defaults to `http://127.0.0.1:8080`, and the server-only `SIM_CONTROL_URL` defaults to `http://127.0.0.1:8090`.

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
