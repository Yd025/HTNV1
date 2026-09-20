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

1. **Select tower positions offline.** Analyze Fort Ross terrain and camera geometry, then compare tower sites and aircraft flight settings on separate training and validation missions. Compatible flight settings can be loaded into the controller; synthetic tower placements are not automatically deployed.
2. **Search complementary areas.** Towers scan fixed sectors, the plane covers wider water, and the quad searches nearby gaps.
3. **Confirm and track ships.** Combine fresh camera observations into one estimate of a ship's position, velocity, and uncertainty. Reject stale, duplicate, and implausible sightings.
4. **Maintain sensor handoffs.** The quad follows the estimate while the plane makes supporting passes. A receiving aircraft must report two fresh, accepted sightings before a handoff counts.
5. **Recover lost contact.** Search around the last observation and predicted movement. Increase uncertainty as sightings age and expire unrecovered tracks.

The dashboard shows fleet roles, camera views, search paths, contact state, and mission events. Overview, Cameras, and Simulation lab share a replay clock. Live simulator feeds are displayed separately from saved synthetic experiments.

### How we built it

Python and FastAPI run a deterministic controller with a target rate of 10 Hz. A MAVLink adapter connects it to ArduPilot in ArcticSim/Gazebo. The default image detector uses hull color and shape, then projects detections onto the sea surface using camera geometry. A target-only, constant-velocity Kalman filter combines observations into position, velocity, and uncertainty estimates. Timestamp and motion checks reject stale, duplicate, and implausible observations. When observations stop, the estimate continues briefly with increasing uncertainty before expiring.

The coordinated strategy assigns complementary search areas, uses offset plane passes to keep the ship inside the camera view, and requires repeated fresh aircraft observations to confirm custody. Recovery searches follow the last accepted observation and predicted movement. Decisions use sensor observations; target truth is reserved for simulation and evaluation.

The offline optimizer performs a bounded search over tower positions and six flight settings: search-lane spacing, route phase, quad search radius, prediction horizon, plane support offset, and reacquisition width. The saved run used 256 synthetic motion trajectories, 12 candidates on 24 training missions, and four finalists on 24 separate validation missions. The selected policy was frozen before testing. This is strategy-parameter optimization, not neural image-model training. The synthetic lab uses its own observation and motion models, so its scores do not establish live camera performance.

Next.js, React, TypeScript, and Three.js power the dashboard and game. WebSockets stream mission telemetry.

**Can’t Catch Me** explores coverage through player-controlled ship routes. Its separate simulation uses two towers, two quadcopters, and a plane. We record controls, pinned starting settings, and random seed for the opening stretch, ending at capture, the first map crossing, or five active minutes. The server reconstructs completed attempts using the same game mechanics to verify capture or escape.

**Sentry Session Replay** captures the player's view. Our map replay reconstructs movement and sensor visibility. **Tracing and Logs** expose controller timing, rejected observations, and command outcomes, helping investigate lost contact even when the application does not crash.

The learning pipeline is designed to upload verified structured recordings to Sentry, retrieve them, and check their integrity before strategy evaluation. After eight eligible current-version attempts have been imported, the optimizer tests tower and flight changes against recorded controls. Separate validation checks preserve an actual escape and reject newly introduced or earlier captures below 12 seconds. Accepted changes apply only to future runs. These fixed-input replays do not predict how a player would adapt to changed patrols. Visual Session Replay documents the player's view; structured recordings drive evaluation.

No game strategy has yet been promoted. As checked on September 20, current-version learning had **0 of 8 eligible imported attempts**; the latest Sentry transfers require a connection retry.

### Challenges we ran into

- **Camera blind spots:** Flying directly over a ship can lose it beneath a forward-facing camera. We implemented offset observation passes and coordinated quad support.
- **Stale evidence:** Delayed and repeated frames can create false tracking confidence. We added freshness checks and explicit handoff confirmation.
- **Comparable game attempts:** We pin settings per run, version recordings, and validate proposed strategies on separate attempts.

