import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { GAME_RULES, SIMULATION_STEP, createGame, formatTime, getDroneTopSpeed, getSector, hasLineOfSight, isNavigable, sampleHeight, sampleRiverHeight, startGame, stepGame, togglePause, type GameState, type InputState, type WorldData } from "../lib/game";

function ocean(): WorldData {
  return { size: 131, half: 3250, heights: Array(131 * 131).fill(-20), waterLevel: 1, towers: [], spawn: { x: 0, z: 0, heading: 0 }, source: "test" };
}
function play(world: WorldData): GameState { const game = createGame(world); startGame(game); return game; }
function setBoatSpeed(game: GameState, speed: number, enginePower = 1): void {
  Object.assign(game.boat, { speed, enginePower, velocityX: Math.sin(game.boat.heading) * speed, velocityZ: Math.cos(game.boat.heading) * speed });
}
function advance(game: GameState, world: WorldData, seconds: number, input: InputState = { throttle: 0, steer: 0 }): void {
  for (let i = 0; i < Math.round(seconds * 60); i++) stepGame(game, world, input, 1 / 60);
}
/** A reproducible skilled route: weave toward visible boosts, then rejoin the river axis. */
function escapeCourse(game: GameState, world: WorldData): InputState {
  const boat = game.boat;
  const forwardX = Math.sin(world.spawn.heading), forwardZ = Math.cos(world.spawn.heading);
  const clamp = (n: number, low: number, high: number) => Math.max(low, Math.min(high, n));
  let targetHeading = world.spawn.heading - 0.025 + 0.74 * Math.sin(game.time * 0.375 + 3.607);
  if (game.loop > 0) {
    const across = (boat.x - world.spawn.x) * forwardZ - (boat.z - world.spawn.z) * forwardX;
    targetHeading = world.spawn.heading + clamp(-across / 350, -0.5, 0.5);
  } else {
    const pickup = game.pickups.filter((p) => (p.x - boat.x) * forwardX + (p.z - boat.z) * forwardZ > -5)
      .sort((a, b) => Math.hypot(a.x - boat.x, a.z - boat.z) - Math.hypot(b.x - boat.x, b.z - boat.z))[0];
    if (pickup) {
      const pickupHeading = Math.atan2(pickup.x - boat.x, pickup.z - boat.z);
      if (Math.abs(pickupHeading - boat.heading) < 1.5) targetHeading = pickupHeading;
    }
  }
  return { throttle: 1, steer: clamp(-2.5 * (targetHeading - boat.heading) + 0.45 * boat.yawRate, -1, 1) };
}

test("bilinear terrain sampling and world boundaries", () => {
  const world = { ...ocean(), size: 2, half: 10, heights: [-10, 10, 10, 30] };
  assert.equal(sampleHeight(world, 0, 0), 10);
  assert.equal(sampleHeight(world, -10, -10), -10);
  assert.equal(sampleHeight(world, 10, 10), 30);
  assert.equal(sampleHeight(world, 11, 0), Infinity, "The legacy terrain sampler stays bounded");
  assert.equal(isNavigable(world, 11, 0), true, "The connected river extends beyond the legacy heightmap");
  assert.equal(isNavigable(world, NaN, 0), false);
});

test("launch provides distance and grace; paused time, radar and pursuit do not advance", () => {
  const world = ocean();
  const game = play(world);
  assert.ok(game.distanceToDrone >= 900);
  assert.equal(game.drones.length, 2);
  assert.ok(Math.hypot(game.drones[0].x - game.drones[1].x, game.drones[0].z - game.drones[1].z) > 1500);
  assert.equal(game.plane.mode, "patrol");
  assert.ok(game.plane.speed > GAME_RULES.maxSpeed);
  advance(game, world, 2, { throttle: 1, steer: 0.5 });
  togglePause(game);
  const paused = JSON.stringify(game);
  advance(game, world, 5, { throttle: 1, steer: 1 });
  assert.equal(JSON.stringify(game), paused);
  togglePause(game);
  advance(game, world, 1);
  assert.ok(Math.abs(game.time - 3) < 1e-8);
  assert.ok(Math.abs(game.simulationTime - 6) < 1e-8);
});

test("long background gaps do not advance the survival timer", () => {
  const world = ocean(); const game = play(world);
  stepGame(game, world, { throttle: 1, steer: 0 }, 30);
  assert.equal(game.time, 0);
  assert.equal(game.simulationTime, 0);
  assert.equal(game.boat.z, 0);
});

test("2x pace advances motion, acceleration, turns and radar twice per real second while score stays real", () => {
  const world = ocean();
  world.towers = [{ id: "T1", x: 2000, z: 2000, height: 0, heading: 0.3, range: 1500 }];
  const cruising = play(world);
  setBoatSpeed(cruising, GAME_RULES.maxSpeed);
  advance(cruising, world, 1, { throttle: 1, steer: 0 });
  assert.equal(GAME_RULES.pace, 2);
  assert.ok(Math.abs(cruising.time - 1) < 1e-8);
  assert.ok(Math.abs(cruising.simulationTime - 2) < 1e-8);
  assert.ok(Math.abs(cruising.boat.z - 120) < 1e-8, "60m per simulation second must cover 120m per real second");
  assert.ok(Math.abs(cruising.drones[0].speed - 38) < 1e-8, "Drone acceleration must share the same accelerated clock");
  assert.ok(Math.abs(cruising.towers[0].heading - (0.3 + Math.sin(2 * 0.27) * 1.08)) < 1e-8);

  const accelerating = play(world);
  advance(accelerating, world, 1, { throttle: 1, steer: 0 });
  assert.ok(accelerating.boat.speed > 40 && accelerating.boat.speed < GAME_RULES.maxSpeed, "Thrust accelerates against increasing water drag");
  const turning = play(world);
  setBoatSpeed(turning, GAME_RULES.maxSpeed);
  advance(turning, world, 1, { throttle: 1, steer: 0.3 });
  assert.ok(turning.boat.heading < -0.4 && turning.boat.heading > -0.57, "Rudder and angular inertia ramp into the turn");
});

