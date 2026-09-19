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

## Sentry tracking evidence

Open **Sentry** in the dashboard sidebar, visit [localhost:3000/sentry](http://localhost:3000/sentry), or use the Sentry link in the backend preview. The tab shows browser/server/backend SDK status, exporter counters, the current run ID and a rolling performance summary. It links to Issues, Traces, Logs and Replays in `hackthenorth-nt / htn`. `/sentry-example-page` opens the same verification view. **Send test event** captures a labeled error, structured log and sampled trace while keeping the dashboard usable; the result distinguishes Sentry accepting the envelope from the SDK merely flushing its queue.

**Control performance** summarizes up to 1,200 browser-received ticks from the last 60 seconds, updating every two seconds. It reports p50/p95/max, core-budget violations, per-stage time share, failed spans, and the worst trace ID. Stage rows stay in a stable order. **Pause summary** freezes the displayed evidence while collection continues; **Save summary** exports that summary as JSON. Collection runs across dashboard tabs and resets for a new run. Missing/stale frames and duplicate sequences are excluded. These are observed core timings, not complete backend deadline statistics; recording and telemetry export are outside the measured core. Use `RUN_LOG_DIR` for full optimizer inputs.

The Next.js 14 Pages Router SDK initializes through `sentry.client.config.ts` and the server/edge instrumentation files. It records navigation and telemetry state changes, with 10% trace/session sampling and masked replay retention on errors. Text is masked and media is blocked, except the native simulator canvas described below. Native Next.js reads `frontend/.env.local`; use `frontend/.env.example` as the template. Docker Compose receives `NEXT_PUBLIC_SENTRY_DSN` and the other public Sentry settings from the root environment. The wizard-generated `.env.sentry-build-plugin` is ignored; set its `SENTRY_AUTH_TOKEN` as a build-time environment variable to enable source-map uploads. Never use a `NEXT_PUBLIC_` name for this token.

In the Sentry tab, **Open ship camera** embeds the native simulator with 13 selectable views: Orbit, Chase, Stern, Bow-on, Port, Starboard, both aft quarters, Waterline, Overhead, Wide aerial, Forward POV, and Free. Locked views rotate with ArcticSim's `target_vessel` heading; Orbit follows its position while preserving manual orbit and zoom; Free releases every camera control. Disconnects, missing objects and invalid positions pause a selected tracking view and resume it when the world recovers. This observer camera uses the native model pose only to compose the view; it never feeds the detector, estimator, or vehicle control loop. It is separate from the backend's local synthetic run when `ADAPTER=local`.

**Record this view** promotes the Replay buffer to a recorded session; **Stop replay recording** flushes it and retains the link. Only the native canvas is captured, at most 2 fps and 960 × 540, immediately after rendering without `preserveDrawingBuffer`. Canvas pixels have no text masking; surrounding DOM text remains masked and other canvases/media stay blocked. The native simulator must be running. Compose fetches its HTML using `SIM_VIEWER_INTERNAL_URL` (default `http://host.docker.internal:8080`) while browser assets/sockets use `NEXT_PUBLIC_SIM_VIEWER_URL` (default `http://127.0.0.1:8080`). Native Next.js needs no internal URL override. See [Sentry canvas recording](https://docs.sentry.io/platforms/javascript/guides/nextjs/session-replay/#canvas-recording).

The API and headless agent use **Sentry Logs and Tracing** alongside error monitoring. Set `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, and optionally `SENTRY_RELEASE`. `SENTRY_TRACES_SAMPLE_RATE` defaults to `0.1`; use `1.0` for a short demo run. Python requires `sentry-sdk>=2.35.0,<3`. Without a DSN, local tracking and recording still work.

The controller measures adapter reads, observation validation, target fusion, role allocation, platform decisions, command dispatch, metrics and snapshot generation. A bounded worker exports `swarm_tick` transactions using those measured timestamps. SDK work runs outside the control loop. These are application spans; they do not include internal MAVLink/network subspans or CPU profiles. The core tick duration excludes recording serialization, publishing and export. `/health` includes exporter queue depth, dropped ticks and failures; enabled means configured, not confirmed cloud delivery.

Structured `mission.window` logs aggregate roughly one second of ticks, with early flushes when an estimate appears/disappears and a final flush at shutdown. Attributes include `run.id`, `run.mode`, `run.scenario`, `tick.sequence`, `tick.trace_id`, latest estimated position/velocity/age/uncertainty, available scores, and window counts for received/forwarded observations, rejection reasons, command outcomes and ticks exceeding the configured budget. An estimate appearing is not proof of visual custody. Forwarded observations passed input validation; the target filter may still decline to associate them. Missing ground truth means measured tracking error remains unavailable. Queue overflow is reported explicitly; Sentry is sampled diagnostic evidence.

Use the existing `--record-dir` / `RUN_LOG_DIR` recording for the later optimization algorithm. Its `manifest.json` and `ticks.jsonl` retain original detections, vehicle positions, estimated target positions, commands, outcomes, evaluation truth, settings and source hash. Each tick now also has `diagnostics` with stage timings and a trace ID. This joins the full evidence to Sentry without depending on Sentry retention, quotas or sampling. Recording limits and completeness checks still apply.

After stopping any controller for the same fleet, run from `backend/` (native Python does not automatically load `.env`; export these variables in the shell):

```powershell
$env:ADAPTER = "local"
$env:FORCE_KINEMATIC = "1"
$env:SENTRY_DSN = "<your project DSN>"
$env:SENTRY_TRACES_SAMPLE_RATE = "1.0"
$env:RUN_SCENARIO = "local-weave-baseline"
python -B -m agent --adapter local --record-dir ../runs --seconds 30
```

For the prize demo, filter Sentry Logs by `event.name:mission.window run.id:<run-id>`. Inspect `window.rejected.duplicate`, `window.rejected.stale`, `window.commands.dispatch_error`, and `window.over_budget`. Open the `swarm_tick` trace from `window.slowest_trace_id` or `window.last_error_trace_id` to locate the expensive/failing stage, then inspect that tick in the recording. `tick.trace_id` identifies the latest tick in the window; earlier anomalies retain their own trace links. Re-run the same scenario after a targeted change and compare measured latency, rejection counts and truth-based error where available. Preserve both runs and actual Sentry links/screenshots as evidence of what changed; the integration alone is not a measured improvement.

Offline tests use Sentry's real SDK with an in-memory transport to verify Logs and Tracing, timestamp accuracy, recording correlation, no-truth semantics and continued control during exporter failure/backpressure. They do not verify ingestion by a live Sentry project. References: [Sentry Python Logs](https://docs.sentry.io/platforms/python/logs/) and [custom tracing](https://docs.sentry.io/platforms/python/tracing/instrumentation/custom-instrumentation/).

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
