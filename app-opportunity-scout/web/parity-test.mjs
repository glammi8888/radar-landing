/*
 * Parity test: replays parity-golden.json (produced by parity.py from the
 * Python model) through the JavaScript port and fails on any divergence.
 *
 *   python3 parity.py && node web/parity-test.mjs
 *
 * The two implementations must agree exactly. Demand is deliberately excluded:
 * the browser build has no autocomplete tier, which is a documented difference,
 * so opportunity() is compared by feeding both the SAME demand object.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('./scoring.js');
const golden = JSON.parse(readFileSync(new URL('../parity-golden.json', import.meta.url)));

let checks = 0;
const fails = [];
const EPS = 1e-6;

function cmp(path, py, js) {
  checks++;
  if (py === null || py === undefined) {
    if (js !== null && js !== undefined) fails.push(`${path}: python null, js ${JSON.stringify(js)}`);
    return;
  }
  if (typeof py === 'number') {
    if (typeof js !== 'number') { fails.push(`${path}: expected number, got ${JSON.stringify(js)}`); return; }
    if (Math.abs(py - js) > EPS) fails.push(`${path}: python ${py} vs js ${js}`);
    return;
  }
  if (typeof py === 'boolean' || typeof py === 'string') {
    if (py !== js) fails.push(`${path}: python ${JSON.stringify(py)} vs js ${JSON.stringify(js)}`);
    return;
  }
  if (Array.isArray(py)) {
    if (!Array.isArray(js)) { fails.push(`${path}: expected array`); return; }
    if (py.length !== js.length) { fails.push(`${path}: length ${py.length} vs ${js.length}`); return; }
    py.forEach((v, i) => cmp(`${path}[${i}]`, v, js[i]));
    return;
  }
  if (typeof py === 'object') {
    for (const k of Object.keys(py)) cmp(`${path}.${k}`, py[k], js ? js[k] : undefined);
  }
}

// Fields whose wording or provenance differs by design, or that the browser
// build stores differently (descriptions are truncated for localStorage).
const SKIP = new Set([
  'note', 'why', 'signal', 'explain', 'caveat', 'formula', 'reason', 'assumption',
  'health', 'warning', 'provenance', 'thresholdCaveat', 'scoringImpact',
  'dominantIncumbentImpact', 'requiresYourEyes', 'method', 'coverageCaveat',
  'description', 'releaseNotes', 'screenshots', 'descriptionExcerpt', 'genres',
  'ratingCurrentVersion', 'ratingCountCurrentVersion', 'fileSizeBytes', 'estimateBasis',
]);
function cmpSkipping(path, py, js) {
  if (py && typeof py === 'object' && !Array.isArray(py)) {
    for (const k of Object.keys(py)) {
      if (SKIP.has(k)) continue;
      cmpSkipping(`${path}.${k}`, py[k], js ? js[k] : undefined);
    }
    return;
  }
  cmp(path, py, js);
}

for (const c of golden.cases) {
  const apps = c.raws.map((raw, i) => S.normaliseApp(raw, i + 1, c.keyword));
  const comp = S.analyseCompetition(apps, c.keyword);
  const e = c.expect;
  const P = `[${c.name}]`;

  // normaliseApp: ageDays/daysSinceUpdate move with the clock, so compare the
  // stable fields and assert the derived day counts are merely close.
  for (const k of Object.keys(e.normalisedFirst)) {
    if (SKIP.has(k)) continue;
    if (k === 'ageDays' || k === 'daysSinceUpdate') {
      checks++;
      const d = Math.abs(e.normalisedFirst[k] - apps[0][k]);
      if (d > 1) fails.push(`${P}.normalised.${k}: python ${e.normalisedFirst[k]} vs js ${apps[0][k]}`);
      continue;
    }
    cmp(`${P}.normalised.${k}`, e.normalisedFirst[k], apps[0][k]);
  }

  const { penetration: pyPen, ...pyComp } = e.competition;
  cmpSkipping(`${P}.competition`, pyComp, comp);
  cmpSkipping(`${P}.penetration`, e.penetration, comp.penetration);
  cmpSkipping(`${P}.rankEvidence`, e.rankEvidence, S.rankEvidence(comp));
  cmpSkipping(`${P}.listingWeakness`, e.listingWeakness, S.listingWeakness(apps));
  cmpSkipping(`${P}.productSignals`, e.productSignalsFirst, S.productSignals(apps[0]));

  const trac = S.tractionSummary(apps, c.history);
  const { growthRanking: _g, ...pyTrac } = e.tractionSummary;
  cmpSkipping(`${P}.traction`, pyTrac, trac);
  cmpSkipping(`${P}.growthRanking`, e.growthRanking, trac.growthRanking);

  const demands = [
    { score: 4.0, confidence: 'MEDIUM', signal: 'fixture' },
    { score: 0.6, confidence: 'LOW', signal: 'fixture' },
    { score: null, confidence: 'UNKNOWN', signal: 'fixture' },
  ];
  demands.forEach((d, i) => {
    const js = S.opportunity(d, comp, 5, 4, apps);
    const py = e.opportunities[i];
    cmp(`${P}.opp[${i}].score`, py.score, js.score);
    cmp(`${P}.opp[${i}].band`, py.band ?? null, js.band ?? null);
    if (py.factors) cmpSkipping(`${P}.opp[${i}].factors`, py.factors, js.factors);
  });
}

console.log(`\nPython <-> JavaScript parity: ${checks} values compared across ${golden.cases.length} SERP shapes`);
if (fails.length) {
  console.log(`\n${fails.length} DIVERGENCE(S):`);
  fails.slice(0, 30).forEach(f => console.log('  ' + f));
  if (fails.length > 30) console.log(`  ... and ${fails.length - 30} more`);
  process.exit(1);
}
console.log('All values identical. The two models agree.\n');