test("right steering turns toward boat starboard and fixed steps are frame independent", () => {
  const world = ocean(); const a = play(world); const b = play(world);
  const input = { throttle: 1, steer: 0.6 };
  for (let i = 0; i < 600; i++) stepGame(a, world, input, 1 / 60);
  for (let i = 0; i < 300; i++) stepGame(b, world, input, 1 / 30);
  assert.ok(a.boat.heading < 0);
  assert.ok(Math.abs(a.boat.x - b.boat.x) < 1e-8);
  assert.ok(Math.abs(a.boat.z - b.boat.z) < 1e-8);
  assert.ok(Math.abs(a.time - b.time) < 1e-8);
  assert.ok(Math.abs(a.simulationTime - b.simulationTime) < 1e-8);
  assert.deepEqual(a.drones, b.drones);
  assert.deepEqual(a.plane, b.plane);
});

test("negative throttle brakes faster than coasting and never produces reverse travel", () => {
  const world = ocean(); const braking = play(world); const coasting = play(world);
  setBoatSpeed(braking, GAME_RULES.maxSpeed);
  setBoatSpeed(coasting, GAME_RULES.maxSpeed);
  advance(braking, world, 0.5, { throttle: -1, steer: 0 });
  advance(coasting, world, 0.5, { throttle: 0, steer: 0 });
  assert.ok(braking.boat.speed < 15);
  assert.ok(coasting.boat.speed > 30 && coasting.boat.speed < GAME_RULES.maxSpeed);
  assert.ok(braking.boat.z < coasting.boat.z);
  advance(braking, world, 1, { throttle: -1, steer: 0 });
  assert.equal(braking.boat.speed, 0);
  const stoppedAt = { x: braking.boat.x, z: braking.boat.z };
  advance(braking, world, 2, { throttle: -1, steer: 0 });
  assert.equal(braking.boat.speed, 0);
  assert.deepEqual({ x: braking.boat.x, z: braking.boat.z }, stoppedAt);
});

test("engine thrust builds momentum and quadratic water resistance grows with speed", () => {
  const world = ocean(); const powered = play(world); const halfPower = play(world);
  stepGame(powered, world, { throttle: 1, steer: 0 }, SIMULATION_STEP / GAME_RULES.pace);
  assert.ok(powered.boat.enginePower > 0 && powered.boat.enginePower < 0.1, "Engine power must spool up over more than one tick");
  assert.ok(powered.boat.speed > 0 && powered.boat.speed < 1, "Thrust cannot jump to cruising velocity");
  advance(powered, world, 2, { throttle: 1, steer: 0 });
  advance(halfPower, world, 2, { throttle: 0.5, steer: 0 });
  assert.ok(powered.boat.speed > halfPower.boat.speed + 10);
  assert.ok(powered.boat.speed < GAME_RULES.maxSpeed);
  assert.ok(powered.boat.pitch > 0, "Acceleration lifts the bow");
  assert.equal(powered.boat.speed, Math.hypot(powered.boat.velocityX, powered.boat.velocityZ));

  const fast = play(world); const slow = play(world);
  setBoatSpeed(fast, 60, 0); setBoatSpeed(slow, 20, 0);
  advance(fast, world, 0.2); advance(slow, world, 0.2);
  assert.ok(60 - fast.boat.speed > (20 - slow.boat.speed) * 3, "High-speed coasting must lose more momentum to water resistance");
  assert.ok(slow.boat.speed > 0, "Letting go of the accelerator keeps the hull coasting");
  advance(powered, world, 0.3, { throttle: -1, steer: 0 });
  assert.ok(powered.boat.pitch < 0, "Braking settles the bow forward");
});

test("rudder and yaw ramp smoothly, turning loses speed and hull momentum slips then settles", () => {
  const world = ocean(); const turning = play(world); const straight = play(world);
  setBoatSpeed(turning, 60); setBoatSpeed(straight, 60);
  stepGame(turning, world, { throttle: 1, steer: 1 }, SIMULATION_STEP / GAME_RULES.pace);
  assert.ok(turning.boat.rudder > 0 && turning.boat.rudder < 0.2);
  assert.ok(turning.boat.yawRate < 0 && turning.boat.yawRate > -0.02);
  advance(turning, world, 0.4, { throttle: 1, steer: 1 });
  advance(straight, world, 0.4, { throttle: 1, steer: 0 });
  const slip = (game: GameState) => Math.abs(game.boat.velocityX * Math.cos(game.boat.heading) - game.boat.velocityZ * Math.sin(game.boat.heading));
  const turnSlip = slip(turning);
  const yawAtRelease = Math.abs(turning.boat.yawRate);
  const headingAtRelease = turning.boat.heading;
  assert.ok(turnSlip > 3, "A turning hull must not rotate its entire velocity instantaneously");
  assert.ok(turning.boat.speed < straight.boat.speed - 3, "Turning should scrub speed against the water");
  assert.ok(turning.boat.roll < 0, "The hull banks with its turn");
  stepGame(turning, world, { throttle: 1, steer: 0 }, SIMULATION_STEP / GAME_RULES.pace);
  assert.ok(turning.boat.heading < headingAtRelease, "Angular momentum persists just after the rudder is released");
  assert.ok(turning.boat.rudder > 0);
  advance(turning, world, 1, { throttle: 1, steer: 0 });
  assert.ok(Math.abs(turning.boat.yawRate) < yawAtRelease * 0.02);
  assert.ok(slip(turning) < turnSlip * 0.03, "Water damps lateral sliding once the hull straightens");
  assert.ok(turning.boat.rudder < 0.001);
});

test("restart clears every momentum and attitude field while pause preserves them", () => {
  const world = ocean(); const game = play(world);
  advance(game, world, 0.8, { throttle: 1, steer: -0.6 });
  assert.ok(game.boat.speed > 0 && game.boat.yawRate > 0 && game.boat.pitch > 0);
  const moving = structuredClone(game.boat);
  togglePause(game);
  advance(game, world, 2, { throttle: -1, steer: 1 });
  assert.deepEqual(game.boat, moving);
  startGame(game);
  assert.deepEqual(game.boat, { ...world.spawn, speed: 0, roll: 0, pitch: 0, velocityX: 0, velocityZ: 0, yawRate: 0, rudder: 0, enginePower: 0 });
});

