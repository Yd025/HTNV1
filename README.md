# Operation: Overwatch — teammate start

Hack the North WHITEOUT base. This repo already contains the shared intelligence loop, simulator adapter, and HUD.

**Four-person team: start with [docs/team/README.md](docs/team/README.md).** The shared setup is on `dev`; each person works on their assigned branch and opens small PRs into `dev`. Tracking research and the proposed predictive handoff are in [docs/research/TRACKING_RESEARCH.md](docs/research/TRACKING_RESEARCH.md).

**Agents (Cursor/Codex/etc.): read [AGENTS.md](AGENTS.md) first** — architecture, file map, invariants, arctic-sim adapter. Humans: this README is the 10-minute bring-up.

## Cant Catch Me player learning

The dashboard's **Game** tab (`/?tab=game`) connects to the separate Cant Catch Me game server. It shows actual opening-stretch player outcomes, capture rate by layout, held-out replay comparisons, and a 2D preview driven by the game's live ship, tower and aircraft positions. This data is separate from the operational simulation and its training experiments; game activity does not command the fleet.

Run the sibling `cant-catch-me` app with `npm run dev` (port 3100), then start this frontend as usual. The frontend's read-only `/api/game-learning` route reads the game server. Set `GAME_SERVICE_URL` to its server-reachable origin (default `http://127.0.0.1:3100`) and `NEXT_PUBLIC_GAME_URL` to the player-facing origin (default `http://localhost:3100`); restart the frontend after configuration changes. An unavailable game shows an explicit reconnect state without interrupting the mission dashboard.

The game pins each player's opening tower layout, verifies completed recordings through its exact deterministic engine, sends a sanitized attempt attachment to Sentry, imports and validates the saved attachment, and automatically evaluates new sites after eight completed Sentry-imported attempts. The Game tab shows upload/import status and links to Sentry visual replays. The game needs its DSNs for recording and a server-only SENTRY_API_TOKEN with project:read to import model data; DSNs alone cannot enable model ingestion. It changes tower positions only. Land, protected-start, capture-time and retained-escape checks gate promotion; active players and later procedural stretches keep their existing rules. Historical routes are replay estimates, not proof that future human players will behave the same way. Runs that close or exceed five active minutes are excluded from training. Persistent attempts and layouts are stored in the game's `.game-learning` directory, outside Git; use `GAME_LEARNING_DIR` for a durable location. One game server process owns that archive. See the game's README for the endpoint contract, recording limits and fairness policy.

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

## Tower-first detection and drone handoff

The main page **Place. Detect. Follow.** now implements the requested sequence: optimize two fixed tower sites, confirm a moving boat from tower observations, dispatch the quadcopter and fixed-wing, and maintain an aircraft track after the boat leaves tower view. The ArcticSim PDF supplies those four assets; tower-first response is our chosen strategy, not a mandatory rule in the slides.

There are two executable paths:

- **Offline placement experiment:** `graph_search.py` and `train_graph_search.py` evaluate legal Fort Ross tower positions using terrain occlusion, camera geometry, apparent boat size and varied synthetic conditions. They learn a sparse motion prior and select a tower pair on separate validation missions before freezing it for 200 untouched tests. The selected placement is the best tested candidate, not a guaranteed global optimum. The two towers remain fixed throughout every mission.
- **Runtime controller:** `SwarmBrain` and `MissionCommand` consume actual adapter observations. Two fresh consistent tower frames authorize dispatch; two distinct-time observations from the receiving aircraft confirm its handoff. Before a cue, grounded aircraft receive no command that would arm/take off. Airborne aircraft reserve/loiter. The quad follows the estimate, the fixed-wing provides forward coverage/reacquisition, and fresh aircraft observations sustain tracking without tower visibility. Gaps lead to coasting, reacquisition and eventual track expiry.

The learned water-occupancy prior guides tower-placement proposals. During pursuit, position and velocity come from fresh sensor observations and a conventional target filter; this is not a trained neural flight policy. The image detector has its own separate training path below.

Commands, proximity to a waypoint and predicted positions never count as camera acquisition. Duplicate frames, stale data, outliers and disconnected sources cannot establish custody. The target filter handles actual elapsed time, asynchronous sensor timestamps, observation identity, uncertainty and loss. MJPEG frame receipt time is preserved rather than re-labeling cached images as new frames.

