# Can't Catch Me — Freeze's playable demo

Pilot a boat through Fort Ross and an endless generated river while two quadcopters, a scouting plane and two towers share sightings and search for you. Survive as long as possible, break their view and collect speed boosts. The game is a standalone Next.js + Three.js application included in Freeze's final release on `main`.

The game runs its own deterministic simulation in the browser. It does not control the ArcticSim fleet. Its optional learning service replays opening-stretch attempts to evaluate tower placement and aircraft search policies; the Freeze dashboard shows those results separately from simulator telemetry.

## Run locally

From the repository root, with Node.js 18.17 or newer and npm installed:

```sh
cd cant-catch-me
npm ci
npm run dev
```

Open [localhost:3100](http://localhost:3100). No simulator, database, API key or separate model service is required to play. World data, models and fonts are bundled in `public/`. The repository's Docker Compose stack does not start this game; run it separately.

For a production server:

```sh
npm run build
npm start
```

The game remains playable when learning or Sentry is unavailable, using its supplied tower layout and default flight policy.

## Controls and survival rules

| Action | Keyboard | Badge |
| --- | --- | --- |
| Accelerate | W / Up arrow | Up |
| Brake | S / Down arrow | Down |
| Steer | A / D or Left / Right arrows | Left / Right |
| Start or retry | Enter / Space on the start or capture screen | Start |
| Pause or resume | Escape / P | Start |
| Switch helm/chase camera | C | A |
| Look back | Hold Space while playing | Hold B |

Touch steering and throttle buttons appear during play. The curved-arrow button toggles the rear view. The pause menu includes camera sway settings; reduced-motion preferences also disable camera effects. Losing window focus pauses the run, and personal bests are saved locally when browser storage is available.

- **Capture:** one drone must remain within 65 metres with clear terrain line of sight for two uninterrupted active real seconds. Each drone maintains its own lock; partial locks do not transfer. The plane spots you but cannot capture you.
- **Detection:** towers use viewing sectors; aircraft spot within a 65-metre downward-looking footprint. They share observed positions and estimated velocity. Losing contact triggers searches around the last observation, without using hidden boat movement.
- **Movement:** thrust, drag and steering build momentum. Braking stops the boat without reversing; steering works while stopped. Heading is limited to 75° either side of the initial downriver course. Shoreline collisions slow or stop the boat instead of ending the run.
- **Boosts:** orange pickups provide four active real seconds of extra thrust and a 1.65× speed limit. Pausing freezes the timer. Each retry gets a fresh pickup seed.
- **Endless patrols:** leaving the first map starts a new patrol; subsequent patrols arrive every 6,500 metres of downriver progress. Each replaces the previous two towers, two drones and plane, clears old locks, and gives three active real seconds of grace. Drone speed and acceleration increase gradually, capped at 30% and 20% above base values.

Movement and sensing run at 2× simulation pace. Survival score, boost duration and capture time use active real seconds. The radar centers on the boat: orange D1/D2 are drones, cyan P1 is the plane, and sectors show tower coverage. An amber T1/T2 warning appears only while a tower actually sees you.

## Connect a Hack the North badge

Choose **Connect a badge** on the start screen or pause menu, then use the live button check. Keyboard and touch remain available. A lost badge connection releases held controls and pauses an active run. Release and press controls again after reconnecting or resuming.

### HTN OS over Wi-Fi

This path is for badges running [HTN OS](https://solana-htn.com/badge).

1. Connect the badge to Wi-Fi.
2. Enter the five-character **HTN-ID** from its home screen and the app key from **Settings → App key**.
3. Connect and check that button presses light up in the game.

The browser connects directly to the badge service, displays controller instructions and enters canvas mode. Hold Home on the badge to leave that mode. The app key stays in this tab and is sent to the badge service; the game does not save it to local storage or send it to its server. This mode depends on the public badge service and a working network connection.

### Original Lua firmware over USB

1. Use a USB data cable and open the [badge editor](https://badge.hackthenorth.com).
2. Install and run the bundled [Game Controller script](public/badge/boat_game.lua), also downloadable from the game's badge menu.
3. Disconnect the editor's serial monitor so the game can open the port.
4. Choose **Lua script · USB**, select the badge and test its buttons.

USB requires desktop Chrome or Edge on HTTPS or localhost. The game reads script log events at 115200 baud. The original `game-script` controller supports Up, Left, Right and Start; the bundled version adds Down/A/B and periodic state snapshots for held-button recovery.

These paths use different firmware. Installing HTN OS replaces the original Lua firmware; connecting through this game does not flash the badge. Automated fake-device tests cover both transports and connection recovery. Physical badge validation remains outstanding.

## Opening-stretch learning

Each run pins its tower layout, `coordinated-surveillance-v1` algorithm and six bounded flight settings. The client records the initial pickup seed and control changes at simulation ticks. Capture or crossing the first map boundary completes an opening attempt. Crossing continues the endless game normally. Quitting or reaching five active minutes abandons the recording; abandoned attempts do not train the optimizer.

The server verifies completed attempts by replaying the same game engine. Eligible recordings then follow this pipeline:

```text
Completed attempt → deterministic verification → Sentry attachment upload
                  → attachment readback and content-hash check
                  → candidate evaluation → validation → future-run policy
```

After at least eight current-rule completed attempts have been imported from Sentry, the optimizer can evaluate flight-only, tower-only and joint candidates against up to 24 recent attempts. Training selects a proposal; at least four separate attempts validate it. The settings cover sweep spacing, route phase, quad search radius, prediction horizon, support offset and reacquisition width. Camera geometry, aircraft speed and turn limits, boosts and capture rules stay fixed.

Promotion requires improved capped capture time without reduced capture rate on both the full evaluation set and validation group. Uncaught replays receive a 300-second penalty. The candidate must preserve at least one recorded validation escape, stay at or below 80% validation captures and introduce no new or earlier capture below 12 active seconds. Tower placement also enforces land, starting-area protection and separation constraints. A recording that ended at capture cannot establish a later escape: such alternative outcomes are marked censored.

Only future runs receive a promoted policy. Active runs keep their pinned policy, including across a server restart. Historical rule versions and recordings remain preserved; only eligible current-version attempts train new rounds. Replayed controls cannot predict a player's reaction to a different policy, so observed player outcomes and replay estimates remain separate.

This is numerical strategy optimization, not image-recognition training or a trained neural network. These are implemented pipeline and validation rules, not evidence of a successful live promotion. At the final-release evidence check, no eligible current-version Sentry imports or promoted game strategy were established. The supplied strategy remains the baseline until actual imported attempts pass the gates.

## Configure Sentry and persistence

Copy `.env.example` to `.env.local` in this directory and configure:

| Setting | Purpose |
| --- | --- |
| `SENTRY_DSN` | Server event and structured-record upload destination |
| `NEXT_PUBLIC_SENTRY_DSN` | Browser errors and game-canvas Replay; use the same project |
| `SENTRY_API_TOKEN` | Server-only token with `project:read`, used to retrieve attachments |
| `SENTRY_API_BASE` | Matching Sentry API origin, such as `https://us.sentry.io` |
| `SENTRY_ORG`, `SENTRY_PROJECT` | Optional IDs or slugs when DSN-derived values need overriding |
| `GAME_LEARNING_DIR` | Optional absolute path for a durable learning archive |

Create the read token in [Sentry Personal Tokens](https://sentry.io/settings/account/api/auth-tokens/) and enable event attachments for the project. Never prefix the token with `NEXT_PUBLIC_` or commit `.env.local`. Restart after environment changes; rebuild production bundles after changing browser settings. Optional source-map uploads use a separate `SENTRY_AUTH_TOKEN` plus organization/project settings; the read token does not authorize build uploads.

Starting an attempt explicitly starts Replay. Manual snapshots capture only the game canvas, at up to two frames per second and 960×540; text and inputs are masked. A replay may span multiple attempts, linked by attempt breadcrumbs. Visual Replay and structured attachment import are independent. Historical attempts can backfill structured data, but cannot gain past visual footage.

The durable outbox uploads `cant-catch-me-opening-v1.json` with rules/world versions, pinned policy, seed, controls, ticks and outcome. It excludes player identities, credentials and session tokens. Readback checks the version and exact content hash; duplicate imports do not count twice. Upload/import failures retry with bounded backoff and resume after restart. Changing the Sentry destination resets import eligibility and queues records for the new destination.

With DSNs alone, records can upload but training waits for read access. Without Sentry, local recording and gameplay still work, but new attempts do not train the model. An uploaded record is not necessarily an imported record; inspect the dashboard's pending/uploaded/imported/error states.

Layouts, attempts and evaluation history live in the Git-ignored `.game-learning/` directory by default. Preserve that directory between deployments or set `GAME_LEARNING_DIR` to durable storage. Run **one game server process per data directory**; this filesystem archive is intended for a shared demo server, not multi-instance deployment.

## Connect the Freeze dashboard

Run the dashboard from [`../frontend`](../frontend/) using the [project setup instructions](../README.md), then open its **Game** tab. It presents attempt outcomes, capture-rate graphs, policy evaluations, recording status and a 2D view based on game telemetry. Paused, stale and completed attempts are labeled.

Set these variables in the dashboard's environment, then restart it:

- `GAME_SERVICE_URL`: origin reachable by the dashboard server; native default `http://127.0.0.1:3100`, Docker Compose default `http://host.docker.internal:3100`.
- `NEXT_PUBLIC_GAME_URL`: origin reachable by the player's browser; default `http://localhost:3100`.

Use origins, not API paths. Remote players need a browser-reachable game URL. The game's endpoints are `/api/learning/{start,live,finish,dashboard,layout,replay}`. Per-attempt tokens authorize updates, and finishing an attempt is idempotent.

## Verify and navigate the code

From `cant-catch-me/`:

```sh
npm test
npm run typecheck
npm run build
```

Tests cover deterministic boat physics, terrain and collision, capture timing, coordinated surveillance, observation-only search, seeded boosts, patrol transitions, learning verification and migration, promotion guards, Sentry privacy/import behavior, and badge transports/input recovery. Automated checks do not establish physical badge compatibility, live Sentry availability or real-world aircraft performance.

| Path | Responsibility |
| --- | --- |
| `lib/game.ts`, `lib/surveillance.ts` | Deterministic rules, terrain, boat physics and aircraft coordination |
| `lib/learning*.ts`, `pages/api/learning/` | Attempt archive, replay evaluation, Sentry synchronization and API |
| `components/Game.tsx` | Menus, input, lifecycle and run seeds |
| `components/Scene.tsx`, `components/Ocean.tsx` | Terrain, models, cameras, water and wake |
| `components/Radar.tsx`, `components/TowerWarning.tsx` | Live situational displays |
| `components/BadgePanel.tsx`, `hooks/useBadgeController.ts`, `lib/badge*.ts` | Badge setup, transports and input merging |
| `public/badge/boat_game.lua` | Extended USB controller script |
| `public/assets/`, `scripts/prepare_assets.py` | Bundled assets and optional regeneration |

Read [ASSET_SOURCES.md](ASSET_SOURCES.md) for source revisions, attributions, coordinate conventions and regeneration inputs. The opening terrain derives from supplied Fort Ross data; its outer border blends into generated game terrain. Later river sections are not surveyed geography. Arcade physics, downward spotting, the extra drone, tagging and boosts are game adaptations, not ArcticSim sensor specifications. See the [project README](../README.md) for the rest of Freeze.
