/**
 * Meta-tests for MergeBench.
 *
 * A broken benchmark gives false confidence, and the first version of this one
 * WAS broken in two ways that made its numbers meaningless:
 *
 *   1. every question spanned branches, so the single-branch baseline was
 *      trivially zero and the comparison said nothing;
 *   2. "faithfulness" compared parsed (key, value) pairs against topic keys,
 *      so it measured "does this arm use topic keys" rather than fabrication.
 *
 * These tests exist so those regressions cannot return silently.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { generateScenario, mulberry32 } from '../bench/generate.js';
import { buildArms, armConcat, armSingleBranch, truncateToBudget } from '../bench/arms.js';
import {
  branchText,
  coverage,
  mentions,
  normalise,
  parseContext,
  questionCovered,
  scoreArm,
  scoreConflictResolution,
  scoreFaithfulness,
} from '../bench/score.js';
import { renderMerged } from '../lib/core/index.js';

/* ------------------------------------------------------------------ */
/* Determinism of the generator                                        */
/* ------------------------------------------------------------------ */

test('the PRNG is deterministic', () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  for (let i = 0; i < 10; i += 1) assert.equal(a(), b());
});

test('the same seed yields the same scenario', () => {
  const a = generateScenario({ seed: 7 });
  const b = generateScenario({ seed: 7 });
  assert.deepEqual(a.facts, b.facts);
  assert.deepEqual(a.questions, b.questions);
});

test('different seeds yield different scenarios', () => {
  const a = generateScenario({ seed: 1 });
  const b = generateScenario({ seed: 2 });
  assert.notDeepEqual(a.facts, b.facts);
});

/* ------------------------------------------------------------------ */
/* The property that makes the benchmark meaningful                    */
/* ------------------------------------------------------------------ */

test('bridge questions really do span branches', () => {
  const scenario = generateScenario({ seed: 3, branchCount: 2, topicCount: 8 });
  assert.ok(scenario.bridge.length > 0, 'expected bridge questions');
  for (const q of scenario.bridge) {
    assert.ok(q.spansBranches.length >= 2, `bridge question ${q.id} spans one branch`);
  }
});

test('local questions are answerable from a single branch', () => {
  const scenario = generateScenario({ seed: 3, branchCount: 2, topicCount: 8 });
  assert.ok(scenario.local.length > 0, 'expected local questions');
  for (const q of scenario.local) {
    assert.equal(q.spansBranches.length, 1);
    const branch = scenario.branches.find((b) => b.id === q.spansBranches[0]);
    assert.ok(questionCovered(q, branchText(branch)), `${q.id} not coverable from its own branch`);
  }
});

test('REGRESSION: the single-branch baseline is not trivially zero', () => {
  // With only cross-branch questions, the baseline is 0 and the comparison is
  // vacuous. Local questions are what make it non-degenerate.
  const scenario = generateScenario({ seed: 5, branchCount: 2, topicCount: 8 });
  const local = coverage(scenario.local, branchText(scenario.branches[0]));
  assert.ok(local.rate > 0, 'a single branch must be able to answer SOME questions');

  const bridge = coverage(scenario.bridge, branchText(scenario.branches[0]));
  assert.equal(bridge.rate, 0, 'and it must not answer any bridge question');
});

test('no single branch can answer every question', () => {
  const scenario = generateScenario({ seed: 9, branchCount: 2, topicCount: 10 });
  for (const branch of scenario.branches) {
    const all = coverage(scenario.questions, branchText(branch));
    assert.ok(all.rate < 1, `branch ${branch.id} answered everything alone`);
  }
});

/* ------------------------------------------------------------------ */
/* Value matching                                                      */
/* ------------------------------------------------------------------ */

test('mentions normalises underscores and case', () => {
  assert.ok(mentions('Records are stored as three_hundred.', 'three_hundred'));
  assert.ok(mentions('records stored as THREE HUNDRED', 'three_hundred'));
  assert.ok(mentions('the region is us-east', 'us_east'));
  assert.ok(!mentions('the region is us-east', 'eu_west'));
});

test('normalise strips markup that appears in rendered blocks', () => {
  assert.equal(normalise('`cache.ttl` = **sixty**'), 'cache ttl sixty');
});

/* ------------------------------------------------------------------ */
/* Parsing the real render format                                      */
/* ------------------------------------------------------------------ */

