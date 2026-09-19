# Saturday — WHITEOUT / arctic-sim

Official repo: `https://github.com/Dominion-Dynamics/arctic-sim` (local clone: `../arctic-sim`).

**Mission:** detect and track a 33.6 m shadow vessel (no AIS, random start, ~3 m/s, water only). Submit hits:

`POST http://<SIM-IP>:8010/api/tracks` `{"name":"Sierra One","lat":…,"lon":…}` — confirm host with DD. Local control is `:8090` (reset only).

**Site:** Fort Ross / Bellot Strait `71.991960, -94.822428`, 6.5 km ArcticDEM. World +Y is **−49.8°** from true north. GUIDED commands stay WGS84 lat/lon.

**MAVLink (GCS must transmit first — `udpout` first; TCP 5760 accepts a socket but may never heartbeat):**

| asset | host TCP | host UDP |
| --- | --- | --- |
| quadcopter | 5760 | 14550 |
| fixed-wing | 5770 | 14560 |
| tower-1 | 5790 | 14580 |
| tower-2 | 5800 | 14590 |

Copter: GUIDED → arm → `NAV_TAKEOFF`. Plane: GUIDED → arm → mode TAKEOFF → GUIDED. Towers: SCAN / `DO_SET_ROI`. Cameras are MJPEG on `8600+10*slot`. There are **no** sim-published detections.

```bash
ADAPTER=whiteout docker compose up --build backend
# or headless
docker compose exec -e ADAPTER=whiteout backend python -m agent --adapter whiteout
```

`WhiteoutAdapter` already speaks those ports. Cameras: `http://<host>:8600/snapshot.jpg` (quad), 8610 (plane), 8630/8640 (towers). HUD proxies them at `/cameras/<id>/snapshot.jpg`. Keep `ADAPTER=local` for kinematic eval.
