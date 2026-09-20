# Can't Catch Me
<!-- impeccable:product-schema 1 -->

## Platform
web

## Stack
User requested Next.js and Three.js. React Three Fiber reuses the source project's rendering stack.

## Product Purpose
Pilot a boat through the supplied Fort Ross world and an endless connected river, evading two surveillance towers, two pursuing drones and a scouting plane on each stretch. Fresh patrols become harder downriver. Survival time is the score; there is no finish line or forced loss timer.

## Capabilities and Constraints
User accepted a standalone browser simulation, chase camera and radar minimap, two seconds of close drone proximity to end a run, WASD/arrow controls, shoreline collision, detection warnings, timer and retry. Saved tower sites are used as the green markers in the reference. This is a game, independent of operational surveillance telemetry. Retain the supplied interior geography, saved tower sites and fleet models; the outer boundary may blend into the generated river extension requested below.

The user subsequently requested shorter, more dynamic runs with a close first-person-style view, visibility of the drone shadow, and optional movement effects while retaining all rules and constraints. The implementation runs the existing simulation at 2× pace, keeps score and the uninterrupted two-second tag in real time, and adds an offset helm view with the original chase view available. Scores at different paces are stored separately.

## Evidence on Hand
HTNV1 boat-game branch handoff and baked fleet geometry; local ArcticSim Fort Ross world and terrain; saved tower-search experiment positions. Selected tower locations are best among tested candidates, not a proof of global optimality.

An earlier request replaced the water animation, fixed jitter in both cameras, made drones modestly faster and deployed a second drone plus the supplied plane. The ArcticSim PDF informs fleet roles and camera angles. Both drone locks remain independent, terrain blocks observations, and hidden boat movement cannot guide any pursuer. The boat and camera use the same render interpolation to remove their earlier timing mismatch.

The player must travel downriver: forward-only throttle, S/down as brake, steering bounded to 75° either side of the initial channel course, and no U-turns or backward progress. Bounded steering remains available while stopped. Personal bests for this rule set are stored separately.

The extended game includes flowing animated loading graphics, clearer game controls, random speed boosts and an endless connected map. The boat retains global coordinates as it moves into generated regions. The original square's outer 500 metres blend into the new river, while the interior and selected first-stretch tower locations remain intact. New terrain represents a game extension of the supplied world. A bounded 3×3 neighbourhood of 6,500-metre tiles follows the boat, using the same continuous terrain function for rendering and collision. The radar also follows the boat continuously, showing nearby terrain and the active patrol throughout the run.

The latest correction requires a fresh patrol on every loop. The first new patrol begins when the boat crosses the original square's boundary downriver; subsequent patrols begin every 6,500 metres of projected downriver progress. Each transition replaces the two towers, two drones and scout with a patrol positioned for the new stretch. Towers use the generated riverbanks and aircraft use terrain-derived routes. The active fleet remains bounded, while the boat's coordinates, traveled distance and score remain continuous. Previous sightings and locks clear, and each patrol gets a short grace period. Drone speeds rise by 3% per loop up to a 30% increase, and acceleration rises by 2% per loop up to 20%. A stretch counter and brief notice explain the change.

Live tower detection produces a small amber warning naming T1, T2, or both. It appears only for an actual tower observation, respects range, camera angle and terrain occlusion, and leaves the controls usable. Any current tower, drone or plane sighting makes drones accelerate harder and allows faster pursuit; last-known-position searching does not retain the detection surge. The base detected pursuit ceiling is 96 simulation metres/second, with drones slowing near the boat to maintain a tag attempt.

Boat movement uses arcade hydrodynamics: mass, engine thrust, linear and quadratic drag, gradual rudder and yaw response, momentum, turn-related speed loss and damped lateral slip. Braking stops the boat without reversing; the existing course bounds and shoreline collision still apply. Four water samples around the hull drive damped heave, pitch and roll. The model is tuned for responsive gameplay, not presented as a validated vessel simulator.

Orange pickups appear randomly on navigable water ahead. Collecting one grants four active real seconds of extra thrust and a 1.65× top-speed limit. Acceleration remains gradual and surplus speed decays through water drag after expiry. Braking remains available and pause freezes boost time. At most four pickups are active; pickups left behind expire. The first pickup lies near the starting course, and retry after capture creates a fresh random pickup seed while restoring the original fleet, initial difficulty, starting position and resting boat physics. The engine accepts an explicit seed for reproducible tests. Current runs use the separate personal-best key `cant-catch-me-best-physics-loop-patrol-pace2`; previous records remain intact.
