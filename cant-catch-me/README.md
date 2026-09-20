# Can't Catch Me

A standalone Next.js + Three.js boat survival game set in the supplied Fort Ross terrain. Two towers and a scouting plane share sightings with two pursuing quadcopters. Stay within 65 metres of either drone for two uninterrupted seconds and the run ends; survival time is the score. There is no finish line or scripted capture deadline.

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

The game automatically pauses when its window loses focus. Personal bests are saved in this browser when local storage is available. Radar sectors indicate tower coverage. Orange D1/D2 marks the drones, cyan P1 is the scout plane, and the white arrow is your boat. Shorelines and the edge of the map stop the boat without ending the run. Brake and steer back toward the channel.

## Build and verify

```sh
npm test
npm run typecheck
npm run build
npm start
```

The deterministic engine tests cover collision, radar occlusion, hidden-target pursuit, uninterrupted tagging, pause, retry, fixed-step timing, and actual-map survival scenarios.

## Sources and game rules

See [ASSET_SOURCES.md](ASSET_SOURCES.md) for the exact branch revision, supplied model attributions, terrain conversion, coordinate conventions, and tower sites. The supplied geography is preserved. The two tower positions are the selected pair from the existing placement experiment, rather than a claim of globally optimal placement.

Gameplay runs locally in the browser and does not control or connect to the surveillance simulator. Speeds and visible vehicle sizes are deliberately exaggerated for playability. All aircraft follow shared observations and search last-known locations; hidden boat movement cannot guide them. The faster drones reach 84 simulation metres/second versus the boat's 60. The plane flies repeated surveillance passes at 100 and cannot tag. The source PDF's horizontal camera angles are used: towers 60°, quadcopters 114.6°, plane 69°. Aircraft cameras use their heading, a bounded range, and terrain line of sight. The source quadcopter's independent gimbal and vertical camera angles are not simulated.

Movement, radar sweeps, search and escalation run at **2× pace**. Survival score measures real active seconds. Capture takes **two uninterrupted real seconds** inside the same 65-metre radius, tracked separately for each drone; partial locks cannot transfer between them. Terrain, selected tower positions, existing tower/drone ranges, line of sight and collision rules are retained. The new plane's 1,100-metre sight range, pursuit speeds, two-drone fleet and tagging rule are game adaptations; the PDF does not specify those values. This fleet uses a separate personal-best record. Restart resets the same map for comparable runs.

`lib/game.ts` owns the deterministic game rules. `components/Scene.tsx` renders the supplied geometry and synchronized cameras; `components/Ocean.tsx` owns the sea and foam wake. `components/Game.tsx` owns menus and input; `components/Radar.tsx` renders the geographic minimap.
