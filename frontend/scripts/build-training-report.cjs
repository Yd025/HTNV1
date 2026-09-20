#!/usr/bin/env node
'use strict';

// Rebuild the report from the frozen experiment; never starts a new training run.
const fs = require('node:fs');
const path = require('node:path');
const { buildReportData } = require('./training-report-data.cjs');
const experiments = path.resolve(__dirname, '../public/experiments');
const { data, csv } = buildReportData(experiments);
const template = fs.readFileSync(path.join(__dirname, 'training-report.template.html'), 'utf8');
const replacements = {
  '__REPORT_DATA__': JSON.stringify(data).replace(/</g, '\\u003c'),
  '__REPORT_CSV__': JSON.stringify(csv).replace(/</g, '\\u003c'),
  '__TERRAIN_IMAGE__': 'data:image/png;base64,' + fs.readFileSync(path.join(experiments, 'fort-ross-terrain.png')).toString('base64'),
};
let html = template;
for (const [token, value] of Object.entries(replacements)) {
  if (html.split(token).length !== 2) throw new Error(`Expected exactly one ${token} placeholder`);
  html = html.replace(token, () => value);
}
fs.writeFileSync(path.join(experiments, 'training-report.html'), html);
fs.writeFileSync(path.join(experiments, 'training-report-data.json'), JSON.stringify(data, null, 2) + '\n');
fs.writeFileSync(path.join(experiments, 'training-missions.csv'), csv);
console.log(JSON.stringify({ report: 'frontend/public/experiments/training-report.html', bytes: Buffer.byteLength(html),
  wallSeconds: data.wallSeconds, seed: data.seed, missions: data.workload.totalMissionEvaluations,
  testRows: Object.values(data.perEpisode).reduce((sum, rows) => sum + rows.length, 0) }, null, 2));
