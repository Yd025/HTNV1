# Saturday 10:30 AM — WHITEOUT workshop capture

Room: PSE 2324 / 2328 (Sponsor Event Rooms A and B). One teammate stays the whole session.

Fill [backend/sim/whiteout.py](../backend/sim/whiteout.py) from these answers. Do **not** refactor the HUD or behavior trees in the room — only the adapter.

## Ask Dominion (write their words)

1. Connection: TCP / UDP / HTTP / Zenoh / other? Host, port, auth?
2. Vehicle list: sysids, classes (plane / copter / rover / **towers**)?
3. Detections: which MAVLink / API messages? Camera frames or already-classified contacts?
4. Scoring: coverage window? Do towers count? Collaboration overlap penalty? Tracking RMSE vs truth?
5. Deploy command they expect (`docker`, `python -m agent --adapter whiteout`, upload, …)
6. Constraints: arena bounds, no-fly, battery, comms drop, max speed
7. Is the agent uploaded to their box or is our laptop the GCS?

## After the workshop (under one hour)

```bash
# .env
ADAPTER=whiteout
WHITEOUT_URL=http://...   # or leave blank and teach WhiteoutAdapter MAVLink
WHITEOUT_TOKEN=

docker compose up --build backend
# or headless for judging
docker compose exec backend python -m agent --adapter whiteout
```

Then freeze BT gains. Tune only if a metric is obviously wrong vs their definition.

## Adapter methods to implement

See `WhiteoutAdapter` in `backend/sim/whiteout.py`:

- `list_vehicles()`
- `poll_detections()`
- `send_command()`
- `comms_ok()`
- `truth_target()` only if they publish truth

Local kinematic fleet stays as `ADAPTER=local` so the rest of the team can keep working if the live sim is late.