test("steering in place remains available but cannot turn upstream even with held controls", () => {
  const world = ocean(); world.spawn.heading = Math.PI * 2 + 1.1;
  for (const steer of [-1, 1]) {
    const game = play(world);
    advance(game, world, 3, { throttle: -1, steer });
    assert.equal(game.boat.speed, 0);
    assert.equal(game.boat.x, world.spawn.x);
    assert.equal(game.boat.z, world.spawn.z);
    assert.ok(Math.abs(game.boat.heading - (world.spawn.heading - steer * GAME_RULES.maxCourseDeviation)) < 1e-8);
    assert.ok(Math.cos(game.boat.heading - world.spawn.heading) > 0, "The bow must still face downriver at either steering limit");
    const limitHeading = game.boat.heading;
    advance(game, world, 0.5, { throttle: 0, steer: -steer });
    assert.ok(Math.abs(game.boat.heading - world.spawn.heading) < Math.abs(limitHeading - world.spawn.heading), "Opposite steering must bring a stopped boat away from a limit");
  }
});

test("adversarial throttle and steering cannot move the boat backwards along its initial course", () => {
  const world = ocean(); world.spawn.heading = 1.1;
  const game = play(world);
  const forwardX = Math.sin(world.spawn.heading), forwardZ = Math.cos(world.spawn.heading);
  let seed = 0x51a7;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 0x100000000; };
  const inputs: InputState[] = [
    { throttle: 1, steer: 1 }, { throttle: 1, steer: -1 },
    { throttle: -1, steer: 1 }, { throttle: -10, steer: -10 },
    { throttle: 10, steer: 10 }, { throttle: 0, steer: 1 },
    { throttle: NaN, steer: Infinity },
  ];
  let movedFrames = 0;
  let reachedLimit = false;
  for (let frame = 0; frame < 8 * 60; frame++) {
    // Long held turns attempt a U-turn before irregular controls, braking, and
    // invalid inputs exercise the course invariant in different combinations.
    const input = frame < 120 ? inputs[0] : frame < 240 ? inputs[1] : inputs[Math.floor(random() * inputs.length)];
    const previous = { x: game.boat.x, z: game.boat.z };
    stepGame(game, world, input, 1 / 60);
    const progress = (game.boat.x - previous.x) * forwardX + (game.boat.z - previous.z) * forwardZ;
    assert.ok(progress >= -1e-10, `Frame ${frame} moved upstream by ${-progress}`);
    assert.ok(game.boat.speed >= 0 && game.boat.speed <= GAME_RULES.maxSpeed + 1e-8);
    const deviation = Math.abs(game.boat.heading - world.spawn.heading);
    assert.ok(deviation <= GAME_RULES.maxCourseDeviation + 1e-10);
    reachedLimit ||= Math.abs(deviation - GAME_RULES.maxCourseDeviation) < 1e-10;
    movedFrames += Number(progress > 0);
  }
  assert.ok(reachedLimit, "Held controls must actually exercise the course clamp");
  assert.ok(movedFrames > 240, "The invariant must be checked during substantial forward travel");
});

test("boat cannot cross the shoreline but can cross the original map edge", () => {
  const world = ocean();
  for (let row = 69; row < world.size; row++) for (let col = 0; col < world.size; col++) world.heights[row * world.size + col] = 200;
  const game = play(world); setBoatSpeed(game, 60);
  advance(game, world, 20, { throttle: 1, steer: 0 });
  assert.ok(game.boat.z < 160);
  assert.equal(isNavigable(world, game.boat.x, game.boat.z), true);
  assert.equal(game.collision, true);
  const edgeWorld = ocean(); edgeWorld.spawn.z = 3200;
  const edge = play(edgeWorld);
  advance(edge, edgeWorld, 10, { throttle: 1, steer: 0 });
  assert.ok(edge.boat.z > edgeWorld.half + 1000);
  assert.equal(edge.collision, false);
  assert.equal(edge.loop, 1);
  assert.deepEqual(getSector(edgeWorld, edge.boat.x, edge.boat.z), { sectorX: 0, sectorZ: 1 });
});

test("a glancing shoreline collision sheds velocity without pushing the hull or bow onto land", () => {
  const world = ocean(); world.spawn.heading = 0.65;
  for (let row = 0; row < world.size; row++) for (let col = 67; col < world.size; col++) world.heights[row * world.size + col] = 200;
  const game = play(world); setBoatSpeed(game, 60);
  let touchedBank = false;
  let collisionSpeed = 0;
  const initialSpeed = game.boat.speed;
  for (let tick = 0; tick < 120; tick++) {
    stepGame(game, world, { throttle: 1, steer: 0 }, SIMULATION_STEP / GAME_RULES.pace);
    const { x, z, heading } = game.boat;
    assert.equal(isNavigable(world, x, z), true);
    for (let i = 0; i < 8; i++) {
      const angle = i / 8 * Math.PI * 2;
      assert.equal(isNavigable(world, x + Math.sin(angle) * GAME_RULES.boatRadius, z + Math.cos(angle) * GAME_RULES.boatRadius), true);
    }
    assert.equal(isNavigable(world, x + Math.sin(heading) * 31, z + Math.cos(heading) * 31), true);
    assert.equal(isNavigable(world, x - Math.sin(heading) * 31, z - Math.cos(heading) * 31), true);
    if (game.collision && !touchedBank) { touchedBank = true; collisionSpeed = game.boat.speed; }
  }
  assert.equal(touchedBank, true);
  assert.ok(collisionSpeed < initialSpeed * 0.6, "Bank contact must dissipate momentum");
  assert.ok(game.boat.z > 20, "A glancing impact should permit conservative travel along the bank");
  assert.equal(game.boat.speed, Math.hypot(game.boat.velocityX, game.boat.velocityZ));
});

test("land blocks radar while clear terrain permits observation", () => {
  const world = ocean();
  assert.equal(hasLineOfSight(world, 0, -400, 55, 0, 400, 6), true);
  for (let col = 0; col < world.size; col++) world.heights[65 * world.size + col] = 120;
  assert.equal(hasLineOfSight(world, 0, -400, 55, 0, 400, 6), false);
  world.spawn.z = 400;
  world.towers = [{ id: "T1", x: 0, z: -400, height: 0, heading: -Math.sin(6.1 * 0.27) * 1.08, range: 1500 }];
  const game = play(world); game.simulationTime = 6; game.time = 3;
  advance(game, world, 0.1);
  assert.equal(game.towers[0].detecting, false);
  world.heights.fill(-20);
  advance(game, world, 0.1);
  assert.equal(game.towers[0].detecting, true);
  assert.ok(game.lastKnown);
});

