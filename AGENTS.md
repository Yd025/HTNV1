# AGENTS.md — Operation Overwatch / WHITEOUT

Read this before editing. This file is the project scope for coding agents (Cursor, Codex, Claude, etc.). Humans: start with [README.md](README.md). Saturday sim contract: [docs/SATURDAY_WORKSHOP.md](docs/SATURDAY_WORKSHOP.md).

## Current four-person team assignment

The user has assigned four workstreams in [docs/team/README.md](docs/team/README.md): UI (`codex/ui`), backend/integration (`codex/backend`), vision/tracking (`codex/vision-tracking`), and simulator/autonomy (`codex/simulator-autonomy`). These file-ownership assignments supersede the historical A/B/C/D labels and earlier visual-only teammate assignment below. Runtime invariants still apply. Read your handoff and [shared contract](docs/team/CONTRACT.md), reuse the existing code, and open small PRs into `dev`.

Do not scaffold the earlier standalone NORTHSTAR folder/API: this repository already has Next.js Pages Router on port 3000 and FastAPI with `/ws/telemetry` on port 8000. Person 2 coordinates shared dataclasses, wire types, dependencies and deployment files. The research is an improvement plan, not a second application or measured performance claim.

## What this repo is

Hack the North 2026 team project. **Primary prize: Dominion Dynamics WHITEOUT.**

WHITEOUT is a live Arctic simulation. Teams deploy **shared intelligence** that coordinates a heterogeneous ArduPilot/MAVLink fleet (fixed-wing, quadcopters, rovers, **fixed sensor towers**) to **detect, classify, and track a moving target**. Judges score live on:

1. **Coverage** — unique arena cells observed in a sliding window (FOV × pose × towers)
2. **Collaboration** — distinct roles, low overlap (plane searches, towers cue, copter tracks, rover confirms)
3. **Efficiency** — time-to-first-detect, meters flown, redundant transits, command spam
4. **Tracking accuracy** — fused **target** track vs truth (or residual if no truth)
5. **Agent deploy** — one process they can launch against their sim (`python -m agent --adapter whiteout`)

The repo has a local stand-in plus an ArcticSim MAVLink adapter so teammates can work in parallel. Camera detections, calibrated target localization and the exact competition submission/scoring contract still require verification. Some workshop notes below record earlier assumptions; current source and the team contract take precedence for implementation.

Secondary prizes (OpenAI, Huawei openJiuwen, Sentry, Tiger Data, Gemini, ElevenLabs) are **overlays**. They must not steal the 10 Hz control loop. If a change helps a side prize but hurts WHITEOUT scores, reject it.

## What this repo is not

- Not a vehicle EKF / Kalman on drones. ArduPilot already estimates own-ship. `backend/tracker.py` fuses **target detections only**.
- Not an LLM flight controller. `ai_orchestrator.py` is a **slow role advisor** (~15 s). Behavior trees emit setpoints.
- Not a commerce, finance, or CTF project. Do not pull in Shopify, RBC, Dryft, Solana, etc.
- Not waiting on Unreal/Gazebo/AuraSim to develop. Local kinematic twins are the default.

## Current runtime (what actually works today)

Default `.env`: `ADAPTER=local`, `FORCE_KINEMATIC=1`.

```
docker compose up --build
```

- **Backend** FastAPI `:8000` runs `SwarmBrain` at `BRAIN_HZ` (10) and WebSockets `/ws/telemetry`
- **Frontend** Next.js Pages Router + Tailwind `:3000` scoreboard. Default **3D fake ice arena** (`TacticalScene.tsx`); **2D** Leaflet toggle still there.
- **TimescaleDB** `:5432` hypertables `mavlink_telemetry`, `whiteout_scores`
- **Fleet**: kinematic `plane-1`, `copter-1`, `rover-1` + virtual `tower-ne`, `tower-sw`
- **Target**: `backend/sim/target.py` weaving contact; towers/vehicles emit FOV detections
- Optional ArduPilot SITL: `docker compose --profile sitl up` then `FORCE_KINEMATIC=0`
- Headless: `python -m agent --adapter local`
- Tune: `python eval.py --seconds 15` (from `backend/`, stdlib-only for kinematic)

`WhiteoutAdapter` speaks arctic-sim MAVLink via **`udpout`** (14550/14560/14580/14590). `ADAPTER=whiteout` arms and flies the official fleet. Cameras are MJPEG `8600+10*slot` (`/snapshot.jpg`); a background grabber turns hull blobs into `Detection`s. Do not run compose profile `sitl` at the same time — host 5760 collides. Keep `ADAPTER=local` for kinematic eval.

## Architecture (do not bypass)

