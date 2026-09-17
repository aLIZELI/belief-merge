import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SlotState,
  adjudicateConflicts,
  buildAdjudicationPrompt,
  findConflicts,
  mergeBranches,
  parseAdjudications,
  reconcileSymmetric,
  renderMerged,
} from '../lib/core/index.js';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/** Two branches asserting the SAME topic with EQUAL evidence -> a real tie. */
function tieSlots(evidence = 2) {
  const branches = [
    {
      id: 'branch-a',
      claims: [
        { key: 'database.engine', value: 'postgresql', evidence, text: 'We use PostgreSQL.', sourceId: 'branch-a' },
      ],
    },
    {
      id: 'branch-b',
      claims: [
        { key: 'database.engine', value: 'mysql', evidence, text: 'We use MySQL.', sourceId: 'branch-b' },
      ],
    },
  ];
  return mergeBranches(branches).slots;
}

/** Returns a scripted response per call, cycling on the last one. */
function scriptedLlm(responses) {
  let call = 0;
  return {
    calls: [],
    async complete(request) {
      this.calls.push(request);
      const response = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return typeof response === 'function' ? response(request) : response;
    },
  };
}

const resolution = (over) =>
  JSON.stringify({ resolutions: [{ key: 'database.engine', outcome: 'choose', value: 'postgresql', premises: ['c0.o0'], rationale: 'the quote names it', ...over }] });

/* ------------------------------------------------------------------ */
/* Detection                                                           */
/* ------------------------------------------------------------------ */

test('only tied slots become conflicts', () => {
  const tied = tieSlots();
  assert.equal(tied[0].decision.outcome, 'disputed');
  assert.equal(findConflicts(tied).length, 1);

  const decided = mergeBranches([
    { id: 'a', claims: [{ key: 'k', value: 'x', evidence: 4, text: 'x', sourceId: 'a' }] },
    { id: 'b', claims: [{ key: 'k', value: 'y', evidence: 1, text: 'y', sourceId: 'b' }] },
  ]).slots;
  assert.equal(decided[0].decision.outcome, 'resolved');
  assert.equal(findConflicts(decided).length, 0, 'a decided slot is not a conflict');
});

test('a conflict carries its competing values and their quotes', () => {
  const [conflict] = findConflicts(tieSlots());
  assert.equal(conflict.key, 'database.engine');
  const values = conflict.options.map((o) => o.value).sort();
  assert.deepEqual(values, ['mysql', 'postgresql']);
  for (const option of conflict.options) {
    assert.ok(option.quotes.length > 0, 'each option must carry a quote');
    assert.ok(option.sources.length > 0);
  }
});

/* ------------------------------------------------------------------ */
/* Prompt                                                              */
/* ------------------------------------------------------------------ */

test('the prompt states that option order carries no meaning', () => {
  const { system } = buildAdjudicationPrompt(findConflicts(tieSlots()));
  assert.match(system, /order carries no meaning/i);
  assert.match(system, /unresolvable.*GOOD answer/is);
  assert.match(system, /never\s+invent a value/i);
});

test('reversing the prompt flips option order without changing the values', () => {
  const conflicts = findConflicts(tieSlots());
  const forward = buildAdjudicationPrompt(conflicts, { reverse: false }).prompt;
  const backward = buildAdjudicationPrompt(conflicts, { reverse: true }).prompt;

  assert.notEqual(forward, backward, 'the two runs must differ');
  for (const value of ['postgresql', 'mysql']) {
    assert.match(forward, new RegExp(value));
    assert.match(backward, new RegExp(value));
  }
  // c0.o0 names a different value in each run -- this is why validation must
  // be against values, not option ids.
  const firstOfForward = forward.match(/option id="c0\.o0" value="([^"]+)"/)[1];
  const firstOfBackward = backward.match(/option id="c0\.o0" value="([^"]+)"/)[1];
  assert.notEqual(firstOfForward, firstOfBackward);
});

/* ------------------------------------------------------------------ */
/* Happy path                                                          */
/* ------------------------------------------------------------------ */

test('a settled tie is attached as a resolution without mutating the state', async () => {
  const slots = tieSlots();
  const before = slots[0].state.items.length;

  const result = await adjudicateConflicts(slots, {
    llm: scriptedLlm([resolution(), resolution()]),
    symmetryCheck: true,
  });

  assert.equal(result.mode, 'llm');
  assert.equal(result.conflicts, 1);
  assert.equal(result.resolved, 1);

  const slot = result.slots[0];
  assert.equal(slot.resolution.outcome, 'choose');
  assert.equal(slot.resolution.value, 'postgresql');
  assert.equal(slot.decision.outcome, 'disputed', 'the underlying decision is untouched');
  assert.equal(slot.state.items.length, before, 'provenance is preserved');
});

