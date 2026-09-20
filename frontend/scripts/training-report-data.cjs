'use strict';

// Read saved evidence only. This module never starts training or a simulator.
const fs = require('node:fs');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

const POLICIES = ['baseline', 'untrained', 'trained'];
const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);
const mean = (rows, key) => sum(rows, key) / rows.length;
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function near(actual, expected, label) {
  if (actual === null || expected === null) {
    assert.equal(actual, expected, label);
    return;
  }
  assert(Number.isFinite(actual) && Number.isFinite(expected), `${label}: expected finite numbers`);
  assert(Math.abs(actual - expected) <= 1e-8 * Math.max(1, Math.abs(expected)),
    `${label}: computed ${actual}, saved ${expected}`);
}
function objective(score) {
  const falseCues = score.falseConfirmations;
  return [-score.towerAcquisitionRate + 100 * falseCues,
    -score.handoffRate - .5 * score.custodyPct - .25 * (score.postTowerCustodyPct || 0)
      + .05 * score.handoffCappedS + .05 * score.meanCappedS + .02 * (score.rmseM || 0) + 100 * falseCues,
    score.distanceM];
}
function compareScores(a, b) {
  const left = objective(a), right = objective(b);
  for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}
function summarize(rows) {
  const episodes = rows.length;
  const detected = rows.filter((row) => row.detectedAt !== null).length;
  const handoffs = rows.filter((row) => row.handoffAt !== null).length;
  const estimateSamples = sum(rows, 'estimateSamples');
  const squaredErrorSum = sum(rows, 'squaredErrorSum');
  const postTowerSamples = sum(rows, 'postTowerSamples');
  const postTowerCustodySamples = sum(rows, 'postTowerCustodySamples');
  return { episodes, detected, handoffs, detectionRate: 100 * detected / episodes,
    handoffRate: 100 * handoffs / episodes, meanCappedS: mean(rows, 'meanCappedS'),
    rmseM: estimateSamples ? Math.sqrt(squaredErrorSum / estimateSamples) : null,
    postTowerCustodyPct: postTowerSamples ? 100 * postTowerCustodySamples / postTowerSamples : null,
    custodyPct: mean(rows, 'custodyPct'), estimateSamples, squaredErrorSum,
    postTowerSamples, postTowerCustodySamples };
}
function verifyAggregateShape(score, count, conditions, label) {
  assert.equal(score.episodes, count, `${label}: episode count`);
  assert.equal(Object.values(score.conditionEpisodes).reduce((a, b) => a + b, 0), count,
    `${label}: condition counts must sum to episode count`);
  assert.deepEqual(Object.keys(score.conditionEpisodes).sort(), [...conditions].sort(), `${label}: conditions`);
  for (const key of ['detectionRate', 'handoffRate', 'contactConfirmationRate']) {
    assert(score[key] >= 0 && score[key] <= 100, `${label}.${key}: invalid percent`);
    near(score[key] * count / 100, Math.round(score[key] * count / 100), `${label}.${key}: whole episode count`);
  }
  near(score.postTowerCustodyPct, score.postTowerSamples
    ? 100 * score.postTowerCustodySamples / score.postTowerSamples : null, `${label}: pooled custody`);
}
function verifyRows(rows, saved, protocol, label) {
  assert.equal(rows.length, protocol.testEpisodes, `${label}: expected all test episodes`);
  const [start, end] = protocol.seedRanges.test;
  const samples = protocol.horizonS / protocol.stepS + 1;
  rows.forEach((row, index) => {
    const context = `${label}[seed=${row.seed}]`;
    assert.equal(row.seed, start + index, `${context}: missing, repeated, or reordered seed`);
    assert(row.seed <= end, `${context}: seed outside test range`);
    assert(protocol.conditions.includes(row.condition), `${context}: unknown condition`);
    for (const [time, rate] of [['detectedAt', 'detectionRate'], ['handoffAt', 'handoffRate'],
      ['towerDetectedAt', 'towerAcquisitionRate'], ['contactConfirmedAt', 'contactConfirmationRate']]) {
      assert(row[time] === null || Number.isFinite(row[time]) && row[time] >= 0 && row[time] <= protocol.horizonS,
        `${context}.${time}: invalid timestamp`);
      near(row[rate], row[time] === null ? 0 : 100, `${context}.${rate}`);
    }
    assert.equal(row.towerDetectedAt, row.detectedAt, `${context}: tower acquisition mismatch`);
    near(row.meanCappedS, row.detectedAt === null ? protocol.horizonS : row.detectedAt, `${context}: capped time`);
    near(row.p90CappedS, row.meanCappedS, `${context}: single episode p90`);
    if (row.handoffAt !== null) assert(row.detectedAt !== null && row.handoffAt >= row.detectedAt,
      `${context}: handoff precedes acquisition`);
    near(row.handoffDelayS, row.handoffAt === null ? null : row.handoffAt - row.detectedAt, `${context}: handoff delay`);
    near(row.handoffCappedS, row.handoffDelayS === null ? protocol.horizonS : row.handoffDelayS, `${context}: capped handoff`);
    near(row.handoffs, row.handoffAt === null ? 0 : 1, `${context}: handoff count`);
    for (const key of ['estimateSamples', 'postTowerSamples', 'postTowerCustodySamples', 'falseConfirmations'])
      assert(Number.isInteger(row[key]) && row[key] >= 0, `${context}.${key}: invalid count`);
    assert(row.estimateSamples <= samples && row.postTowerSamples <= samples
      && row.postTowerCustodySamples <= row.postTowerSamples, `${context}: sample count bounds`);
    near(row.estimateAvailabilityPct, 100 * row.estimateSamples / samples, `${context}: estimate availability`);
    near(row.rmseM, row.estimateSamples ? Math.sqrt(row.squaredErrorSum / row.estimateSamples) : null, `${context}: RMSE`);
    near(row.postTowerCustodyPct, row.postTowerSamples
      ? 100 * row.postTowerCustodySamples / row.postTowerSamples : null, `${context}: post-tower custody`);
  });
  verifyAggregateShape(saved, rows.length, protocol.conditions, label);
  const pooled = summarize(rows);
  for (const key of ['episodes', 'detectionRate', 'handoffRate', 'meanCappedS', 'rmseM',
    'postTowerSamples', 'postTowerCustodySamples', 'postTowerCustodyPct']) near(pooled[key], saved[key], `${label}.${key}`);
  for (const key of ['coveragePct', 'custodyPct', 'estimateAvailabilityPct', 'distanceM', 'handoffs',
    'towerAcquisitionRate', 'contactConfirmationRate', 'contactHandoffs', 'handoffCappedS',
    'falseConfirmations', 'rejectedObservations', 'acceptedObservations', 'losses', 'reacquisitions'])
    near(mean(rows, key), saved[key], `${label}.${key}`);
  const delays = rows.filter((row) => row.handoffDelayS !== null);
  near(delays.length ? mean(delays, 'handoffDelayS') : null, saved.handoffDelayS, `${label}.handoffDelayS`);
  const times = rows.map((row) => row.meanCappedS).sort((a, b) => a - b);
  near(times[Math.ceil(.9 * times.length) - 1], saved.p90CappedS, `${label}.p90CappedS`);
  for (const source of Object.keys(saved.bySource)) near(rows.reduce((a, row) => a + row.bySource[source], 0),
    saved.bySource[source], `${label}.bySource.${source}`);
  for (const condition of protocol.conditions) assert.equal(rows.filter((row) => row.condition === condition).length,
    saved.conditionEpisodes[condition], `${label}: ${condition} episode count`);
}

