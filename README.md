# Operation: Overwatch — teammate start

## Noncombat simulation tracking update

This iteration improves the offline hackathon simulation. Cameras retain independent pending observations, so unrelated clutter cannot erase a contact awaiting confirmation. A rejected return no longer consumes a whole camera frame before another compatible return is considered. The discovering aircraft can briefly verify its own recent sighting without awarding confirmation or custody. Following waypoints keep their continuous camera viewing distance, and a fresh observation from another sensor prevents an unnecessary lost-contact search offset. Patrol also advances when the aircraft's own camera has covered a waypoint, avoiding repeated approaches to already-observed cells and unreachable edge waypoints.

Terrain, sensor probabilities, camera limits, aircraft speeds, turn rates, scoring tolerances and two-frame confirmation requirements remain unchanged. The legacy tower-first path is preserved. These changes do not modify the fleet adapters or runtime aircraft controllers.

Training can reuse a saved candidate with `--initial-model`, then compares it against new proposals on training and validation missions. Old test results are never imported as a selection score. The dashboard uses this warm start for coordinated training. The standalone `backend/compare_simulation.py` checks source fingerprints and disjoint seeds, runs each checkout in an isolated process, verifies matching scenarios and scoring rules, and reports paired confidence intervals while retaining every missed mission.

