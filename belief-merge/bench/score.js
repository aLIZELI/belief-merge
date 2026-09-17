/**
 * MergeBench -- scoring (M6).
 *
 * Everything here is deterministic: the metrics are computed by parsing the
 * rendered context, not by asking a model. That keeps the benchmark cheap,
 * reproducible and honest about what it measures -- information retention in
 * the injected context. It does NOT measure whether a model then uses that
 * information well; an optional end-to-end arm exists for that, clearly
 * separated.
 *
 * The metric that matters most is **bridge gain**:
 *
 *     bridgeGain = coverage(merged) - max over branches of coverage(branch alone)
 *
 * A merge that cannot beat the best single branch has not earned its tokens.
 */

/** Normalise a value token or prose for comparison. */
export function normalise(text) {
  return String(text)
    .toLowerCase()
    .replace(/[_`*]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Does `text` mention `value`?
 * Values are distinctive tokens ("postgresql", "three hundred"); underscores
 * in keys/values are normalised to spaces on both sides.
 */
export function mentions(text, value) {
  const haystack = normalise(text);
  const needle = normalise(value);
  if (needle.length === 0) return false;
  return haystack.includes(needle);
}

/* ------------------------------------------------------------------ */
/* Parsing the rendered block                                          */
/* ------------------------------------------------------------------ */

const RESOLVED = /^- `([^`]+)` = \*\*([^*]+)\*\*/;
const DISPUTED = /^- \*\*DISPUTED\*\* `([^`]+)`/;
const OPTION = /^\s+- `([^`]+)`: /;
const COMPATIBLE = /^- `([^`]+)` — (BOTH hold|CONDITIONAL)/;
const EMPTY = /^- `([^`]+)`: \(no assertion\)/;

/**
 * Extract the decisions a rendered context presents.
 * @returns {Map<string, {outcome: string, values: string[]}>}
 */
export function parseContext(text) {
  const out = new Map();
  let current = null;

  for (const raw of String(text ?? '').split('\n')) {
    let m;
    if ((m = RESOLVED.exec(raw))) {
      out.set(m[1], { outcome: 'resolved', values: [m[2].trim()] });
      current = null;
    } else if ((m = DISPUTED.exec(raw))) {
      out.set(m[1], { outcome: 'disputed', values: [] });
      current = m[1];
    } else if ((m = COMPATIBLE.exec(raw))) {
      out.set(m[1], { outcome: 'compatible', values: [] });
      current = m[1];
    } else if ((m = EMPTY.exec(raw))) {
      out.set(m[1], { outcome: 'empty', values: [] });
      current = null;
    } else if (current && (m = OPTION.exec(raw))) {
      out.get(current).values.push(m[1]);
    }
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* Coverage                                                            */
/* ------------------------------------------------------------------ */

/** Text of one branch as the reader would see it. */
export function branchText(branch) {
  const parts = [];
  for (const message of branch.messages ?? []) {
    for (const block of message.content ?? []) {
      if (typeof block?.text === 'string') parts.push(block.text);
    }
  }
  return parts.join('\n');
}

/** A question is covered when every expected value appears in the text. */
export function questionCovered(question, text) {
  return Object.values(question.expect).every((value) => mentions(text, value));
}

export function coverage(questions, text) {
  if (questions.length === 0) return { covered: 0, total: 0, rate: 0 };
  let covered = 0;
  for (const q of questions) if (questionCovered(q, text)) covered += 1;
  return { covered, total: questions.length, rate: covered / questions.length };
}

/** Coverage split by question kind -- local is the baseline, bridge is the point. */
export function coverageByKind(questions, text) {
  return {
    all: coverage(questions, text),
    local: coverage(questions.filter((q) => q.kind === 'local'), text),
    bridge: coverage(questions.filter((q) => q.kind === 'bridge'), text),
  };
}

/**
 * The number a merge has to beat: the best any single branch achieves alone.
 * Averaged over every branch (not the max) so a lucky branch does not set an
 * impossible bar; `best` is also reported.
 */
export function singleBranchCoverage(questions, branches) {
  const per = branches.map((branch) => ({
    id: branch.id,
    ...coverage(questions, branchText(branch)),
  }));
  const best = per.reduce((a, b) => (b.rate > a.rate ? b : a), per[0]);
  return { per, best, mean: per.reduce((n, p) => n + p.rate, 0) / per.length };
}

/* ------------------------------------------------------------------ */
/* Conflict handling and faithfulness                                  */
/* ------------------------------------------------------------------ */

/**
 * For every key asserted more than once, the scenario says which value is
 * correct (the higher-evidence one). Did the merge present it?
 */
export function scoreConflicts(scenario, parsed) {
  const byKey = new Map();
  for (const fact of scenario.facts) {
    if (!byKey.has(fact.key)) byKey.set(fact.key, []);
    byKey.get(fact.key).push(fact);
  }

  let total = 0;
  let correct = 0;
  let wrong = 0;
  let missing = 0;
  const details = [];

  for (const [key, facts] of byKey) {
    if (facts.length < 2) continue;
    total += 1;
    const expected = facts.find((f) => f.correct);
    const decision = parsed.get(key);
    if (!decision) {
      missing += 1;
      details.push({ key, outcome: 'absent', expected: expected.value });
      continue;
    }
    // A "resolved" slot presents exactly one value; compatible presents several.
    const presented = new Set(decision.values.map(normalise));
    const expectedNorm = normalise(expected.value);
    if (presented.has(expectedNorm)) {
      correct += 1;
    } else if (decision.values.length === 0) {
      // Disputed with no options parsed: treat as not decided.
      missing += 1;
      details.push({ key, outcome: 'undecided', expected: expected.value });
    } else {
      wrong += 1;
      details.push({ key, outcome: 'wrong', presented: decision.values, expected: expected.value });
    }
  }

  return {
    total,
    correct,
    wrong,
    missing,
    accuracy: total ? correct / total : 1,
    details,
  };
}

/**
 * Every (key, value) the context presents should have been asserted by some
 * branch. A pair that was not is a fabrication.
 */
export function scoreFaithfulness(scenario, text) {
  // The right question is: does the block contain a value that NO branch ever
  // asserted? Comparing parsed (key, value) pairs against topic keys instead
  // measures "does this arm use topic keys", which the heuristic path cannot
  // and which has nothing to do with fabrication. That was a real bug in the
  // first version of this scorer.
  const assertedValues = new Set(scenario.facts.map((f) => normalise(f.value)));
  const vocabulary = scenario.vocabulary ?? [];
  const invented = vocabulary.filter(
    (value) => !assertedValues.has(normalise(value)) && mentions(text, value),
  );
  return {
    vocabularySize: vocabulary.length,
    invented: invented.length,
    rate: vocabulary.length ? invented.length / vocabulary.length : 0,
    examples: invented.slice(0, 5),
  };
}

/**
 * Conflict resolution measured on the TEXT, so it applies to every arm --
 * including concatenation, which presents no keyed decisions at all.
 *
 *   unambiguous  the correct value appears and the wrong one does not
 *   ambiguous    BOTH appear, leaving the reader to resolve it (concat)
 *   wrong-only   only the lower-evidence value appears
 *   absent       neither appears
 *
 * The keyed-decision metric above cannot see this: concat and the heuristic
 * path legitimately produce no topic keys, so scoring them as "0% correct"
 * conflated "did not decide" with "decided wrongly".
 */
export function scoreConflictResolution(scenario, text) {
  const byKey = new Map();
  for (const fact of scenario.facts) {
    if (!byKey.has(fact.key)) byKey.set(fact.key, []);
    byKey.get(fact.key).push(fact);
  }

  const counts = { total: 0, unambiguous: 0, ambiguous: 0, wrongOnly: 0, absent: 0 };
  for (const [, facts] of byKey) {
    if (facts.length < 2) continue;
    counts.total += 1;
    const correct = facts.find((f) => f.correct);
    const wrong = facts.find((f) => !f.correct);
    const hasCorrect = mentions(text, correct.value);
    const hasWrong = wrong ? mentions(text, wrong.value) : false;

    if (!hasCorrect && !hasWrong) counts.absent += 1;
    else if (hasCorrect && !hasWrong) counts.unambiguous += 1;
    else if (hasCorrect && hasWrong) counts.ambiguous += 1;
    else counts.wrongOnly += 1;
  }

  return {
    ...counts,
    rate: counts.total ? counts.unambiguous / counts.total : 1,
  };
}

/* ------------------------------------------------------------------ */
/* One arm                                                             */
/* ------------------------------------------------------------------ */

/**
 * @param {{name: string, text: string, tokens: number}} arm
 * @param {object} scenario
 * @returns {object} metrics
 */
export function scoreArm(arm, scenario) {
  const parsed = parseContext(arm.text);
  const cov = coverageByKind(scenario.questions, arm.text);
  const singleAll = singleBranchCoverage(scenario.questions, scenario.branches);
  const singleBridge = singleBranchCoverage(scenario.bridge, scenario.branches);
  const conflicts = scoreConflicts(scenario, parsed);
  const conflictResolution = scoreConflictResolution(scenario, arm.text);
  const faithfulness = scoreFaithfulness(scenario, arm.text);

  return {
    arm: arm.name,
    covered: cov.all.covered,
    questions: cov.all.total,
    coverage: cov.all.rate,
    localCoverage: cov.local.rate,
    bridgeCoverage: cov.bridge.rate,
    bridgeQuestions: cov.bridge.total,
    tokens: arm.tokens,
    tokensPerQuestion: cov.all.total ? arm.tokens / cov.all.total : 0,
    // The headline: bridge coverage over what the best single branch manages.
    bridgeGain: cov.bridge.rate - singleBridge.best.rate,
    localGain: cov.local.rate - singleAll.best.rate,
    bestSingleBranch: singleBridge.best.id,
    bestSingleBridgeRate: singleBridge.best.rate,
    bestSingleAllRate: singleAll.best.rate,
    meanSingleRate: singleAll.mean,
    conflicts: {
      total: conflicts.total,
      correct: conflicts.correct,
      wrong: conflicts.wrong,
      missing: conflicts.missing,
      accuracy: conflicts.accuracy,
    },
    conflictResolution,
    faithfulness,
  };
}