test("actual tower contact accelerates both drones to a higher cap and losing contact ends the surge", () => {
  const world = ocean();
  world.towers = [{ id: "T1", x: 0, z: -300, height: 0, heading: 0, range: 1000 }];
  const detected = play(world); const unseen = play(world);
  unseen.towers[0].range = 0;
  for (const game of [detected, unseen]) {
    game.time = 3; game.simulationTime = 6;
    game.drones.forEach((drone, i) => Object.assign(drone, { x: i * 50, z: -1800, heading: 0, speed: 0 }));
    Object.assign(game.plane, { x: 3000, z: 3000, heading: Math.PI / 2 });
  }
  const tickTower = (game: GameState) => {
    game.towers[0].baseHeading = -Math.sin((game.simulationTime + SIMULATION_STEP) * 0.27) * 1.08;
    stepGame(game, world, { throttle: 0, steer: 0 }, SIMULATION_STEP / GAME_RULES.pace);
  };
  tickTower(detected); tickTower(unseen);
  assert.equal(detected.towers[0].detecting, true);
  assert.equal(unseen.detected, false);
  assert.ok(detected.drones.every((drone) => !drone.detecting && drone.mode === "pursuit"), "The tower's real observation is shared with both drones");
  assert.equal(detected.drones[0].speed, GAME_RULES.droneDetectedAcceleration * SIMULATION_STEP);
  assert.equal(unseen.drones[0].speed, GAME_RULES.droneAcceleration * SIMULATION_STEP);
  for (let tick = 0; tick < 240; tick++) { tickTower(detected); tickTower(unseen); }
  assert.ok(detected.drones.every((drone) => drone.speed === GAME_RULES.droneDetectedSpeed && drone.speed > GAME_RULES.droneMaxSpeed));
  assert.ok(detected.drones[0].speed > unseen.drones[0].speed + 30);
  detected.towers[0].range = 0;
  tickTower(detected);
  assert.equal(detected.detected, false);
  assert.equal(detected.towers[0].detecting, false);
  assert.ok(detected.drones.every((drone) => drone.mode === "searching" && drone.speed < GAME_RULES.droneDetectedSpeed));
  advance(detected, world, 1.5);
  assert.ok(detected.drones.every((drone) => drone.speed < GAME_RULES.droneMaxSpeed));
  assert.equal(detected.detected, false, "A remembered position cannot sustain detection speed");
});

test("detected drones still slow near the hull instead of blowing past the capture radius", () => {
  const world = ocean(); const game = play(world);
  game.time = 3; game.simulationTime = 6;
  Object.assign(game.drones[0], { x: 0, z: -35, heading: 0, speed: 0 });
  Object.assign(game.drones[1], { x: -3000, z: -3000 });
  Object.assign(game.plane, { x: 3000, z: 3000 });
  advance(game, world, 0.3);
  assert.equal(game.detected, true);
  assert.ok(game.drones[0].speed <= 18.1);
  assert.ok(game.drones[0].tagProgress > 0);
  assert.ok(game.drones[0].distanceToBoat < GAME_RULES.tagRadius);
});

test("hidden boat positions and speeds cannot affect either drone or the scouting plane", () => {
  const world = ocean(); const a = play(world); const b = play(world);
  for (const game of [a, b]) {
    game.time = 5; game.simulationTime = 10; game.lastKnown = { x: 0, z: 0 };
    game.drones.forEach((drone, i) => Object.assign(drone, { x: 1200, z: i * 300, heading: -Math.PI / 2, speed: 30 }));
    Object.assign(game.plane, { x: 1000, z: -1000, heading: -Math.PI / 4 });
  }
  a.boat.x = -2500; a.boat.z = -2400; setBoatSpeed(a, 23);
  b.boat.x = 2500; b.boat.z = 2400; setBoatSpeed(b, 54);
  advance(a, world, 3); advance(b, world, 3);
  const flight = (game: GameState) => game.drones.map(({ distanceToBoat: _distance, ...drone }) => drone);
  assert.deepEqual(flight(a), flight(b));
  assert.deepEqual(a.plane, b.plane);
  assert.deepEqual(a.lastKnown, { x: 0, z: 0 });
  assert.equal(a.alert, "searching");
  assert.equal(b.alert, "searching");
});

test("published camera angles constrain each aircraft and terrain still blocks every sensor", () => {
  assert.equal(GAME_RULES.radarFov, 60 * Math.PI / 180);
  assert.equal(GAME_RULES.droneFov, 114.6 * Math.PI / 180);
  assert.equal(GAME_RULES.planeFov, 69 * Math.PI / 180);
  for (const sensorIndex of [0, 1, 2]) {
    const world = ocean(); const game = play(world); game.simulationTime = 6; game.time = 3;
    const aircraft = [...game.drones, game.plane];
    for (const craft of aircraft) Object.assign(craft, { x: 3000, z: 3000 });
    const sensor = aircraft[sensorIndex];
    Object.assign(sensor, { x: 0, z: -300, heading: Math.PI, altitude: 106, speed: 0 });
    stepGame(game, world, { throttle: 0, steer: 0 }, SIMULATION_STEP / GAME_RULES.pace);
    assert.equal(sensor.detecting, false, `${sensor.id} must not see through the back of its camera`);
    sensor.heading = 0;
    stepGame(game, world, { throttle: 0, steer: 0 }, SIMULATION_STEP / GAME_RULES.pace);
    assert.equal(sensor.detecting, true, `${sensor.id} should detect an unobstructed boat ahead`);
    for (let col = 0; col < world.size; col++) world.heights[62 * world.size + col] = 400;
    stepGame(game, world, { throttle: 0, steer: 0 }, SIMULATION_STEP / GAME_RULES.pace);
    assert.equal(sensor.detecting, false, `${sensor.id} must not see through a ridge`);
  }
});