### Accomplishments

On **200 held-out synthetic missions**, our current coordinated strategy with optimized tower sites and flight settings produced the following results against the historical tower-first strategy with default sites. Both ran the same five-minute missions under the same synthetic sensor and movement rules:

| Metric | Baseline | Optimized |
| --- | ---: | ---: |
| Confirmed ship detection | 26.0% (52/200) | 70.0% (140/200) |
| Aircraft tracking custody, share of all sampled mission time | 9.09% | 31.93% |
| Mean longest contact gap | 228.25 s | 106.25 s |
| Sampled water area observed at least once | 56.00% | 78.45% |

There were tradeoffs: mean combined horizontal aircraft travel increased from **4.74 to 7.01 km**, pooled position RMSE increased from **100.9 to 180.8 m**, and false confirmed contacts increased from **1 to 7** across the 200 missions. We improved detection and continuity, but have not demonstrated improved position accuracy or travel efficiency against this baseline. [Saved 200-mission results](https://github.com/Yd025/HTNV1/blob/6422823de8cded9e3b5a21ed4764b8f0e3142d57/frontend/public/experiments/surveillance-report.json).

A separate **400-mission paired comparison against the already optimized release 0.2** tested the latest revision on new seeds:

| Metric | Release 0.2 | Current |
| --- | ---: | ---: |
| Confirmed ship detection | 68.75% (275/400) | 70.00% (280/400) |
| Aircraft tracking custody | 24.07% | 29.80% |
| Mean longest contact gap | 113.98 s | 106.28 s |

Aircraft custody improved by **5.73 percentage points**, with a paired 95% bootstrap interval of **+3.46 to +8.05 points**. Detection and gap changes remained uncertain because their intervals included zero. On this comparison, cumulative sampled-water coverage fell from **84.04% to 78.73%**, position RMSE rose from **237.9 to 268.8 m**, and false contacts rose from **7 to 12**; mean combined horizontal aircraft travel fell slightly from **7.113 to 7.059 km**. The strongest supported improvement is sustained aircraft contact. [Saved paired comparison and per-mission evidence](https://github.com/Yd025/HTNV1/blob/6422823de8cded9e3b5a21ed4764b8f0e3142d57/frontend/public/experiments/release-comparison.json).

Detection requires repeated consistent observations and an estimate within 150 m of evaluator truth. Aircraft custody requires confirmed aircraft evidence no older than 10 seconds and a position within that tolerance; all mission samples, including missed missions, count in the denominator. Each mission has 61 samples at five-second intervals. The contact-gap metric is the longest period of stale or incorrect fused contact after first true confirmation, with never-detected missions assigned the full 300 seconds. RMSE includes available observed and coasting estimates, not periods without an estimate. The two test sets are separate and their figures must not be mixed. Cumulative water coverage is a local benchmark measure, not the competition's live sliding-window coverage score.

### Software verification

On September 20, **484 automated tests passed with zero failures or skips** at revision `6422823`: **261 backend, 118 dashboard, and 105 game tests**. Dashboard and game TypeScript checks also passed. Tests cover observation freshness and rejection, tracking and handoffs, replay consistency, game verification and promotion safeguards, and map-boundary coverage counting. The latest coverage fix prevents positions just outside the map from being counted inside its boundary.

These checks support software reliability; they do not establish camera recognition accuracy, successful Sentry cloud delivery, or official live competition scores. Test coverage and observed arena coverage measure different things.

### What we learned

Tower placement, camera geometry, and flight paths must be evaluated together. Detection rate alone does not measure continuous tracking, and longer tracking can consume time that would otherwise cover new water. We evaluate contact gaps, position error, false contacts, and aircraft travel alongside detection. A bounded search can find a better tested strategy without proving a global optimum.

### What’s next

1. **Validate a complete ArcticSim mission.** Record camera frames, frame times, vehicle poses, detections, commands, and target truth when available. Measure the actual judging categories: rolling coverage, role overlap, detection delay and travel, and target-position error. Confirm the competition's track-submission and scoring interface.
2. **Measure and calibrate perception.** Check camera alignment, sea-surface projection, and frame/pose timing. Build a labeled evaluation set separated by whole missions. Compare the existing detector with the already available optional YOLO integration, enabling or training it only if it improves measured accuracy within the timing budget. We have not yet trained a neural detector.
3. **Complete game learning evidence.** Restore Sentry upload/import completion and collect at least eight eligible current-version attempts, including escapes. Inspect and retain the validation decision; keeping the existing strategy is a valid outcome if no candidate passes.
4. **Address measured tradeoffs.** Use the resulting evidence to target position error, false contacts, and lost search coverage before adding more strategy complexity. Validate any proposed change on fresh missions under unchanged rules.

## Built with

Python, TypeScript, Next.js, React, Three.js, React Three Fiber, Tailwind CSS, FastAPI, WebSockets, Leaflet, NumPy, Sentry, Docker, ArcticSim, Gazebo, ArduPilot, MAVLink, pymavlink

## Try it out

[Current implementation](https://github.com/Yd025/HTNV1/tree/codex/simulation-tracking) · [Frozen release 0.2](https://github.com/Yd025/HTNV1/tree/release/0.2)

## Gallery captions

1. **Mission overview:** Tower coverage, aircraft routes, and shared ship tracking.
2. **Camera views:** Sensor observations and confirmed handoffs.
3. **Simulation lab:** Replay the selected strategy across Fort Ross terrain.
4. **Benchmark:** Detection and tracking results across 200 unseen synthetic missions.
5. **Can’t Catch Me:** Player routes recorded for strategy evaluation.
6. **Sentry:** Replays, controller traces, and logs for investigating lost contact.

## Internal references — not for Devpost

- Audited implementation and fresh test execution: `6422823de8cded9e3b5a21ed4764b8f0e3142d57`. This report update does not alter runtime behavior.
- Current mission and benchmark: README.md, frontend/public/experiments/surveillance-model.json, and frontend/public/experiments/surveillance-report.json. The 200-mission test seeds are 32400000–32400199; the selected model was frozen before evaluation.
- Separate release comparison: frontend/public/experiments/release-comparison.json; 400 test seeds 21070001–21070400, 2,000 paired whole-mission bootstrap resamples. Both policies were frozen before this evaluation. Do not combine these rows with the 200-mission table or release 0.2's older 200-mission report.
- Local verification evidence: .qa/report-test-summary.json, .qa/report-verified-stats.json, and .qa/report-*-tests.log. The .qa directory is local and ignored by Git. Benchmark summaries were recomputed from saved per-mission records and artifact/source hashes checked; the full benchmarks were not regenerated during this report audit.
- Backend and frontend tests ran in the current checkout. Game tests used the existing release-0.2 dependency installation after verifying that the complete tracked game source tree was identical (tree a725b5338caf715febe8ca2f8a38fba3dc3d9eca). No dependencies were installed.
- Detection and localization: backend/sim/detector.py.
- Runtime tracking: backend/tracker.py. Offline evaluation: backend/graph_search.py. Runtime policy loading applies six flight settings only: backend/agents/surveillance.py.
- Game recording and validation: cant-catch-me/README.md, lib/learningServer.ts, and lib/learningOptimizer.ts.
- The supplied pitch guides the structure. Current coordinated search supersedes its historical tower-only launch gate.
- Game learning evaluates the opening stretch only. Later stretches continue gameplay. The method is replay-based policy optimization.
- The game's September 20 operational state was read from the running local service, not inferred from unit tests: current rules opening-observation-shadowing-v4, layout version 0, zero eligible imported current-version attempts, and zero promotions. Historical attempts/rounds use older rules and are not a comparable benchmark. Do not quote the mixed-version aggregate capture rate.
- No measured live image precision/recall, calibrated live localization error, official judging score, or global optimality claim is established by this report.
