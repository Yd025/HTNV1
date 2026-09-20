# Freeze — presentation and judge Q&A

Use the general pitch or replace the platform walkthrough with the Sentry variant. Bracketed directions are not spoken. Use saved results; do not start training during the presentation.

## Speaker 1 — mission and coordination

[Overview → select a saved coordinated-surveillance mission.]

Freeze coordinates two fixed camera towers, a quadcopter, and a fixed-wing plane to find and track ships in an Arctic simulation.

Terrain blocks sightlines, and each camera covers a limited area. We compare tower sites and aircraft flight settings before testing the selected strategy on unseen routes.

The plane searches wider water while the quad covers nearby gaps. Repeated fresh observations confirm a contact and feed one shared estimate of the ship's position, velocity, and uncertainty. The quad follows that estimate; the plane makes supporting camera passes.

A handoff requires two fresh, accepted sightings from the receiving aircraft. Flying to a predicted coordinate does not establish contact. When sightings stop, uncertainty grows and the aircraft search around the predicted movement. An unrecovered track eventually expires.

## Platform walkthrough

[Overview → Watch handoff example → play at 8×.]

This is a saved synthetic mission. The map and timeline show aircraft routes, contact state, and changes in the observing sensor. The display distinguishes observations from predicted positions.

[Cameras → Simulation lab.]

Cameras shows modeled sensor views. Simulation lab shows the same mission in 3D. Both follow the replay clock; connected simulator feeds appear separately.

[Overview → Completed benchmark.]

Across 200 held-out synthetic missions, confirmed detection increased from 25 percent with the tower-first baseline to 66.5 percent with optimized coordinated search. Contact gaps shortened, but aircraft traveled farther. These results measure a synthetic sensor model, not live-camera accuracy.

## Speaker 2 — game and evaluation

[Game → show an attempt's outcome and import status → Open Cant Catch Me.]

Can’t Catch Me makes coverage testable through a playable ship escape game. Two towers, two quadcopters, and a plane search while the player uses terrain and boosts to evade them. It runs separately from the operational controller.

We record the opening stretch's controls, seed, and strategy, then reproduce the attempt on the server. Capture or crossing the opening map's downriver boundary completes it. Leaving tower range alone is not an escape because aircraft may still see the ship.

Verified recordings retrieved from Sentry qualify for strategy evaluation. After eight eligible attempts, the optimizer can test new tower sites and flight settings against recorded controls. Separate validation determines whether a proposal affects future games. Active runs retain their original settings. No strategy has yet been promoted from the inspected recordings.

Later river stretches extend survival gameplay but contribute no additional training attempts. Keyboard and touch controls work; optional badge support still needs physical-device validation.

## Sentry variant — replace the platform walkthrough

[Show an actual stored controller trace, matching logs, and a saved Session Replay.]

A player can escape without causing a software exception. We use Sentry to inspect coverage failures as well as application errors.

Session Replay shows the player's experience. Our custom map replay reconstructs vehicle movement and sensor visibility. Tracing measures controller stages; Logs record rejected sightings and command outcomes.

[Game → saved replay → recording/import status.]

The server verifies a structured attempt, uploads it to Sentry, retrieves it, and checks its contents and version before evaluation. Escapes produce informational events, not error alerts. These recordings support repeatable strategy comparisons; they do not guarantee an improved layout.

## Screen reference

| Screen | Use |
| --- | --- |
| Overview | Saved terrain experiment, observer changes, timeline, benchmark. |
| Cameras / Simulation lab | Modeled views and 3D playback of the selected mission. Identify live feeds separately. |
| Fleet / Activity | Asset state and intended commands; neither proves camera acquisition. |
| Game | Actual outcomes, strategy version, imported recordings, alternative-strategy estimates. |
| Sentry | Stored traces, logs, replay and delivery evidence. |
| System monitor / `/backend` | Connection health and actual simulator feeds; show only when connected. |

## Judge Q&A

### What recognizes the ship?

The default live detector uses hull color and shape against the water. It projects an approximate hull water-contact point through the camera pose onto the sea surface to estimate map coordinates. Calibration remains necessary. An optional YOLO/ONNX interface exists without supplied trained ship weights. The benchmark and game use modeled visibility, not this image detector.

### Does the controller know the hidden position?

Decisions use accepted sensor observations and a shared target filter. Checks reject stale, duplicate, out-of-order, and implausible observations. Ground truth supports simulated observations, scoring, and spectator views; it does not guide searches. The tracker follows one ship.

### Why does the plane make passes?

Its camera faces forward and down, and the aircraft must keep moving. Directly overhead can place the ship outside its view. Offset passes and quad support help maintain contact. The game's camera rules are separate.

### What is optimized? Is it reinforcement learning?

Two tower sites and six flight settings: search spacing, route phase, quad search radius, prediction horizon, support offset, and reacquisition width. This is replay-based policy optimization, not reinforcement learning. Candidates use separate training and validation data before held-out testing. Results identify the best tested settings, not a global optimum.

### Which game attempts qualify?

Only verified, current-version opening attempts completing Sentry upload and retrieval qualify. Quitting is abandonment. A genuine 10–13-second capture can qualify; there is no minimum recording duration. Start a fresh run to contribute another attempt. Replaying fixed controls cannot predict how a human would react to changed settings, and game optimization does not establish operational-controller improvement.

### Does eight attempts guarantee an update?

No. Initially four rank candidates and four validate; later evaluations use up to 24 recent attempts with at least four reserved for validation. Acceptance requires a better capture-time objective without reduced capture rate, at least one validation escape, no more than 80% validation captures, and valid placements.

A candidate cannot introduce a capture below 12 seconds or make an existing capture earlier below that threshold. An unchanged existing 10-second capture is allowed. An all-capture validation group cannot pass.

### What else did the benchmark show?

Across the same 200 synthetic test missions, detection was 25.0%, 46.0%, and 66.5% for tower-first, coordinated, and optimized coordinated search. From first to last, aircraft tracking custody rose from 9.4% to 23.9%; mean longest contact gap fell from 228.7 to 118.9 seconds; travel rose from 4.74 to 7.12 km. These are not physical-flight results.

## Internal references — not spoken

Paths are relative to HTN2026.

- Mission/results: `HTNV1-tower-search/README.md`; `HTNV1-tower-search/frontend/public/experiments/surveillance-report.json`.
- Detection/tracking: `HTNV1-tower-search/backend/sim/detector.py`; `HTNV1-tower-search/backend/vision/vessel.py`; `HTNV1-tower-search/backend/tracker.py`; `HTNV1-tower-search/backend/agents/c2.py`.
- Game eligibility/acceptance: `cant-catch-me/lib/learningClient.ts`; `cant-catch-me/lib/learningServer.ts`; `cant-catch-me/lib/learningOptimizer.ts`.
- Recording/events: `cant-catch-me/lib/learningSentry.ts`; `cant-catch-me/lib/sentryGame.ts`.