test("the fixed-wing scout shares actual observations with both drones but cannot tag", () => {
  const world = ocean(); const game = play(world); game.simulationTime = 6; game.time = 3;
  game.drones.forEach((drone, i) => Object.assign(drone, { x: -2800 + i * 100, z: -2800 }));
  Object.assign(game.plane, { x: 0, z: -800, heading: 0 });
  stepGame(game, world, { throttle: 0, steer: 0 }, SIMULATION_STEP / GAME_RULES.pace);
  assert.equal(game.plane.detecting, true);
  assert.equal(game.detected, true);
  assert.ok(game.drones.every((drone) => !drone.detecting && drone.mode === "pursuit"));
  assert.deepEqual(game.lastKnown, { x: 0, z: 0 });
  game.plane.heading = Math.PI;
  stepGame(game, world, { throttle: 0, steer: 0 }, SIMULATION_STEP / GAME_RULES.pace);
  assert.equal(game.plane.detecting, false);
  assert.equal(game.detected, false);
  assert.ok(game.drones.every((drone) => drone.mode === "searching"));
  for (let frame = 0; frame < 180; frame++) {
    Object.assign(game.plane, { x: 0, z: -10, heading: 0 });
    stepGame(game, world, { throttle: 0, steer: 0 }, 1 / 60);
  }
  assert.equal(game.status, "playing", "A nearby scout is an observer, never a capture agent");
  assert.equal(game.tagProgress, 0);
});

test("partial locks belong to individual drones and cannot be combined or transferred", () => {
  const world = ocean(); const game = play(world); game.simulationTime = 10; game.time = 5;
  Object.assign(game.plane, { x: -3000, z: 3000 });
  const lockWith = (index: number, seconds: number) => {
    for (let frame = 0; frame < Math.round(seconds * 60); frame++) {
      game.drones.forEach((drone, i) => Object.assign(drone, i === index
        ? { x: game.boat.x, z: game.boat.z - 10, heading: 0, speed: 0 }
        : { x: 3000, z: 3000, speed: 0 }));
      stepGame(game, world, { throttle: 0, steer: 0 }, 1 / 60);
    }
  };
  lockWith(0, 1.2);
  assert.ok(Math.abs(game.drones[0].tagProgress - 0.6) < 1e-8);
  lockWith(1, 1.2);
  assert.equal(game.status, "playing");
  assert.equal(game.drones[0].tagProgress, 0);
  assert.ok(Math.abs(game.drones[1].tagProgress - 0.6) < 1e-8);
  assert.equal(game.tagProgress, game.drones[1].tagProgress);
  assert.equal(game.distanceToDrone, Math.min(...game.drones.map((drone) => drone.distanceToBoat)));
  lockWith(1, 0.8);
  assert.equal(game.status, "caught");
});

test("render snapshots bracket fixed simulation ticks and are never called while paused", () => {
  const world = ocean(); const game = play(world);
  const previousTimes: number[] = [];
  stepGame(game, world, { throttle: 1, steer: 0 }, 1 / 60, () => previousTimes.push(game.simulationTime));
  assert.deepEqual(previousTimes, [0, SIMULATION_STEP]);
  assert.equal(game.simulationTime, 2 * SIMULATION_STEP);
  togglePause(game);
  stepGame(game, world, { throttle: 1, steer: 0 }, 1 / 60, () => assert.fail("Paused simulations must not request interpolation snapshots"));
  togglePause(game);
  const resumedTime = game.simulationTime;
  stepGame(game, world, { throttle: 1, steer: 0 }, 2, () => assert.fail("Rejected background gaps must not request interpolation snapshots"));
  assert.equal(game.simulationTime, resumedTime);
  assert.equal(game.accumulator, 0);
});

test("interpolated constant-speed boat motion stays continuous across irregular and sub-tick render frames", () => {
  const world = ocean(); world.spawn.heading = 1.1;
  const game = play(world); setBoatSpeed(game, GAME_RULES.maxSpeed);
  let previous = { ...game.boat };
  let snapshotCount = 0;
  const renderFrame = (dt: number) => {
    const times: number[] = [];
    stepGame(game, world, { throttle: 1, steer: 0 }, dt, () => {
      previous = { ...game.boat };
      times.push(game.simulationTime);
      snapshotCount++;
    });
    // Mirrors Scene's previous/current interpolation. The callback must replace
    // the snapshot before the LAST tick, not only once per rendered frame.
    const alpha = Math.min(1, game.accumulator / SIMULATION_STEP);
    if (times.length) assert.ok(Math.abs(times[times.length - 1] - (game.simulationTime - SIMULATION_STEP)) < 1e-10);
    return {
      x: previous.x + (game.boat.x - previous.x) * alpha,
      z: previous.z + (game.boat.z - previous.z) * alpha,
      ticks: times.length,
    };
  };
  // Interpolation has a deliberate one-tick latency. Prime that tick before
  // checking every subsequent displacement, including frames with zero ticks.
  let rendered = renderFrame(SIMULATION_STEP / GAME_RULES.pace);
  const cadence = [1 / 240, 1 / 500, 1 / 43, 1 / 120, 1 / 37, 1 / 75, 1 / 300, 1 / 24];
  let elapsed = 0;
  let subTickFrames = 0;
  let multiTickFrames = 0;
  for (let cycle = 0; cycle < 8; cycle++) for (const dt of cadence) {
    const next = renderFrame(dt);
    const distance = dt * GAME_RULES.pace * GAME_RULES.maxSpeed;
    assert.ok(Math.abs(next.x - rendered.x - Math.sin(world.spawn.heading) * distance) < 1e-8, "X motion must advance continuously even when this frame executes no simulation tick");
    assert.ok(Math.abs(next.z - rendered.z - Math.cos(world.spawn.heading) * distance) < 1e-8, "Z motion must not jump after a frame executing several simulation ticks");
    subTickFrames += Number(next.ticks === 0);
    multiTickFrames += Number(next.ticks > 1);
    rendered = next;
    elapsed += dt;
  }
  assert.ok(subTickFrames > 0, "Exercise render frames shorter than a simulation tick");
  assert.ok(multiTickFrames > 0, "Exercise render frames containing several simulation ticks");
  assert.ok(snapshotCount > cadence.length * 8);
  const expectedDistance = elapsed * GAME_RULES.pace * GAME_RULES.maxSpeed;
  assert.ok(Math.abs(rendered.x - world.spawn.x - Math.sin(world.spawn.heading) * expectedDistance) < 1e-8);
  assert.ok(Math.abs(rendered.z - world.spawn.z - Math.cos(world.spawn.heading) * expectedDistance) < 1e-8);
});

