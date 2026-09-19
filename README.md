# Operation: Overwatch — teammate start

Hack the North WHITEOUT base. Competition has not started. This repo is the shared intelligence loop so you can split work on day one instead of scaffolding Docker.

**Agents (Cursor/Codex/etc.): read [AGENTS.md](AGENTS.md) first** — architecture, file map, invariants, Saturday stub. Humans: this README is the 10-minute bring-up.

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
| Headless agent | `docker compose exec backend python -m agent --adapter local` |
| Four-score eval | `docker compose exec backend python eval.py --seconds 15` |

Kinematic twins (plane, copter, rover) + virtual towers + a weaving target run **without waiting on ArduPilot**. Optional SITL:

```bash
docker compose --profile sitl up --build
# then set FORCE_KINEMATIC=0 in .env
```

## Who owns what

| Person | Files | Job |
| --- | --- | --- |
| A — fleet / adapter | `backend/sim/`, `mavlink_connection.py` | Saturday `WhiteoutAdapter`. Attend the 10:30 workshop. Checklist: [docs/SATURDAY_WORKSHOP.md](docs/SATURDAY_WORKSHOP.md) |
| B — tracker / scores | `tracker.py`, `metrics.py`, `eval.py` | Coverage FOV, track error, `eval.py` profiles |
| C — behaviors | `agents/`, `behaviors/trees.py`, `allocator.py` | Mission command + platform agents. Do not put LLM in this loop |
| D — HUD / demo | `frontend/`, `agent.py` | Four numbers, heatmap, roles, 90s talk |

## Non-negotiables (WHITEOUT scoring)

Live metrics: **coverage, collaboration, efficiency, tracking accuracy**, plus **one-command agent deploy**.

- Inner loop is deterministic BTs at `BRAIN_HZ` (default 10).
- LLM DAG only biases roles (`ai_orchestrator.py` `advise()`).
- No vehicle Kalman; ArduPilot owns own-ship. Tracker is **target-only**.
- Do not scatter `tcp:sitl:5760` — go through `SimAdapter`.

## Saturday

Workshop 10:30 AM, PSE 2324/2328. Capture the sim contract, fill `WhiteoutAdapter`, run:

```bash
ADAPTER=whiteout python -m agent --adapter whiteout
```
