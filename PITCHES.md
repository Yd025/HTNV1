# Operation Overwatch — two prize pitches

Prepared September 20, 2026 from the current HTNV1-tower-search and cant-catch-me source, saved experiment evidence, the supplied challenge descriptions, locally saved images of ArcticSim slides 9/11/18/24, and read-only checks of running services. The Slack PDF itself was inaccessible. No code or service configuration was changed.

Both scripts target roughly 2:30–2:50 including clicks at 125–140 words per minute. Bracketed directions are for the demonstrator; do not read them aloud. Finish speaking before inviting judges to play. Keep the two-minute Q&A available; offer a short game turn during it only if the judges want one.

## What each sponsor is looking for

| Sponsor criterion | What is implemented | What to show |
| --- | --- | --- |
| Dominion: coverage | Offline tower-site comparison using source terrain, sensor geometry, training/validation/test separation | Selected sites and completed benchmark |
| Dominion: collaboration | Repeated tower confirmation, separate quad/fixed-wing roles, receiving-aircraft confirmation | Saved handoff timeline |
| Dominion: efficiency | Launch gating, stable destinations and duplicate command suppression | Aircraft reserve → dispatch, distance and detection delay |
| Dominion: tracking accuracy and duration | Shared target filter, observation freshness checks, uncertainty growth, loss/reacquisition | Track state and custody outside tower view |
| Dominion: detection/classification | Camera hull-color baseline labels vessel candidates and projects them to the water plane; optional model interface | Real camera panel and detector status when connected |
| Sentry: at least two additional products | Session Replay, Tracing, Logs across the game and mission system | Actual Sentry replay, stored trace and run-filtered logs |
| Sentry: depth | Per-stage controller spans, correlated mission summaries, bounded background export | One run across trace and logs |
| Sentry: creativity | Structured game recordings uploaded to and retrieved from Sentry before placement evaluation | Received-from-Sentry count and evaluation eligibility |
| Sentry: influence on the project | Reproducible evaluation path and guarded future-layout decisions are implemented | Current evidence proves imports, not a measured player-facing improvement |

## Pitch 1 — Dominion Dynamics

A tower spots a boat. A few seconds later, the boat leaves its camera view. The hard part is getting another sensor to find the same boat and keep following it.

We built Operation Overwatch to coordinate two sensor towers, a quadcopter, and a fixed-wing aircraft for that job.

[SHOW: Overview → Watch handoff example. Keep the map and mission timeline visible. Say this is a saved synthetic test.]

First, we built a tower-placement experiment using ArcticSim terrain. It compares candidate sites, selects a pair on separate validation missions, and freezes the layout before testing unseen routes. Placement determines what the fleet can see before an aircraft moves.

Second, we built a confirmation step. A tower needs repeated, fresh, consistent sightings before the controller dispatches aircraft. That keeps grounded aircraft in reserve until there is a confirmed contact.

[SHOW: Tower confirmation, then aircraft dispatch.]

Third, we assign different jobs. The quadcopter follows the estimated vessel position. The fixed wing covers the route ahead. Both contribute observations to one shared target estimate.

Our handoff has a clear success condition: the receiving aircraft must report two fresh, accepted sightings. A command to fly somewhere does not prove the camera found the vessel.

[SHOW: Aircraft handoff, then tracking outside tower view.]

Fourth, we handle lost contact. When sightings stop, uncertainty grows and the controller searches around the predicted position. An unrecovered contact eventually expires. The display separates observations from predictions.

[SHOW: Completed benchmark · 200 unseen missions.]

We evaluate coverage, detection delay, aircraft travel, handoff, and tracking on the same test missions. The saved results expose where a placement helps and where tracking still needs work.

We also implemented the ArcticSim MAVLink connection, camera-to-map detection pipeline, and live fleet monitor.

[SHOW: /backend if connected; otherwise stay with the labeled saved test.]

