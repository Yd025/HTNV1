# Freeze — timed video pitch

Matched to htn.mp4 (3:58.97). Two speakers; switch at 02:00. Bracketed screen cues are not spoken. Aim for a conversational 130–140 words per minute, easing through the benchmark numbers. These are narration slots aligned to the existing video, not a verbatim transcription of its audio.

**00:00–00:20 · Speaker 1**

[Mission overview and map]

A ship goes dark in the Arctic. Keeping it in sight means dealing with terrain, narrow camera views, and a moving target. Meet Freeze: a system that coordinates two ground towers, a quadcopter, and a fixed-wing plane to track that ship.

**00:20–00:38 · Speaker 1**

[Mission graphs and tracking results]

We start with our territorial advantage: understanding the map. We model the terrain, water routes, and camera blind spots, then compare tower positions and flight strategies. The dashboard shows what matters: coverage, tracking, and how long contact breaks.

**00:38–00:50 · Speaker 1**

[Training results and completed benchmark]

Across 200 unseen simulated missions, our optimized strategy increased confirmed detection from 46 percent to 66.5 percent compared with our default coordinated search.

**00:50–01:02 · Speaker 1**

[Fleet page and platform models]

Each platform has a distinct job. Towers scan from fixed positions, the plane searches wider water, and the quadcopter covers nearby gaps before following a confirmed contact.

**01:02–01:22 · Speaker 1**

[Tower and aircraft camera views]

These are modeled camera views from the saved mission. They help us see why coordination matters: a boat visible to one sensor can disappear from another. We combine fresh observations into one shared estimate of its position, movement, and uncertainty.

**01:22–01:40 · Speaker 1**

[Aircraft camera views and boat sightings]

We’re strict about handoffs. The receiving aircraft needs two fresh, accepted sightings of its own before we count it as tracking. If observations stop, uncertainty grows, and the fleet searches around the boat’s predicted movement to regain contact.

**01:40–02:00 · Speaker 1**

[Simulation lab, then Activity]

The simulation lab puts those views back into the terrain. We can inspect flight paths, rotate around obstacles, and follow the same mission from each sensor’s perspective. Alongside the activity timeline, that helps us connect a tracking failure to what the fleet was actually doing.

**02:00–02:17 · Speaker 2**

[Sentry page and mission view]

And that led to a different engineering problem. A boat can escape while the application keeps running perfectly. There may be no crash to investigate. We need to understand where coverage failed, and whether the controller reacted in time.

**02:17–02:34 · Speaker 2**

[Mission view, then controller performance]

Sentry Tracing measures each controller stage, while Logs record rejected sightings and command outcomes. Paired with our mission view, these tools help us investigate whether a loss of contact involved slow decisions, stale data, or a coverage gap.

**02:34–02:48 · Speaker 2**

[System monitor]

This system monitor brings fleet state, the shared target estimate, and controller timing together. Here, it’s showing our local simulator. Our ArcticSim adapter connects vehicle telemetry and commands through MAVLink.

**02:48–03:10 · Speaker 2**

[Game dashboard, results, and recorded map replay]

Then we put a human on the other side with Can’t Catch Me. You control the boat and try to escape our sensors. We added Sentry Session Replay for the player’s view; our separate map replay reconstructs recorded movement and visibility so we can inspect each attempt.

**03:10–03:26 · Speaker 2**

[Game opens; physical badge demonstration]

And yes, that controller is our Hack the North badge. We turned it into physical controls for steering and throttle. In this game, two towers, two quadcopters, and a plane are trying to catch you.

**03:26–03:47 · Speaker 2**

[Badge-controlled gameplay continues]

Once eight eligible opening runs are verified and retrieved from Sentry, the optimizer can test new tower positions and flight settings. A change reaches future games only after separate validation, including checks that preserve a chance to escape. Active games keep their original strategy.

**03:47–03:59 · Speaker 2**

[Final gameplay and invitation]

That’s Freeze: understand the terrain, coordinate the fleet, record what happened, and test how to improve. Now take the badge, head downriver, and see if you can disappear.

---

## Accuracy notes — not spoken

- The current coordinated strategy actively searches with aircraft. The old grounded-until-tower-confirmation explanation describes the historical tower-first strategy.
- The benchmark is exactly 200 held-out synthetic missions. 46% is the default coordinated strategy; 66.5% is the optimized coordinated strategy. The historical tower-first baseline is 25%. These are simulated detection results, not field accuracy.
- Tower placement and flight settings are optimized together. Avoid “absolute best” and claims of a trained visual detector.
- The camera walkthrough is a saved modeled mission. The monitor around 02:34 shows the local simulator, not verified live ArcticSim camera feeds.
- The Sentry page shows integration and local instrumentation. The clip does not show a stored Sentry trace or a Sentry Session Replay playing; do not introduce it as one. The game map replay is a separate reconstruction.
- Eight eligible current-rule completed opening attempts must pass verification and Sentry retrieval. Strategy promotion is conditional; the inspected game state shows no promotion yet. The script describes the implemented mechanism, not a demonstrated learning improvement.
- The main mission uses one quadcopter. The separate game uses two. Physical badge use is visible in the supplied video.

## Source checks

- `tmp/release-0.2/frontend/components/GraphTrainingDemo.tsx`: current coordinated demo selection.
- `tmp/release-0.2/frontend/public/experiments/surveillance-report.json`: saved 200-mission benchmark.
- `tmp/release-0.2/backend/agents/plane.py`, `copter.py`, `c2.py`: search roles and two-observation handoff.
- `tmp/release-0.2/backend/sim/whiteout.py`: MAVLink fleet adapter.
- `tmp/release-0.2/frontend/components/SentryPanel.tsx`: configuration vs delivery and instrumentation display.
- `cant-catch-me/lib/learningServer.ts`, `learningOptimizer.ts`, `learningTypes.ts`: verification, Sentry retrieval, eight-run threshold, and validation before promotion.
- `cant-catch-me/sentry.client.config.ts`, `components/SentryCanvasRecorder.tsx`: game Session Replay integration.
- `cant-catch-me/components/BadgePanel.tsx`, `lib/badgeInput.ts`: badge input.
- `C:/Users/rbm72/Downloads/htn.mp4`: screen order and physical badge demonstration.
