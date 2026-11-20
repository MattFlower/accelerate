import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [flag, dir, ...rest] = process.argv.slice(2);
if (flag !== '--trials' || !dir || rest.length) throw new Error('Usage: node dropped-report.mjs --trials <dir>');

const reference = /[A-Za-z0-9_./-]+:\d+/;
const rows = [];
let totalDropped = 0, totalReferenced = 0, totalProseOnly = 0, totalEmpty = 0, emptyTrials = 0;
for (const line of readFileSync(join(dir, 'trials.jsonl'), 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const trial = JSON.parse(line);
  if (trial.droppedField !== 'on' || trial.status !== 'ok') continue;
  const dropped = trial.dropped.length;
  let referenced = 0, proseOnly = 0, empty = 0;
  for (const item of trial.dropped) {
    const evidence = item.evidence.trim();
    if (reference.test(evidence)) referenced++;
    else if (evidence) proseOnly++;
    else empty++;
  }
  rows.push({ caseId: trial.caseId, runtime: trial.runtime, modelRequested: trial.modelRequested,
    sample: trial.sample, dropped, referenced, proseOnly, empty });
  totalDropped += dropped;
  totalReferenced += referenced;
  totalProseOnly += proseOnly;
  totalEmpty += empty;
  if (dropped === 0) emptyTrials++;
}
console.log(JSON.stringify({
  rows,
  trials: rows.length,
  meanDroppedPerTrial: rows.length ? totalDropped / rows.length : null,
  shareReferenced: totalDropped ? totalReferenced / totalDropped : null,
  shareProseOnly: totalDropped ? totalProseOnly / totalDropped : null,
  shareEmpty: totalDropped ? totalEmpty / totalDropped : null,
  shareWithoutCodeProof: totalDropped ? (totalProseOnly + totalEmpty) / totalDropped : null,
  emptyTrials,
}, null, 2));
