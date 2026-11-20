import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [flag, dir, ...rest] = process.argv.slice(2);
if (flag !== '--trials' || !dir || rest.length) throw new Error('Usage: node models-report.mjs --trials <dir>');

const groups = new Map();
let extraModels = 0;
for (const line of readFileSync(join(dir, 'trials.jsonl'), 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const trial = JSON.parse(line);
  const models = Object.keys(trial.modelsObserved ?? {}).sort();
  const key = JSON.stringify([trial.modelRequested, models]);
  const group = groups.get(key) ?? { modelRequested: trial.modelRequested, modelsObserved: models, trials: 0 };
  group.trials++;
  groups.set(key, group);
  if (trial.extraModels === true) extraModels++;
}
console.log(JSON.stringify({ groups: [...groups.values()], extraModels }, null, 2));