```
WHITEOUT sim or LocalSitlAdapter
        │  VehicleState[], Detection[], send_command()
        ▼
   SwarmBrain.tick()          10 Hz, deterministic
        ├─ tracker.update     target-only CV / gated filter
        ├─ metrics.update     four live scores + heatmap
        ├─ C2.assign          find/fix/track/PID roles; optional advisor bias
        ├─ squad.tick         plane / copter / rover / tower agents
        └─ adapter.send_command
        │
        ├─ WebSocket state → HUD
        └─ every ~15s DAG.advise() → world.advisor (role_bias only)
```

**All I/O to vehicles/sim goes through `SimAdapter`.** Never hardcode `tcp:sitl:5760` in `main.py`, BTs, or the frontend.

Adapter contract (`backend/sim/types.py`):

- `list_vehicles() -> list[VehicleState]`
- `poll_detections() -> list[Detection]`
- `arena() -> Arena` (origin, half-extent meters, tower mounts, no-fly)
- `send_command(Command)` — goto / loiter / search_sector / hold
- `comms_ok(vehicle_id) -> bool` (DDIL / dropouts)
- `truth_target() -> (lat, lon) | None` (local sim has truth; WHITEOUT maybe not)

Implementations: `LocalSitlAdapter` (`sim/local_sitl.py`), `WhiteoutAdapter` (`sim/whiteout.py`). Factory: `sim/adapter.py` `build_adapter()`.

## Roles the swarm must show

| Class | Default role | Agent (`agents/`) |
| --- | --- | --- |
| plane | search (always) | lawnmower ISR; reports contact; never prosecutes |
| copter | search until cue, then track | opposite-sector QRF → lead intercept / custody |
| rover | reserve then confirm | alt=0; PID only after C2 tasks confirm |
| tower | cue | slews stare; posts cue; no transit |

Allocator: `backend/allocator.py`. Collaboration score drops if two searchers sit on the same coverage cell.

## Terrain and HUD (stand-in only)

Dominion has **not** published a 3D map, DEM, or Unreal/AuraSim viewer. Official world facts are only: Arctic, contested, mixed fleet, moving target, four live scores. Arena size, elevation, occlusion, and whether scoring is 2D or 3D are **unknown until the Saturday 10:30 workshop**.

What you see locally is **ours**, not theirs:

- Flat **3 km × 3 km** square, origin ≈ Resolute Bay `74.6973, -94.8297` (`ARENA_HALF_M=1500`)
- Planning in north/east meters plus a cruise **altitude** (2.5D). No hills. `Arena.no_fly` is empty
- Coverage and FOV are **2D** stand-ins
- HUD 3D view is a **fake ice sheet** with live WebSocket poses on it

Do **not** treat generated ice, mountains, or satellite tiles as WHITEOUT terrain. ChatGPT **Astra** (GPT-6) may restyle the HUD for the OpenAI/demo WOW. It cannot invent their world.

**Astra / visual teammate — restyle only** `frontend/components/TacticalScene.tsx` (`ARENA_LOOK` and meshes). Do not change:

- `frontend/lib/geo.ts` (lat/lon → scene; matches `backend/geo.py`)
- the WebSocket in `frontend/pages/index.tsx`
- anything under `backend/`

If Astra rebuilds a page from scratch, it must still consume `/ws/telemetry`. A pretty scene with invented contacts is a disconnected demo and fails WHITEOUT.

The canvas is labeled **“Stand-in arena · not Dominion terrain.”** Keep that until they hand us a real mesh. Saturday, ask: elevation? FOV occlusion? 2D vs 3D occupancy? Target altitude? `no_fly`?

If host **8000** or **5432** are taken, compose accepts `BACKEND_PORT` / `POSTGRES_PORT`. Point `NEXT_PUBLIC_WS_URL` / `NEXT_PUBLIC_API_URL` at the backend host port (browser is not on Docker DNS).

## File map

