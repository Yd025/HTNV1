# AGENTS.md — Operation Overwatch / WHITEOUT

Read this before editing. This file is the project scope for coding agents (Cursor, Codex, Claude, etc.). Humans: start with [README.md](README.md). Saturday sim contract: [docs/SATURDAY_WORKSHOP.md](docs/SATURDAY_WORKSHOP.md).

## What this repo is

Hack the North 2026 team project. **Primary prize: Dominion Dynamics WHITEOUT.**

WHITEOUT is a live Arctic simulation. Teams deploy **shared intelligence** that coordinates a heterogeneous ArduPilot/MAVLink fleet (fixed-wing, quadcopters, rovers, **fixed sensor towers**) to **detect, classify, and track a moving target**. Judges score live on:

1. **Coverage** — unique arena cells observed in a sliding window (FOV × pose × towers)
2. **Collaboration** — distinct roles, low overlap (plane searches, towers cue, copter tracks, rover confirms)
3. **Efficiency** — time-to-first-detect, meters flown, redundant transits, command spam
4. **Tracking accuracy** — fused **target** track vs truth (or residual if no truth)
5. **Agent deploy** — one process they can launch against their sim (`python -m agent --adapter whiteout`)

The **hackathon has not started**. Dominion’s live binary/API is unknown until the **Saturday 10:30 AM workshop (PSE 2324/2328)**. This repo is a complete local stand-in plus a Saturday swap layer so teammates can work in parallel now.

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
- **Frontend** Next.js Pages Router + Tailwind + react-leaflet `:3000` scoreboard
- **TimescaleDB** `:5432` hypertables `mavlink_telemetry`, `whiteout_scores`
- **Fleet**: kinematic `plane-1`, `copter-1`, `rover-1` + virtual `tower-ne`, `tower-sw`
- **Target**: `backend/sim/target.py` weaving contact; towers/vehicles emit FOV detections
- Optional ArduPilot SITL: `docker compose --profile sitl up` then `FORCE_KINEMATIC=0`
- Headless: `python -m agent --adapter local`
- Tune: `python eval.py --seconds 15` (from `backend/`, stdlib-only for kinematic)

`WhiteoutAdapter` is a **stub**. It no-ops unless `WHITEOUT_URL` is set. Do not pretend the Dominion sim is integrated.

## Architecture (do not bypass)

```
WHITEOUT sim or LocalSitlAdapter
        │  VehicleState[], Detection[], send_command()
        ▼
   SwarmBrain.tick()          10 Hz, deterministic
        ├─ tracker.update     target-only CV / gated filter
        ├─ metrics.update     four live scores + heatmap
        ├─ assign_roles       greedy roles; optional advisor bias
        ├─ tick_vehicle BT    plane / copter / rover / tower
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

| Class | Default role | Behavior (`behaviors/trees.py`) |
| --- | --- | --- |
| plane | search, then standoff trail | lawnmower; never hover |
| copter | search until cue, then track | hold/box search → sprint/hover-track |
| rover | reserve then confirm | alt=0; ignore air intercepts until confirm |
| tower | cue | no actuation; FOV detections only |

Allocator: `backend/allocator.py`. Collaboration score drops if two searchers sit on the same coverage cell.

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
| `backend/sim/whiteout.py` | A | Saturday fill |
| `backend/mavlink_connection.py` | A | pymavlink TCP; **routing only**, no estimators |
| `backend/tracker.py` | B | Target track (n,e,vn,ve) |
| `backend/metrics.py` | B | Coverage grid, four scores |
| `backend/geo.py` | shared | WGS84 ↔ local north/east meters |
| `backend/world.py` | C | Fleet + track + blackboard |
| `backend/allocator.py` | C | Roles |
| `backend/behaviors/trees.py` | C | Actual controller |
| `backend/ai_orchestrator.py` | C/OpenAI | `advise()` only; Huawei DAG story |
| `backend/db.py` | Tiger Data | asyncpg hypertables |
| `backend/radio.py` | garnish | ElevenLabs; never on scoring path |
| `frontend/pages/index.tsx` | D | HUD, four tiles, AGENT DEPLOYED |
| `frontend/components/TacticalMap.tsx` | D | Heatmap, role colors, track + truth |
| `docker-compose.yml` | A | `postgres`, `backend`, `frontend`; SITL behind profile `sitl` |
| `docs/SATURDAY_WORKSHOP.md` | A | Capture checklist |

Python imports assume **cwd = `backend/`** (Docker `WORKDIR /app`). Do not use `backend.` package prefixes.

## Invariants (fail the PR if broken)

1. Inner loop stays deterministic and cheap. No OpenAI/Gemini/httpx inside `tick_vehicle`, `TargetTracker.update`, or `MetricsEngine.update`.
2. `advise()` may set `world.advisor["role_bias"]`. It must not be the only source of lat/lon actuation.
3. Do not add a Kalman filter for plane/copter/rover own-ship.
4. New sim transports belong in an adapter, not in the BT.
5. Frontend `NEXT_PUBLIC_WS_URL` is `ws://localhost:8000/...` (browser is not on Docker DNS).
6. Keep `FORCE_KINEMATIC=1` as the default so `eval.py` and the HUD work offline.
7. Do not edit files under `.cursor/plans/`.

## How to extend (typical teammate tasks)

**Better coverage** — `metrics.py` FOV models + `behaviors/trees.py` lawnmower lane width. Prove with `eval.py` before/after.

**Better tracking** — `tracker.py` gating/process noise; association only on `Detection`s. Compare `track_error_m` vs `truth_target()`.

**Better collaboration** — `allocator.py` costs; ensure one tracker when `track.confidence` is high.

**Saturday** — fill `WhiteoutAdapter` methods from workshop notes. Point `ADAPTER=whiteout`. Freeze BT gains unless their metric definition differs.

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
- Next.js 14 **Pages Router** (`pages/`), not App Router. Leaflet via `dynamic(..., { ssr: false })`.
- Do not add READMEs or markdown the user did not ask for except updating this file and `README.md` when scope changes.
