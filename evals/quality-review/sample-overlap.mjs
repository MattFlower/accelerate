import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readInputs } from './judge-trials.mjs';
import {
  cachedJudgment, isBlocking, judgingTrials, redact, requiredGoldDecisions, secretsForAuth, targetOf,
} from './judge.mjs';

const MERGE_RULES = { version: 2, window: 10, similarity: 0.7 };

function tokens(report) {
  const text = `${report.title} ${report.failure_scenario ?? ""}`.toLowerCase();
  return new Set((text.match(/[a-z0-9_]+(?:\.[a-z0-9_]+)*/g) ?? []).filter((t) => t.length >= 3));
}

function claimSimilarity(a, b) {
  const [x, y] = [tokens(a), tokens(b)];
  const shared = [...x].filter((t) => y.has(t)).length;
  const union = x.size + y.size - shared;
  return union ? shared / union : 0;
}

// Limitless e42003a src/pipeline/panel-merge.ts. The two samples supply distinct
// finder identities. The schema has no label (always equal), and eval cases
// have no prior findings (citation is undefined for both).
const sameClaim = (a, b) =>
  a.file !== "" && a.file === b.file && a.line > 0 && b.line > 0 &&
  Math.abs(a.line - b.line) <= 2 * MERGE_RULES.window && a.category === b.category &&
  a.security === b.security && claimSimilarity(a, b) >= MERGE_RULES.similarity;

function canonicalJSON(value) {
  return JSON.stringify(value, (_, entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    return Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]]));
  });
}

function findingOverlap(s1, s2) {
  const withPartner = s1.filter(a => s2.some(b => sameClaim(a, b))).length;
  const first = s1.map(canonicalJSON).sort();
  const second = s2.map(canonicalJSON).sort();
  // Choose the same traversal order when the sample labels are swapped.
  const [left, right] = (JSON.stringify(first) <= JSON.stringify(second)
    ? [first, second] : [second, first]).map(sample => sample.map(JSON.parse));
  const used = new Set();
  for (const finding of left) {
    const partner = right.findIndex((candidate, i) => !used.has(i) && sameClaim(finding, candidate));
    if (partner >= 0) used.add(partner);
  }
  const union = s1.length + s2.length - used.size;
  return { s1: s1.length, s2: s2.length, withPartner, matched: used.size, overlap: union ? used.size / union : null };
}

function groupIdentity(trial) {
  return {
    caseId: trial.caseId,
    runtime: trial.runtime,
    model: trial.modelRequested ?? trial.model,
    effort: trial.effortRequested ?? trial.effort,
    prompt: trial.promptSha256 ?? {
      promptBuilder: trial.promptBuilder,
      promptSourcePin: trial.promptSourcePin,
      verifierClause: trial.verifierClause,
      omitRequest: trial.omitRequest,
    },
  };
}

function summarize(overlaps) {
  const values = overlaps.filter(overlap => overlap !== null);
  const emptyPairs = overlaps.length - values.length;
  if (!values.length) return { mean: null, median: null, emptyPairs };
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return {
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    median: (values[middle] + values[Math.floor((values.length - 1) / 2)]) / 2,
    emptyPairs,
  };
}

function overlapReport(trials, cases, judges, cacheDir, secrets) {
  const catches = new Map();
  for (const { trial, item, output } of judgingTrials(trials, cases)) {
    const matches = judges.map(judge => cachedJudgment(cacheDir, judge, item, output, secrets)?.matches);
    if (matches.every(Boolean)) {
      catches.set(trial, [...requiredGoldDecisions(item, output, matches)]);
    }
  }

  const groups = new Map();
  let unjudged = 0;
  for (const trial of trials) {
    const key = JSON.stringify(groupIdentity(trial));
    if (!groups.has(key)) groups.set(key, []);
    if (trial.status !== 'ok') continue;
    groups.get(key).push(trial);
    if (!catches.has(trial)) unjudged++;
  }

  const pairs = [];
  const goldTotals = { both: 0, onlyS1: 0, onlyS2: 0, neither: 0 };
  for (const group of groups.values()) {
    if (group.length !== 2) continue;
    const s1 = group.find(trial => trial.sample === 1);
    const s2 = group.find(trial => trial.sample === 2);
    if (!s1 || !s2) continue;
    const gold = [];
    if (catches.has(s1) && catches.has(s2)) {
      const second = catches.get(s2);
      for (const [i, { id, caught }] of catches.get(s1).entries()) {
        const caughtByS2 = second[i].caught;
        const bucket = caught ? (caughtByS2 ? 'both' : 'onlyS1') : (caughtByS2 ? 'onlyS2' : 'neither');
        gold.push({ id, bucket });
        goldTotals[bucket]++;
      }
    }
    pairs.push({
      ...groupIdentity(s1),
      identicalFindings: canonicalJSON(s1.findings) === canonicalJSON(s2.findings),
      all: findingOverlap(s1.findings, s2.findings),
      blocking: findingOverlap(s1.findings.filter(isBlocking), s2.findings.filter(isBlocking)),
      unjudged: [s1, s2].filter(trial => !catches.has(trial)).length,
      gold,
    });
  }

  const { both, onlyS1, onlyS2, neither } = goldTotals;
  const total = both + onlyS1 + onlyS2 + neither;
  return {
    judges,
    summary: {
      pairs: pairs.length,
      incompleteGroups: groups.size - pairs.length,
      identicalPairs: pairs.filter(pair => pair.identicalFindings).length,
      unjudged,
      all: summarize(pairs.map(pair => pair.all.overlap)),
      blocking: summarize(pairs.map(pair => pair.blocking.overlap)),
      goldTotals,
      singleSampleRecall: total ? (2 * both + onlyS1 + onlyS2) / (2 * total) : null,
      unionOfJudgments: total ? (both + onlyS1 + onlyS2) / total : null,
    },
    pairs,
  };
}

export function main(args) {
  const opts = { judge: [] };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[++i];
    if (!['--trials', '--cases', '--judge', '--cache', '--out'].includes(flag) || !value || value.startsWith('--')) {
      throw new Error(`Invalid argument: ${flag}`);
    }
    if (flag === '--judge') opts.judge.push(targetOf(value));
    else opts[flag.slice(2)] = value;
  }
  if (opts.judge.length !== 2) throw new Error('exactly two --judge flags are required');
  for (const key of ['trials', 'cache', 'out']) {
    if (!opts[key]) throw new Error(`Required: --${key}`);
  }
  const { trials, cases } = readInputs(opts);
  const secrets = secretsForAuth(false);
  const report = overlapReport(trials, cases, opts.judge, opts.cache, secrets);
  writeFileSync(opts.out, redact(JSON.stringify(report, null, 2), secrets) + '\n');
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
