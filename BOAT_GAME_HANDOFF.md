# Boat game visual handoff

## Goal

Turn the existing WHITEOUT demonstration into a readable Arctic tracking game while preserving the real simulator, telemetry, and autonomy behavior. The moving vessel is the target. The fixed-wing UAV searches, towers cue, the quadcopter tracks, and the rover confirms when it is available.

The presentation should use one consistent, clean, low-poly style. It should not use Clash Royale, Tom and Jerry, or unrelated characters and themes.

Keep the label **“Stand-in arena · not Dominion terrain.”** until the supplied competition terrain and coordinate conventions are confirmed.

## Assets already supplied with ArcticSim

The repository already contains three complete simulation worlds:

| Map | World definition | Terrain source |
| --- | --- | --- |
| Resolute | `arctic-sim/sim/worlds/resolute.world` | `arctic-sim/sim/models/terrain_resolute/` |
| Pond Inlet | `arctic-sim/sim/worlds/pond_inlet.world` | `arctic-sim/sim/models/terrain_pond_inlet/` |
| Fort Ross | `arctic-sim/sim/worlds/fort_ross.world` | `arctic-sim/sim/models/terrain_fort_ross/` |

Each terrain contains:

- `heightmap.png` for ground elevation
- `albedo.png` for the supplied surface imagery
- `detail.png` for close-range surface detail
- `model.sdf` for dimensions, elevation, and material configuration

The supplied object models are:

- `arctic-sim/sim/models/fishing_vessel/`
- `arctic-sim/sim/models/ship/`
- `arctic-sim/sim/models/skywalker_x8/`
- `arctic-sim/sim/models/iris_with_standoffs/`
- `arctic-sim/sim/models/gimbal_small_2d/`
- `arctic-sim/sim/models/tower-1/`
- `arctic-sim/sim/models/tower-2/`
- `arctic-sim/sim/models/rover_core/`

The world files are the source of truth for the original object placement, vessel route, geographic origin, terrain orientation, and physical scale.

## Optional unified visual style

Use [Kenney’s Watercraft Kit](https://kenney.nl/assets/watercraft-kit) as the reference for a friendly low-poly presentation. It contains 45 optimized watercraft models and is released under CC0.

Reuse the shapes of the supplied simulator vehicles instead of inventing different platforms:

| Game object | Shape reference |
| --- | --- |
| Target boat | Supplied fishing vessel or a suitable Kenney motorboat |
| Fixed-wing UAV | Supplied Skywalker X8 |
| Quadcopter | Supplied 3DR Iris |
| Sensor tower | Supplied tripod mast and camera head |
| Rover | Supplied tracked rover |

Restyle display geometry with a shared palette rather than changing simulator physics or detection geometry:

- navy
- snow white
- safety orange
- ice blue
- charcoal

Use flat shading, low polygon counts, and slightly enlarged identifying details so every platform remains legible from the mission camera.

## Browser asset format

Convert display assets to GLB for React Three Fiber. GLB can contain meshes, materials, vertex colors, embedded textures, named nodes, pivots, and simple animations.

Recommended output structure:

```text
frontend/public/models/whiteout/
  arctic_map.glb
  target_boat.glb
  fixed_wing.glb
  quadcopter.glb
  sensor_tower.glb
  rover.glb
  scene-layout.json
```

Use these conventions for every moving model:

```text
Units: metres
Up axis: +Y
Forward: +Z
Origin: ground or water contact point
Materials: shared flat-color palette
```

Keep the terrain in one static `arctic_map.glb`. Keep the boat, aircraft, and rover separate because live telemetry controls their position and heading. Towers may be part of the static map, but their camera heads should remain separate if the interface animates their pointing direction.

## Water and terrain rendering

Water should be rendered at runtime as a lightweight Three.js surface rather than baked into the GLB. It can provide:

- slow blue-green wave motion
- directional highlights
- shallow and deep color variation
- foam near ice and shore
- a wake behind the moving vessel

Mountains, shoreline, icebergs, and rocks can be generated from lightweight geometry without paid generation services. Assign colors by height and slope:

```text
High, flatter faces  -> snow white
Steep faces          -> slate blue
Low shoreline        -> dark blue-gray
Ice edges            -> pale cyan
```

Flat shading and directional light make individual faces readable without large texture files. When the supplied terrain is used, preserve its heightmap and albedo instead of replacing its geography with invented terrain.

## Product behavior

The memorable feature is predictive sensor handoff:

1. A tower or aircraft detects the vessel.
2. The shared tracker predicts where the vessel is moving.
3. The system prepares the next observer before the current view is lost.
4. The interface distinguishes measured contact, predicted position, uncertainty, loss, and reacquisition.
5. A successful handoff is confirmed only by a fresh observation from the receiving sensor.

All displayed positions must continue to come from the existing `/ws/telemetry` stream. The visual layer must not invent contacts or become a second controller.

## Implementation boundary

Visual work belongs in the existing Next.js Pages Router frontend, primarily `frontend/components/TacticalScene.tsx` and its scene helpers. Preserve `frontend/lib/geo.ts`, the WebSocket transport, the `SimAdapter` boundary, and the deterministic 10 Hz control loop.

The first implementation should use one supplied ArcticSim world, its original placement data, the supplied fleet shapes, and runtime water. Additional scenery is presentation-only and must remain outside the operational assumptions used for scoring or control.