test('parseContext reads resolved slots from real renderer output', () => {
  const slots = [
    {
      key: 'database.engine',
      type: 'Fact',
      state: { items: [{ value: 'postgresql', source: 'a', evidence: 4 }] },
      decision: { outcome: 'resolved', winner: 'postgresql', tied: [] },
      claims: [{ key: 'database.engine', value: 'postgresql', evidence: 4, text: 'pg', sourceId: 'a', trust: 1 }],
    },
  ];
  const parsed = parseContext(renderMerged(slots, { budgetTokens: 800 }).text);
  assert.equal(parsed.get('database.engine').outcome, 'resolved');
  assert.deepEqual(parsed.get('database.engine').values, ['postgresql']);
});

test('parseContext reads disputed options from real renderer output', () => {
  const slots = [
    {
      key: 'cache.ttl',
      type: 'Fact',
      state: {
        items: [
          { value: 'sixty', source: 'a', evidence: 2 },
          { value: 'three_hundred', source: 'b', evidence: 2 },
        ],
      },
      decision: { outcome: 'disputed', winner: null, tied: ['sixty', 'three_hundred'] },
      claims: [
        { key: 'cache.ttl', value: 'sixty', evidence: 2, text: 'sixty', sourceId: 'a', trust: 1 },
        { key: 'cache.ttl', value: 'three_hundred', evidence: 2, text: 'three hundred', sourceId: 'b', trust: 1 },
      ],
    },
  ];
  const parsed = parseContext(renderMerged(slots, { budgetTokens: 800 }).text);
  const decision = parsed.get('cache.ttl');
  assert.equal(decision.outcome, 'disputed');
  assert.deepEqual([...decision.values].sort(), ['sixty', 'three_hundred']);
});

/* ------------------------------------------------------------------ */
/* Faithfulness, done correctly                                        */
/* ------------------------------------------------------------------ */

test('REGRESSION: faithfulness measures fabrication, not key style', () => {
  const scenario = generateScenario({ seed: 4, branchCount: 2, topicCount: 6 });

  // A context that invents a value from the topic vocabulary that no branch
  // ever asserted must be flagged.
  const invented = scenario.vocabulary.find(
    (v) => !scenario.facts.some((f) => normalise(f.value) === normalise(v)),
  );
  assert.ok(invented, 'expected an unasserted vocabulary value to exist');
  const bad = scoreFaithfulness(scenario, `The value is ${invented}.`);
  assert.ok(bad.invented >= 1, 'an invented value must be caught');

  // A context built only from asserted values must be clean.
  const honest = scoreFaithfulness(scenario, branchText(scenario.branches[0]));
  assert.equal(honest.invented, 0);
});

test('an arm that uses sentence keys is not falsely accused of fabrication', () => {
  // The old scorer flagged the heuristic arm at 100% because its keys are
  // sentences. Faithfulness must not depend on key style.
  const scenario = generateScenario({ seed: 6, branchCount: 2, topicCount: 6 });
  const text = branchText(scenario.branches[0]);
  assert.equal(scoreFaithfulness(scenario, text).invented, 0);
});

/* ------------------------------------------------------------------ */
/* Conflict resolution is measurable on any arm                        */
/* ------------------------------------------------------------------ */

test('conflict resolution distinguishes a resolved block from a pasted one', () => {
  const scenario = generateScenario({ seed: 8, branchCount: 2, topicCount: 8, conflictCount: 2 });

  // Pick a fact from a key that is ACTUALLY asserted twice. The first correct
  // fact in the list may belong to an uncontested key, where mentioning it
  // resolves no conflict at all -- that was a bug in this test.
  const asserted = scenario.facts.find(
    (f) => f.correct && scenario.facts.filter((x) => x.key === f.key).length > 1,
  );
  const rejected = scenario.facts.find((f) => !f.correct && f.key === asserted.key);

  const resolved = scoreConflictResolution(scenario, `The answer is ${asserted.value}.`);
  assert.ok(resolved.unambiguous >= 1, 'correct value alone must count as unambiguous');

  const pasted = scoreConflictResolution(
    scenario,
    `Someone said ${asserted.value} and someone else said ${rejected.value}.`,
  );
  assert.ok(pasted.ambiguous >= 1, 'both values present must count as ambiguous');
  assert.equal(pasted.unambiguous, 0);
});