Now you can try the search from the boat's side. Can't Catch Me is our separate game adaptation. Steer through the river, break the sensors' view, and see how long you can escape.

[OPEN: Game → Open Cant Catch Me. Hand over controls after the pitch.]

## Pitch 2 — Sentry

A boat leaves sensor coverage, and the fleet loses contact. The application keeps running, so an error alert alone misses the failure we care about.

We built a way to inspect that loss of contact and test whether different tower positions would help. We use three Sentry products beyond errors: Session Replay, Tracing, and Logs.

[SHOW: A saved game session in Sentry.]

First, Session Replay captures what appeared in the game. We can watch the attempt and inspect the player's experience.

[SHOW: Game → Saved player runs → Watch run → Play. Point to Seen by.]

We also built a map replay that reconstructs the boat and aircraft coordinates over time. It shows which sensors see the boat and when capture progress starts or breaks. This lets us inspect where coverage is missing.

The two recordings serve different jobs: Sentry Replay shows the screen; our map replay reconstructs the simulation.

[SHOW: Received from Sentry, then the eligible-run counter.]

For each attempt, we record controls, random seed, and tower layout. The server verifies the outcome, uploads that recording to Sentry, retrieves it, and checks its content and version.

Those retrieved records feed our tower-placement optimizer. After eight eligible completed attempts, it tests alternative positions, compares capture times, and validates the proposal on separate attempts. Only a passing layout changes future runs. Active players keep their starting layout, and validation must retain a recorded escape.

[SHOW: How learning stays playable.]

The server currently reports seventeen historical recordings imported. Our updated spotting rules start a fresh evaluation group, so those older runs cannot silently train the new version.

[SHOW: A saved controller trace and Logs for the same run.]

Tracing measures each controller stage. Logs explain rejected observations, failed commands, and growing uncertainty. Together, they help distinguish a coverage gap from a slow decision or stale input.

That is the loop we built: record the attempt, reconstruct what happened, test another placement, and validate before changing the game.

Now take the boat. Your completed opening run can contribute the next verified attempt.