test('a settled tie renders as decided and notes it was a tie', () => {
  const slots = tieSlots().map((s) => ({
    ...s,
    resolution: { outcome: 'choose', value: 'postgresql', premises: [], rationale: '' },
  }));
  const text = renderMerged(slots, { budgetTokens: 500 }).text;
  assert.match(text, /database\.engine` = \*\*postgresql\*\*/);
  assert.match(text, /tie broken by adjudication/i);
  assert.doesNotMatch(text, /DISPUTED/);
});

test('"both" records compatible values instead of a winner', async () => {
  const result = await adjudicateConflicts(tieSlots(), {
    llm: scriptedLlm([resolution({ outcome: 'both', value: undefined })]),
    symmetryCheck: false,
  });
  assert.equal(result.slots[0].resolution.outcome, 'both');
  const text = renderMerged(result.slots, { budgetTokens: 500 }).text;
  assert.match(text, /BOTH hold/);
});

test('"conditional" requires and renders a guard', async () => {
  const okay = await adjudicateConflicts(tieSlots(), {
    llm: scriptedLlm([resolution({ outcome: 'conditional', value: undefined, guard: 'if deployed on K8s' })]),
    symmetryCheck: false,
  });
  assert.equal(okay.slots[0].resolution.guard, 'if deployed on K8s');
  assert.match(renderMerged(okay.slots, { budgetTokens: 500 }).text, /if deployed on K8s/);

  // A conditional without a guard is rejected outright.
  const bad = await adjudicateConflicts(tieSlots(), {
    llm: scriptedLlm([resolution({ outcome: 'conditional', value: undefined, guard: '' })]),
    symmetryCheck: false,
  });
  assert.equal(bad.slots[0].resolution, undefined, 'no resolution should be attached');
  assert.match(renderMerged(bad.slots, { budgetTokens: 500 }).text, /DISPUTED/);
});

/* ------------------------------------------------------------------ */
/* The two safety properties                                           */
/* ------------------------------------------------------------------ */

test('HALLUCINATION GUARD: an invented value is rejected', async () => {
  // "sqlite" appears nowhere in the conflict.
  const result = await adjudicateConflicts(tieSlots(), {
    llm: scriptedLlm([resolution({ value: 'sqlite' })]),
    symmetryCheck: false,
  });
  assert.equal(result.slots[0].resolution, undefined);
  assert.match(renderMerged(result.slots, { budgetTokens: 500 }).text, /DISPUTED/);
});

test('HALLUCINATION GUARD: an invented value is rejected even when cased differently', async () => {
  const result = await adjudicateConflicts(tieSlots(), {
    llm: scriptedLlm([resolution({ value: 'PostgreSQL' })]),
    symmetryCheck: false,
  });
  // "PostgreSQL" lowercases to a real option, so this one is accepted.
  assert.equal(result.slots[0].resolution.value, 'postgresql');
});

test('SYMMETRY: an order-sensitive answer is downgraded, not guessed', async () => {
  const forward = resolution({ value: 'postgresql' });
  const backward = resolution({ value: 'mysql' }); // flipped when order flipped
  const result = await adjudicateConflicts(tieSlots(), {
    llm: scriptedLlm([forward, backward]),
    symmetryCheck: true,
  });

  assert.equal(result.orderSensitive, 1);
  assert.equal(result.resolved, 0);
  assert.equal(result.slots[0].resolution.outcome, 'unresolvable');
  assert.match(result.slots[0].resolution.rationale, /order-sensitive/);
  assert.match(renderMerged(result.slots, { budgetTokens: 500 }).text, /DISPUTED/);
});

test('SYMMETRY: a stable answer survives the reversal', async () => {
  const stable = resolution({ value: 'postgresql' });
  const result = await adjudicateConflicts(tieSlots(), {
    llm: scriptedLlm([stable, stable]),
    symmetryCheck: true,
  });
  assert.equal(result.orderSensitive, 0);
  assert.equal(result.slots[0].resolution.value, 'postgresql');
});

test('reconcileSymmetric agrees on outcome+value, never on option ids', () => {
  const forward = new Map([['k', { key: 'k', outcome: 'choose', value: 'a' }]]);
  const backward = new Map([['k', { key: 'k', outcome: 'choose', value: 'a' }]]);
  assert.equal(reconcileSymmetric(forward, backward).orderSensitive, 0);

  const flipped = new Map([['k', { key: 'k', outcome: 'choose', value: 'b' }]]);
  assert.equal(reconcileSymmetric(forward, flipped).orderSensitive, 1);

  // A missing counterpart is a rejection, not agreement.
  assert.equal(reconcileSymmetric(forward, new Map()).rejected, 1);
});

test('the symmetry check costs exactly one extra call', async () => {
  const llm = scriptedLlm([resolution(), resolution()]);
  await adjudicateConflicts(tieSlots(), { llm, symmetryCheck: true });
  assert.equal(llm.calls.length, 2);

  const single = scriptedLlm([resolution()]);
  await adjudicateConflicts(tieSlots(), { llm: single, symmetryCheck: false });
  assert.equal(single.calls.length, 1);
});

/* ------------------------------------------------------------------ */
/* Robustness                                                          */
/* ------------------------------------------------------------------ */

test('parse rejects unknown keys and bad outcomes', () => {
  const conflicts = findConflicts(tieSlots());
  const payload = JSON.stringify({
    resolutions: [
      { key: 'not.a.conflict', outcome: 'choose', value: 'postgresql' },
      { key: 'database.engine', outcome: 'maybe', value: 'postgresql' },
    ],
  });
  const { resolutions, dropped } = parseAdjudications(payload, { conflicts });
  assert.equal(resolutions.size, 0);
  assert.equal(dropped.unknownKey, 1);
  assert.equal(dropped.badOutcome, 1);
});

test('a malformed adjudication response leaves the slots untouched', async () => {
  const slots = tieSlots();
  const result = await adjudicateConflicts(slots, {
    llm: scriptedLlm(['not json at all']),
    symmetryCheck: false,
  });
  assert.equal(result.mode, 'error');
  assert.equal(result.slots[0].resolution, undefined);
  assert.equal(result.slots[0].state.items.length, slots[0].state.items.length);
  assert.match(result.error, /JSON/i);
});

test('no ties -> no model call at all', async () => {
  const decided = mergeBranches([
    { id: 'a', claims: [{ key: 'k', value: 'x', evidence: 4, text: 'x', sourceId: 'a' }] },
    { id: 'b', claims: [{ key: 'k', value: 'y', evidence: 1, text: 'y', sourceId: 'b' }] },
  ]).slots;
  const llm = scriptedLlm([resolution()]);
  const result = await adjudicateConflicts(decided, { llm });
  assert.equal(result.mode, 'none');
  assert.equal(llm.calls.length, 0);
});

test('no llm -> skipped, no crash', async () => {
  const result = await adjudicateConflicts(tieSlots(), {});
  assert.equal(result.mode, 'skipped');
  assert.equal(result.slots[0].resolution, undefined);
});

test('adjudication is bounded by maxConflicts', async () => {
  const branches = [];
  for (let i = 0; i < 30; i += 1) {
    branches.push({ id: 'a', claims: [{ key: `k${i}`, value: 'x', evidence: 2, text: 'x', sourceId: 'a' }] });
    branches.push({ id: 'b', claims: [{ key: `k${i}`, value: 'y', evidence: 2, text: 'y', sourceId: 'b' }] });
  }
  const slots = mergeBranches(branches).slots;
  const llm = scriptedLlm(['{"resolutions":[]}']);
  const result = await adjudicateConflicts(slots, { llm, symmetryCheck: false, maxConflicts: 5 });
  assert.equal(result.conflicts, 5);
  assert.match(llm.calls[0].prompt, /5 conflict/);
});

test('adjudication is deterministic for identical input', async () => {
  const run = async () => {
    const result = await adjudicateConflicts(tieSlots(), {
      llm: scriptedLlm([resolution(), resolution()]),
      symmetryCheck: true,
    });
    return result.slots[0].resolution;
  };
  assert.deepEqual(await run(), await run());
});

/* ------------------------------------------------------------------ */
/* Integration with the merge entry point                              */
/* ------------------------------------------------------------------ */

test('SlotState stays the source of truth after adjudication', async () => {
  const slots = tieSlots();
  const result = await adjudicateConflicts(slots, {
    llm: scriptedLlm([resolution({ value: 'mysql' }), resolution({ value: 'mysql' })]),
  });
  const slot = result.slots[0];
  // The model chose mysql even though postgresql sorts first -- the annotation
  // still holds BOTH, and only the resolution layer carries the choice.
  assert.equal(slot.resolution.value, 'mysql');
  assert.deepEqual(
    slot.state.items.map((i) => i.value).sort(),
    ['mysql', 'postgresql'],
  );
  assert.ok(SlotState.of(...slot.state.items).items.length === 2);
});
