# Can't Catch Me
<!-- impeccable:product-schema 1 -->

## Platform
web

## Stack
User requested Next.js and Three.js. React Three Fiber reuses the source project's rendering stack.

## Product Purpose
Pilot a boat through the supplied Fort Ross world, escape two surveillance towers, two pursuing drones and a scouting plane, then continue along an endless connected river. Survival time is the score; there is no finish line or forced loss timer.

## Capabilities and Constraints
User accepted a standalone browser simulation, chase camera and radar minimap, two seconds of close drone proximity to end a run, WASD/arrow controls, shoreline collision, detection warnings, timer and retry. Saved tower sites are used as the green markers in the reference. This is a game, independent of operational surveillance telemetry. Retain the supplied interior geography, saved tower sites and fleet models; the outer boundary may blend into the generated river extension requested below.

The user subsequently requested shorter, more dynamic runs with a close first-person-style view, visibility of the drone shadow, and optional movement effects while retaining all rules and constraints. The implementation runs the existing simulation at 2× pace, keeps score and the uninterrupted two-second tag in real time, and adds an offset helm view with the original chase view available. Scores at different paces are stored separately.

## Evidence on Hand
HTNV1 boat-game branch handoff and baked fleet geometry; local ArcticSim Fort Ross world and terrain; saved tower-search experiment positions. Selected tower locations are best among tested candidates, not a proof of global optimality.

An earlier request replaced the water animation, fixed jitter in both cameras, made drones modestly faster and deployed a second drone plus the supplied plane. The ArcticSim PDF informs fleet roles and camera angles. Both drone locks remain independent, terrain blocks observations, and hidden boat movement cannot guide any pursuer. The boat and camera use the same render interpolation to remove their earlier timing mismatch.

The player must travel downriver: forward-only throttle, S/down as brake, steering bounded to 75° either side of the initial channel course, and no U-turns or backward progress. Bounded steering remains available while stopped. Personal bests for this rule set are stored separately.

The latest request adds flowing animated loading graphics, clearer game controls, random speed boosts and an endless connected map. The boat retains global coordinates as it moves into generated regions. The original square's outer 500 metres blend into the new river, while the interior and selected tower locations remain intact. New terrain represents a game extension of the supplied world. A bounded 3×3 neighbourhood of 6,500-metre tiles follows the boat, using the same continuous terrain function for rendering and collision.

Surveillance remains finite: the original two towers stay fixed, and the original two drones and scout stay inside their initial region. Leaving that region permanently clears shared sightings and drone locks for the run and returns the aircraft to patrol. Generated regions contain no duplicated towers or aircraft. Travel and the real-time survival score continue after escape.

Orange pickups appear randomly on navigable water ahead. Collecting one grants four active real seconds at 1.65× the normal boat top speed. Braking remains available and pause freezes boost time. At most four pickups are active; pickups left behind expire. The first pickup lies near the starting course, and retry after capture creates a fresh random pickup seed while restoring the original fleet and starting position. The engine accepts an explicit seed for reproducible tests. Endless boosted runs use the separate personal-best key `cant-catch-me-best-endless-boost-pace2`; previous records remain intact.