The runtime also respects the inspected aircraft interfaces. The quad has a fixed camera angled 20 degrees down, so it follows at a viewing distance derived from camera height and turns its body toward the estimated vessel. Live camera following waits for sea-level altitude telemetry. The plane uses ArduPlane's supported guided waypoint message, including its initial climb waypoint. Mock transport tests exercise both launch sequences and continued commands after tower loss; no actual aircraft was armed or flown during these checks.

**Play mission** shows recorded phases, current observer, uncertainty and events. **Watch handoff example** selects a successful held-out example with aircraft custody outside tower visibility; it is labeled as an example, while the benchmark retains every miss. **Optimize tower placement** runs the local numerical experiment and streams candidate results. **Run this placement** freezes edited tower sites for the selected boat route. Charts use only samples through playback time; rewinding removes later evidence.

The saved [model](frontend/public/experiments/graph-model.json) and [complete report](frontend/public/experiments/graph-report.json) are versioned `tower-first-v2` with source/terrain hashes. Old models are rejected for new replays. Metrics distinguish raw contact confirmation from evaluator-verified boat detection and aircraft custody; false contacts earn no boat-success credit. Offline success uses a declared 150 m truth-association tolerance. This is an evaluation tolerance, not a claim of 150 m real-camera accuracy. Truth is used only inside sensor simulation and scoring, never by the mission policy.

The saved run (seed 191926, 200 held-out missions numbered 591926–592125) uses the verified fixed camera mounts and a fresh scenario family. Selected sites increased true tower acquisition from 29.0% to 40.0% and confirmed aircraft handoff from 26.5% to 31.0% compared with the default sites under the same tower-first controller. Position RMSE fell from 415 m to 323 m and false confirmed cues fell from 3 to 2. However, custody outside tower view fell from 58.6% to 24.4%. Selection prioritized acquisition on validation data; the result improves detection but does not establish better tracking continuity. Mean capped detection delay fell by 21.3 seconds, with paired 95% bootstrap interval 0.59–41.93 seconds. Test 30 (seed 591955) illustrates a successful chain: tower confirmation at 70 s, aircraft confirmation at 115 s, and custody during 21 of 25 eligible samples outside tower view. It is an example, not the aggregate result.

Reproduce the placement experiment from `backend/`:

```powershell
python -m pip install -r requirements-training.txt
python -B train_graph_search.py --seed 191926
python -B -m unittest discover -s tests -p 'test_tower*.py' -v
```

For the dashboard's experiment buttons, start the frontend with `GRAPH_PYTHON` pointing to the Python environment where `requirements-training.txt` is installed. This variable configures the local experiment worker, independently of the backend API environment.

The experiment uses projected ArcticSim world X/Y, fixed aircraft camera mounts, simplified aircraft dynamics and approximate tower pointing. Its 5-second sampling, condition-dependent detection/miss/clutter model, uncertainty and control thresholds are recorded in the output. Real camera detection rates, flight dynamics and operational reliability remain uncalibrated. Offline tower selection does not automatically reposition the live simulator; apply the selected sites through its placement configuration after verifying coordinate conversion and camera heights. Live submission remains a separate integration step (`POST /api/tracks`, simulator port 8010 in slide 24).

## Actual camera perception and image-model training

The real camera path is `MJPEG frame + own-platform pose → vessel detector → pixel-to-water projection → target filter → mission controller`. It supports an optional local object-detection model; a whole-image classifier is insufficient for localization. No radar, lidar or sonar feed is invented.

The default `VESSEL_DETECTOR=blob` is explicitly a simulator color baseline. To use the neural path in a native Python environment, install `backend/requirements-vision.txt` alongside the base requirements and set:

```powershell
$env:VESSEL_DETECTOR = "yolo"
$env:VESSEL_MODEL_PATH = "C:/models/trusted-vessel-model.onnx"
$env:VESSEL_CLASSES = "boat,ship,vessel"
$env:VESSEL_DEVICE = "cpu"
```

Supply an existing trusted `.pt` or `.onnx` detection model. Class names are read from model output, multiple vessel boxes are preserved, and the bottom-center water-contact point is projected. Inference runs outside the fast controller. A missing model, dependency or vessel class produces an explicit unavailable status, never silent fallback to invented observations. `/cameras` and the camera panel expose detector status. The standard Docker image installs only base dependencies; the optional model path requires a Python environment/image with the vision requirements and access to the supplied model.

