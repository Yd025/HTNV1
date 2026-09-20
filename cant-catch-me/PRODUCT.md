# Can't Catch Me
<!-- impeccable:product-schema 1 -->

## Platform
web

## Stack
User requested Next.js and Three.js. React Three Fiber reuses the source project's rendering stack.

## Product Purpose
Pilot a boat through the supplied Fort Ross world and survive two surveillance towers, two pursuing drones and a scouting plane. Survival time is the score; there is no finish line or forced loss timer.

## Capabilities and Constraints
User accepted a standalone browser simulation, chase camera and radar minimap, two seconds of close drone proximity to end a run, WASD/arrow controls, shoreline collision, detection warnings, timer and retry. Saved tower sites are used as the green markers in the reference. This is a game, independent of operational surveillance telemetry. Use the supplied geography and fleet models.

The user subsequently requested shorter, more dynamic runs with a close first-person-style view, visibility of the drone shadow, and optional movement effects while retaining all rules and constraints. The implementation runs the existing simulation at 2× pace, keeps score and the uninterrupted two-second tag in real time, and adds an offset helm view with the original chase view available. Scores at different paces are stored separately.

## Evidence on Hand
HTNV1 boat-game branch handoff and baked fleet geometry; local ArcticSim Fort Ross world and terrain; saved tower-search experiment positions. Selected tower locations are best among tested candidates, not a proof of global optimality.

The latest user request replaces the water animation, fixes jitter in both cameras, makes drones modestly faster and deploys a second drone plus the supplied plane. The ArcticSim PDF informs fleet roles and camera angles. Both drone locks remain independent, terrain blocks observations, and hidden boat movement cannot guide any pursuer. The boat and camera use the same render interpolation to remove their earlier timing mismatch.

The player must travel downriver: forward-only throttle, S/down as brake, steering bounded to 75° either side of the initial channel course, and no U-turns or backward progress. Bounded steering remains available while stopped. Personal bests for this rule set are stored separately.