test("tagging still requires two continuous REAL seconds at 2x pace and resets immediately on escape", () => {
  const world = ocean(); const game = play(world); game.time = 5; game.simulationTime = 10;
  Object.assign(game.drones[1], { x: 3000, z: 3000 });
  Object.assign(game.plane, { x: -3000, z: 3000 });
  function holdClose(seconds: number) {
    for (let i = 0; i < Math.round(seconds * 60); i++) {
      Object.assign(game.drones[0], { x: game.boat.x + 10, z: game.boat.z, heading: -Math.PI / 2, speed: 0 });
      stepGame(game, world, { throttle: 0, steer: 0 }, 1 / 60);
    }
  }
  holdClose(1);
  assert.ok(Math.abs(game.tagProgress - 0.5) < 1e-8);
  assert.ok(Math.abs(game.time - 6) < 1e-8);
  assert.ok(Math.abs(game.simulationTime - 12) < 1e-8);
  assert.equal(game.status, "playing");
  game.drones[0].x = 100;
  stepGame(game, world, { throttle: 0, steer: 0 }, 1 / 60);
  assert.equal(game.tagProgress, 0);
  holdClose(1.9);
  assert.equal(game.status, "playing");
  holdClose(0.1);
  assert.equal(game.status, "caught");
  const endTime = game.time;
  advance(game, world, 1);
  assert.equal(game.time, endTime);
  startGame(game);
  assert.equal(game.time, 0);
  assert.equal(game.simulationTime, 0);
  assert.equal(game.tagProgress, 0);
  assert.equal(game.boat.x, world.spawn.x);
  for (const drone of game.drones) { assert.equal(drone.tagProgress, 0); assert.equal(drone.mode, "patrol"); }
  assert.equal(game.plane.x, game.initialPlane.x);
  assert.equal(game.plane.mode, "patrol");
  assert.equal(game.plane.detecting, false);
});

test("grace period prevents immediate tags and score formatting is stable", () => {
  const world = ocean(); const game = play(world);
  Object.assign(game.drones[0], { x: 0, z: 0 });
  advance(game, world, 1);
  assert.equal(game.tagProgress, 0);
  assert.equal(formatTime(65.9), "01:05");
  assert.equal(formatTime(-10), "00:00");
});

test("the full fleet finds an idle boat while following boosts permits a forward-only Fort Ross escape", () => {
  const world = JSON.parse(readFileSync(resolve(__dirname, "../../public/assets/world.json"), "utf8")) as WorldData;
  const idle = play(world);
  advance(idle, world, 30);
  assert.equal(idle.status, "caught", "A stationary player must eventually be found by the terrain-defined patrol");
  assert.ok(idle.time > 10 && idle.time < 25, `An idle boat survived ${idle.time.toFixed(2)} real seconds`);

  const moving = play(world);
  let previousProgress = 0;
  let navigatedDistance = 0;
  let boostsCollected = 0;
  for (let frame = 0; frame < 45 * 60 && moving.status === "playing" && moving.loop === 0; frame++) {
    const previousBoost = moving.boostRemaining;
    stepGame(moving, world, escapeCourse(moving, world), 1 / 60);
    if (moving.boostRemaining > previousBoost) boostsCollected++;
    const { x, z, heading } = moving.boat;
    assert.equal(isNavigable(world, x, z), true);
    assert.equal(isNavigable(world, x + Math.sin(heading) * 31, z + Math.cos(heading) * 31), true);
    assert.equal(isNavigable(world, x - Math.sin(heading) * 31, z - Math.cos(heading) * 31), true);
    const progress = (x - world.spawn.x) * Math.sin(world.spawn.heading) + (z - world.spawn.z) * Math.cos(world.spawn.heading);
    assert.ok(progress >= previousProgress - 1e-8);
    if (!moving.collision) navigatedDistance = progress;
    previousProgress = progress;
  }
  assert.ok(navigatedDistance > 4000, "The route must continue downriver through the former map boundary");
  assert.equal(moving.status, "playing");
  assert.equal(moving.loop, 1);
  assert.ok(boostsCollected >= 3, "A viable escape uses real pickups while steering around the patrol");
});

test("generated terrain joins every original edge continuously while preserving interior geography", () => {
  const world = JSON.parse(readFileSync(resolve(__dirname, "../../public/assets/world.json"), "utf8")) as WorldData;
  for (let x = -2500; x <= 2500; x += 250) for (let z = -2500; z <= 2500; z += 250) {
    assert.equal(sampleRiverHeight(world, x, z), sampleHeight(world, x, z));
  }
  for (const sign of [-1, 1]) for (let coordinate = -world.half; coordinate <= world.half; coordinate += 250) {
    const edge = sign * world.half;
    assert.ok(Math.abs(sampleRiverHeight(world, edge - 0.001, coordinate) - sampleRiverHeight(world, edge + 0.001, coordinate)) < 0.01);
    assert.ok(Math.abs(sampleRiverHeight(world, coordinate, edge - 0.001) - sampleRiverHeight(world, coordinate, edge + 0.001)) < 0.01);
  }
  assert.equal(sampleRiverHeight(world, Infinity, 0), Infinity);
  assert.equal(isNavigable(world, 0, NaN), false);
  assert.deepEqual(getSector(world, -world.half - 1, world.half + 1), { sectorX: -1, sectorZ: 1 });
});

