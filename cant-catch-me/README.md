# Can't Catch Me

A standalone Next.js + Three.js boat survival game that starts in the supplied Fort Ross terrain and continues along an endless generated river. Every new stretch brings two towers, two pursuing quadcopters and a scouting plane, with tougher drones each time. Stay within 65 metres of either drone with a clear line of sight for two uninterrupted seconds and the run ends. Survival time is the score. There is no finish line or scripted capture deadline.

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

Movement uses arcade boat physics: engine thrust builds momentum against linear and quadratic water resistance, the rudder and yaw respond gradually, and turns lose speed while allowing a little sideways slip. Braking brings the boat to a stop without reversing. Steering is limited to 75° either side of the initial downriver course, preventing U-turns and backward progress. You can steer while stopped to clear a shoreline.

The default view sits just above and beside the bridge so the bow and nearby water remain visible. Both cameras follow the same interpolated hull position, avoiding a jittering boat against a separately smoothed camera. Four water samples around the hull drive damped buoyancy, pitch and roll, alongside its response to acceleration and turning. Broad swells, filtered small ripples, soft sky reflections and a continuous foam trail animate the water. Each drone casts a silhouette on the water. Turn gentle camera sway off in the pause menu; the device's reduced-motion preference also disables these camera effects.

The game automatically pauses when its window loses focus. Personal bests are saved in this browser when local storage is available. A small amber warning names T1, T2, or both only while those towers actually see the boat; it leaves steering available and disappears when tower contact breaks. Any live tower, drone or plane sighting makes the drones accelerate harder. Searching a last-known position alone does not trigger that faster pursuit.

The radar stays centered on the boat as the terrain moves beneath it. Sectors indicate tower coverage; orange D1/D2 marks the drones, cyan P1 is the scout plane, and the white arrow is your boat. Shoreline contact sheds momentum or stops the boat without ending the run; brake and steer back toward the channel. The old map edge flows into connected terrain without teleporting the boat or interrupting play.

Collect an orange boost pickup for **four active real seconds** of increased thrust and a **1.65× top-speed limit** (99 simulation metres/second). Speed builds with momentum, and excess speed decays through water resistance when the boost ends. Pickups appear at random navigable positions ahead, with the first placed close to the starting course. Braking still works, pausing freezes the boost timer, and no more than four pickups remain active. Each new browser session and retry after capture uses a fresh pickup seed.

The first stretch uses the original two saved tower sites. Crossing the original square's boundary downriver starts the next patrol; later patrols arrive every 6,500 metres of progress along the initial downriver direction. Each transition replaces the existing patrol with two towers on the generated riverbanks, two drones and the scout plane. The fleet stays bounded at those counts. Old sightings and drone locks clear, and the new patrol receives a short grace period. Drone speeds rise by 3% of their base values per loop, capped at 30%; acceleration rises by 2% per loop, capped at 20%. The stretch counter and a brief new-patrol notice mark progress while the boat, river and score continue.

## Build and verify

```sh
npm test
npm run typecheck
npm run build
npm start
```

The deterministic engine tests cover thrust and drag, steering inertia, momentum and shoreline collision, sensor occlusion, detection-driven pursuit, hidden-target searching, independent uninterrupted tagging, pause and reset, fixed-step timing, seeded boosts, terrain continuity, patrol replacement and capped difficulty. Actual Fort Ross terrain is included in the continuous-travel and patrol-transition checks.

## Sources and game rules

See [ASSET_SOURCES.md](ASSET_SOURCES.md) for the exact branch revision, supplied model attributions, terrain conversion, coordinate conventions, and tower sites. The supplied interior geography and tower sites are retained. The outer 500 metres of the original square blend smoothly into generated river terrain so the old boundary becomes a navigable connection. The extension is game terrain, not surveyed Fort Ross geography. The two tower positions are the selected pair from the existing placement experiment, rather than a claim of globally optimal placement.

Gameplay runs locally in the browser and does not control or connect to the surveillance simulator. Boat physics, speeds and visible vehicle sizes are tuned for arcade play. All aircraft follow shared observations and search last-known locations; hidden boat movement cannot guide them. At base difficulty the drone's detected pursuit ceiling is 96 simulation metres/second, with lower patrol and search speeds, versus the boat's normal 60 and boosted limit of 99. Drones slow on approach to the boat. Detection raises their acceleration from 19 to 30 simulation metres/second² before loop difficulty is applied. The plane flies repeated surveillance passes at 100 and cannot tag. The source PDF's horizontal camera angles are used: towers 60°, quadcopters 114.6°, plane 69°. Aircraft cameras use their heading, a bounded range, and terrain line of sight. The source quadcopter's independent gimbal and vertical camera angles are not simulated.

Movement, radar sweeps and search run at **2× pace**. Survival score and boost duration measure real active seconds. Capture takes **two uninterrupted real seconds** inside the same 65-metre radius with clear line of sight, tracked separately for each drone; partial locks cannot transfer between them. Each new patrol clears prior locks and sightings, then begins observing after six simulation seconds (three active real seconds). Selected first-stretch tower positions, sensor ranges, line of sight and shoreline collision remain in effect. The plane's 1,100-metre sight range, pursuit speeds, two-drone fleet, tagging rule, boosts and repeating patrols are game adaptations; the PDF does not specify those values. This rule set uses the separate local-storage record `cant-catch-me-best-physics-loop-patrol-pace2`, leaving earlier records intact. Retry restores the starting terrain, original fleet, initial difficulty, boat momentum and score with a fresh pickup layout.

Terrain generation uses global coordinates, so neighbouring regions share a continuous surface. Rendering keeps only a **3×3 neighbourhood** of 6,500-metre terrain tiles around the boat and disposes of tiles left behind. The deterministic terrain function is shared by rendering, navigation, collision and the radar. The radar caches an oversized terrain image at 250-metre intervals while keeping the boat continuously centered. Only the pickup seed varies between browser runs; `createGame(world, seed)` permits reproducible engine tests.

`lib/game.ts` owns the deterministic game rules, boat physics, patrol transitions, continuous terrain sampler and seeded pickups. `components/Scene.tsx` renders the terrain neighbourhood, hull buoyancy, supplied fleet geometry, pickups and synchronized cameras; `components/Ocean.tsx` owns the sea and foam wake. `components/Game.tsx` owns menus, input and new-run seeds; `components/TowerWarning.tsx` presents live tower contacts, and `components/Radar.tsx` renders the boat-centered geographic minimap.
