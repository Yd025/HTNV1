# Freeze

Freeze coordinates camera towers and aircraft to find and track ships in an Arctic simulation. Built for Hack the North 2026's WHITEOUT challenge, it combines a mission dashboard, an observation-driven fleet controller, reproducible strategy experiments, and **Can't Catch Me**, a ship-escape game that records player routes for strategy evaluation.

**`main` is the canonical final release.** It contains the dashboard, backend, game, badge controls, saved experiments, and submission materials. [Release 0.2](https://github.com/Yd025/HTNV1/tree/release/0.2) remains the frozen historical comparison. Operation Overwatch is the implementation's earlier name; some internal packages retain it.

[Submission](DEVPOST_FREEZE.md) · [Pitch and Q&A](FREEZE_PITCH_AND_QA.md) · [Game guide](cant-catch-me/README.md) · [Contributor guide](docs/team/README.md)

Presentation materials: [timed video pitch](FREEZE_TIMED_VIDEO_PITCH.md), [algorithm results](freeze-algorithm-results.md), and [submission gallery](docs/gallery/freeze-gallery-2026-09-20.zip).

## What is included

- **Mission dashboard:** synchronized experiment playback, fleet roles, camera views, contact uncertainty, mission events, and explicit connection/freshness status. `/backend` combines the connected ArcticSim world, cameras, and runtime diagnostics.
- **Coordinated surveillance:** two towers scan while a fixed-wing plane and a quad search complementary areas. Repeated fresh observations establish contact; aircraft support tracking and reacquisition. Historical `tower-first-v2` behavior remains available.
- **Simulation lab:** jointly searches tower sites and six bounded flight settings, selects on separate training/validation missions, and retains every miss in held-out results.
- **Can't Catch Me:** a separate game with two towers, two quads, and a plane; keyboard, touch, and optional Hack the North badge controls. Each attempt pins its rules, policy, layout, and seed.
- **Sentry evidence:** controller traces/logs, UI replay, and structured game-recording upload/import. Cloud delivery and successful learning promotion are separate from local gameplay.

This is a noncombat hackathon simulation and game. Synthetic results do not establish live-camera accuracy or official competition scores.

## Run the local demo

Use Docker Compose for the dashboard, backend, and TimescaleDB. No sponsor credentials or ArcticSim installation are required. From a fresh checkout:

```bash
cp .env.example .env
docker compose up --build
```

In PowerShell, use `Copy-Item .env.example .env` for the first command. Preserve an existing configured `.env`. Defaults are `ADAPTER=local` and `FORCE_KINEMATIC=1`: synthetic vehicles and observations run locally. The generic backend defaults to tower-first; coordinated surveillance is selected explicitly below.

| Service | Address |
| --- | --- |
| Dashboard and saved experiments | http://localhost:3000 |
| Backend health | http://localhost:8000/health |
| Latest mission state | http://localhost:8000/telemetry/latest |
| Mission WebSocket | ws://localhost:8000/ws/telemetry |
| Game, started separately | http://localhost:3100 |

The game is bundled but is not a Compose service. With Node.js 20 and npm installed, start it in another terminal:

```bash
cd cant-catch-me
npm ci
npm run dev
```

Open the dashboard's **Game** tab at `/?tab=game`. Compose reaches the native game through `GAME_SERVICE_URL=http://host.docker.internal:3100`; a native dashboard defaults to `http://127.0.0.1:3100`. `NEXT_PUBLIC_GAME_URL` is the player's browser address. Change these addresses for remote hosting and restart the frontend.

Saved experiments can be viewed without retraining. New dashboard training jobs require a native Python environment with `backend/requirements-training.txt`; set `GRAPH_PYTHON` in `frontend/.env.local` to that interpreter. The standard frontend container does not include this training environment.

## Native development

Use Python 3.12 and Node.js 20. Python commands run from `backend/`, where imports resolve. In PowerShell, from the repository root:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend/requirements.txt -r backend/requirements-training.txt
cd backend
$env:ADAPTER = 'local'
$env:FORCE_KINEMATIC = '1'
$env:DATABASE_ENABLED = '0'
..\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000 --workers 1
```

In another terminal, from the repository root:

```powershell
cd frontend
npm ci
npm run dev
```

Start the game separately as above. Optional native frontend settings belong in ignored `frontend/.env.local`; game settings belong in `cant-catch-me/.env.local`. Root `.env` is used by Compose and the Windows launcher, not automatically by every native command. Templates contain placeholders only; keep credentials out of Git.

Use **one backend worker**, because each process owns a controller. Do not run the API and a headless controller against the same fleet simultaneously. Dashboard development and production builds use separate output directories; `NEXT_DIST_DIR` overrides the default.

## Connect the existing ArcticSim world

The Windows launcher requires PowerShell 7, the Python environment above, `npm ci` in both apps, and an already configured **Fort Ross** ArcticSim stack. Its control service must answer on port 8090, with the world viewer on 8080. ArcticSim is a separate installation.

```powershell
./start-whiteout.ps1 -Check
./start-whiteout.ps1 -FlightPolicyFile frontend/public/experiments/surveillance-model.json
```

`-Check` inspects setup without starting services. The second command starts the simulated fleet controller, dashboard at **http://127.0.0.1:3003**, and game at **http://127.0.0.1:3100**. Open **http://127.0.0.1:3003/backend** for the native world and four cameras. Use `-Python` for another environment or `-GamePath` for a separate game checkout; the bundled game is selected by default.

New launcher sessions select `coordinated-surveillance-v1`. Use `-MissionAlgorithm tower-first-v2` without a coordinated policy file for the historical controller. The launcher reuses compatible services, rejects an incompatible backend, reports started process IDs, and writes logs under `.qa/whiteout/`. Stop the reported backend before changing its algorithm or policy. Services continue running after the launcher returns.

For native or Compose configuration, set `MISSION_ALGORITHM=coordinated-surveillance-v1`. Optionally set `SURVEILLANCE_POLICY_FILE` to `../frontend/public/experiments/surveillance-model.json` from `backend/`, or `/flight-policies/surveillance-model.json` in Compose. Only six flight settings load into the runtime; graph tower coordinates and synthetic sensor probabilities do not. After restarting, verify the algorithm, values, and file hash in `/telemetry/latest` under `mission_algorithm`.

The WHITEOUT adapter validates vehicle identities and expires stale links. Its climb envelope is specific to the inspected Fort Ross terrain and local altitude observations. A healthy API or accepted command does not establish connected cameras, takeoff, or vessel acquisition. If an aircraft is physically overturned, stop the controller and reset the simulator through its control service before relaunching. Do not run the optional Compose `sitl` profile alongside ArcticSim: their host ports conflict.

## Evidence and measured tradeoffs

The final offline revision improves pending-observation handling, camera-distance following, and patrol progress after a camera has covered a waypoint. Terrain, sensor probabilities, movement limits, scoring rules, and two-observation confirmation remain fixed. These changes affect the offline experiment, not fleet adapters or runtime aircraft controllers.

The [400-mission paired comparison](frontend/public/experiments/release-comparison.json) runs release 0.2's optimized strategy and the final revision on the same previously held-out seeds, **21070001–21070400**:

| Metric | Release 0.2 optimized | Final revision | Paired improvement, 95% interval |
| --- | ---: | ---: | --- |
| Confirmed ship detection | 68.75% | 70.00% | +1.25 percentage points [−4.25, +6.75] |
| Aircraft custody, all sampled mission time | 24.07% | 29.80% | +5.73 percentage points [+3.46, +8.05] |
| Mean longest contact gap | 113.98 s | 106.28 s | 7.70 s saved [−7.49, +23.04] |
| Position RMSE | 237.91 m | 268.83 m | Increased; no interval estimated |
| False confirmed contacts, total | 7 | 12 | Increased; no interval estimated |
| Cumulative sampled-water coverage | 84.04% | 78.73% | Decreased; no interval estimated |
| Mean combined aircraft travel | 7.113 km | 7.059 km | Decreased; no interval estimated |

The strongest supported improvement is aircraft custody. Detection and gap intervals include zero; position error, false contacts, and lost search coverage are material tradeoffs. Intervals use 2,000 paired whole-mission bootstrap samples and include all misses.

The dashboard's separate [200-mission report](frontend/public/experiments/surveillance-report.json), seeds **32400000–32400199**, compares three strategies under the current simulation:

| Metric | Tower-first, default sites | Coordinated, default settings | Coordinated, trained settings/sites |
| --- | ---: | ---: | ---: |
| Confirmed ship detection | 26.0% | 59.0% | 70.0% |
| Aircraft custody | 9.09% | 29.27% | 31.93% |
| Mean longest contact gap | 228.25 s | 139.45 s | 106.25 s |

Against that tower-first baseline, the trained coordinated strategy increases mean travel from 4.74 to 7.01 km, RMSE from 100.9 to 180.8 m, and false contacts from 1 to 7. Do not mix these test sets or substitute the historical release's original 66.5% detection figure into the paired comparison.

Both evaluations use synthetic five-minute missions. Detection requires repeated consistent observations within **150 m** of evaluator truth. Aircraft custody requires repeated aircraft evidence no older than **10 seconds** and a correct estimate; all 61 mission samples count. A never-detected mission receives the full **300-second** longest gap. RMSE covers available observed/coasting estimates, excluding periods without an estimate. Cumulative water coverage differs from the competition's live sliding-window score. In coordinated reports, the legacy `postTowerCustodyPct` field counts eligible samples after any-sensor confirmation despite its saved tower-only wording; this known definition mismatch does not affect the metrics above.

The [final model](frontend/public/experiments/surveillance-model.json) was selected before these tests: 256 motion trajectories, 12 candidates on 24 training missions, and four finalists on 24 validation missions, with training seed 32000000. Search fits tower sites and lane spacing, route phase, quad search radius, prediction horizon, support offset, and reacquisition width. This is bounded parameter search, not neural flight control or image-model training, and it does not prove a global optimum.

The [initial comparison](frontend/public/experiments/tracking-initial-comparison.json), [initial model](frontend/public/experiments/tracking-initial-model.json), and historical [tower-first results](frontend/public/experiments/graph-report.json) remain available. Source fingerprints separate revisions; replay the original coordinated release model from its `release/0.2` checkout.

### Reproduce or train

With training dependencies installed, run from `backend/`. A smoke run writes new files without replacing published evidence:

```powershell
..\.venv\Scripts\python.exe -B train_graph_search.py --algorithm coordinated-surveillance-v1 --quick --seed 41000000 --initial-model ../frontend/public/experiments/surveillance-model.json --output ../.qa/smoke-report.json --model-output ../.qa/smoke-model.json
```

`--quick` uses four candidates and 12 tests; it is not the published benchmark. A warm start reuses parameters, not old test scores. Further tuning needs fresh disjoint development, validation, and test seeds.

To replay the published paired benchmark, put a frozen release checkout beside this one, for example `git worktree add ../release-0.2 release/0.2` from the repository root. Then, from `backend/`:

```powershell
..\.venv\Scripts\python.exe -B compare_simulation.py --reference-root ../../release-0.2 --reference-model ../../release-0.2/frontend/public/experiments/surveillance-model.json --candidate-model ../frontend/public/experiments/surveillance-model.json --seed-start 21070001 --episodes 400 --exclude-range 20770001:20770048 --exclude-range 20780001:20780048 --exclude-range 20970001:20970200 --exclude-range 31100000:31400199 --output ../.qa/reproduced-release-comparison.json
```

The comparator checks fingerprints, seed separation, matching scenarios, and scoring rules in isolated processes. Replaying published seeds reproduces evidence; it does not create a fresh evaluation after further tuning.

## Game, badge controls, and Sentry

The game verifies completed opening-stretch attempts through its deterministic engine. Its learning pipeline uploads a sanitized structured recording to Sentry, retrieves it, checks integrity, and evaluates tower/flight proposals after **eight eligible current-version imported attempts**. Separate validation preserves escape opportunities and rejects newly introduced or earlier captures below 12 seconds. Active games keep pinned settings; accepted updates affect future runs. Later procedural stretches and abandoned attempts do not train the model.

Configure `cant-catch-me/.env.local` from its `.env.example`. Server/browser DSNs enable ingestion; a **server-only `SENTRY_API_TOKEN` with `project:read`** is also required for import. Keep tokens out of `NEXT_PUBLIC_*`. Without Sentry setup, gameplay and local storage work but new learning waits. Visual Session Replay records the player's view; structured controls drive evaluation. The September 20 release evidence records **0 of 8 eligible imports and no promoted strategy**, with transfers requiring retry. End-to-end cloud import remains unverified.

Attempts and layouts persist in ignored `.game-learning/`; set `GAME_LEARNING_DIR` to a durable absolute directory for deployment. Run one game server per archive. Fixed-control replay cannot predict how players would react to changed patrols, and game results do not measure operational fleet performance.

Choose **Connect a badge** for HTN OS over Wi-Fi or original Lua firmware over USB. Keyboard and touch remain available. USB requires desktop Chrome/Edge and HTTPS or localhost. The game does not flash firmware; the extended script is bundled at [`public/badge/boat_game.lua`](cant-catch-me/public/badge/boat_game.lua). Physical badge validation remains outstanding. See the [game guide](cant-catch-me/README.md) for setup, controls, recording limits, and fairness rules.

For dashboard/backend Sentry, use the root and frontend environment templates. `/sentry` checks delivery; the Sentry tab links traces, logs, and replay to observed controller timings. Local charts or SDK queue flushing alone do not establish cloud ingestion. Source-map upload uses a separate server-side `SENTRY_AUTH_TOKEN` at build time.

## Architecture and repository map

```text
Local / WHITEOUT / replay adapter
  -> available observations + vehicle state
  -> SwarmBrain at 10 Hz: target filter -> metrics -> roles -> behaviors
  -> adapter commands
  -> WebSocket dashboard + optional database + recording/Sentry evidence

Slow optional advisor -> role suggestions only
Offline experiments and game -> separate simulations and evidence
```

All vehicle I/O goes through `SimAdapter`. The target filter fuses ship observations; ArduPilot owns vehicle-state estimation. Predicted positions, waypoint proximity, and command acknowledgements do not count as visual acquisition. Evaluation truth stays outside mission decisions and advisor input. Optional model calls remain outside the fast loop.

| Path | Purpose |
| --- | --- |
| [`backend/`](backend/) | FastAPI, controller, tracker, adapters, recording/replay, experiments, tests |
| [`frontend/`](frontend/) | Next.js 14 Pages Router dashboard, Three.js/Leaflet views, proxies, tests |
| [`cant-catch-me/`](cant-catch-me/) | Game engine, badge input, Sentry-backed learning |
| [`frontend/public/experiments/`](frontend/public/experiments/) | Terrain, frozen models, reports, per-mission replays |
| [`start-whiteout.ps1`](start-whiteout.ps1) | Windows launcher for the existing ArcticSim stack |
| [`docker-compose.yml`](docker-compose.yml) | Local demo services and optional SITL profile |
| [`docs/team/`](docs/team/) | Responsibilities and historical integration handoffs |
| [`docs/research/`](docs/research/) | Research, evaluation protocols, earlier experiments |

The camera path is image + own-platform pose → vessel detector → pixel-to-water projection → target filter. `VESSEL_DETECTOR=blob` is a simulator color/shape baseline. Optional YOLO support requires `backend/requirements-vision.txt`, a trusted local `.pt`/`.onnx` vessel detector, and the explicit settings in `.env.example`. Missing models/dependencies produce an unavailable status. No trained neural weights or labeled dataset are bundled; alignment, altitude, localization, and frame/pose timing still need measurement. See [perception research](docs/research/TOWER_SEARCH_RESEARCH.md).

## Validation and replay

The final release passed **492 automated tests**: 261 backend, 126 dashboard, and 105 game, with no failures or skips. Both TypeScript checks and production builds completed, and dashboard/game pages served successfully. [Validation evidence](docs/release-validation.json) records the checks and deployment limitations.

Install dependencies above and run each group from its indicated directory to repeat the checks:

```powershell
# backend/ — use the repository's Python environment
$env:ADAPTER = 'local'
$env:FORCE_KINEMATIC = '1'
$env:DATABASE_ENABLED = '1'
..\.venv\Scripts\python.exe -B -m unittest discover -s tests -v
..\.venv\Scripts\python.exe -B eval.py --seconds 30 --profile all

# frontend/
$env:TELEMETRY_TEST_PYTHON = (Resolve-Path ../.venv/Scripts/python.exe).Path
node --test tests/*.test.cjs
npx tsc --noEmit
npm run build

# cant-catch-me/
npm test
npm run typecheck
npm run build
```

Database tests mock storage; enable that code path for the suite even if your native demo uses `DATABASE_ENABLED=0`. `TELEMETRY_TEST_PYTHON` includes the actual backend serializer contract test. Local tests do not validate camera calibration, badge hardware, Sentry cloud delivery, or simulator flight. The release dashboard build reported a Windows dependency-junction warning while copying standalone dependencies. Standard `next start` served successfully, but standalone deployment packaging remains unverified.

After stopping any API controller, record and replay a local headless run from `backend/`:

```powershell
..\.venv\Scripts\python.exe -m agent --adapter local --record-dir ../runs --seconds 3
..\.venv\Scripts\python.exe -m agent --replay ../runs/RUN_ID
```

Replace `RUN_ID` with the generated directory. `RUN_LOG_DIR` enables equivalent API recording. Manifests retain settings/provenance; bounded tick logs retain observations, estimates, decisions, and dispatch outcomes. Incomplete or invalid evidence is rejected. Replay captures commands without transmitting them and does not recreate physical simulation. To inspect a recording in the dashboard, start the API with `ADAPTER=replay` and `REPLAY_PATH=../runs/RUN_ID`.

Contributors and coding agents should read [the contributor guide](docs/team/README.md) and [AGENTS.md](AGENTS.md). The final release lives on `main`; earlier `dev` onboarding instructions describe the historical hackathon workflow.