test("each connected loop replaces a finite patrol without teleporting the boat or resetting its run", () => {
  const world = JSON.parse(readFileSync(resolve(__dirname, "../../public/assets/world.json"), "utf8")) as WorldData;
  const game = play(world);
  const originalTowers = game.towers.map(({ id, x, z }) => ({ id, x, z }));
  const originalAircraft = [...game.drones, game.plane].map(({ id }) => id);
  const forwardX = Math.sin(world.spawn.heading), forwardZ = Math.cos(world.spawn.heading);
  const firstBoundary = Math.min((world.half - world.spawn.x) / forwardX, (world.half - world.spawn.z) / forwardZ);
  let previousTowers = originalTowers;
  game.time = 40; game.simulationTime = 80; game.distanceTraveled = 4000;
  for (let loop = 1; loop <= 5; loop++) {
    const boundary = loop === 1 ? firstBoundary : game.nextLoopProgress;
    Object.assign(game.boat, { x: world.spawn.x + forwardX * (boundary - 0.5), z: world.spawn.z + forwardZ * (boundary - 0.5) });
    setBoatSpeed(game, GAME_RULES.maxSpeed);
    game.boostRemaining = 2;
    const before = { ...game.boat, time: game.time, distance: game.distanceTraveled };
    stepGame(game, world, { throttle: 1, steer: 0 }, SIMULATION_STEP / GAME_RULES.pace);
    const displacement = Math.hypot(game.boat.x - before.x, game.boat.z - before.z);
    assert.ok(displacement > 0 && displacement <= GAME_RULES.maxSpeed * GAME_RULES.boostMultiplier * SIMULATION_STEP, "Crossing loops cannot jump world coordinates");
    assert.ok(Math.abs(game.distanceTraveled - before.distance - displacement) < 1e-8);
    assert.ok(Math.abs(game.time - before.time - SIMULATION_STEP / GAME_RULES.pace) < 1e-8);
    assert.ok(Math.abs(game.boostRemaining - (2 - SIMULATION_STEP / GAME_RULES.pace)) < 1e-8);
    assert.ok(game.boat.speed >= GAME_RULES.maxSpeed, "New patrols retain the moving hull's momentum");
    assert.equal(game.loop, loop);
    assert.equal(game.collision, false);
    assert.equal(game.status, "playing");
    assert.equal(isNavigable(world, game.boat.x, game.boat.z), true);
    assert.equal(game.detected, false);
    assert.equal(game.lastKnown, null);
    assert.equal(game.tagProgress, 0);
    assert.equal(game.alert, "clear");
    assert.equal(game.towers.length, 2);
    assert.equal(game.drones.length, 2);
    assert.deepEqual([...game.drones, game.plane].map(({ id }) => id), originalAircraft);
    assert.deepEqual(game.towers.map(({ id }) => id), originalTowers.map(({ id }) => id));
    assert.notDeepEqual(game.towers.map(({ id, x, z }) => ({ id, x, z })), previousTowers);
    assert.ok(game.distanceToDrone > 900, "Every fresh pair launches safely ahead of the crossing");
    assert.equal(game.patrolStartedAt, game.simulationTime);
    assert.ok(Math.abs(game.nextLoopProgress - game.loopStartProgress - GAME_RULES.loopLength) < 1e-8);
    assert.ok(game.patrolPoints.every((point) => isNavigable(world, point.x, point.z)));
    for (const tower of game.towers) {
      assert.ok(tower.height > world.waterLevel, "Respawned towers must stand on the generated banks");
      assert.equal(tower.height, sampleRiverHeight(world, tower.x, tower.z));
      const target = { x: tower.x + Math.sin(tower.baseHeading) * 650, z: tower.z + Math.cos(tower.baseHeading) * 650 };
      assert.equal(isNavigable(world, target.x, target.z), true);
      assert.equal(hasLineOfSight(world, tower.x, tower.z, tower.height + 55, target.x, target.z, world.waterLevel + 5), true);
    }
    assert.ok([...game.drones, game.plane].every((craft) => !craft.detecting && craft.mode === "patrol"
      && Math.hypot(craft.x - game.patrolOrigin.x, craft.z - game.patrolOrigin.z) < GAME_RULES.loopLength));
    previousTowers = game.towers.map(({ id, x, z }) => ({ id, x, z }));
    assert.ok(game.pickups.length <= GAME_RULES.maxPickups);
  }
  togglePause(game);
  const paused = JSON.stringify(game);
  advance(game, world, 5, { throttle: 1, steer: 0 });
  assert.equal(JSON.stringify(game), paused);
  startGame(game);
  assert.equal(game.loop, 0);
  assert.equal(game.patrolStartedAt, 0);
  assert.deepEqual(game.towers.map(({ id, x, z }) => ({ id, x, z })), originalTowers);
  assert.deepEqual(game.patrolPoints, game.initialPatrolPoints);
  assert.deepEqual(game.patrolOrigin, { x: 0, z: 0 });
});

test("fresh patrols clear old locks, cannot rapidly repeat at a map edge, and detect again after grace", () => {
  const world = ocean();
  const game = play(world);
  game.boat.z = world.half - 0.2; setBoatSpeed(game, GAME_RULES.maxSpeed);
  game.simulationTime = 30;
  game.lastKnown = { x: game.boat.x, z: game.boat.z };
  game.detected = true;
  game.tagProgress = 0.99;
  game.drones.forEach((drone) => Object.assign(drone, { x: 0, z: world.half - 1, heading: 0, detecting: true, tagProgress: 0.99 }));
  stepGame(game, world, { throttle: 1, steer: 0 }, SIMULATION_STEP / GAME_RULES.pace);
  assert.equal(game.loop, 1);
  assert.equal(game.status, "playing");
  assert.equal(game.lastKnown, null);
  assert.equal(game.detected, false);
  assert.equal(game.tagProgress, 0);
  assert.ok(game.drones.every((drone) => drone.tagProgress === 0 && drone.mode === "patrol"));
  const towers = structuredClone(game.towers);
  const nextBoundary = game.nextLoopProgress;
  game.boat.z = world.half - 0.1;
  stepGame(game, world, { throttle: -1, steer: 0 }, SIMULATION_STEP / GAME_RULES.pace);
  assert.equal(game.loop, 1, "Crossing back over an old map edge cannot load another patrol");
  assert.equal(game.nextLoopProgress, nextBoundary);
  assert.deepEqual(game.towers.map(({ x, z }) => ({ x, z })), towers.map(({ x, z }) => ({ x, z })));
  Object.assign(game.drones[0], { x: game.boat.x, z: game.boat.z - 10, heading: 0, speed: 0 });
  stepGame(game, world, { throttle: 0, steer: 0 }, SIMULATION_STEP / GAME_RULES.pace);
  assert.equal(game.detected, false);
  assert.equal(game.tagProgress, 0, "A fresh patrol always receives a full grace period");
  game.simulationTime = game.patrolStartedAt + GAME_RULES.graceSeconds;
  Object.assign(game.drones[0], { x: game.boat.x, z: game.boat.z - 10, heading: 0, speed: 0 });
  stepGame(game, world, { throttle: 0, steer: 0 }, SIMULATION_STEP / GAME_RULES.pace);
  assert.equal(game.detected, true, "New drones must be able to acquire the boat again");
  assert.ok(game.tagProgress > 0);
});