test('an empty context resolves nothing', () => {
  const scenario = generateScenario({ seed: 8, branchCount: 2, topicCount: 8 });
  const result = scoreConflictResolution(scenario, '');
  assert.equal(result.unambiguous, 0);
  assert.equal(result.absent, result.total);
});

/* ------------------------------------------------------------------ */
/* Budget fairness                                                     */
/* ------------------------------------------------------------------ */

test('truncateToBudget respects the limit', () => {
  const text = Array.from({ length: 200 }, (_, i) => `line ${i} of some content`).join('\n');
  const cut = truncateToBudget(text, 50); // 50 tokens ~ 200 chars
  assert.ok(cut.length <= 200, `${cut.length} chars exceeds the 200-char budget`);
  assert.ok(cut.length > 0);
});

test('REGRESSION: every arm respects the same budget', async () => {
  const scenario = generateScenario({ seed: 2, branchCount: 2, topicCount: 10 });
  const budget = 200;
  const arms = await buildArms(scenario, { budgetTokens: budget, includeOracle: false });
  for (const arm of arms) {
    assert.ok(
      arm.tokens <= budget * 1.15,
      `arm ${arm.name} spent ${arm.tokens} tokens against a ${budget} budget`,
    );
  }
});

test('a small budget costs concatenation its bridge coverage', () => {
  // The core claim of the benchmark: pasting does not fit, extracting does.
  const scenario = generateScenario({ seed: 11, branchCount: 2, topicCount: 10 });
  const generous = armConcat(scenario.branches, 100000);
  const tight = armConcat(scenario.branches, 200);

  const generousCoverage = coverage(scenario.bridge, generous.text).rate;
  const tightCoverage = coverage(scenario.bridge, tight.text).rate;
  assert.ok(generousCoverage > tightCoverage, 'truncation must cost coverage');
});

/* ------------------------------------------------------------------ */
/* The benchmark can tell arms apart                                   */
/* ------------------------------------------------------------------ */

test('the panel separates the floor, the baseline and the ceiling', async () => {
  const scenario = generateScenario({ seed: 12, branchCount: 2, topicCount: 10 });
  // Deliberately a LOOSE budget: with nothing truncated, the only reason
  // concatenation is ambiguous is that it pastes both conflicting values.
  // At a tight budget it would look decisive merely by having lost one side.
  const arms = await buildArms(scenario, { budgetTokens: 100000 });
  const scored = new Map(arms.map((a) => [a.name, scoreArm(a, scenario)]));

  const none = scored.get('none');
  const oracle = scored.get('beliefmerge-oracle');
  const concat = scored.get('concat');

  assert.equal(none.bridgeCoverage, 0, 'no context answers nothing');
  assert.ok(oracle.bridgeCoverage > none.bridgeCoverage, 'the ceiling must beat the floor');
  assert.ok(oracle.conflictResolution.rate > concat.conflictResolution.rate,
    'the merge must resolve conflicts that pasting leaves ambiguous');
});

test('CAVEAT: at a tight budget "unambiguous" can mean information was lost', () => {
  // A truncating arm that drops the losing half of a conflict LOOKS like it
  // resolved the conflict. It did not -- it lost data. This is why the report
  // must be read with bridge coverage beside it, and why the claim above is
  // asserted at a LOOSE budget where nothing is truncated away.
  const scenario = generateScenario({ seed: 12, branchCount: 2, topicCount: 10 });
  const tight = armConcat(scenario.branches, 200);
  const loose = armConcat(scenario.branches, 100000);

  const tightScore = scoreConflictResolution(scenario, tight.text);
  const looseScore = scoreConflictResolution(scenario, loose.text);

  assert.ok(
    coverage(scenario.bridge, tight.text).rate <= coverage(scenario.bridge, loose.text).rate,
    'truncation must not IMPROVE bridge coverage',
  );
  assert.ok(
    tightScore.unambiguous >= looseScore.unambiguous,
    'the truncated arm can appear more decisive precisely because it lost data',
  );
});

test('scoring is deterministic', async () => {
  const scenario = generateScenario({ seed: 13, branchCount: 2, topicCount: 8 });
  const arms = await buildArms(scenario, { budgetTokens: 400 });
  const once = arms.map((a) => JSON.stringify(scoreArm(a, scenario)));
  const twice = arms.map((a) => JSON.stringify(scoreArm(a, scenario)));
  assert.deepEqual(once, twice);
});
