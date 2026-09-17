#!/usr/bin/env node
/**
 * MergeBench -- driver (M6).
 *
 *   node bench/run.js [--seeds=5] [--topics=8] [--branches=2] [--budget=1200] [--json]
 *
 * Reports, per arm: bridge coverage, the gain over the best single branch,
 * conflict-decision accuracy, fabrication rate, and token cost. The headline
 * number is `bridge gain` -- a merge that cannot beat the best single branch
 * has not earned the tokens it costs.
 */

import { buildArms } from './arms.js';
import { generateScenario } from './generate.js';
import { scoreArm } from './score.js';

function parseArgs(argv) {
  const out = { seeds: 5, topics: 8, branches: 2, budget: 1200, json: false, conflicts: 2 };
  for (const arg of argv) {
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(arg);
    if (!m) continue;
    const [, key, value] = m;
    if (key === 'json') out.json = true;
    else if (key in out) out[key] = Number(value);
  }
  return out;
}

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function pad(text, width, right = false) {
  const s = String(text);
  return right ? s.padStart(width) : s.padEnd(width);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const perArm = new Map();
  const scenarios = [];

  for (let seed = 1; seed <= args.seeds; seed += 1) {
    const scenario = generateScenario({
      seed,
      branchCount: args.branches,
      topicCount: args.topics,
      conflictCount: args.conflicts,
    });
    scenarios.push({
      seed,
      questions: scenario.questions.length,
      local: scenario.local.length,
      bridge: scenario.bridge.length,
      facts: scenario.facts.length,
    });

    const arms = await buildArms(scenario, { budgetTokens: args.budget });
    for (const arm of arms) {
      const metrics = scoreArm(arm, scenario);
      if (!perArm.has(arm.name)) perArm.set(arm.name, []);
      perArm.get(arm.name).push(metrics);
    }
  }

  const rows = [...perArm.entries()].map(([name, runs]) => ({
    arm: name,
    localCoverage: mean(runs.map((r) => r.localCoverage)),
    bridgeCoverage: mean(runs.map((r) => r.bridgeCoverage)),
    bestSingleBridge: mean(runs.map((r) => r.bestSingleBridgeRate)),
    bridgeGain: mean(runs.map((r) => r.bridgeGain)),
    unambiguous: mean(runs.map((r) => r.conflictResolution.rate)),
    ambiguous: mean(runs.map((r) => r.conflictResolution.ambiguous)),
    conflicts: mean(runs.map((r) => r.conflictResolution.total)),
    invented: mean(runs.map((r) => r.faithfulness.rate)),
    tokens: mean(runs.map((r) => r.tokens)),
    tokensPerQuestion: mean(runs.map((r) => r.tokensPerQuestion)),
  }));

  // Stable display order.
  const ORDER = ['none', 'single:', 'concat', 'beliefmerge-heuristic', 'beliefmerge-oracle'];
  rows.sort((a, b) => {
    const rank = (name) => {
      const i = ORDER.findIndex((o) => name === o || name.startsWith(o));
      return i === -1 ? ORDER.length : i;
    };
    return rank(a.arm) - rank(b.arm);
  });

  if (args.json) {
    console.log(JSON.stringify({ args, scenarios, rows }, null, 2));
    return 0;
  }

  const bridgeTotal = scenarios.reduce((n, s) => n + s.bridge, 0);
  const localTotal = scenarios.reduce((n, s) => n + s.local, 0);
  console.log('');
  console.log('MergeBench — does merging beat the best single branch?');
  console.log('='.repeat(100));
  console.log(
    `${args.seeds} scenario(s), ${args.branches} branches, ${args.topics} topics each, budget ${args.budget} tokens`,
  );
  console.log(`${localTotal} local questions (answerable from one branch), ${bridgeTotal} bridge questions (need both)`);
  console.log('');
  console.log(
    pad('arm', 24) +
      pad('local', 9, true) +
      pad('bridge', 9, true) +
      pad('best 1', 9, true) +
      pad('GAIN', 9, true) +
      pad('unambig', 9, true) +
      pad('both', 7, true) +
      pad('invent', 9, true) +
      pad('tokens', 9, true) +
      pad('tok/ques', 10, true),
  );
  console.log('-'.repeat(100));
  for (const r of rows) {
    console.log(
      pad(r.arm, 24) +
        pad(`${(r.localCoverage * 100).toFixed(0)}%`, 9, true) +
        pad(`${(r.bridgeCoverage * 100).toFixed(0)}%`, 9, true) +
        pad(`${(r.bestSingleBridge * 100).toFixed(0)}%`, 9, true) +
        pad(`${r.bridgeGain >= 0 ? '+' : ''}${(r.bridgeGain * 100).toFixed(0)}%`, 9, true) +
        pad(r.conflicts ? `${(r.unambiguous * 100).toFixed(0)}%` : '—', 9, true) +
        pad(r.conflicts ? r.ambiguous.toFixed(1) : '—', 7, true) +
        pad(`${(r.invented * 100).toFixed(0)}%`, 9, true) +
        pad(Math.round(r.tokens), 9, true) +
        pad(Math.round(r.tokensPerQuestion), 10, true),
    );
  }
  console.log('-'.repeat(100));
  console.log('');
  console.log('  local         questions answerable from ONE branch. A merge should keep this high');
  console.log('                while a single branch cannot exceed roughly 1/branches');
  console.log('  bridge        questions needing facts from DIFFERENT branches. This is the point');
  console.log('  best 1        the best any single branch scores on BRIDGE questions — the bar');
  console.log('  GAIN          bridge minus that bar. Negative means the merge wasted tokens');
  console.log('  unambig       of keys asserted twice, share where ONLY the correct value appears.');
  console.log('                READ WITH bridge: a truncating arm can look decisive simply because');
  console.log('                it lost the other side. High unambig + low bridge = data loss');
  console.log('  both          average number of keys where BOTH values appear, leaving it to the reader');
  console.log('  invent        share of the value vocabulary present that NO branch ever asserted');
  console.log('');
  console.log('  beliefmerge-oracle is fed a PERFECT extraction: it measures the PIPELINE ceiling,');
  console.log('  not achievable accuracy. beliefmerge-heuristic is the no-model, fully');
  console.log('  deterministic floor. Extraction quality on a real model sits between them.');
  console.log('');

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error('mergebench failed:', error);
    process.exit(1);
  });