test("each loop makes the drones a little faster, with a bounded difficulty cap", () => {
  assert.equal(getDroneTopSpeed(0), GAME_RULES.droneMaxSpeed);
  assert.equal(getDroneTopSpeed(0, true), GAME_RULES.droneDetectedSpeed);
  for (let loop = 1; loop <= 10; loop++) {
    assert.ok(getDroneTopSpeed(loop, true) > getDroneTopSpeed(loop - 1, true));
    assert.ok(Math.abs(getDroneTopSpeed(loop, true) - GAME_RULES.droneDetectedSpeed * (1 + loop * 0.03)) < 1e-8);
  }
  assert.equal(getDroneTopSpeed(1000, true), GAME_RULES.droneDetectedSpeed * 1.3);
  const world = ocean();
  const speeds = [1, 2].map((loop) => {
    const game = play(world);
    game.loop = loop;
    game.nextLoopProgress = 10000;
    game.simulationTime = 10;
    Object.assign(game.drones[0], { x: 0, z: -450, heading: 0, speed: 0 });
    stepGame(game, world, { throttle: 0, steer: 0 }, SIMULATION_STEP / GAME_RULES.pace);
    assert.equal(game.detected, true);
    return game.drones[0].speed;
  });
  assert.ok(speeds[1] > speeds[0], "The later patrol must actually accelerate harder during the simulation");
});

test("speed pickups collect once, last four real seconds, respect braking and pause, and reset on retry", () => {
  const world = ocean();
  const game = play(world);
  const firstPickups = structuredClone(game.pickups);
  assert.equal(firstPickups.length, 1);
  assert.ok(firstPickups[0].z >= 360 && firstPickups[0].z <= 450);
  assert.ok(Math.abs(firstPickups[0].x) <= 20, "The initial pickup is reachable on the starting course");
  const pickup = game.pickups[0];
  Object.assign(game.boat, { x: pickup.x, z: pickup.z });
  stepGame(game, world, { throttle: 1, steer: 0 }, SIMULATION_STEP / GAME_RULES.pace);
  assert.equal(game.pickups.length, 0);
  assert.equal(game.boostRemaining, GAME_RULES.boostDuration);
  advance(game, world, 1.5, { throttle: 1, steer: 0 });
  assert.ok(game.boat.speed > GAME_RULES.maxSpeed);
  assert.ok(Math.abs(game.boostRemaining - 2.5) < 1e-8);
  togglePause(game);
  const snapshot = JSON.stringify(game);
  advance(game, world, 20, { throttle: 1, steer: 0 });
  assert.equal(JSON.stringify(game), snapshot);
  togglePause(game);
  const speed = game.boat.speed;
  advance(game, world, 0.5, { throttle: -1, steer: 0 });
  assert.ok(game.boat.speed < speed * 0.45, "The accelerator effect must not override braking and water resistance");
  advance(game, world, 2.1, { throttle: -1, steer: 0 });
  assert.equal(game.boostRemaining, 0);
  assert.equal(game.boat.speed, 0);
  startGame(game);
  assert.equal(game.boostRemaining, 0);
  assert.equal(game.distanceTraveled, 0);
  assert.equal(game.loop, 0);
  assert.equal(game.sectorX, 0);
  assert.equal(game.sectorZ, 0);
  assert.deepEqual(game.pickups, firstPickups);
});

test("boost expiration loses excess momentum through water drag instead of snapping to normal speed", () => {
  const world = ocean(); const game = play(world);
  setBoatSpeed(game, GAME_RULES.maxSpeed * GAME_RULES.boostMultiplier);
  game.boostRemaining = SIMULATION_STEP / GAME_RULES.pace;
  stepGame(game, world, { throttle: 1, steer: 0 }, SIMULATION_STEP / GAME_RULES.pace);
  assert.equal(game.boostRemaining, 0);
  assert.ok(game.boat.speed > 95 && game.boat.speed < 99);
  advance(game, world, 1, { throttle: 1, steer: 0 });
  assert.ok(game.boat.speed > GAME_RULES.maxSpeed && game.boat.speed < 65);
});

test("pickup placement is seeded, navigable, bounded and expires behind the boat", () => {
  const world = ocean();
  const a = createGame(world, 123);
  const b = createGame(world, 123);
  const different = createGame(world, 456);
  assert.deepEqual(a.pickups, b.pickups);
  assert.notDeepEqual(a.pickups, different.pickups);
  startGame(a); startGame(b);
  for (const game of [a, b]) {
    game.boat.z = 7000;
    setBoatSpeed(game, GAME_RULES.maxSpeed);
  }
  let highestId = 0;
  for (let frame = 0; frame < 120 * 60; frame++) {
    // Isolate the continuous pickup stream from capture, which is covered by
    // dedicated fleet tests; the newly respawned patrols remain active/moving.
    a.patrolStartedAt = a.simulationTime; b.patrolStartedAt = b.simulationTime;
    stepGame(a, world, { throttle: 1, steer: 0 }, 1 / 60);
    stepGame(b, world, { throttle: 1, steer: 0 }, 1 / 60);
    assert.ok(a.pickups.length <= GAME_RULES.maxPickups);
    for (const pickup of a.pickups) {
      assert.equal(isNavigable(world, pickup.x, pickup.z), true);
      assert.ok(pickup.z - a.boat.z > -180);
      assert.ok(Math.hypot(pickup.x - a.boat.x, pickup.z - a.boat.z) < 2200);
      highestId = Math.max(highestId, pickup.id);
    }
  }
  assert.ok(highestId > 10, "The random pickup stream must continue across sectors");
  assert.ok(a.loop >= 3, "The deterministic run must cross several fresh patrols");
  assert.deepEqual(a.pickups, b.pickups);
  assert.deepEqual(a.boat, b.boat);
  assert.deepEqual(a.towers, b.towers);
  assert.deepEqual(a.drones, b.drones);
  assert.deepEqual(a.plane, b.plane);
  assert.deepEqual(a.patrolPoints, b.patrolPoints);
  assert.equal(a.randomState, b.randomState);
});