| Path | Own | Notes |
| --- | --- | --- |
| `backend/brain.py` | loop | 10 Hz tick; Sentry spans `bt.tick`, `track.update`, `adapter.send` |
| `backend/main.py` | API | FastAPI + WS; does not fly vehicles itself |
| `backend/agent.py` | deploy | `python -m agent --adapter local\|whiteout` |
| `backend/eval.py` | B | Scripted target profiles; print four scores |
| `backend/sim/types.py` | A | Shared dataclasses |
| `backend/sim/local_sitl.py` | A | Kinematic + optional multi-SITL MAVLink |
| `backend/sim/target.py` | A/B | Moving contact + FOV occupancy |
| `backend/sim/whiteout.py` | A | Arctic-sim MAVLink (5760/5770/5790/5800). Arm/takeoff SM. Camera grabber. |
| `backend/sim/cameras.py` | A | MJPEG snapshot catalog (8600+10*slot) |
| `backend/sim/detector.py` | B | Hull-on-water blob → lat/lon |
| `backend/mavlink_connection.py` | A | pymavlink TCP; **routing only**, no estimators |
| `backend/tracker.py` | B | Target track (n,e,vn,ve) |
| `backend/metrics.py` | B | Coverage grid, four scores |
| `backend/geo.py` | shared | WGS84 ↔ local north/east meters |
| `backend/world.py` | C | Fleet + track + blackboard |
| `backend/allocator.py` | C | C2 roles (plane always search) |
| `backend/agents/` | C | Platform agents + MissionCommand; observe/decide/report |
| `backend/behaviors/trees.py` | C | Maneuver primitives the agents call |
| `backend/ai_orchestrator.py` | C/OpenAI | `advise()` only; Huawei DAG story |
| `backend/db.py` | Tiger Data | asyncpg hypertables |
| `backend/radio.py` | garnish | ElevenLabs; never on scoring path |
| `frontend/pages/index.tsx` | D | HUD, four tiles, 3D/2D toggle, AGENT DEPLOYED |
| `frontend/lib/geo.ts` | D | Lat/lon → Three.js; keep in sync with `backend/geo.py` |
| `frontend/components/TacticalMap.tsx` | D | 2D Leaflet heatmap |
| `frontend/components/TacticalScene.tsx` | D | Fake 3D ice arena (not WHITEOUT terrain); **Astra restyle target** |
| `docker-compose.yml` | A | `postgres`, `backend`, `frontend`; SITL behind profile `sitl` |
| `docs/SATURDAY_WORKSHOP.md` | A | Capture checklist |

Python imports assume **cwd = `backend/`** (Docker `WORKDIR /app`). Do not use `backend.` package prefixes.

## Invariants (fail the PR if broken)

1. Inner loop stays deterministic and cheap. No OpenAI/Gemini/httpx inside platform agents, `TargetTracker.update`, or `MetricsEngine.update`.
2. `advise()` may set `world.advisor["role_bias"]`. It must not be the only source of lat/lon actuation.
3. Do not add a Kalman filter for plane/copter/rover own-ship.
4. New sim transports belong in an adapter, not in the BT.
5. Frontend `NEXT_PUBLIC_WS_URL` is `ws://localhost:<backend-host-port>/ws/telemetry` (browser is not on Docker DNS). Default port 8000.
6. Keep `FORCE_KINEMATIC=1` as the default so `eval.py` and the HUD work offline.
7. Do not edit files under `.cursor/plans/`.
8. HUD 3D ice is a **local fake**. Do not present it as Dominion terrain. Astra restyles `TacticalScene.tsx` only.

## How to extend (typical teammate tasks)

**Better coverage** — `metrics.py` FOV models + `behaviors/trees.py` lawnmower lane width. Prove with `eval.py` before/after.

**Better tracking** — `tracker.py` gating/process noise; association only on `Detection`s. Compare `track_error_m` vs `truth_target()`.

**Better collaboration** — `allocator.py` costs; ensure one tracker when `track.confidence` is high.

**HUD / Astra** — prettier ice, lights, craft meshes in `TacticalScene.tsx` only. Do not invent a second telemetry path.

**Saturday** — `ADAPTER=whiteout` against arctic-sim `udpout`. Freeze BT gains unless their metric definition differs. The baseline camera detector/projection lives in `sim/detector.py` and still needs accuracy/timing validation. Verify the competition's actual track-submission interface before implementing it; no upload endpoint is established here. Swap HUD terrain only after validating the supplied mesh and coordinate convention.

**SITL** — unique TCP per vehicle via env `MAVLINK_PLANE/COPTER/ROVER`. Image `radarku/ardupilot-sitl` may ignore `VEHICLE`; kinematic fallback is expected.

## Run / test

```bash
# kinematic eval (no pip extras required for brain+local adapter)
cd backend && python3 eval.py --seconds 15 --profile all

# API + HUD
docker compose up --build

# health
curl -s localhost:8000/health
```

Eval profiles: `straight`, `weave`, `stop_and_go`. Prefer improving **tracking** and **coverage over 30–60 s**, not 5 s snapshots (coverage window is ~45 s).

## Demo order (when judges appear)

1. Agent deployed (`/health` `deployed: true`)
2. Heatmap spreading = coverage
3. Plane search, tower cue, copter commit, rover confirm = collaboration
4. Copter sprints; plane does not dump a long hover = efficiency
5. Track sticks through a weave = tracking
6. Optional: advisor rationale on the blackboard (Huawei/OpenAI), not the controller

## Style

- Python 3.12, type hints, stdlib-first in the inner loop.
- FastAPI async; pymavlink in `asyncio.to_thread` with a lock (already in `MavlinkBridge`).
- Next.js 14 **Pages Router** (`pages/`), not App Router. Leaflet and R3F (`TacticalScene`) via `dynamic(..., { ssr: false })`.
- Do not add READMEs or markdown the user did not ask for except updating this file and `README.md` when scope changes.