function buildReportData(experimentsDir) {
  const dir = fs.realpathSync(experimentsDir);
  const root = fs.realpathSync(`${dir}/../../..`);
  const sources = [];
  const read = (file) => {
    const bytes = fs.readFileSync(`${dir}/${file}`);
    sources.push({ file, bytes: bytes.length, sha256: sha256(bytes) });
    return JSON.parse(bytes.toString('utf8'));
  };
  const report = read('graph-report.json');
  const model = read('graph-model.json');
  const profile = read('arctic-profile.json');
  const protocol = report.protocol;
  for (const key of ['schemaVersion', 'mode', 'missionVersion', 'sensorModel', 'placementFrozen',
    'seed', 'profileHash', 'sourceSha256', 'protocol', 'trained', 'selectedIndex'])
    assert.deepEqual(report[key], model[key], `graph-model / graph-report mismatch: ${key}`);
  assert.deepEqual(report.sources, profile.source, 'Terrain source provenance mismatch');
  assert.equal(report.placementFrozen, true, 'Tower placement must be frozen');
  assert.equal(report.comparison.testUsedForSelection, false, 'Test data must not select placement');
  assert.equal(protocol.placementFrozenBeforeMission, true, 'Protocol must freeze placement');
  assert(Number.isFinite(report.wallSeconds) && report.wallSeconds > 0, 'Missing elapsed pipeline time');
  assert.equal(protocol.horizonS % protocol.stepS, 0, 'Horizon must contain whole simulation steps');
  const rangeCounts = { motion: protocol.motionTrajectories, train: protocol.trainEpisodes,
    validation: protocol.validationEpisodes, test: protocol.testEpisodes };
  const ranges = Object.entries(protocol.seedRanges);
  assert.deepEqual(ranges.map(([key]) => key).sort(), Object.keys(rangeCounts).sort(), 'Unexpected seed partitions');
  ranges.forEach(([name, [start, end]], index) => {
    assert(Number.isInteger(start) && Number.isInteger(end), `${name}: seed endpoints must be integers`);
    assert.equal(end - start + 1, rangeCounts[name], `${name}: seed range size mismatch`);
    for (const [other, [otherStart, otherEnd]] of ranges.slice(index + 1))
      assert(end < otherStart || otherEnd < start, `Seed leakage between ${name} and ${other}`);
  });
  assert.equal(model.motion.trainingTrajectories, protocol.motionTrajectories, 'Motion trajectory count mismatch');
  assert.equal(model.motion.stepS, protocol.stepS, 'Motion cadence mismatch');
  assert.equal(model.motion.trainingTransitions, protocol.motionTrajectories * protocol.horizonS / protocol.stepS,
    'Motion transition count mismatch');
  assert.equal(report.modelSummary.motionTrajectories, model.motion.trainingTrajectories, 'Model summary trajectory count');
  assert.equal(report.modelSummary.motionTransitions, model.motion.trainingTransitions, 'Model summary transition count');
  assert.deepEqual(report.modelSummary.weights, model.trained.weights, 'Model summary legacy weights');
  near(model.motion.prior.reduce((a, b) => a + b, 0), 1, 'Motion prior probability sum');
  const transitionSums = new Array(model.motion.prior.length).fill(0);
  for (const [from, to, probability] of model.motion.transitions) {
    assert(Number.isInteger(from) && Number.isInteger(to) && from >= 0 && to >= 0
      && from < transitionSums.length && to < transitionSums.length && probability >= 0 && probability <= 1,
    'Invalid motion transition');
    transitionSums[from] += probability;
  }
  transitionSums.forEach((value, index) => near(value, 1, `Motion transition row ${index}`));
  assert.equal(report.history.length, protocol.candidates, 'Candidate history count mismatch');
  let best = null;
  for (const [index, row] of report.history.entries()) {
    assert.equal(row.index, index, 'Candidate history index mismatch');
    verifyAggregateShape(row.train, protocol.trainEpisodes, protocol.conditions, `candidate ${index} train`);
    const improves = best === null || compareScores(row.train, best) < 0;
    assert.equal(row.accepted, improves, `candidate ${index}: accepted flag mismatch`);
    if (improves) best = row.train;
    if (row.validation) verifyAggregateShape(row.validation, protocol.validationEpisodes, protocol.conditions,
      `candidate ${index} validation`);
  }
  const byTraining = [...report.history].sort((a, b) => compareScores(a.train, b.train) || a.index - b.index);
  const finalists = [...new Set([0, ...byTraining.slice(0, 3).map((row) => row.index)])].sort((a, b) => a - b);
  const validated = report.history.filter((row) => row.validation);
  assert.deepEqual(validated.map((row) => row.index), finalists, 'Validation finalists disagree with training objective');
  const winner = [...validated].sort((a, b) => compareScores(a.validation, b.validation) || a.index - b.index)[0];
  assert.equal(winner.index, report.selectedIndex, 'Selected placement is not the validation winner');
  assert.deepEqual(report.trained, { towers: winner.towers, weights: winner.weights }, 'Selected model/history mismatch');
  assert.deepEqual(report.baseline.towers, report.history[0].towers, 'Baseline/history mismatch');
  assert.deepEqual(Object.keys(report.perEpisode).sort(), [...POLICIES].sort(), 'Expected three paired test policies');
  const conditionMetrics = {};
  for (const policy of POLICIES) {
    const rows = report.perEpisode[policy];
    verifyRows(rows, report.metrics[policy], protocol, policy);
    rows.forEach((row, i) => assert.equal(row.condition, report.perEpisode.baseline[i].condition,
      `Paired test condition mismatch at seed ${row.seed}`));
    conditionMetrics[policy] = Object.fromEntries(protocol.conditions.map((condition) =>
      [condition, summarize(rows.filter((row) => row.condition === condition))]));
  }
  assert.equal(report.detectionCurve.length, protocol.horizonS / protocol.stepS + 1, 'Detection curve length');
  for (const [index, point] of report.detectionCurve.entries()) {
    assert.equal(point.t, index * protocol.stepS, 'Detection curve cadence');
    for (const policy of POLICIES) near(100 * report.perEpisode[policy].filter((row) =>
      row.detectedAt !== null && row.detectedAt <= point.t).length / protocol.testEpisodes,
    point[policy], `Detection curve ${policy} at ${point.t}s`);
  }
  near(report.metrics.baseline.meanCappedS - report.metrics.trained.meanCappedS,
    report.comparison.meanSecondsSaved, 'Saved mean time difference');
  near(report.metrics.trained.detectionRate - report.metrics.baseline.detectionRate,
    report.comparison.detectionRateGain, 'Saved detection percentage-point difference');
  assert.equal(report.replays.length, protocol.testEpisodes, 'Trained replay count');
  report.replays.forEach((replay, index) => {
    assert.deepEqual(replay.metrics, report.perEpisode.trained[index], `Trained replay metrics mismatch ${index}`);
    assert.deepEqual(replay.towers, report.trained.towers, `Trained replay placement mismatch ${index}`);
  });
  const sourceVerification = { normalization: 'CRLF converted to LF, matching the training fingerprint',
    allMatch: true, files: Object.entries(report.sourceSha256).map(([name, expectedSha256]) => {
      const bytes = fs.readFileSync(`${root}/backend/${name}`);
      const digest = sha256(bytes.toString('utf8').replace(/\r\n/g, '\n'));
      assert.equal(digest, expectedSha256, `Training source fingerprint mismatch: backend/${name}`);
      return { file: `backend/${name}`, bytes: bytes.length, expectedSha256, sha256: digest, matches: true };
    }) };
  const placements = (towers) => towers.map(({ id, x, y, z, heading, pitch }) => ({ id, x, y,
    cameraZ: z, approximateGroundZ: z - profile.assetHeightsM.tower, worldHeading: heading,
    trueHeading: ((heading + profile.frame.positiveYTrueBearingDeg) % 360 + 360) % 360, pitch }));
  const trainingEvaluations = report.history.reduce((total, row) => total + row.train.episodes, 0);
  const validationEvaluations = validated.reduce((total, row) => total + row.validation.episodes, 0);
  const testEvaluations = POLICIES.reduce((total, key) => total + report.perEpisode[key].length, 0);
  const totalMissionEvaluations = trainingEvaluations + validationEvaluations + testEvaluations;
  const workload = { motionTrajectories: protocol.motionTrajectories, trainingEvaluations,
    validationCandidates: validated.length, validationEvaluations, testEvaluations, totalMissionEvaluations,
    simulatedMissionHours: totalMissionEvaluations * protocol.horizonS / 3600,
    motionTrajectoryHours: protocol.motionTrajectories * protocol.horizonS / 3600 };
  const { replays, sources: sourceTerrain, history, ...retained } = report;
  const data = { ...retained,
    reportMetadata: { title: 'Fort Ross tower placement — saved training and evaluation report',
      evidenceType: 'Offline synthetic experiment', timingScope: 'Full recorded training, validation and test pipeline; isolated model-fit duration was not recorded',
      verification: 'All saved per-episode metrics reconciled; paired test seeds and training/validation separation verified' },
    site: profile.site, frame: profile.frame, origin: profile.origin, halfM: profile.halfM,
    terrainGrid: { size: profile.grid.size, cellM: profile.grid.cellM },
    sensors: profile.sensors, assetHeightsM: profile.assetHeightsM,
    placements: placements(report.trained.towers), baselinePlacements: placements(report.baseline.towers),
    history: history.map(({ index, towers, weights, train, validation, accepted }) =>
      ({ index, towers, weights, train, validation: validation || null, accepted })),
    conditionMetrics, workload, sources, sourceVerification, sourceTerrain };
  const columns = ['policy', 'seed', 'condition', 'detectedAt', 'missed', 'detectionRate', 'handoffAt',
    'handoffRate', 'meanCappedS', 'rmseM', 'custodyPct', 'postTowerSamples', 'postTowerCustodySamples', 'falseConfirmations'];
  const escape = (value) => value === null || value === undefined ? '' : `"${String(value).replace(/"/g, '""')}"`;
  const lines = [columns.join(','), ...POLICIES.flatMap((policy) => report.perEpisode[policy].map((row) => {
    const values = { ...row, policy, missed: row.detectedAt === null };
    return columns.map((key) => escape(values[key])).join(',');
  }))];
  return { data, csv: `${lines.join('\n')}\n` };
}

module.exports = { buildReportData };