The original source, model and results remain frozen on [release/0.2](https://github.com/Yd025/HTNV1/tree/release/0.2). Use that checkout to replay the original coordinated model; its source fingerprints intentionally differ from this revision.

The initial tracking revision is retained in [its comparison](frontend/public/experiments/tracking-initial-comparison.json) and [parameter model](frontend/public/experiments/tracking-initial-model.json). On 200 paired missions (20970001–20970200), release detection was 60.5% versus 64.5%, custody 22.53% versus 23.34%, and longest gap 135.73 versus 127.30 seconds. All three paired confidence intervals included zero improvement. These missions were excluded from subsequent evaluation. The archived model supplies warm-start parameters only; its source hashes predate the camera-footprint patrol fix and it is not replayable with current source.

For the final revision, development used missions 20770001–20770048 and separate validation used 20780001–20780048. Full training then used seed 32000000, with 256 motion trajectories, 12 candidates on 24 training missions, and three finalists on 24 validation missions. The selected policy was frozen before its 200 test missions and a separate 400-mission paired comparison against release 0.2. Previously viewed comparison and training ranges are explicitly excluded. No further strategy changes were selected using the final test results.

The [400-mission paired comparison](frontend/public/experiments/release-comparison.json), on seeds 21070001–21070400, measures the released optimized strategy against this revision:

| Metric | Release 0.2 optimized | Current revision | Paired improvement, 95% interval |
| --- | ---: | ---: | --- |
| Confirmed ship detection | 68.75% | 70.00% | +1.25 percentage points [−4.25, +6.75] |
| Aircraft custody, all sampled mission time | 24.07% | 29.80% | +5.73 percentage points [+3.46, +8.05] |
| Mean longest contact gap | 113.98 s | 106.28 s | 7.70 s saved [−7.49, +23.04] |
| Position RMSE | 237.91 m | 268.83 m | Increased; no uncertainty interval estimated |
| False confirmed contacts, total | 7 | 12 | Increased; no uncertainty interval estimated |
| Mean aircraft travel | 7.113 km | 7.059 km | Decreased; no uncertainty interval estimated |

Aircraft custody improved by about 24% relative to release 0.2, with its paired interval excluding zero. A large detection improvement or reliably shorter gaps was not established. More false contacts and higher position error are material tradeoffs; this is not evidence of uniformly better reliability. Intervals use 2,000 paired whole-mission bootstrap samples and retain all misses. The original 66.5% detection figure used a different mission set and must not be substituted for the paired reference above.

The dashboard's [200-mission report](frontend/public/experiments/surveillance-report.json) uses a separate test set, 32400000–32400199. Historical tower-first/default sites, current default coordinated settings, and the final trained policy respectively achieved detection of 26.0%, 59.0%, and 70.0%; aircraft custody of 9.09%, 29.27%, and 31.93%; and mean longest gaps of 228.25, 139.45, and 106.25 seconds. Candidate 6 was selected on validation before these tests. These figures describe a different comparison from the 400-mission release check.

To reproduce the paired comparison, place a checkout of `release/0.2` beside this checkout (for example, `git worktree add ../release-0.2 release/0.2` from the repository root), then run from `backend/`:

```powershell
python -B compare_simulation.py --reference-root ../../release-0.2 --reference-model ../../release-0.2/frontend/public/experiments/surveillance-model.json --candidate-model ../frontend/public/experiments/surveillance-model.json --seed-start 21070001 --episodes 400 --exclude-range 20770001:20770048 --exclude-range 20780001:20780048 --exclude-range 20970001:20970200 --exclude-range 31100000:31400199 --output ../.qa/reproduced-release-comparison.json
```

This replays a published benchmark; reusing these missions after further tuning would no longer be a fresh evaluation. Validation passed 257 backend tests, 118 dashboard tests and TypeScript checking. All 13 protected world, sensor, movement and scoring sections match release 0.2, and four legacy replay hashes match exactly.

## Release 0.2

The `release/0.2` branch bundles the current dashboard, backend, saved experiment evidence, and `cant-catch-me/` game, including badge controls and the Freeze submission documents. It preserves the existing strategy and benchmark results. The game is included in this checkout; the Windows launcher locates it automatically and retains support for a sibling game checkout. Development and production dashboard builds use separate output directories, with `NEXT_DIST_DIR` available as an override.

The frozen 200-mission report records 50/200 baseline detections and 133/200 optimized detections. Aircraft custody covers all sampled mission time, including missions without detection. The mean longest-gap metric assigns the full 300-second horizon to undetected missions, so its reduction combines improved acquisition with contact continuity. These are synthetic results, not measured live-camera accuracy.

The coordinated report's legacy `postTowerCustodyPct` field actually counts eligible samples after any sensor confirms the target, despite the saved definition saying tower acquisition. This definition mismatch does not affect detection rate, aircraft custody, or mean longest gap above. The historical report is retained unchanged.

Release checks: 229 backend tests passed across the suite and one targeted rerun with its mocked database enabled; 116 dashboard tests passed and one was skipped; 105 game tests and game typechecking passed. Both production builds completed and served their main pages locally; the dashboard's Windows standalone dependency-copy step warned about a dependency junction, so that standalone output is not a validated deployment artifact. The launcher was syntax-checked without starting a fleet controller.

Hack the North WHITEOUT base. This repo already contains the shared intelligence loop, simulator adapter, and HUD.

**Four-person team: start with [docs/team/README.md](docs/team/README.md).** The shared setup is on `dev`; each person works on their assigned branch and opens small PRs into `dev`. Tracking research and the proposed predictive handoff are in [docs/research/TRACKING_RESEARCH.md](docs/research/TRACKING_RESEARCH.md).

**Agents (Cursor/Codex/etc.): read [AGENTS.md](AGENTS.md) first** — architecture, file map, invariants, arctic-sim adapter. Humans: this README is the 10-minute bring-up.

## Cant Catch Me player learning

The dashboard's **Game** tab (`/?tab=game`) connects to the separate Cant Catch Me game server. It shows actual opening-stretch player outcomes, capture rate by layout, held-out replay comparisons, and a 2D preview driven by the game's live ship, tower and aircraft positions. This data is separate from the operational simulation and its training experiments; game activity does not command the fleet.

Run the bundled `cant-catch-me` app with `npm run dev` (port 3100), then start this frontend as usual. The frontend's read-only `/api/game-learning` route reads the game server. Set `GAME_SERVICE_URL` to its server-reachable origin (default `http://127.0.0.1:3100`) and `NEXT_PUBLIC_GAME_URL` to the player-facing origin (default `http://localhost:3100`); restart the frontend after configuration changes. An unavailable game shows an explicit reconnect state without interrupting the mission dashboard.

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

## Coordinated surveillance and flight-policy training

The main page supports **coordinated-surveillance-v1** alongside the historical **tower-first-v2** algorithm. Coordinated surveillance sends the fixed-wing to search wider water and the quad to search nearby gaps while two fixed towers scan. Any sensor may originate a contact; repeated fresh observations confirm it. The quad then follows from a camera viewing distance, while the plane makes offset passes that move with the estimated vessel. Its fixed camera's field of view, depression and sea-level height determine when to turn away before the steep-down blind area, then reposition for another pass. The plane maintains forward speed and bounded turns; the quad and towers support contact during the plane's unavoidable viewing gaps. Both aircraft reacquire around the predicted position after contact loss. The ArcticSim PDF supplies those four assets; it does not require a tower to detect first.

There are two executable paths:

- **Offline joint experiment:** `graph_search.py` and `train_graph_search.py` evaluate legal Fort Ross tower positions together with bounded aircraft flight parameters, using terrain occlusion, camera geometry, apparent boat size and varied synthetic conditions. A sparse motion prior is fitted on training routes. Twelve candidates are ranked on 24 training missions; finalists are compared on 24 separate validation missions before the selected policy is frozen for 200 untouched tests. The two towers remain fixed within every mission. The selected policy is the best tested candidate, not a guaranteed global optimum.
- **Runtime controller:** `SwarmBrain` and `MissionCommand` consume actual adapter observations. Explicitly selecting coordinated surveillance permits aircraft to search before a tower cue and permits any camera to confirm first. The legacy default retains tower-first dispatch and grounded reserve. Both modes require the receiving aircraft's own repeated fresh observations for handoff. See the coordinated runtime configuration below for importing the portable flight parameters; graph world coordinates are not copied into live flight commands.

The six fitted `flightPolicy` fields are `laneSpacingM` (200–1600 m), `routePhase` (0–1), `quadSearchRadiusM` (250–2200 m), `lookaheadS` (0–40 s), `supportOffsetM` (100–1000 m), and `reacquireWidthM` (50–700 m). Candidate mutations change actual patrol routes and pursuit/support behavior. Selection rewards confirmed detection, fresh contact continuity, shorter outages and lower flight distance, with a penalty for false confirmations. Position and velocity during pursuit still come from observations and a conventional target filter. This is flight-policy parameter search, not neural flight control or image-model training; the detector has its own separate training path below.

Commands, proximity to a waypoint and predicted positions never count as camera acquisition. Duplicate frames, stale data, outliers and disconnected sources cannot establish custody. The target filter handles actual elapsed time, asynchronous sensor timestamps, observation identity, uncertainty and loss. MJPEG frame receipt time is preserved rather than re-labeling cached images as new frames.

The runtime also respects the inspected aircraft interfaces. The quad has a fixed camera angled 20 degrees down, so it follows at a viewing distance derived from camera height and turns its body toward the estimated vessel. Live camera following waits for sea-level altitude telemetry. The plane uses ArduPlane's supported guided waypoint message, including its initial climb waypoint. Mock transport tests exercise both launch sequences and continued commands after tower loss; no actual aircraft was armed or flown during these checks.

**Play mission** shows recorded phases, current observer, uncertainty and events. **Watch handoff example** selects a successful held-out example with aircraft custody outside tower visibility; it is labeled as an example, while the benchmark retains every miss. The algorithm selector runs either joint surveillance training or the legacy placement experiment and streams the candidates' own routes and metrics. Replays use the selected candidate's flight policy together with its tower sites. Charts use only samples through playback time; rewinding removes later evidence.

Modeled camera detail automatically returns to **Wide** when the latest report leaves the camera/detail crop or becomes more than 10 seconds old. The requested detail magnification resumes when recent evidence is inside the crop again. This prevents a stale crop from showing an unexplained blank patch; it does not turn a previous report into a current visual lock or use the boat's hidden position to steer the crop.

The historical [model](frontend/public/experiments/graph-model.json) and [complete report](frontend/public/experiments/graph-report.json) remain versioned `tower-first-v2`. Coordinated outputs use separate `surveillance-model.json` and `surveillance-report.json` files in the same experiments directory; dashboard training jobs also retain their own model/report files. Algorithm and flight parameters are saved in the model, candidate history, progress snapshots and replays. New coordinated models enforce matching source/terrain hashes. Historical tower-first models can replay through the compatible controller with an explicit warning if source hashes differ; their saved replay frames remain unchanged.

Metrics distinguish raw contact confirmation from evaluator-verified boat detection and aircraft custody; false contacts earn no boat-success credit. `anySensorCustodyPct` measures fresh correct fused contact from any sensor; `custodyPct` requires repeated aircraft observations. `longestGapS` measures the longest stale/incorrect-contact interval after first confirmation, with the full mission deadline assigned to never-detected missions. Per-aircraft flight distances are included. Offline success uses a declared 150 m truth-association tolerance, not a claim of real-camera accuracy. Truth is used only inside sensor simulation and scoring, never by the mission policy.

The historical tower-first run (seed 191926, 200 held-out missions numbered 591926–592125) uses the verified fixed camera mounts and a fresh scenario family. Selected sites increased true tower acquisition from 29.0% to 40.0% and confirmed aircraft handoff from 26.5% to 31.0% compared with the default sites under the same tower-first controller. Position RMSE fell from 415 m to 323 m and false confirmed cues fell from 3 to 2. However, custody outside tower view fell from 58.6% to 24.4%. Selection prioritized acquisition on validation data; the result improves detection but does not establish better tracking continuity. Mean capped detection delay fell by 21.3 seconds, with paired 95% bootstrap interval 0.59–41.93 seconds. Test 30 (seed 591955) illustrates a successful chain: tower confirmation at 70 s, aircraft confirmation at 115 s, and custody during 21 of 25 eligible samples outside tower view. It is an example, not the aggregate result. These numbers describe the historical algorithm, not coordinated surveillance.

The frozen release 0.2 coordinated run (seed 20260921, camera-aware support passes) compared all three strategies on the same 200 held-out missions: tower-first/default sites detected **25.0%**, default coordinated flights/default sites **46.0%**, and trained flights/selected sites **66.5%**. Aircraft tracking custody increased from **9.4% → 21.1% → 23.9%**; mean longest contact gap decreased from **228.7 → 169.6 → 118.9 seconds**. The trained strategy saved 82.9 seconds of capped detection delay against tower-first (paired 95% bootstrap interval 62.35–102.55 seconds), but increased mean aircraft travel from **4.74 to 7.12 km**. Position RMSE was **396 → 400 → 154 m**, and false confirmed contacts totaled **5 → 9 → 4** over those 200 missions. These are combined tower-and-flight-policy results under the synthetic sensor model, not an isolated comparison against the previous flight controller or proof of real-camera performance. A separate deterministic 300-second geometry regression keeps the same 100 m support offset, aircraft speed and moving vessel: the new pass controller raises camera time in view from 22.3% to 37.0% and keeps the closest pass at 324 m instead of 77 m. That fixture isolates the camera-overflight fix but does not establish general mission performance. Its frozen [model](https://github.com/Yd025/HTNV1/blob/release/0.2/frontend/public/experiments/surveillance-model.json) and [complete results](https://github.com/Yd025/HTNV1/blob/release/0.2/frontend/public/experiments/surveillance-report.json) retain all misses and source fingerprints. The current branch artifacts contain the later noncombat simulation revision described at the top of this README.

Train coordinated surveillance from `backend/` without replacing the historical artifacts:

```powershell
python -m pip install -r requirements-training.txt
python -B train_graph_search.py --algorithm coordinated-surveillance-v1 --seed 32000000 --initial-model ../frontend/public/experiments/tracking-initial-model.json --output ../frontend/public/experiments/surveillance-report.json --model-output ../frontend/public/experiments/surveillance-model.json --progress ../frontend/public/experiments/surveillance-progress.json
python -B -m unittest discover -s tests -p 'test_graph*.py' -v
```

Use `--quick` for a smoke run with four candidates and 12 held-out tests; it is not equivalent to the 200-test protocol. To rerun tower-first placement, explicitly pass `--algorithm tower-first-v2 --seed 191926` and choose separate output/model paths if retaining the saved historical files. For the dashboard's experiment buttons, start the frontend with `GRAPH_PYTHON` pointing to the Python environment where `requirements-training.txt` is installed. This variable configures the local experiment worker, independently of the backend API environment.

The experiment uses projected ArcticSim world X/Y, fixed aircraft camera mounts, simplified aircraft dynamics and approximate tower pointing. Its 5-second sampling, condition-dependent detection/miss/clutter model, uncertainty and control thresholds are recorded in the output. Real camera detection rates, flight dynamics and operational reliability remain uncalibrated. Offline tower selection does not automatically reposition the live simulator; apply the selected sites through its placement configuration after verifying coordinate conversion and camera heights. Live submission remains a separate integration step (`POST /api/tracks`, simulator port 8010 in slide 24).

## Coordinated surveillance runtime

`coordinated-surveillance-v1` is an opt-in runtime algorithm shared with the new offline flight-policy training. Before any contact, the plane flies repeated camera-oriented sweep lanes, the quad searches a complementary local patch with less tower/plane overlap, and the towers keep scanning. Any aircraft or tower camera can initiate a candidate; two fresh consistent accepted observations confirm it. A plane can retain visual custody after discovering the vessel, but handing off to the quad still requires two fresh observations from that receiving quad. A second tower watches the estimated continuation when available. Observation gaps expand the reacquisition search, then expire the track and resume patrol. Aircraft with reported battery at or below 20% return toward their launch reserve position/orbit; this is a fixed reserve threshold, not a calibrated endurance model.

Training selects six bounded route/tactic parameters, rather than replaying privileged target paths or training a neural flight controller:

| Parameter | Default | Allowed range | Runtime effect |
| --- | --- | --- | --- |
| `laneSpacingM` | 700 m | 200–1600 m | Plane lane spacing, capped by a nominal camera footprint. |
| `routePhase` | 0 | 0–1 | Starting waypoint around the patrol route. |
| `quadSearchRadiusM` | 1200 m | 250–2200 m | Quad's local search extent, bounded by the arena. |
| `lookaheadS` | 15 s | 0–40 s | Predicted continuation for aircraft/tower support; runtime quad follow and fixed-wing camera guidance cap lead at 8 s. |
| `supportOffsetM` | 350 m | 100–1000 m | Oblique fixed-wing viewing passes and repositioning width, respecting a camera-derived minimum viewing distance. |
| `reacquireWidthM` | 250 m | 50–700 m | Initial reacquisition width, expanded with track uncertainty. |

The backend still defaults to `tower-first-v2` when neither new environment variable is set. Select the new algorithm before starting a new backend process:

```powershell
# From backend/, local kinematic run:
$env:MISSION_ALGORITHM = 'coordinated-surveillance-v1'
$env:ADAPTER = 'local'
python -m agent --adapter local
```

After training, set `SURVEILLANCE_POLICY_FILE` to the new coordinated graph model (from `backend/`, `../frontend/public/experiments/surveillance-model.json`) or a portable JSON object containing `algorithm` and `flightPolicy`. A supplied file selects its named algorithm unless it conflicts with `MISSION_ALGORITHM`, in which case startup fails. Invalid, unknown or out-of-range parameters also fail before the adapter connects. Only `flightPolicy` loads: graph tower placements, world X/Y coordinates, motion priors and synthetic sensor probabilities do not enter the runtime. Routes are regenerated using the connected adapter's origin and rotated arena boundary. In Compose the model directory is mounted read-only at `/flight-policies`, so the equivalent file path is `/flight-policies/surveillance-model.json`.

The runtime uses actual adapter observations and existing MAVLink commands. Its camera geometry and bounded routes do not establish terrain clearance, calibrated detection performance, realistic wind/turn dynamics or operational reliability. The graph trainer and runtime regenerate routes differently; synthetic training gains are not evidence of live gains. Verify the loaded algorithm, six values, file hash and explicit scope flags in `/telemetry/latest` → `mission_algorithm`; `c2.algorithm` also identifies the controller. The selected policy is recorded in the run manifest. Existing processes retain their loaded policy until explicitly relaunched.

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
## Sentry tracking evidence

Open **Sentry** in the dashboard sidebar, visit [localhost:3000/sentry](http://localhost:3000/sentry), or use the Sentry link in the backend preview. The tab shows browser/server/backend SDK status, exporter counters, the current run ID and a rolling performance summary. It links to Issues, Traces, Logs and Replays in the configured organization and project. `/sentry-example-page` opens the same verification view. **Send test event** captures a labeled error, structured log and sampled trace while keeping the dashboard usable; the result distinguishes Sentry accepting the envelope from the SDK merely flushing its queue.

**Control performance** summarizes up to 1,200 browser-received ticks from the last 60 seconds, updating every two seconds. It reports p50/p95/max, core-budget violations, per-stage time share, failed spans, and the worst trace ID. Stage rows stay in a stable order. **Pause summary** freezes the displayed evidence while collection continues; **Save summary** exports that summary as JSON. Collection runs across dashboard tabs and resets for a new run. Missing/stale frames and duplicate sequences are excluded. These are observed core timings, not complete backend deadline statistics; recording and telemetry export are outside the measured core. Use `RUN_LOG_DIR` for full optimizer inputs.

The Next.js 14 Pages Router SDK initializes through `sentry.client.config.ts` and the server/edge instrumentation files. It records navigation and telemetry state changes, with 10% trace/session sampling and masked replay retention on errors. Text is masked and media is blocked, except the native simulator canvas described below. Native Next.js reads `frontend/.env.local`; use `frontend/.env.example` as the template. Docker Compose receives `NEXT_PUBLIC_SENTRY_DSN` and the other public Sentry settings from the root environment. The wizard-generated `.env.sentry-build-plugin` is ignored; set its `SENTRY_AUTH_TOKEN` as a build-time environment variable to enable source-map uploads. Never use a `NEXT_PUBLIC_` name for this token.

In the Sentry tab, **Open ship camera** embeds the native simulator with one default **Follow ship** view: drag to orbit and scroll to zoom. The asset strip identifies towers and vehicles with their assigned search/cue/track/confirm roles; selecting a matched asset locates it in the world. Labels use the same role colors. Roles indicate tasking, not confirmed visual contact, and detection counts describe reports in the received frame. **View options** contains label visibility and a free camera. Disconnects, missing objects and invalid positions pause ship following until the world recovers. This observer camera uses the native model pose only to compose the view; it never feeds the detector, estimator, or vehicle control loop. It is separate from the backend's local synthetic run when `ADAPTER=local`.

Native towers and aircraft remain labeled and locatable even when mission telemetry is unavailable. In that case the viewer reports **Assignment unavailable**. Local kinematic fleet metadata is never attached to native simulator objects.

Selecting an asset frames its horizontal reference-radius circle and the native ship together, with a live ship close-up at the top right. Reference radii use the configured WHITEOUT tower mounts (2,500 m) and the vehicle coverage model (plane 400 m, copter 120 m, rover 40 m). They are labeled as unverified sensor reach, not camera FOV or confirmed detection coverage. **Follow ship** clears the selection and recenters an elevated view over the ship; drag and zoom remain available. The inset uses the existing native renderer and does not open another simulator connection.

For presenting, [the mission demo](http://localhost:3000/backend) keeps Mission and Sentry guide as the main navigation, with appearance, alternate plots and technical diagnostics collapsed. Its [Sentry guide](http://localhost:3000/backend#sentry-guide) walks through following the ship, pausing the measured stage-duration graph, inspecting the worst trace and opening the same run's logs. Use Traces for slow stages, Logs for observation/dispatch problems, Issues for exceptions, and Replay for camera/UI behavior. Verify delivery on `/sentry` before presenting; local timing graphs do not establish cloud ingestion and sampled traces may be absent.

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

### Launch the local dashboard and game bundle

With the existing Fort Ross ArcticSim stack running, use PowerShell 7 from this checkout:

```powershell
./start-whiteout.ps1 -Python ../HTNV1-backend/.venv/Scripts/python.exe
```

`-Python` can point to any environment with `backend/requirements.txt` installed; it defaults to this checkout's `.venv/Scripts/python.exe`. Install dashboard dependencies in `frontend` and game dependencies in the sibling `cant-catch-me` directory first (`npm ci` in each). Use `-GamePath` if that sibling is elsewhere. Add `-Check` to validate the setup without starting services.

New launcher sessions select `coordinated-surveillance-v1`, so the simulated aircraft begin surveillance before a tower sighting. Use `-MissionAlgorithm tower-first-v2` for the old tower-gated mission. To load trained aircraft tactics, add `-FlightPolicyFile frontend/public/experiments/surveillance-model.json` after training a coordinated model. Relative policy paths resolve from this checkout. `-Check` reports the requested and running algorithms plus `NeedsBackendRelaunch`; it never changes a controller. A running backend with another/unreported algorithm or different requested policy contents must be explicitly stopped and relaunched; the launcher refuses to silently reuse it.

The launcher connects the existing WHITEOUT backend to the local simulator, serves the dashboard at **http://127.0.0.1:3003**, and links the game at **http://127.0.0.1:3100** through the dashboard's **Game** tab. Open **http://127.0.0.1:3003/backend** for the native world and cameras. Existing compatible services are reused. A running local-demo backend must be stopped before launching; the script refuses to replace it or run another controller. The script reports process IDs for services it starts and writes their logs under `.qa/whiteout/`; failed startup rolls back only those new processes. Services continue running after the script returns.

Native launch loads this checkout's `.env` for optional backend integrations, overrides the simulator addresses to this computer, and excludes synthetic search policies. It skips Postgres unless database settings are supplied in the invoking environment. It leaves saved configuration and game learning history untouched. Docker uses the separate internal addresses documented in `.env.example`; generic Compose startup still defaults to local demo mode.

WHITEOUT supplies vehicle telemetry and camera observations to the existing mission tracker and WebSocket. The game retains its own physics and learning records; game replays do not become real camera detections or move the simulator's target vessel. Coordinated surveillance authorizes simulated aircraft patrol before detection; the legacy algorithm retains tower-confirmed launch. Each connection checks the configured MAVLink identity (quad 1, plane 2, tower 1 = 4, tower 2 = 5), rejecting other vehicles' messages before they can change pose or command routing. See `.env.example` for explicit identity overrides if the simulator roster changes. Fleet links expire after five seconds without a vehicle heartbeat, suppress stale commands/observations, and reconnect in the background. A running controller alone does not prove every asset is connected or that camera tracking has acquired the vessel.

During Windows live verification, Docker UDP forwarding sometimes stayed unavailable after client reconnects. Restarting the affected existing `arctic-sim-*` vehicle container restored its telemetry; the backend then reconnected automatically. The launcher reports partial connectivity explicitly. Initial GPS placeholders and disconnected samples are excluded from mission travel and coverage, and the viewer's mission-link count comes from the backend's current telemetry.

If a connected aircraft remains on the ground after accepted takeoff commands, inspect its physical pose. Restarting only an autopilot preserves an overturned Gazebo aircraft. Stop the reported mission backend process first, use the simulator control service's **Reset simulation** (`POST http://127.0.0.1:8090/api/reset`), wait for `/api/status` to return `idle` and the fleet to reconnect, then relaunch with the same algorithm and policy file. This recreates the simulator and fleet together; saved training artifacts remain intact. Verify sustained altitude and movement, rather than relying on command acknowledgements.

The coordinated WHITEOUT adapter uses the verified Fort Ross heightmap maximum of **252.109 m above sea level** to set a **330 m estimated sea-level cruise height**. It converts that height to each aircraft's own home-relative MAVLink altitude. This includes a 20 m allowance for the 11–14 m EKF height overestimate observed against own raw GPS and Gazebo in local validation; it is not a general altitude calibration. The quad climbs vertically; a ground-launched plane climbs over the surveyed water circle at world `(-350, 1250)` (the surrounding 200 m disk is sea-level terrain), and an already airborne controller reconnect climbs locally. Mission routes are released above an estimated 323 m MSL. This envelope is specific to Fort Ross; it does not import the graph simulator's terrain-following dynamics, and the historical tower-first algorithm retains its original flight behavior.

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
