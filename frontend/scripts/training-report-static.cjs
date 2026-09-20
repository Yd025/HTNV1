'use strict';

// Initial report content is baked into the HTML so file previews and script-free
// readers show the same evidence as the interactive report's default state.
const safe = (value) => String(value).replace(/[&<>"']/g,
  (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const number = (value, digits = 1) => value === null || value === undefined ? '—'
  : safe(Number(value).toLocaleString('en-CA', { minimumFractionDigits: digits, maximumFractionDigits: digits }));
const row = (cells) => '<tr>' + cells.map((cell, index) =>
  '<td' + (index > 0 ? ' class="num"' : '') + '>' + cell + '</td>').join('') + '</tr>';

function aggregate(rows) {
  const sum = (key) => rows.reduce((total, item) => total + (item[key] ?? 0), 0);
  const mean = (key) => sum(key) / rows.length;
  const estimates = sum('estimateSamples'), eligible = sum('postTowerSamples');
  return {
    episodes: rows.length, detected: rows.filter((item) => item.detectedAt !== null).length,
    detectionRate: mean('detectionRate'), handoffRate: mean('handoffRate'),
    meanCappedS: mean('meanCappedS'), rmseM: estimates ? Math.sqrt(sum('squaredErrorSum') / estimates) : null,
    custodyPct: mean('custodyPct'), postTowerCustodyPct: eligible ? 100 * sum('postTowerCustodySamples') / eligible : null,
    falseCueCount: sum('falseConfirmations'), coveragePct: mean('coveragePct'),
    estimateAvailabilityPct: mean('estimateAvailabilityPct'),
  };
}

function terrainPaths(profile) {
  const grid = profile.grid, size = grid.size, halfM = profile.halfM;
  if (!Number.isInteger(size) || size < 2 || !Number.isFinite(halfM) || halfM <= 0
      || grid.elevations.length !== size * size || grid.water.length !== size * size)
    throw new Error('The terrain profile must contain a complete square planning grid.');
  const maximum = Math.max(1, ...grid.elevations);
  const step = grid.cellM, groups = new Map();
  const coordinate = (value) => String(Number(value.toFixed(4)));
  const projectX = (worldX) => Math.max(0, Math.min(650, (worldX + halfM) / (2 * halfM) * 650));
  const projectY = (worldY) => Math.max(0, Math.min(650, (halfM - worldY) / (2 * halfM) * 650));
  const color = (index) => {
    if (grid.water[index]) return '#162331';
    const level = Math.round(Math.max(0, Math.min(1, grid.elevations[index] / maximum)) * 15);
    const shade = Math.round(125 + level / 15 * 110).toString(16).padStart(2, '0');
    return '#' + shade.repeat(3);
  };
  // Nodes include both map endpoints. Their cells extend half a step to each
  // side, clipped at the square boundary. Row zero is south, hence Y inversion.
  for (let y = 0; y < size; y += 1) {
    const bottom = projectY(grid.yMin + (y - .5) * step);
    const top = projectY(grid.yMin + (y + .5) * step);
    let start = 0;
    while (start < size) {
      const fill = color(y * size + start);
      let end = start + 1;
      while (end < size && color(y * size + end) === fill) end += 1;
      const left = projectX(grid.xMin + (start - .5) * step);
      const right = projectX(grid.xMin + (end - .5) * step);
      const rectangle = `M${coordinate(left)} ${coordinate(top)}H${coordinate(right)}V${coordinate(bottom)}H${coordinate(left)}Z`;
      groups.set(fill, (groups.get(fill) || '') + rectangle);
      start = end;
    }
  }
  return '<title>Fort Ross sampled planning grid: dark water, gray land shaded by sampled elevation</title>'
    + Array.from(groups, ([fill, path]) => `<path fill="${fill}" d="${path}"/>`).join('');
}

function markers(values, selected, halfM) {
  return values.map((tower, index) => {
    const x = (tower.x + halfM) / (2 * halfM) * 650;
    const y = (halfM - tower.y) / (2 * halfM) * 650;
    return `<g transform="translate(${safe(x)},${safe(y)})"><title>${safe(tower.id)}: X ${number(tower.x, 2)}, Y ${number(tower.y, 2)}</title>`
      + (selected ? '<circle r="15" fill="#86e5cb" stroke="#162331" stroke-width="3"/>'
        : '<rect x="-10" y="-10" width="20" height="20" fill="none" stroke="#b6c9ff" stroke-width="3"/>')
      + `<text text-anchor="middle" dy="5" font-size="13" font-family="Segoe UI,sans-serif" fill="${selected ? '#123b3c' : '#fff'}" font-weight="700">${index + 1}</text></g>`;
  }).join('');
}

function detectionChart(reference, selected) {
  const x = (time) => 65 + time / 300 * 835, y = (percent) => 250 - percent / 100 * 220;
  const rate = (rows, time) => 100 * rows.filter((item) => item.detectedAt !== null && item.detectedAt <= time).length / rows.length;
  let svg = '';
  for (const percent of [0, 20, 40, 60, 80, 100])
    svg += `<line x1="65" x2="900" y1="${y(percent)}" y2="${y(percent)}" stroke="#dce6ec"/><text x="51" y="${y(percent) + 4}" text-anchor="end" font-size="13" fill="#526979">${percent}%</text>`;
  for (const time of [0, 60, 120, 180, 240, 300])
    svg += `<text x="${x(time)}" y="279" text-anchor="middle" font-size="13" fill="#526979">${time}s</text>`;
  for (const [rows, color] of [[reference, '#365bb4'], [selected, '#006e65']]) {
    let path = `M${x(0)},${y(rate(rows, 0))}`;
    for (let time = 5; time <= 300; time += 5) path += ` H${x(time)} V${y(rate(rows, time))}`;
    svg += `<path d="${path}" fill="none" stroke="${color}" stroke-width="3"/><circle cx="${x(300)}" cy="${y(rate(rows, 300))}" r="5" fill="${color}"/>`;
  }
  return svg + `<line x1="${x(300)}" x2="${x(300)}" y1="25" y2="250" stroke="#819aaa" stroke-dasharray="4 5"/>`;
}

function metricRows(reference, selected) {
  const definitions = [
    ['Ships correctly confirmed', 'detectionRate', '%', true],
    ['Confirmed aircraft handoff', 'handoffRate', '%', true],
    ['Mean delay, misses counted at 300 s', 'meanCappedS', ' s', false],
    ['Pooled position error (RMSE)', 'rmseM', ' m', false],
    ['Aircraft custody outside tower view', 'postTowerCustodyPct', '%', true],
    ['Aircraft custody across all mission samples', 'custodyPct', '%', true],
    ['Available position estimate', 'estimateAvailabilityPct', '%', true],
    ['False confirmed cues, total', 'falseCueCount', '', false],
    ['Water grid observed during mission', 'coveragePct', '%', true],
  ];
  return definitions.map(([label, key, unit, up]) => {
    const missing = reference[key] == null || selected[key] == null;
    const delta = missing ? null : selected[key] - reference[key];
    const positive = !missing && (up ? delta > 0 : delta < 0);
    const negative = !missing && delta !== 0 && !positive;
    const digits = unit === '' ? 0 : 1, suffix = unit === '%' ? ' pp' : unit;
    return `<tr><td>${safe(label)}</td><td class="num">${number(reference[key], digits)}${reference[key] == null ? '' : unit}</td>`
      + `<td class="num">${number(selected[key], digits)}${selected[key] == null ? '' : unit}</td>`
      + `<td class="${positive ? 'good' : negative ? 'bad' : ''}">${missing ? 'Unavailable' : (delta > 0 ? '+' : '') + number(delta, digits) + suffix}</td></tr>`;
  }).join('');
}

function renderStaticReport(data, profile) {
  const seconds = data.wallSeconds, minutes = Math.floor(seconds / 60), remainder = Math.round(seconds % 60);
  const workload = data.workload, towers = data.trained.towers;
  const bearing = (tower) => (tower.heading + data.frame.positiveYTrueBearingDeg + 360) % 360;
  const reference = aggregate(data.perEpisode.untrained), selected = aggregate(data.perEpisode.trained);
  const trials = data.perEpisode.trained;
  return {
    'run-tag': safe(`Saved run ${data.seed} · ${data.missionVersion}`),
    'opening-result': `The selected sites confirmed <strong>${number(data.metrics.trained.detectionRate, 0)}% of ships</strong> within five simulated minutes, versus ${number(data.metrics.untrained.detectionRate, 0)}% with default sites and the same controller. Tracking after the ship left tower view remained a weakness.`,
    'duration-summary': `The recorded run took <strong>${number(minutes, 0)} minutes ${number(remainder, 0)} seconds</strong> (${number(seconds, 2)} seconds) of elapsed computer time.`,
    timing: [[data.protocol.motionTrajectories, 'synthetic boat routes'], [data.protocol.candidates, 'tower-pair candidates'],
      [data.protocol.trainEpisodes, 'shared training scenarios'], [data.protocol.testEpisodes, 'unseen test scenarios']]
      .map(([count, label]) => `<div><b>${number(count, 0)}</b><span>${safe(label)}</span></div>`).join(''),
    workload: [
      ['Motion statistics', '256 routes × 60 movement transitions', number(data.modelSummary.motionTransitions, 0) + ' transitions'],
      ['Placement search', '12 candidates × 24 shared training scenarios', number(workload.trainingEvaluations, 0) + ' missions'],
      ['Validation', '4 finalists × 24 separate validation scenarios', number(workload.validationEvaluations, 0) + ' missions'],
      ['Held-out evaluation', '3 policies × 200 identical unseen scenarios', number(workload.testEvaluations, 0) + ' missions'],
    ].map(row).join(''),
    'sim-time': `The search, validation and testing total ${number(workload.totalMissionEvaluations, 0)} mission evaluations, equivalent to ${number(workload.simulatedMissionHours, 0)} simulated mission-hours. Motion learning adds ${number(workload.motionTrajectoryHours, 1)} hours of boat trajectories. Repeated policy evaluations reuse scenario sets; these are not all independent scenarios.`,
    'tower-rows': towers.map((tower) => row([safe(tower.id), number(tower.x, 2), number(tower.y, 2),
      number(tower.heading, 2) + '°', number(bearing(tower), 2) + '°'])).join(''),
    'tower-config': safe(towers.map((tower, index) => `ASSET_${index === 0 ? 2 : 5}=tower,${tower.id},xy:${tower.x.toFixed(6)},${tower.y.toFixed(6)},${bearing(tower).toFixed(6)}`).join('\n')),
    'terrain-layer': terrainPaths(profile),
    'default-markers': markers(data.baseline.towers, false, data.halfM),
    'selected-markers': markers(towers, true, data.halfM),
    'result-summary': safe(`${selected.detected} of ${selected.episodes} ships confirmed`),
    'condition-summary': 'All conditions • 300-second deadline',
    'metric-caption': safe(`Selected towers vs default towers, same controller; ${selected.episodes} identical held-out missions.`),
    'metric-rows': metricRows(reference, selected),
    'detection-chart': detectionChart(data.perEpisode.untrained, trials),
    'deadline-summary': `By 300 seconds: ${number(selected.detectionRate, 1)}% confirmed with selected towers; ${number(reference.detectionRate, 1)}% with the reference.`,
    'episode-scope': safe(`Selected towers. ${trials.length} matching missions. This table shows one page; the downloads contain all 600 policy evaluations.`),
    'episode-rows': trials.slice(0, 20).map((trial) => `<tr><td>${safe(trial.seed)}</td><td>${safe(trial.condition)}</td>`
      + `<td><span class="badge ${trial.detectedAt === null ? 'miss' : ''}">${trial.detectedAt === null ? 'Missed' : 'Confirmed'}</span></td>`
      + `<td class="num">${number(trial.detectedAt, 0)}</td><td class="num">${number(trial.handoffAt, 0)}</td><td class="num">${number(trial.rmseM, 1)}</td></tr>`).join('')
      || '<tr><td colspan="6">No missions match these filters.</td></tr>',
    'page-info': trials.length ? safe(`1–${Math.min(20, trials.length)} of ${trials.length}`) : '0 missions',
    'saved-limitations': data.limitations.map((limitation) => '<li>' + safe(limitation) + '</li>').join(''),
    'source-rows': data.sources.map((source) => `<tr><td><a href="${safe(source.file)}" download>${safe(source.file)}</a></td>`
      + `<td class="num">${number(source.bytes / 1024, 1)} KB</td><td class="hash">${safe(source.sha256)}</td></tr>`).join(''),
    protocol: safe(JSON.stringify({ seed: data.seed, missionVersion: data.missionVersion, protocol: data.protocol,
      selectedIndex: data.selectedIndex, sourceVerification: data.sourceVerification }, null, 2)),
  };
}

module.exports = { renderStaticReport };
