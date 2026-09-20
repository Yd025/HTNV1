#!/usr/bin/env node
'use strict';

// Rebuild the report from the frozen experiment; never starts a new training run.
const fs = require('node:fs');
const path = require('node:path');
const { buildReportData } = require('./training-report-data.cjs');
const { renderStaticReport } = require('./training-report-static.cjs');
const experiments = path.resolve(__dirname, '../public/experiments');
const { data, csv } = buildReportData(experiments);
const template = fs.readFileSync(path.join(__dirname, 'training-report.template.html'), 'utf8');
const profile = JSON.parse(fs.readFileSync(path.join(experiments, 'arctic-profile.json'), 'utf8'));
const replacements = {
  '__REPORT_DATA__': JSON.stringify(data).replace(/</g, '\\u003c'),
  '__REPORT_CSV__': JSON.stringify(csv).replace(/</g, '\\u003c'),
};
let html = template;
// The saved HTML is readable even when a file preview strips scripts. Scripts
// enhance this complete initial snapshot with filters, pagination and downloads.
for (const [id, content] of Object.entries(renderStaticReport(data, profile))) {
  const element = new RegExp(`(<([\\w-]+)\\b[^>]*\\bid="${id}"[^>]*>)[\\s\\S]*?(<\\/\\2>)`);
  if (!element.test(html)) throw new Error(`Missing static report element: ${id}`);
  html = html.replace(element, (_match, open, _tag, close) => open + content + close);
}
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
