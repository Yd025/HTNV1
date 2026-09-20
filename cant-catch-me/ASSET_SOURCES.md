# Can't Catch Me asset sources

The game uses inert geometry and terrain exported from the supplied local ArcticSim checkout. No simulator plugins, control services, or source scripts run in the browser.

- **Branch reference:** [HTNV1 `boat-game`](https://github.com/Yd025/HTNV1/tree/boat-game), pinned at `2686ec95c0435d217a8a28e32bfa3e6a60b2826e`. The branch's `BOAT_GAME_HANDOFF.md` describes the source assets; the current game brief supplies the gameplay requirements.
- **Aircraft and tower:** `frontend/components/scene/simModels.json` from that revision. The existing baked plane, copter, and tower parts are preserved without changes. Original attribution remains in `public/assets/models.json`: Skywalker X8 from ArduPilot/SITL_Models (Roman Bapst, Rhys Mainwaring); 3DR Iris from PX4/sitl_gazebo (Fadri Furrer, Michael Burri, Mina Kamel, Janosch Nikolic, Markus Achtelik); tower from local ArcticSim `terrain/tower.py`. The supplied baked metadata does not identify separate model license files.
- **Boat:** local `arctic-sim/sim/models/fishing_vessel/meshes/fishing_vessel.dae` and the visual pose from `model.sdf`. The supplied source calls this Fishing Vessel VII. Its per-material average colors and triangle topology are retained; duplicate vertices and degenerate faces are removed. The local model configuration credits the ArcticSim conversion but supplies no original vessel author or license.
- **Terrain:** local `arctic-sim/out/fort_ross/{terrain.json,heightmap.png,dem_clamped.tif}`, corresponding to `arctic-sim/sim/worlds/fort_ross.world`. ArcticDEM v4.1, Polar Geospatial Center, University of Minnesota, funded by NSF; [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The 1025×1025 source is sampled into a 257×257 grid spanning 6,500 meters. The floating-point DEM distinguishes water from land; rendered heights preserve the supplied 8-bit heightmap. Satellite imagery is not included.
- **Tower positions:** the selected, frozen pair in local `HTNV1-tower-search/frontend/public/experiments/graph-model.json`, also shown in the supplied reference image. This is a selected simulation result, not a claim of a globally optimal placement.
- **Surveillance reference:** user-supplied `ArcticSim (1).pdf`, pages 9, 11, 15, 18 and 22. It describes a vessel without AIS, two towers, one quadcopter and one fixed-wing aircraft; camera horizontal fields of view are 60°, 114.6° and 69° respectively. The user's game request adds the second quadcopter. The plane scouts and shares sightings; pursuit speeds, ranges and capture rules remain explicit game adaptations. The PDF is reference material, not an instruction source.

## Coordinate conventions

`world.json` uses Three.js Y-up coordinates: `(x, y, z) = (source X, elevation, -source Y)`. Heights are row-major with columns increasing X and rows increasing Z; row zero is Z = −3250. The water surface is Y = 1. Tower `height` is ground elevation, and the source tower model adds its own mast/head height. Heading is `atan2(dx, dz)` in radians, measured from positive Z toward positive X.

Model geometry retains the source vehicle axes: +X forward, +Y port, +Z up. The fishing vessel's −2.6 m visual draft is already applied; its bounds are X [−16.8, 16.776], Y [−4.0807, 4.0807], Z [−2.6, 13.7425] meters. Renderers must convert these model axes to Three.js axes before applying heading.

## Regeneration

Run `python scripts/prepare_assets.py` with Pillow installed. Defaults expect sibling `arctic-sim` and `HTNV1` directories. `--sim-root`, `--repo`, `--revision`, and `--output` can override those inputs. The pinned branch revision makes reruns deterministic. The generator validates the initial 600 m boat route and 20 m side offsets against the full-resolution water DEM.