Training and evaluation are separately executable from `backend/`:

```powershell
python -B -m vision.train_vessel check --data C:/data/maritime.yaml
python -B -m vision.train_vessel train --data C:/data/maritime.yaml --weights C:/models/trusted-initial.pt --epochs 50
python -B -m vision.train_vessel evaluate --data C:/data/maritime.yaml --weights C:/models/best.pt --split test
```

Data must contain local YOLO-format images/labels and distinct train/validation/test sets. The checker rejects duplicate image content across splits; hold out whole recordings/sites to prevent adjacent-frame leakage too. No weights or labeled data were present in this workspace, so no neural training, neural accuracy or field readiness is claimed. The model interface is covered with controlled outputs, alongside actual image-baseline and projection tests.

Camera projection now distinguishes sea-level and home-relative height. It still needs measured camera/gimbal alignment, calibrated height and frame/pose synchronization. Receipt time and commanded attitude are approximations. [Research and limitations](docs/research/TOWER_SEARCH_RESEARCH.md) explain the evidence and remaining validation.

Verification for this revision: 171 backend tests and 72 frontend tests passed, including the actual telemetry serializer and all 200 replay/metric comparisons. TypeScript checks passed; desktop/mobile inspection verified the handoff and rewind states, and the local experiment button completed a replay. The frontend production build compiled, but this Windows checkout reported a symlink-permission warning when packaging its standalone server; standalone deployment packaging remains unverified.

## Historical flat-arena placement experiment

The earlier two-tower-only panel and the following benchmarks are retained in source for comparison. They use a different 3 km flat arena and synthetic sensors; they are not the current main-page ArcticSim experiment.

The main page's **Put the towers to the test** panel starts with the saved learned placement and a seeded random boat route. **Spawn random boat** samples a new start and destination anywhere in the square, independently of the towers. Drag either tower or route endpoint, then choose **Run test** to see the boat, radial pulses, and rotating camera views. A solid distance line selects the nearest tower that can currently see the boat; a dashed line is only a nearest-tower distance guide. It does not claim a sighting outside range/FOV, terrain-aware routing, or continuous target custody. First sightings are sampled once per second over 180 seconds; boats hold at their destinations.

**Improve tower placement** tries 48 pairs against the same 80 training boats, validates the top eight plus the starting layout on 64 other routes, and freezes the winner before testing 200 unseen boats. Selection favors more detections, then a lower capped mean. Misses remain in every metric at the 180-second cap. Every placement can be inspected from the history strip. Learning can pause/resume; completion automatically replays the 200 boats with fixed winning towers, holding each sighting/miss briefly. **Watch random boats**, **Next boat**, and the numbered selector replay the saved test routes. Map edits stop automation and update the distance line; the completed round's score remains explicitly saved for its winner.

Five independently selected rounds produced [1,000 additional paired, unseen tests](docs/research/placement-demo-random-tests.json): 661 boats found with the saved pair versus 665 after selection; capped mean 101.396 versus 100.783 seconds. One round regressed and three retained the starting layout. This is a modest aggregate gain, not a universal optimum. Reproduce the evidence and its compact UI summary from `frontend/` with `node scripts/benchmark-placement.cjs --check`; use the command without `--check` to regenerate both files. Run the geometry, selection, nearest-visible-link, and telemetry checks with `node --test tests/*.test.cjs`.

This panel runs locally in the browser and does not move the live fleet. It models ideal tower visibility on a flat arena, excluding terrain, camera misses, and mobile vehicle search. Two 600 m range circles cannot cover the entire 9 km² square. The learned pair is the best tested configuration under the selected random-route distribution, not a proven global optimum or verified ArcticSim placement. The separate historical benchmark below includes **two towers plus vehicles** and uses a different experiment.

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

The 2D operational map uses CARTO Dark Matter when `NEXT_PUBLIC_CARTO_BASEMAP_API_KEY` is configured, and OpenStreetMap otherwise. Set the key in ignored `frontend/.env.local` for a native frontend or root `.env` for Compose, then restart the frontend (rebuild a production frontend). This is a browser-visible basemap credential; keep the actual value out of Git. CARTO now requires the [`key` tile URL parameter](https://carto.com/basemaps/apikey/). Both providers retain their required attribution.

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
