const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const directory = path.join(__dirname, '../public/experiments');
const html = fs.readFileSync(path.join(directory, 'training-report.html'), 'utf8');
// Simulate a file preview removing every script, including application/json.
const preview = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
const content = id => {
  const match = preview.match(new RegExp(`<([\\w-]+)\\b[^>]*\\bid="${id}"[^>]*>`));
  assert(match, `Missing preview element ${id}`);
  const start = match.index + match[0].length;
  const tags = new RegExp(`<\\/?${match[1]}\\b[^>]*>`, 'g');
  tags.lastIndex = start;
  let depth = 1, tag;
  while ((tag = tags.exec(preview))) {
    if (tag[0].startsWith('</')) depth -= 1;
    else if (!tag[0].endsWith('/>')) depth += 1;
    if (depth === 0) return preview.slice(start, tag.index);
  }
  assert.fail(`Unclosed preview element ${id}`);
};

test('saved measurements and coordinates survive scripts being removed', () => {
  assert.match(content('duration-summary'), /4 minutes 28 seconds/);
  assert.match(content('opening-result'), /40%/);
  assert.match(content('result-summary'), /80 of 200 ships confirmed/);
  assert.match(content('metric-rows'), /40\.0%/);
  assert.match(content('metric-rows'), /29\.0%/);
  assert.equal((content('metric-rows').match(/<tr>/g) || []).length, 9);
  assert.equal((content('tower-rows').match(/<tr>/g) || []).length, 2);
  assert.match(content('tower-config'), /xy:1489\.583333,-2031\.250000/);
  assert.match(content('tower-config'), /xy:-677\.083333,1760\.416667/);
});

test('terrain and placement markers need no raster URL or script', () => {
  assert.match(content('terrain-layer'), /<path\b/);
  assert.doesNotMatch(preview, /<image\b|data:image\//);
  assert.equal((content('selected-markers').match(/<circle\b/g) || []).length, 2);
  assert.equal((content('default-markers').match(/<rect\b/g) || []).length, 2);
});

test('both saved detection curves are visible and have the full time series', () => {
  const chart = content('detection-chart');
  const curves = [...chart.matchAll(/<path\b[^>]*d="([^"]+)"[^>]*>/g)];
  assert.equal(curves.length, 2);
  for (const [, commands] of curves) assert.equal((commands.match(/H/g) || []).length, 60);
  assert.match(chart, /V162(?:\.0+)?(?:[\s"]|$)/); // 40% at y=250-40*2.2
  assert.match(content('deadline-summary'), /40\.0%.*29\.0%/);
});

test('mission preview and provenance remain readable without scripts', () => {
  assert.equal((content('episode-rows').match(/<tr>/g) || []).length, 20);
  assert.match(content('episode-rows'), /591926/);
  assert.match(content('episode-rows'), /591945/);
  assert.match(content('episode-rows'), /Confirmed/);
  assert.match(content('episode-rows'), /Missed/);
  assert.equal((content('source-rows').match(/<tr>/g) || []).length, 3);
});

test('complete evidence can be downloaded without a click handler', () => {
  assert.match(preview, /<a\b[^>]*id="download-json"[^>]*href="training-report-data\.json"[^>]*download/);
  assert.match(preview, /<a\b[^>]*id="download-csv"[^>]*href="training-missions\.csv"[^>]*download/);
  const data = JSON.parse(fs.readFileSync(path.join(directory, 'training-report-data.json'), 'utf8'));
  assert.deepEqual(Object.values(data.perEpisode).map(rows => rows.length), [200, 200, 200]);
  assert.equal(fs.readFileSync(path.join(directory, 'training-missions.csv'), 'utf8').trim().split(/\r?\n/).length, 601);
});
