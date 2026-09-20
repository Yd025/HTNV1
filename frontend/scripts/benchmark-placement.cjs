// From frontend: node scripts/benchmark-placement.cjs [--check]
// Fixed seeds are declared before evaluation; test scores never choose a run.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const frontend = path.resolve(__dirname, "..");
const repository = path.resolve(frontend, "..");
const destination = path.join(repository, "docs/research/placement-demo-random-tests.json");
const summaryDestination = path.join(frontend, "lib/placementRandomEvidence.json");
const seeds = [190926, 190927, 190928, 190929, 190930];
const modules = new Map();
function load(name) {
  if (modules.has(name)) return modules.get(name);
  if (!["placementDemo", "placementExperiments"].includes(name)) throw new Error(`Unexpected source module: ${name}`);
  const source = fs.readFileSync(path.join(frontend, `lib/${name}.ts`), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: (dependency) => load(dependency.replace(/^\.\//, "")) });
  modules.set(name, exports);
  return exports;
}

const { EXPERIMENT, createExperiment, advanceExperiment } = load("placementExperiments");
const { evaluateRoute } = load("placementDemo");
const evidence = JSON.parse(fs.readFileSync(path.join(frontend, "lib/placementDemoData.json"), "utf8"));
const plain = (value) => JSON.parse(JSON.stringify(value));
const summarize = (detectedAt) => {
  const times = detectedAt.map((time) => time ?? EXPERIMENT.horizonS).sort((a, b) => a - b);
  const detected = detectedAt.filter((time) => time !== null).length;
  return {
    episodes: times.length,
    detected,
    missed: times.length - detected,
    detectionRate: detected / times.length,
    meanCappedS: times.reduce((sum, time) => sum + time, 0) / times.length,
    p90CappedS: times[Math.ceil(times.length * 0.9) - 1],
    worstCappedS: times[times.length - 1],
  };
};
const sources = [
  "frontend/lib/placementDemo.ts",
  "frontend/lib/placementExperiments.ts",
  "frontend/lib/placementDemoData.json",
  "frontend/scripts/benchmark-placement.cjs",
];
const sourceSha256 = Object.fromEntries(sources.map((file) => [file,
  crypto.createHash("sha256").update(fs.readFileSync(path.join(repository, file), "utf8").replace(/\r\n/g, "\n")).digest("hex"),
]));

const rounds = seeds.map((seed) => {
  let experiment = createExperiment(seed, evidence.learned.towers);
  while (experiment.phase !== "complete") experiment = advanceExperiment(experiment);
  const winner = experiment.candidates[experiment.winnerIndex];
  const before = experiment.testRoutes.map((route) => evaluateRoute(evidence.learned.towers, route, EXPERIMENT).detectedAt);
  const after = experiment.testResults.map((result) => result.detectedAt);
  const baseline = summarize(before);
  const learned = summarize(after);
  // Audit the independent score aggregation against the UI model's outputs.
  for (const [score, expected] of [[baseline, experiment.test.baseline], [learned, experiment.test.learned]]) {
    for (const [field, value] of Object.entries(expected)) assert.equal(score[field], value, `seed ${seed}: ${field}`);
  }
  return {
    seed,
    winnerIndex: experiment.winnerIndex,
    winnerTowers: plain(experiment.bestTowers),
    winnerTrainScore: plain(winner.train),
    winnerValidationScore: plain(winner.validation),
    finalists: experiment.candidates.filter((candidate) => candidate.validation).map((candidate) => ({
      index: candidate.index,
      train: plain(candidate.train),
      validation: plain(candidate.validation),
    })),
    test: {
      baseline,
      learned,
      detectedDelta: learned.detected - baseline.detected,
      meanCappedDeltaS: learned.meanCappedS - baseline.meanCappedS,
      regressionInDetections: learned.detected < baseline.detected,
      regressionInMeanCappedTime: learned.meanCappedS > baseline.meanCappedS,
    },
    // Array slot i is randomRoute(seed, 144 + i); null is a missed route.
    testDetectedAt: { baseline: before, learned: after },
  };
});
const baseline = summarize(rounds.flatMap((round) => round.testDetectedAt.baseline));
const learned = summarize(rounds.flatMap((round) => round.testDetectedAt.learned));
const result = {
  schemaVersion: 1,
  label: "synthetic-towers-only",
  reproduce: "From frontend: node scripts/benchmark-placement.cjs (or --check to verify the saved result)",
  sourceSha256,
  seeds,
  settings: plain(EXPERIMENT),
  baseline: { label: "Existing saved learned placement", towers: evidence.learned.towers },
  protocol: {
    distribution: "Independent uniform start and destination throughout the 3000 m square; uniform speed in [6, 16) m/s. No rejection of missed, edge, or difficult routes.",
    routeIndices: { train: [0, 79], validation: [80, 143], test: [144, 343] },
    selection: "48 candidates including the initial pair. Rank training results by most detections, then lowest mean capped time, then earliest candidate. Validate the top 8 plus the initial pair; select with the same ordering using validation only. Freeze the winner before evaluating the 200 test routes.",
    controls: "All five seeds use the identical starting pair and unchanged sensor range/FOV. Within each round, baseline and winner face the exact same 200 test routes. All five seeds are reported; no selection by test results.",
    timeMetrics: "First visible sample at 1 Hz including time zero and 180 s. Misses count as 180 s in the mean, p90 (nearest rank), and worst capped time. This does not claim a finite actual detection time for misses.",
    limitations: "Ideal flat-arena tower visibility only. Excludes terrain, camera errors, vehicle search, and live ArcticSim validation. The winner is the best tested candidate under this finite protocol; it is not a guaranteed global optimum or guaranteed coverage of every possible spawn.",
  },
  aggregate: {
    baseline,
    learned,
    detectedDelta: learned.detected - baseline.detected,
    meanCappedDeltaS: learned.meanCappedS - baseline.meanCappedS,
    roundsWithDetectionRegression: rounds.filter((round) => round.test.regressionInDetections).map((round) => round.seed),
    roundsWithMeanTimeRegression: rounds.filter((round) => round.test.regressionInMeanCappedTime).map((round) => round.seed),
  },
  rounds,
};

const args = process.argv.slice(2);
const summary = { label: result.label, seeds, baseline, learned, roundsWithDetectionRegression: result.aggregate.roundsWithDetectionRegression };
if (args.length > 1 || (args.length === 1 && args[0] !== "--check")) throw new Error("Usage: node scripts/benchmark-placement.cjs [--check]");
if (args[0] === "--check") {
  assert.deepEqual(JSON.parse(fs.readFileSync(destination, "utf8")), plain(result));
  assert.deepEqual(JSON.parse(fs.readFileSync(summaryDestination, "utf8")), plain(summary));
  console.log("Saved placement benchmark matches all five reproduced runs and source fingerprints.");
} else {
  fs.writeFileSync(destination, JSON.stringify(result, null, 2) + "\n");
  fs.writeFileSync(summaryDestination, JSON.stringify(summary, null, 2) + "\n");
  console.log(`Saved ${path.relative(repository, destination)}.`);
}
console.log(JSON.stringify({ aggregate: result.aggregate, rounds: rounds.map(({ seed, winnerIndex, test }) => ({ seed, winnerIndex, test })) }, null, 2));
