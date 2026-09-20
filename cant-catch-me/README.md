# Can't Catch Me

A standalone Next.js + Three.js boat survival game that starts in the supplied Fort Ross terrain and continues along an endless generated river. Two towers and a scouting plane share sightings with two pursuing quadcopters in the original region. Stay within 65 metres of either drone for two uninterrupted seconds and the run ends; leave the original region to escape their pursuit. Survival time is the score, and the river remains open after escape. There is no finish line or scripted capture deadline.

## Play locally

Requires Node.js 18.17+.

```sh
npm ci
npm run dev
```

Open http://localhost:3100. No simulator, backend, account, API key, or network connection is needed once installed. The first visit downloads approximately 2 MB of local world and model data, plus the game code and fonts.

- **W / ↑**: accelerate
- **S / ↓**: brake (never reverse)
- **A / D or ← / →**: steer (also while stopped)
- **Escape / P**: pause and resume
- **C**: switch between the close helm view and chase camera
- **Hold Space**: look back (or tap the curved-arrow button to toggle looking back)
- **Touch**: use the four on-screen controls

Movement is forward-only. Steering is limited to 75° either side of the initial downriver course, preventing U-turns and backward progress. You can steer while stopped to clear a shoreline. This is still survival play, not a timed finish-line race.

The default view sits just above and beside the bridge so the bow and nearby water remain visible. Both cameras follow the same interpolated hull position, avoiding a jittering boat against a separately smoothed camera. A fresh water surface uses broad swells, filtered small ripples, soft sky reflections and a continuous foam trail. Each drone casts a silhouette on the water. Turn gentle camera sway off in the pause menu; the device's reduced-motion preference also disables these camera effects.

The game automatically pauses when its window loses focus. Personal bests are saved in this browser when local storage is available. Radar sectors indicate tower coverage. Orange D1/D2 marks the drones, cyan P1 is the scout plane, and the white arrow is your boat. Shorelines stop the boat without ending the run; brake and steer back toward the channel. The old map edge now flows into connected terrain without teleporting the boat or interrupting play.

Collect an orange boost pickup for **four active real seconds** of **1.65× top speed** (99 simulation metres/second). Pickups appear at random navigable positions ahead, with the first placed close to the starting course. Braking still works, pausing freezes the boost timer, and no more than four pickups remain active. Each new browser session and retry after capture uses a fresh pickup seed.

The original two towers stay at their saved sites. The same two drones and scout remain inside the original region, return to patrol, and stop sharing sightings or tagging once you leave it. New river regions do not create additional towers or aircraft. The distance and region displays continue as you travel farther downriver.

## Build and verify

```sh
npm test
npm run typecheck
npm run build
npm start
```

The 24 deterministic engine tests cover collision, radar occlusion, hidden-target pursuit, uninterrupted tagging, pause, retry, fixed-step timing, seeded pickups, boost collection and expiry, terrain continuity, and actual-map escape. A three-minute Fort Ross run verifies continuous travel across several regions without teleporting, collisions, or duplicated towers and aircraft.

## Sources and game rules

See [ASSET_SOURCES.md](ASSET_SOURCES.md) for the exact branch revision, supplied model attributions, terrain conversion, coordinate conventions, and tower sites. The supplied interior geography and tower sites are retained. The outer 500 metres of the original square blend smoothly into generated river terrain so the old boundary becomes a navigable connection. The extension is game terrain, not surveyed Fort Ross geography. The two tower positions are the selected pair from the existing placement experiment, rather than a claim of globally optimal placement.

Gameplay runs locally in the browser and does not control or connect to the surveillance simulator. Speeds and visible vehicle sizes are deliberately exaggerated for playability. Within the original patrol region, all aircraft follow shared observations and search last-known locations; hidden boat movement cannot guide them. The drones reach 84 simulation metres/second versus the boat's normal 60, while a boost raises the boat's top speed to 99. The plane flies repeated surveillance passes at 100 and cannot tag. The source PDF's horizontal camera angles are used: towers 60°, quadcopters 114.6°, plane 69°. Aircraft cameras use their heading, a bounded range, and terrain line of sight. The source quadcopter's independent gimbal and vertical camera angles are not simulated.

Movement, radar sweeps, search and escalation run at **2× pace**. Survival score and boost duration measure real active seconds. Capture takes **two uninterrupted real seconds** inside the same 65-metre radius, tracked separately for each drone; partial locks cannot transfer between them. Escape immediately clears all locks and sightings for the rest of that run. Selected tower positions, existing tower/drone ranges, line of sight and shoreline collision remain in effect. The plane's 1,100-metre sight range, pursuit speeds, two-drone fleet, tagging rule, boosts and patrol boundary are game adaptations; the PDF does not specify those values. Endless boosted runs use the separate local-storage record `cant-catch-me-best-endless-boost-pace2`, leaving earlier records intact. Retry restores the starting terrain, fleet and score with a fresh pickup layout.

Terrain generation uses global coordinates, so neighbouring regions share a continuous surface. Rendering keeps only a **3×3 neighbourhood** of 6,500-metre terrain tiles around the boat and disposes of tiles left behind. The deterministic terrain function is shared by rendering, navigation, collision and the radar. Only the pickup seed varies between browser runs; `createGame(world, seed)` permits reproducible engine tests.

`lib/game.ts` owns the deterministic game rules, continuous terrain sampler and seeded pickups. `components/Scene.tsx` renders the terrain neighbourhood, supplied fleet geometry, pickups and synchronized cameras; `components/Ocean.tsx` owns the sea and foam wake. `components/Game.tsx` owns menus, input and new-run seeds; `components/Radar.tsx` renders the geographic minimap.
