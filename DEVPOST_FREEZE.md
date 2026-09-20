# Freeze — Devpost submission

## Project name

Freeze

## Elevator pitch

Freeze coordinates towers and aircraft to detect and track ships in ArcticSim, combining terrain analysis, camera observations, and replay-based strategy optimization.

## About the project

### Inspiration

The WHITEOUT mission requires a fleet to detect and track ships across Arctic terrain. Fixed cameras leave blind spots, aircraft have limited viewing angles, and sightings become stale. Freeze coordinates these sensors to improve coverage and maintain contact.

### What it does

Freeze controls two camera towers, a quadcopter, and a fixed-wing plane through five steps:

1. **Select tower positions.** Analyze Fort Ross terrain and camera geometry, then compare tower sites and aircraft flight settings on separate training and validation missions.
2. **Search complementary areas.** Towers scan fixed sectors, the plane covers wider water, and the quad searches nearby gaps.
3. **Confirm and track ships.** Combine fresh camera observations into one estimate of a ship's position, velocity, and uncertainty. Reject stale, duplicate, and implausible sightings.
4. **Maintain sensor handoffs.** The quad follows the estimate while the plane makes supporting passes. A receiving aircraft must report two fresh, accepted sightings before a handoff counts.
5. **Recover lost contact.** Search around the last observation and predicted movement. Increase uncertainty as sightings age and expire unrecovered tracks.

The dashboard shows fleet roles, camera views, search paths, contact state, and mission events. Overview, Cameras, and Simulation lab share a replay clock. Live simulator feeds are displayed separately from saved synthetic experiments.

### How we built it

Python and FastAPI run a deterministic 10 Hz controller. MAVLink connects it to ArduPilot in ArcticSim/Gazebo. The default image detector uses hull color and shape, then projects detections onto the sea surface to estimate ship coordinates. A shared target filter combines observations from different sensors.

Next.js, React, TypeScript, and Three.js power the dashboard and game. WebSockets stream mission telemetry. The offline optimizer searches tower positions and six flight settings, including search spacing, prediction horizon, and reacquisition width.

**Can’t Catch Me** tests coverage through player-controlled ship routes. Its separate simulation uses two towers, two quadcopters, and a plane. We record controls, starting settings, and random seed for the opening stretch, then replay each attempt on the server to verify capture or escape.

**Sentry Session Replay** captures the player's view. Our map replay reconstructs movement and sensor visibility. **Tracing and Logs** expose controller timing, rejected observations, and command outcomes, helping investigate lost contact even when the application does not crash.

Verified attempt recordings are uploaded to Sentry, retrieved, and checked before strategy evaluation. After eight eligible attempts, the optimizer tests tower and flight changes against recorded controls. Separate validation checks preserve escape opportunities and prevent newly introduced early captures. Accepted changes apply only to future runs. This replay pipeline has not yet promoted a new strategy.

### Challenges we ran into

- **Camera blind spots:** Flying directly over a ship can lose it beneath a forward-facing camera. We implemented offset observation passes and coordinated quad support.
- **Stale evidence:** Delayed and repeated frames can create false tracking confidence. We added freshness checks and explicit handoff confirmation.
- **Comparable game attempts:** We pin settings per run, version recordings, and validate proposed strategies on separate attempts.

### Accomplishments

On **200 held-out synthetic missions**, optimized tower sites and flight settings improved results against the tower-first baseline:

| Metric | Baseline | Optimized |
| --- | ---: | ---: |
| Confirmed ship detection | 25.0% | 66.5% |
| Aircraft tracking custody, share of sampled mission time | 9.4% | 23.9% |
| Mean longest contact gap | 228.7 s | 118.9 s |

Average aircraft travel increased from 4.74 to 7.12 km. These results measure the combined strategy under a synthetic sensor model; live camera accuracy still needs validation.

### What we learned

Tower placement, camera geometry, and flight paths must be optimized together. Detection rate alone does not measure continuous tracking. We evaluate contact gaps, handoffs, and aircraft travel alongside detection.

### What’s next

Calibrate camera localization, train a stronger ship detector on labeled images, and measure strategy updates using more verified player attempts. Complete physical testing of the implemented Hack the North badge controls.

## Built with

Python, TypeScript, Next.js, React, Three.js, React Three Fiber, Tailwind CSS, FastAPI, WebSockets, Leaflet, NumPy, Sentry, Docker, Gazebo, ArduPilot, MAVLink, pymavlink

## Try it out

[Source repository](https://github.com/Yd025/HTNV1)

## Gallery captions

1. **Mission overview:** Tower coverage, aircraft routes, and shared ship tracking.
2. **Camera views:** Sensor observations and confirmed handoffs.
3. **Simulation lab:** Replay the selected strategy across Fort Ross terrain.
4. **Benchmark:** Detection and tracking results across 200 unseen synthetic missions.
5. **Can’t Catch Me:** Player routes recorded for strategy evaluation.
6. **Sentry:** Replays, controller traces, and logs for investigating lost contact.

## Internal references — not for Devpost

- Current mission and benchmark: README.md and frontend/public/experiments/surveillance-report.json.
- Detection and localization: backend/sim/detector.py.
- Game recording and validation: cant-catch-me/README.md, lib/learningServer.ts, and lib/learningOptimizer.ts.
- The supplied pitch guides the structure. Current coordinated search supersedes its historical tower-only launch gate.
- Game learning evaluates the opening stretch only. Later stretches continue gameplay. The method is replay-based policy optimization.
- Repository URL comes from local Git configuration; public access and inclusion of all latest changes are unverified.