[OPEN: Can't Catch Me → Make your escape. Hand over controls after the pitch.]

## Exact demonstration order

**Dominion — pre-open the dashboard at http://127.0.0.1:3003.**

1. Open Overview. Use Watch handoff example, or explicitly select Test 30 / seed 591955 and Play mission at 8×. It is a saved synthetic mission using terrain-derived geometry.
2. Point to the selected towers. While playback runs, explain site selection and repeated fresh confirmation.
3. At simulation time 70 seconds, show tower confirmation and dispatch; at 115 seconds, show aircraft handoff. Around 190 seconds, show aircraft custody outside tower view. At 8×, reaching this point takes about 24 real seconds from the start.
4. Cameras and Simulation lab share this replay clock. Their replay camera images are modeled; keep that distinction explicit.
5. Expand Completed benchmark · 200 unseen missions. Show coverage, detection and tracking together. Do not start Optimize tower placement during the pitch: the saved experiment took about 268 seconds.
6. If the operational backend is healthy, open http://127.0.0.1:3003/backend and Expand monitor to show actual Gazebo and four live camera feeds. Select a fleet tag for its role/status. If unavailable, omit the live demonstration.
7. Game → Open Cant Catch Me → Make your escape. The game is separate from operational simulator control.

**Sentry — pre-open three cloud tabs.**

Follow the revised spoken order: Sentry Session Replay → Game map replay → import count and eligibility → placement safeguards → saved mission trace and logs → game handoff. The numbered items below describe where to find each view.

1. Open the actual saved Sentry Session Replay: https://minty-rt.sentry.io/replays/9d82ca0ed88e442eb863a2f11d4517e7/ . Its URL is stored on four historical attempts; cloud playback was not opened during this audit. Verify access and playback before presenting.
2. Open an actual stored swarm_tick trace with its stage spans visible. A local timing chart alone does not prove cloud ingestion.
3. Open Sentry Logs for that same run: event.name:mission.window run.id:<actual-run-id>. Point to a rejection/command/timing field that is actually present.
4. On a connected dashboard, Sentry → Control performance · last 60 seconds → Pause summary → Inspect worst trace is the trace shortcut. Traces are sampled, so preselect one that exists in Sentry. Open logs for this run links the log view.
5. Game → Saved player runs → Received from Sentry shows the import count. Watch run → Play shows deterministic 2D playback, not Sentry Session Replay.
6. Point to the eligible-run counter, Replay validation, and How learning stays playable. New-rule evaluation is currently waiting for data; say so.
7. Open Cant Catch Me → Make your escape.

**Game instructions — about ten seconds.**

“W or Up accelerates; A/D or the arrows steer; S or Down brakes. Break their view and collect orange boosts. A drone needs two uninterrupted seconds close to you with clear sight to capture you. Survival time is your score.”

Keyboard is the simplest presentation path. Badge controls are implemented, but the README records that physical hardware validation was not completed.

## Two-minute Q&A preparation

**Dominion: What makes the coordination different?**

A tower needs repeated fresh evidence before dispatch. The receiving aircraft then needs its own repeated accepted observations before handoff counts. Every sensor contributes to one target estimate.

**Dominion: What is learned?**

The offline experiment uses a boat-motion prior to propose tower sites and evaluates the layouts on separate missions. The game has a different numerical optimizer that evaluates positions against recorded controls. Neither is a trained neural flight controller.

**Dominion: What did the benchmark show?**

For 200 synthetic tests, default towers with the tower-first controller versus selected towers with that same controller: confirmed detection rose from 29% to 40%, handoff from 26.5% to 31%, and capped detection delay fell from 244.2 to 222.9 seconds. However, custody outside tower view fell from 58.6% to 24.4%. This supports improved acquisition under that model; it does not establish improved continuous tracking. Do not mix this baseline with the separate systematic-sweep baseline.

**Dominion: Are the cameras and boat real?**

Everything is simulated. Overview and Simulation lab are offline modeled experiments. The /backend page connects to the actual supplied ArcticSim simulator when running. Can't Catch Me is a separate game adaptation.

**Dominion: How strong is classification?**

The current default is a simulator hull-color detector labeled as a vessel. An optional local vessel-model interface exists, but no trained weights or labeled dataset were present. General vessel recognition and calibrated camera accuracy are unproven.

**Dominion: Do you send tracks to the official endpoint?**

The slides specify POST /api/tracks on port 8010. The repository still lists that as a separate integration step. Do not claim successful official submission.

**Sentry: Which products count beyond errors?**

Session Replay, Tracing and Logs. Replay is in the game; detailed controller Logs and Tracing are in the mission backend, with additional browser tracing/logging in the dashboard. Game SDK logs are disabled.

**Sentry: Does the video train the optimizer?**

No. Session Replay shows the experience. Structured event attachments contain controls, seed and layout. The server retrieves those attachments from Sentry and validates the exact content before evaluation.

**Sentry: Is this reinforcement learning or coordinate logging?**

The implementation is replay-based tower-placement optimization. It generates candidate sites and evaluates them against recorded controls; it does not implement reinforcement learning. Controls, seed and layout in the Sentry attachment reproduce boat/aircraft coordinates through the game engine. Mission Logs separately include the latest estimated target position, velocity and uncertainty. Explain the loss-of-contact case as the problem the system addresses; no specific Sentry-discovered incident was supplied by the team.

**Sentry: What changes after enough attempts?**

After eight eligible completed runs, the optimizer compares positions using up to 24 recent runs and keeps at least four separate for validation. Only tower positions can change, and only for future attempts. Recorded escapes and early-capture checks constrain promotion.

**Sentry: Has the game improved already?**

The server reports 17 imported historical attempts. There are zero eligible attempts under the updated rules and no current-rule placement evaluation. Layout remains version 0. Nine preserved historical evaluations made no promotion; their dates do not establish that Sentry caused those decisions.

**Sentry: What bug did Sentry help you fix?**

No specific Sentry-discovered fix with before/after evidence was found in the audited material. Answer with a real team example only if you can show its event/trace, the change, and a repeated measurement. Otherwise describe the implemented workflow and be clear about the missing measured result.

**Sentry: What happens if Sentry is unavailable?**

The game remains playable and stores attempts locally; upload/import retries are bounded. New placement evaluation waits for qualifying imported records. Controller observability export is isolated in a bounded worker; exporter failure and dropped telemetry are visible.

## Presentation checks and claim boundaries

- At inspection, the game on port 3100 and dashboard Sentry configuration endpoint on port 3003 responded. Backend health on port 8000 refused the connection, and the dashboard health proxy returned 503. The simulator's site endpoint on port 8090 responded. Resolve the operational backend before promising a live fleet demonstration.
- Inspect actual Sentry cloud Replay, Logs and Tracing before presenting. Configured=true is not evidence of delivered telemetry.
- The latest game rules are opening-overhead-spotting-v2. All 17 imported records use earlier rules; the current counter is 0/8. Do not imply one judge run immediately updates the model.
- There is no saved proof of a Sentry-discovered fix or measured improvement. The strongest missing evidence is a genuine Sentry finding → code change → repeated result.
- A synthetic integration test records an optimizer promotion. It is test evidence, not a player result.
- Historical nine layout evaluations are preserved, but cannot be attributed to Sentry without proving that sequence.
- No claim of measured live ArcticSim accuracy, calibrated neural classification, official scoring improvement, or successful track submission is supported by this audit.
- The official supplied four-asset configuration has two towers, one quadcopter and one fixed wing. The game's two pursuing drones and capture rules are adaptations. The local rover is not part of that four-asset demonstration.
- No new tests were run for this writing task. Existing tests and recorded evidence were inspected.

## Source map

All paths below are relative to the shared HTN2026 workspace.

- Supplied slide images: tmp/pdfs/arctic-relevant.png, pages 9, 11, 18 and 24.
- Runtime scope and current caveats: HTNV1-tower-search/README.md:101, :126, :130, :151, :198, :233.
- Confirmation and handoff: HTNV1-tower-search/backend/agents/c2.py:14, :74, :94, :106.
- Command suppression: HTNV1-tower-search/backend/brain.py:226.
- Target filtering: HTNV1-tower-search/backend/tracker.py:1.
- Tower experiment: HTNV1-tower-search/backend/train_graph_search.py:144, :212, :244.
- Saved current synthetic data: HTNV1-tower-search/frontend/public/experiments/graph-report.json.
- Exact replay controls: HTNV1-tower-search/frontend/components/GraphTrainingDemo.tsx:257.
- Game dashboard and eligibility: HTNV1-tower-search/frontend/components/GameLearning.tsx:56, :81, :85.
- Local game playback versus Sentry import status: HTNV1-tower-search/frontend/components/GamePreview.tsx:38, :132.
- Sentry measured stages and worker: HTNV1-tower-search/backend/observability.py:129, :165, :193, :225.
- Sentry trace shortcut: HTNV1-tower-search/frontend/components/TickPerformance.tsx:23.
- Game capture: cant-catch-me/lib/sentryGame.ts:17; cant-catch-me/sentry.client.config.ts:25.
- Structured Sentry upload/download: cant-catch-me/lib/learningSentry.ts:40, :133.
- Eligibility, verification and downloaded recording use: cant-catch-me/lib/learningServer.ts:206, :276, :345, :436.
- Placement acceptance guards: cant-catch-me/lib/learningOptimizer.ts:119.
- Current imported counts were read from http://127.0.0.1:3100/api/learning/dashboard; saved local evaluation history is in cant-catch-me/.game-learning/state.json.
