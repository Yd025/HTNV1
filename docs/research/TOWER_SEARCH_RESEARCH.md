# Tower placement, confirmed detection, and drone tracking

Research and implementation revision: September 19, 2026.

## Current mission and PDF interpretation

The supplied ArcticSim slides specify two fixed sensor towers, one quadcopter and one fixed-wing aircraft (page 11), a moving vessel without AIS (page 9), camera fields of view (page 18), and a geographic track submission interface (page 24). They do not require a tower-first strategy or promise that the two towers cover every random boat spawn. The user selected the following architecture: place towers before the mission, acquire and confirm a moving boat with tower imagery, dispatch both aircraft, and maintain the track from aircraft observations when tower visibility ends.

"Best placement" means the best validated candidate among legal terrain sites and tested vessel/condition distributions. It is not a proof of a global optimum. A strict tower-first mission can miss boats that never cross observable water; those misses must remain in evaluation.

## Research basis and engineering decisions

- **Separate sensing, assignment, and motion.** Zhang et al. decompose cooperative coverage and tracking into information fusion, task assignment, and vehicle decisions. Their use of detection probability and information-based tracking rewards motivates scoring useful observations rather than map coverage alone. This implementation uses a smaller, explicit state machine and numerical placement search, not their complete algorithm. [Primary paper](https://arxiv.org/abs/2303.09003).
- **Verify the receiving sensor.** PATH studies geometry-assisted target handoff and receiver verification, and identifies relative-pose uncertainty as a major projection-error source. Here a dispatch command, command acknowledgement, or proximity to an estimated point never proves visual custody: a fresh accepted aircraft observation does. [Primary paper](https://arxiv.org/abs/2609.12456).
- **Train perception on maritime imagery.** SeaDronesSee provides maritime visual detection and tracking benchmarks. It is a relevant evaluation source, not evidence that a detector already works in ArcticSim or Arctic field conditions. Partition video by sequence/site rather than randomly splitting adjacent frames. [Dataset authors](https://seadronessee.cs.uni-tuebingen.de/).
- **Use a deployable detector independently of the planner.** The optional Ultralytics path loads explicitly supplied local weights and uses class names, bounding boxes and confidence. Its separate training and validation entry points follow the supported model APIs. No field-trained model or dataset is bundled. [Prediction](https://docs.ultralytics.com/modes/predict/), [training](https://docs.ultralytics.com/modes/train/), [validation](https://docs.ultralytics.com/modes/val/).

## Implemented mission contract

1. **Place and freeze:** compare legal tower sites with terrain occlusion and camera geometry, select on validation missions, then freeze before untouched tests. Detection and post-cue aircraft custody are evaluated for the complete mission.
2. **Watch and confirm:** repeated fresh, spatially consistent tower measurements establish a cue. Cached camera frames, outliers, and drone-only sightings do not unlock the tower-first response.
3. **Dispatch:** the quadcopter moves to maintain a useful close view; the fixed-wing supports forward observation and reacquisition. Routes use observation-derived position and velocity, never the hidden boat coordinates.
4. **Transfer custody:** only fresh accepted aircraft detections confirm the receiver. Tower loss alone does not stop an aircraft with fresh observations.
5. **Handle gaps honestly:** predict for a bounded interval with increasing uncertainty, attempt reacquisition, and expire the contact when evidence is too old. Predictions are not new measurements.

The offline graph experiment and runtime C2 enforce this sequence through separate environment adapters. The graph experiment uses projected terrain XY; the live controller uses geographic observations. Their results are not interchangeable, and an offline learned tower pair does not automatically relocate physical or live-simulator towers.

## What learns, and what must be calibrated

Placement/motion training learns a sparse boat-motion model and evaluates candidate fixed tower sites under explicit camera and environment assumptions. The synthetic camera model varies detectability with viewing geometry, apparent target size, distance and conditions; location error is also variable. These assumptions are a sensitivity-testing model, not measured hardware performance.

Image-detector training is a separate supervised task: local labeled vessel imagery and explicit local initial weights produce candidate detector weights, which must be validated on held-out sequences. The repository supplies the execution path, not a claim that this training was completed without data. Conventional target filtering, geometric projection and the bounded mission state machine do not need to be neural networks.

Prioritize confirmed tower acquisition, receiver-confirmed handoff, continued aircraft custody outside tower view, time to acquire, localization error, false confirmations, losses and reacquisition. Ground truth is allowed only for synthetic observation generation, training labels and evaluation; it is not a deployed planner or controller input. Save sample counts/denominators and null results when a metric has no qualifying samples.

## Real sensor scope

The supplied simulator documents cameras, not working radar, lidar or sonar feeds. The implementation consumes camera evidence; it does not synthesize additional sensor feeds and label them real. Radar and visible/thermal camera fusion is a plausible surface-vessel extension, subject to hardware, calibration and field evaluation. Marine radar needs sea/weather clutter processing ([Furuno](https://www.furuno.com/en/technology/radar/display/index.html)); thermal cameras still lose range in rain/fog ([FLIR](https://www.flir.com/discover/rd-science/can-thermal-imaging-see-through-fog-and-rain/)); sonar requires suitable underwater acoustic sensing ([NOAA](https://oceanservice.noaa.gov/facts/sonar.html)).

Before claiming field readiness, measure real detector precision/recall by range and weather, synchronize camera/pose timestamps, calibrate optical orientation and sea-relative camera height, verify transport and battery/flight constraints, and test repeated handoff/loss scenarios with the actual fleet.

### Verified aircraft camera mounts and pointing

The inspected quad camera points **20 degrees below body forward**. The nested mount has roll `1.9199` in [`iris_with_ardupilot/model.sdf`](../../../arctic-sim/sim/models/iris_with_ardupilot/model.sdf#L10); its accompanying rotation-composition comment explicitly derives elevation −20 degrees and unchanged azimuth. Its mounting joint is `type="fixed"` at line 31. The camera's [`tilt_joint`](../../../arctic-sim/sim/models/gimbal_small_2d/model.sdf#L168) is also fixed; that source explains there is no actuator and the airframe plugin drives only four rotor channels. `MNT1_TYPE=0` in [`copter.parm`](../../../arctic-sim/sitl/params/copter.parm#L519) matches that implementation. Mentions of a ROS `gimbal_bridge` and `/set_joint_trajectory` in old comments do not establish a working control interface: no corresponding plugin is present in the inspected model.

The live camera catalog therefore uses a −20-degree fixed mounting bias. Projection rotates the camera ray into body coordinates **before** applying measured body roll, pitch, and yaw; simply adding mounting pitch to body pitch would misproject a banked aircraft. At level attitude, the image center intersects a flat water plane at horizontal distance `camera_height_above_water / tan(20 degrees)`. This supports a viewing standoff instead of hovering directly above the vessel. The fixed-wing camera is independently mounted **8 degrees downward**, with the sensor pose and explanation in [`skywalker_x8/model.sdf`](../../../arctic-sim/sim/models/skywalker_x8/model.sdf#L198).

Steering the quad view in this checkout requires vehicle yaw, not an invented gimbal command. ArduPilot documents guided position-plus-yaw targets and `MAV_CMD_CONDITION_YAW` for Copter. Position and heading commands remain separate from visual confirmation: camera projection uses measured attitude, and only fresh receiver detections establish custody. [Official Copter guided command interface](https://ardupilot.org/dev/docs/copter-commands-in-guided-mode.html). ArduPlane has a different command contract: its global position-target message accepts altitude, while geographic navigation uses its supported movement commands. [Official Plane guided command interface](https://ardupilot.org/dev/docs/plane-commands-in-guided-mode.html).

The offline graph experiment now also uses the source-derived fixed quad mount (approximately −20 degrees), body yaw limited to 45 degrees per second toward the observation-derived estimate, and a viewing standoff derived from sea-relative height. Its multirotor translation is independent of yaw; it does not steer an independent gimbal. The plane retains its source-derived fixed mount (approximately −8 degrees). Offline roll and pitch remain level, aircraft dynamics are simplified, and tower slew is approximate. Matching these mounting constraints does not validate the synthetic detector or establish live flight performance.

## Historical first-detection experiment

The following records earlier work for reproducibility. Its first-hit objectives, permissive independent drone search, ideal sensor assumptions and historical scores do not describe the current tower-first mission.

## Goal and recommended approach

**Find a reproducible two-tower placement and coordinated vehicle search policy that detects previously unseen boat scenarios faster, without increasing missed detections.** Repeated simulation episodes should improve the saved configuration, and a held-out benchmark should show whether that improvement generalizes.

The problem has three distinct decisions:

1. **Placement:** where the two fixed towers stand before the boat spawns, and how their cameras scan.
2. **Search:** which areas each vehicle observes while the boat's location is unknown.
3. **Navigation:** how a vehicle reaches its next observation location efficiently.

A* and BFS address the third decision. They cannot alone optimize tower locations or decide where an unseen boat is likely to be. Maritime search practice instead combines a probability distribution over target locations with movement and detection models. The US Coast Guard's SAROPS uses simulated particles, environmental drift, previous-search information, and resource allocation that maximizes success probability. This motivates the architecture, without implying that this prototype reproduces SAROPS. [USCG SAROPS](https://www.dcms.uscg.mil/Our-Organization/Assistant-Commandant-for-Acquisitions-CG-9/International-Acquisition/SAROPS/)

For this project's first version, use a small numerical optimizer and transparent search policies. A language model can explain results or suggest bounded experiment configurations outside the control loop. A neural policy trained through reinforcement learning is a later experiment if it adds measurable value across changing maps and conditions. Neither a language model nor a neural policy guarantees the globally best placement.

## What v1 does, and what it does not establish

The implementation scope accompanying this research is:

- Offline, seeded first-detection trials that reuse the existing `TargetSim`, `KinematicCraft`, and field-of-view sensor primitives.
- A systematic sweep baseline compared with a `belief_greedy` search policy.
- Candidate tower pairs generated by random search and coordinate mutations around the incumbent configuration.
- Disjoint training, validation, and test scenarios, with identical scenario seeds when comparing configurations.
- A saved policy that can be explicitly opted into in the local stand-in only.

This is **simulation-based policy optimization**, not LLM training. The v1 optimizer is random plus incumbent mutation search; it is not exhaustive enumeration, CMA-ES, PPO, or a proof of a continuous global optimum. Saved parameters represent experience accumulated from evaluated trials. Do not describe that artifact as a trained language model.

The actual v1 methods are implemented in [`search_policy.py`](../../backend/search_policy.py), [`search_experiment.py`](../../backend/search_experiment.py), and [`train_search.py`](../../backend/train_search.py):

- **Systematic sweep:** construct a serpentine route through grid-cell centers, partition it into disjoint contiguous parts roughly proportional to vehicle speed times sensor half-width, and start each vehicle near its closest assigned route cell. Towers rotate through a fixed scan period with their saved initial headings as phase offsets.
- **Belief-greedy search:** begin with a uniform grid; apply a mild, mass-preserving nearest-neighbor motion approximation with reflecting boundaries; then downweight cells in each sampled sensor FOV following a miss. Independent overlapping sensor misses compound in this synthetic model. Rank unreserved waypoint cells by visible belief mass divided by estimated transit time plus six seconds. Reconsider a goal on arrival or after 15 seconds. Complete belief exclusion resets to uniform exploration. This coarse heuristic neither estimates the boat's exact velocity nor solves an optimal search policy.
- **Placement proposals:** every third proposal resamples both positions across the inner 90% of the arena; other proposals perturb the incumbent coordinates using Gaussian offsets. Initial tower headings are also perturbed. Tower range and FOV remain fixed throughout ordinary training. Candidate sensor locations must be in bounds and at least 50 m apart.
- **Promotion:** retain the best training candidate per search algorithm, compare finalists on validation episodes, and select a configuration whose validation miss rate is no worse than the reference. Restricted mean time is the leading objective, followed by miss rate and distance for exact ties. On resume, the previous incumbent is included. Selection freezes before test scoring; the test set does not choose the policy. Resumed rounds retain training/validation scenarios and generate fresh test seeds, so repeated validation can still overfit.

Scenario generation samples starting positions within the inner 80% of the square, headings across 360 degrees, speeds from 2 to 10 m/s, and spawn delays from 0 to 20 seconds. Profiles cycle through straight, weave, and stop-and-go motion. Boats reflect within the inner 85% of the square. The weave preserves its sampled initial direction and reflects its curvature at boundaries rather than becoming trapped at a corner. This is a synthetic prior, not a water mask or a measured shipping distribution.

The fast benchmark evaluates the local movement and idealized geometric sensor model. It does not run the full camera detector, geographic projection, target tracker, command transport, or official scoring system. A first synthetic field-of-view hit is therefore a different event from a confirmed camera-backed boat detection. Reusing primitives reduces drift from the local simulator but does not make the benchmark a complete end-to-end mission evaluation.

The offline evaluator adds independent sampled misses using the saved detection-probability parameter and uses common per-sensor random draws for paired policies. The opt-in local simulator uses the saved observation cadence and miss probability; its ordinary scripted spawn is not an exact replay of randomized benchmark episodes. Sensor observation cadence and the recorded integration timestep are part of the experiment definition; do not compare different timestep settings as if the sensing opportunities were identical. Ablations rerun the selected placement with disabled sensors removed from both scoring and planning; they are not separately optimized tower-only or vehicle-only policies.

The opt-in local policy is not permission to rewrite the running ArcticSim site, reposition its towers, reset its vessel, or enable a second fleet controller. Promotion into the real adapter requires the validation stages below.

## Grounding in the actual simulator

Two different environments must remain explicit:

| Property | Local stand-in | Inspected ArcticSim checkout |
| --- | --- | --- |
| Arena | Flat 3 km square by default; local north/east geometry | Fort Ross site recorded at 6,500 m extent; terrain uses a polar projected grid |
| Towers | Two virtual mounts; defaults in `TowerMount` are 600 m range and 40-degree FOV | Recorded camera far clip is 1,500 m; horizontal FOV 1.047 rad, approximately 60 degrees |
| Detection | Ideal geometric field-of-view hit with synthetic target position | Image processing must detect a rendered boat and convert image evidence using sensor calibration |
| Motion | `KinematicCraft` moves toward commanded points; simplified dynamics | ArduPilot/MAVLink assets with actual camera and control behavior |
| Terrain effects | The base sensor primitive has no terrain line-of-sight test | Shorelines, terrain visibility, camera clipping, and pose can affect observations |
| Target truth | Available inside the simulator/evaluator | Gazebo vessel pose is hidden state, not camera evidence |

Local code references: [`target.py`](../../backend/sim/target.py), [`local_sitl.py`](../../backend/sim/local_sitl.py), and [`types.py`](../../backend/sim/types.py). The ArcticSim facts were recorded in the existing workspace's `northstar/SIMULATOR.md`, inspected September 19, 2026, and are also reflected in the team's [simulator handoff](../team/04-simulator-autonomy.md). They describe that inspected checkout, not every competition image.

That evidence log identifies these upstream source locations:

- `terrain/tower.py:159-166`: tower resolution 1280 by 720, nominal camera frequency 10 Hz, FOV and clipping. Nominal frequency is not measured delivered FPS. **A far clip is an upper rendering limit, not guaranteed detection range.**
- `terrain/tower.py:186-236` and `sitl/params/tower.parm:31-39`: tower pan/tilt implementation. Command semantics, acknowledgements, and actual head pose still require live verification.
- `sim/models/gimbal_small_2d/model.sdf:168,193`: fixed copter gimbal joints; vehicle movement/orientation is needed to steer the view in that checkout.
- `terrain/make_world.py:335-379`: EPSG:3413 grid conversion and optional true-scale correction. Do not relabel world XY as true east/north or apply convergence twice.
- `sim/plugins/CameraStreamPlugin.cc:259-292`: a JPEG can be cached and the multipart stream has no capture timestamp or camera pose. Receipt time is approximate; an HTTP response does not prove a fresh frame.
- `control/server.py:1068-1137`: the recorded control surface did not implement a detector, autonomous search controller, `/api/tracks`, or a scoring endpoint. Official submission and score weights remain separate verification items.

The earlier notes also record a camera fog issue and a visual-only infrared housing. Neither implies access to a working thermal detector. The exact terrain, permitted tower sites, vessel spawn/reset interface, detector sensitivity, and organizer scoring contract must be established before calling a placement the best for ArcticSim.

## Correcting the maze-algorithm comparison

Let `V` denote graph cells or vertices and `E` traversable edges. Memory below is auxiliary algorithm memory; storing the map can separately require `O(V+E)`. Guarantees concern the graph and costs actually supplied, not an unknown moving target.

| Algorithm | Category | Shortest-path guarantee? | Typical auxiliary memory | Appropriate use here |
| --- | --- | --- | --- | --- |
| Wall follower / right-hand rule | Local boundary following | No; escape depends on maze connectivity and entry/exit assumptions | Constant local state | Weak reactive baseline; not an open-water placement optimizer |
| Trémaux / marked depth-first exploration | Local exploration with remembered edges | No shortest route; systematic exploration needs reachable finite maze and correct marks | `O(E)` marks; implementations may also keep an `O(V)` stack | Exploration baseline, not fastest boat discovery |
| Pledge | Local obstacle escape with preferred heading | No shortest route or minimum detection time | Constant number of counters and heading variables | Obstacle escape; not a policy for locating arbitrary interior targets |
| BFS | Global graph search | Fewest edges when every edge has equal cost | `O(V)` queue, distance and predecessor state | Unit-cost grid routing |
| Distance-field flood fill | Global propagation from a goal | Yes when implemented as correct unit-cost distance propagation on the known graph; generic filling alone has no such guarantee | `O(V)` distance map and frontier | Routing to known search waypoints; a reusable distance map |
| Dijkstra | Global weighted graph search | Minimum total cost for nonnegative edge costs | `O(V)` with an indexed heap; a lazy duplicate heap can use `O(E)` entries | Travel-time routing with terrain or turn costs represented in the state/edges |
| A* | Global heuristic graph search | Minimum cost with an admissible heuristic and correct reopening; a consistent heuristic supports closed-set use without reopening | Generally `O(V)` records; duplicate priority-queue entries can increase storage | Faster route planning to a chosen observation location |
| D* Lite | Incremental heuristic graph search | Shortest-path properties under its graph/cost assumptions | Per-state records and a priority queue, generally scaling with the represented graph | Consider if changing obstacles make repeated A* expensive |

BFS's exact guarantee is fewest edges, with `O(V+E)` traversal time. [MIT 6.006 notes](https://www.ocw.mit.edu/courses/6-006-introduction-to-algorithms-fall-2011/1208e162775f6f5cedfbb9f2b694ede0_MIT6_006F11_lec13.pdf) Weighted shortest-path methods have different assumptions: [Dijkstra's original paper](https://research.tue.nl/en/publications/a-note-on-two-problems-in-connexion-with-graphs/) and [Hart, Nilsson and Raphael's A* paper](https://people.stfx.ca/jdelamer/courses/csci-564/_downloads/b2220c66675ddde471ca1795147b8e86/A_Formal_Basis_for_the_Heuristic_Determination_of_Minimum_Cost_Paths.pdf). D* Lite reuses earlier search work for related planning problems. [Koenig and Likhachev, 2002](https://publications.ri.cmu.edu/d-lite)

The local movement primitive currently follows straight-line waypoint commands. Listing A* here is a researched extension, not a claim that v1 uses it. If a fixed-wing aircraft needs turn radius or heading-dependent costs, represent heading/dynamics in planning; a shortest XY grid route is not necessarily executable or fastest.

## Placement methods and their guarantees

### Finite pair enumeration: a useful later reference

With `M` legal candidate sites, two indistinguishable towers have `M(M-1)/2` distinct pairs. For 200 sites, that is 19,900 pairs. If each sensor's scan policy is fixed and target scenarios are predetermined, precompute its first-detection time per scenario; the pair's detection time is the earlier of the two. A fixed independent vehicle patrol can contribute another precomputed detection time.

This gives an exact minimum **over the enumerated sites, supplied scenarios, and fixed sensing/patrol assumptions**. It does not prove a continuous optimum, performance on unseen boats, or the optimum of a coupled adaptive fleet. If moving a tower changes vehicle decisions, evaluate that coupled episode rather than reusing an incompatible patrol time.

Scenario-based sensor placement research shows that certain detection-time reduction and detection-likelihood objectives have diminishing returns. That enables greedy approximation guarantees under the stated model. Those bounds concern the defined benefit objective, not an arbitrary percentage improvement in raw detection time. [Krause et al., 2008](https://www.cs.cmu.edu/~jure/pubs/bwsn-jwrpm08.pdf)

### Continuous coordinates and scan parameters

V1 uses random candidate pairs plus bounded coordinate mutations around the best observed configuration. This is a useful inexpensive starting point, but it can settle in a local region and is sensitive to the sampled training scenarios. Random restarts, a coarse spatial grid, and eventually finite pair enumeration are informative comparisons.

CMA-ES is a possible later optimizer for continuous coordinates and scan parameters. It adapts a sampling distribution for nonlinear, nonconvex optimization; it is not a global-optimality certificate. Do not label v1 mutation search CMA-ES. [Hansen's CMA-ES tutorial](https://arxiv.org/abs/1604.00772)

Ship-sensor placement research explicitly distinguishes a desired no-missed-target objective from a tractable submodular approximation, while modeling uncertainty in target arrivals. That is a useful reminder that a good coverage surrogate may differ from the final detection objective. [Kim et al., 2023](https://arxiv.org/abs/2307.04634)

Tower locations should be optimized together with realistic observation behavior: viewing direction, sweep rate, settling time, revisit interval, visibility, and probability of detection. Two large overlapping circles are not an adequate model of two narrow cameras scanning terrain.

## Searching without revealing the boat

Maintain a belief distribution `b_t(x)` over plausible target locations. A fuller model predicts motion with a transition model:

```text
predicted_belief[x] = sum(previous_belief[y] * transition_probability[y -> x])
posterior_after_no_detection[x] proportional to predicted_belief[x] * (1 - P_detect[x, action])
```

Normalize after the update. A joint update for multiple sensors needs an explicit joint observation model; multiplying independent miss probabilities is justified only when conditional independence is reasonable. Shared fog, occlusion, or repeated frames can violate that assumption.

Choose a feasible observation action using expected detection benefit relative to travel and observation time. Coordinate reservations or marginal gains so vehicles do not all inspect the same region. Replan on a short horizon. Search the predicted uncertainty region after loss of contact; before first detection, preserve broad exploration so an imperfect prior does not permanently exclude the boat.

This is an engineering proposal informed by multi-robot search research. Hollinger and colleagues study a moving, non-adversarial target, finite-horizon planning, coordination, and Bayesian observation updates. Their theoretical results depend on their problem formulation and do not automatically apply to this project's `belief_greedy` heuristic. [Efficient Multi-Robot Search for a Moving Target, 2009](https://publications.ri.cmu.edu/efficient-multi-robot-search-for-a-moving-target)

V1's coarse belief heuristic should be described by its actual update implementation. It is not automatically a calibrated Bayesian filter or a solved POMDP. Under a geometric synthetic detector, negative observations can use the known ideal FOV. For actual cameras, reduce belief only when a fresh frame was processed with adequate sensitivity and visibility. An offline frame, blank view, or unseen side of a hill does not demonstrate absence.

Keep hidden target position inside the scenario simulator and evaluator. The placement optimizer may consume episode-level scores; the online search policy receives only permitted observations and its own fleet state. Do not pass boat truth or future trajectory into `belief_greedy`, the LLM adviser, or the deployed controller. Candidate selection must precede the held-out target spawn.

## Where a small model can help

The useful immediate learning loop is: propose configuration, run many episodes, measure outcomes, preserve better configurations, and repeat. It requires no language-model weights or model API.

A small neural policy becomes worth testing if one saved coordinate pair cannot adapt across sites, sensors, weather, or fleet availability. Define observations as the map, fleet state, target belief, and valid-action mask; actions as feasible sites or observation waypoints; rewards as elapsed-time cost plus a detected-target reward and declared miss penalty. Train offline, compare against the same baselines, and deploy only if held-out results justify the complexity. PPO is one established method that actually updates policy parameters from environment interaction. Its original benchmark results do not predict this project's performance. [Schulman et al., 2017](https://arxiv.org/abs/1707.06347)

An optional language model can translate a user's preferences into validated experiment settings, summarize failure cases, or propose among already feasible high-level actions. Preserve the existing slow adviser boundary and deterministic fleet controller. Natural-language reasoning is not evidence that a tower pair is optimal; measured, reproducible episodes provide that evidence.

## Benchmark design and measurable stages

Let `T` be seconds from target spawn to first detection and `H` the episode deadline. Define a missed episode as `T > H`, with infinite `T` when no detection occurs. The primary time metric is restricted mean detection time:

```text
restricted_mean_time = mean(min(T, H))
miss_rate = count(T > H) / episode_count
```

Always report both. Averaging only successful episodes can reward a policy for abandoning difficult boats. An optional optimization score can add a declared miss penalty, but publish its units and weight and retain the raw metrics. A capped time is not an observed detection time. If more than 5% of boats remain undetected at the deadline, report the uncensored P95 as unavailable or beyond the observation window rather than treating the deadline as a measured detection.

For the full system also record probability detected by selected deadlines, first sensor, confirmed-detection latency, false alarms, traveled distance, duplicate coverage, inference/control latency, track gaps, and tracking error where legitimate reference truth exists. Differentiate simulation seconds from wall-clock training/runtime cost. The fastest optimizer computation and the fastest simulated detection are separate results.

| Stage | Deliverable | Measurable completion condition |
| --- | --- | --- |
| 1. Reproducible local experiment | Seeded scenarios, baseline, candidate search, report, saved local policy | Same seed and configuration reproduce results; train/validation/test episode IDs are disjoint; no truth enters policy decisions; failure episodes remain in metrics |
| 2. Credible local improvement | Frozen winner compared with frozen baseline on untouched test episodes | Proposed target: at least 10% lower restricted mean time, observed miss rate no higher, and a paired episode-bootstrap 95% interval for seconds saved (baseline minus candidate) above zero; report uncertainty in success-rate difference as well |
| 3. Real sensor and geometry validation | Calibrated camera evidence and legal-site map | Fresh-frame provenance, head pose, optical projection, visibility and command outcomes pass the checks below; no hidden target state substitutes for observations |
| 4. ArcticSim validation | Same scenario conditions, baseline and candidate, actual detector and control path | Improved confirmed-detection time without a measured miss-rate regression; report all episodes and uncertainty, tracking/coverage tradeoffs, simulator revision, and settings |

The 10% target is a proposed project acceptance criterion, not an achieved result or organizer requirement. Fix acceptance criteria and episode budgets before viewing the final test results. A practical starting budget is hundreds of training scenarios and a larger untouched test batch when runtime permits; choose the final count from desired uncertainty and measured episode cost. If intervals are inconclusive, call the outcome inconclusive rather than selecting a favorable subset.

Use paired seeds for comparisons, but keep train, validation, and test seed sets distinct. Vary starts, headings, speeds, and motion profiles. Later stress tests should cover sensor failures, delayed frames, map/visibility changes, and a shifted spawn distribution. Hold out entire episodes; neighboring frames of the same run are not independent test scenarios. Do not repeatedly tune on the test set.

Compare the current fixed towers plus systematic sweep, random tower placement plus sweep, optimized towers plus sweep, and optimized towers plus `belief_greedy`. Tower-only and vehicle-only ablations help show whether collaboration contributes. Greedy weighted coverage, exhaustive pair enumeration, and PPO are future comparisons unless implemented and measured explicitly.

## Gate before using results in the real Arctic simulation

1. **Verify legal geometry and placement.** Record ArcticSim revision, site, extent, projection convergence/scale, land/water mask, tower mount restrictions, and map source. Check coordinate round trips and landmark projections. A synthetic point within the square is not automatically a legal real tower site.
2. **Verify camera behavior.** Check head pan/tilt against visible image motion; record FOV, clipping, delivered frame rate, settling time, and pose convention. Confirm what happens during rapid turns and cached frames. Do not use the 1,500 m clip as measured detection range.
3. **Measure actual detection.** Assemble held-out visible-boat and empty-water/shoreline samples across range and pose. Record misses and false alarms, and estimate usable detection sensitivity. Measure first raw candidate and first confirmed observation separately. Test terrain occlusion and the prescribed fog configuration.
4. **Verify timing and projection.** Use sea-level camera height and explicit optical/body/world rotations. Record receipt time when capture time is unavailable; bound queue age and pose mismatch. Deduplicate frames/observations. Reject unreliable projection rather than silently producing precise coordinates.
5. **Verify one controller and observed effects.** Use the existing `SimAdapter` boundary. Record command acknowledgement and the actual resulting camera/vehicle observation; an acknowledgement alone is not successful acquisition. Keep the fast control loop free of model API calls and image-processing stalls.
6. **Run the actual closed-loop benchmark.** Establish the permitted spawn/reset mechanism, then compare baseline and candidate on the same episode conditions with fresh camera detections and the existing tracking path. Evaluate with isolated permitted reference truth or annotated camera evidence. If world truth is unavailable, leave geographic error unavailable.
7. **Promote with a recorded configuration.** Save sensor calibration, map/site identity, policy version, seed manifest, objective, complete episode outcomes, and uncertainty. Keep the prior configuration available. Do not claim compliance with an undocumented official score or submission endpoint.

These are validation requirements arising from the known model gap, not evidence that any external action has already been performed. Existing related work: [tracking research](TRACKING_RESEARCH.md), [evaluation plan](EVALUATION.md), and [shared integration contract](../team/CONTRACT.md).

## Measured results

Verified local run: September 19, 2026, source commit `f6ddaadfbe092f5434f10eb260e9b6941d276d79`. The experiment fingerprints its source before evaluation and refuses to save if those files change during the run. A repeat run reproduced the same placements and episode outcomes.

```powershell
# From backend/, no external model or simulator required.
python -B train_search.py --candidates 32 --train 32 --validation 48 --test 160 --horizon 180 --output ../runs/tower-search-verified
```

Seed `2026`; 32 training scenarios, 48 validation scenarios, and 160 untouched test scenarios; three boat-motion profiles, random starts/headings/speeds, 0–20 second spawn delay. One-second observation/integration interval, 180-second deadline after spawn, 0.9 independent detection probability per in-FOV source/sample. Two towers use 600 m range, 40-degree horizontal FOV and 60-second full rotations. The mobile fleet includes the local plane, copter and rover; the documented live four-asset ArcticSim roster has no rover. There are 32 new candidates per algorithm plus its initial placement, totaling 3,056 evaluated episodes including validation, test and sensor ablations.

Validation selected **optimized systematic sweep** before test evaluation. The probability-guided heuristic did not win this experiment. The baseline is the newly defined systematic sweep at the old tower locations, not a claim about the unmodified live controller.

| Policy, all on identical 160 test scenarios | Restricted mean detection time | Detected by 180 s | Miss rate | Mean fleet distance to detection/deadline |
| --- | ---: | ---: | ---: | ---: |
| Original tower locations + systematic sweep | 121.45 s | 48.75% | 51.25% | 5,380.93 m |
| Optimized locations + systematic sweep — selected on validation | **98.82 s** | **62.50%** | **37.50%** | **4,456.02 m** |
| Optimized locations + probability-guided search | 117.83 s | 54.38% | 45.63% | 5,235.75 m |
| Selected layout, towers only | 106.82 s | 56.25% | 43.75% | 0 m |
| Selected layout, vehicles only | 160.83 s | 19.38% | 80.63% | 6,988.27 m |

The selected pair saves **22.63 s (18.63%)** in restricted mean detection time. The paired episode-bootstrap 95% interval for seconds saved is **4.84–39.28 s**. Detection success increases by **13.75 percentage points**, with a paired 95% interval of **1.25–26.25 points**. These intervals are conditional on this synthetic scenario and sensor model. The selected policy still misses 60 of 160 boats; its capped P90 equals the deadline, and uncensored P90 detection time cannot be established. This is a useful measured local improvement, not a reliable real-world detection system or a global optimum.

Selected tower positions in **metres north/east of the local stand-in origin** (`74.6973, -94.8297`):

| Preserved tower ID | North | East | Initial scan heading |
| --- | ---: | ---: | ---: |
| `tower-ne` | -233.12 m | +461.70 m | 304.75 degrees |
| `tower-sw` | +627.99 m | -612.18 m | 279.50 degrees |

The IDs preserve compatibility and no longer describe the positions. Do not transfer these metre offsets or geographic coordinates into Fort Ross without the terrain/visibility validation above.

The [complete benchmark evidence](tower-search-benchmark.json) includes all candidate policies, scenario seeds, per-episode results, uncertainty and source fingerprint. The [saved local policy](example-search-policy.json) is directly usable through `SEARCH_POLICY_FILE=../docs/research/example-search-policy.json` from `backend/`. [README instructions](../../README.md#learn-two-tower-placement-and-search) cover further training, resuming and local preview. `--resume` uses the selected policy embedded in the canonical latest report, reevaluates candidates, preserves round reports, and chooses a fresh test seed range.

Camera-backed ArcticSim improvement: **not measured**. Live relocation/reset/training has not been enabled, and no language-model weights were trained. The small optimizer improves a configuration through simulation; an LLM adviser remains an optional future interface to this evidence.

## Branch comparison and integration

At fetch time, `origin/main` was `ad8e302` and `codex/backend` was `79d9147`, with common ancestor `bf5b64a`. Main had five unique commits covering live flight behavior, tower scanning/camera streams and tower-to-copter handoff. Backend had four unique commits covering the dashboard, telemetry reliability, bounded recording/replay and simulator integration.

The local `main` reference was fast-forwarded. Both histories were combined on **`codex/tower-search`**, in the separate `HTNV1-tower-search` worktree. Merge commit `a063bb8` resolves the WHITEOUT adapter conflict by preserving backend observation draining/lifecycle and main flight/camera behavior, including cleanup for streaming/reconnect workers. Existing uncommitted backend arena/nonblocking fixes were carried forward where applicable; the original backend and UI worktrees retain their unfinished edits. Nothing was pushed.

Validation: **95 backend tests and 21 frontend checks passed**. Three 30-second legacy local evaluation profiles also completed as an integration smoke check; their default target starts in coverage, so they are not the randomized placement benchmark. Generated bytecode was excluded from the new changes.
