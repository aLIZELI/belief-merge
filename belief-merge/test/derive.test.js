/**
 * Derivation propagation tests (M4).
 *
 * The mechanism exists for two situations that evidence arithmetic cannot see:
 *
 *   1. a conclusion whose premise was retracted -- the conclusion's own
 *      evidence weight is untouched, so nothing else would notice;
 *   2. a conclusion with SEVERAL independent routes, where losing one premise
 *      must NOT retract it. This is the whole reason to carry a graph rather
 *      than a boolean.
 */

import test from 'node:test';

import assert from 'node:assert/strict';

import {
  Trust,
  checkTrustInvariants,
  derivationTrustCeiling,
  isRetracted,
  justificationsOf,
  mergeBranches,
  propagateDerivation,
  renderMerged,
} from '../lib/core/index.js';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function branchFor(key, opts = {}) {
  const {
    value = 'v',
    evidence = 4,
    derivedFrom = [],
    trust = Trust.EXTERNAL,
    source = 'a',
  } = opts;
  return {
    id: source,
    trust,
    claims: [
      {
        key,
        value,
        evidence,
        text: `${key} body`,
        sourceId: source,
        trust,
        derivedFrom,
      },
    ],
  };
}

/** Build slots from a compact spec: [key, { derivedFrom, ... }]. */
function slotsFrom(specs) {
  const branches = specs.map(([key, opts]) => branchFor(key, opts));
  return mergeBranches(branches).slots;
}

function statusOf(slots, key) {
  return slotOf(slots, key)?.derivation?.status;
}

/** Slots are ordered by key, so index 0 is not "the slot I just added". */
function slotOf(slots, key) {
  return slots.find((s) => s.key === key);
}

/* ------------------------------------------------------------------ */
/* Reading the graph                                                   */
/* ------------------------------------------------------------------ */

test('justificationsOf accepts a single conjunction', () => {
  const slots = slotsFrom([['b', { derivedFrom: ['a', 'c'] }]]);
  assert.deepEqual(justificationsOf(slotOf(slots, 'b')), [['a', 'c']]);
});

test('justificationsOf accepts alternatives of conjunctions', () => {
  const slots = slotsFrom([['b', { derivedFrom: [['a', 'c'], ['d']] }]]);
  const routes = justificationsOf(slotOf(slots, 'b'));
  assert.equal(routes.length, 2);
  assert.deepEqual(routes[0], ['a', 'c']);
  assert.deepEqual(routes[1], ['d']);
});

test('duplicate routes are collapsed, so corroboration is not double counted', () => {
  const slots = mergeBranches([
    branchFor('b', { derivedFrom: [['a']], source: 'a1' }),
    branchFor('b', { derivedFrom: [['a']], source: 'a2' }),
  ]).slots;
  assert.equal(justificationsOf(slotOf(slots, 'b')).length, 1);
});

test('malformed premises are ignored rather than trusted', () => {
  const slots = slotsFrom([['b', { derivedFrom: ['a', '', 42, null] }]]);
  assert.deepEqual(justificationsOf(slotOf(slots, 'b')), [['a']]);
});

/* ------------------------------------------------------------------ */
/* The core semantics                                                  */
/* ------------------------------------------------------------------ */

test('an asserted slot with no premises is an axiom', () => {
  const slots = slotsFrom([['a', {}]]);
  const result = propagateDerivation(slots);
  assert.equal(slotOf(result.slots, 'a').derivation.status, 'axiom');
  assert.equal(result.inCount, 1);
});

test('a derived slot is founded when its premise is IN', () => {
  const slots = slotsFrom([['a', {}], ['b', { derivedFrom: ['a'] }]]);
  const result = propagateDerivation(slots);
  assert.equal(statusOf(result.slots, 'a'), 'axiom');
  assert.equal(statusOf(result.slots, 'b'), 'founded');
  assert.equal(result.retractedCount, 0);
});

test('a derived slot is RETRACTED when its premise is not established', () => {
  // "a" is never asserted, so nothing supports "b".
  const slots = slotsFrom([['b', { derivedFrom: ['a'] }]]);
  const result = propagateDerivation(slots);
  assert.equal(statusOf(result.slots, 'b'), 'retracted');
  assert.deepEqual(slotOf(result.slots, 'b').derivation.unmet, ['a']);
  assert.match(slotOf(result.slots, 'b').derivation.reason, /unmet/);
});

test('a DISPUTED premise is not established, so its conclusion falls', () => {
  // Two branches disagree about "a" with equal evidence -> disputed.
  const slots = mergeBranches([
    branchFor('a', { value: 'x', evidence: 2, source: 'a1' }),
    branchFor('a', { value: 'y', evidence: 2, source: 'a2' }),
    branchFor('b', { derivedFrom: ['a'], source: 'a1' }),
  ]).slots;
  assert.equal(slots.find((s) => s.key === 'a').decision.outcome, 'disputed');
  const result = propagateDerivation(slots);
  assert.equal(statusOf(result.slots, 'a'), 'unasserted');
  assert.equal(statusOf(result.slots, 'b'), 'retracted');
});

test('an unresolvable PREMISE stays unresolved, so its conclusion falls', () => {
  // Adjudication that declines to settle leaves the premise unestablished.
  const slots = mergeBranches([
    branchFor('a', { value: 'x', evidence: 2, source: 'a1' }),
    branchFor('a', { value: 'y', evidence: 2, source: 'a2' }),
    branchFor('b', { derivedFrom: ['a'], source: 'a1' }),
  ]).slots;
  const withResolution = slots.map((s) =>
    s.key === 'a' ? { ...s, resolution: { outcome: 'unresolvable' } } : s,
  );
  const result = propagateDerivation(withResolution);
  assert.equal(statusOf(result.slots, 'b'), 'retracted');
});

test('an adjudicated premise STANDS, so its conclusion survives', () => {
  const slots = mergeBranches([
    branchFor('a', { value: 'x', evidence: 2, source: 'a1' }),
    branchFor('a', { value: 'y', evidence: 2, source: 'a2' }),
    branchFor('b', { derivedFrom: ['a'], source: 'a1' }),
  ]).slots;
  const withResolution = slots.map((s) =>
    s.key === 'a' ? { ...s, resolution: { outcome: 'choose', value: 'x' } } : s,
  );
  const result = propagateDerivation(withResolution);
  assert.equal(statusOf(result.slots, 'b'), 'founded');
});

/* ------------------------------------------------------------------ */
/* Why a graph, not a boolean                                          */
/* ------------------------------------------------------------------ */

test('MULTI-SUPPORT: losing one route does not retract the conclusion', () => {
  const slots = slotsFrom([
    ['a', {}],
    // "c" is never established.
    ['b', { derivedFrom: [['a'], ['c']] }],
  ]);
  const result = propagateDerivation(slots);
  assert.equal(statusOf(result.slots, 'b'), 'founded', 'the surviving route should hold');
  assert.equal(result.retractedCount, 0);
});

test('MULTI-SUPPORT: losing EVERY route does retract it', () => {
  const slots = slotsFrom([
    ['b', { derivedFrom: [['c'], ['d']] }],
  ]);
  const result = propagateDerivation(slots);
  assert.equal(statusOf(result.slots, 'b'), 'retracted');
  assert.deepEqual(slotOf(result.slots, 'b').derivation.unmet, ['c', 'd']);
});

test('a conjunction needs ALL of its premises', () => {
  const slots = slotsFrom([
    ['a', {}],
    ['b', { derivedFrom: [['a', 'c']] }], // c missing
  ]);
  const result = propagateDerivation(slots);
  assert.equal(statusOf(result.slots, 'a'), 'axiom');
  assert.equal(statusOf(result.slots, 'b'), 'retracted');
  assert.deepEqual(slotOf(result.slots, 'b').derivation.unmet, ['c']);
});

/* ------------------------------------------------------------------ */
/* Propagation through a chain                                         */
/* ------------------------------------------------------------------ */

test('retraction is TRANSITIVE along a chain', () => {
  // a is disputed -> b falls -> c falls.
  const slots = mergeBranches([
    branchFor('a', { value: 'x', evidence: 2, source: 'a1' }),
    branchFor('a', { value: 'y', evidence: 2, source: 'a2' }),
    branchFor('b', { derivedFrom: ['a'], source: 'a1' }),
    branchFor('c', { derivedFrom: ['b'], source: 'a1' }),
  ]).slots;
  const result = propagateDerivation(slots);
  assert.equal(statusOf(result.slots, 'b'), 'retracted');
  assert.equal(statusOf(result.slots, 'c'), 'retracted');
  assert.deepEqual(result.retracted, ['b', 'c']);
});

test('a long founded chain survives intact', () => {
  const slots = slotsFrom([
    ['a', {}],
    ['b', { derivedFrom: ['a'] }],
    ['c', { derivedFrom: ['b'] }],
    ['d', { derivedFrom: ['c'] }],
  ]);
  const result = propagateDerivation(slots);
  assert.equal(result.retractedCount, 0);
  assert.equal(result.inCount, 4);
});

test('a CYCLE with no external support never becomes IN', () => {
  // Circular argument: x rests on y, y rests on x.
  const slots = slotsFrom([
    ['x', { derivedFrom: ['y'] }],
    ['y', { derivedFrom: ['x'] }],
  ]);
  const result = propagateDerivation(slots);
  assert.equal(result.retractedCount, 2);
});

test('a cycle WITH external support is founded', () => {
  const slots = slotsFrom([
    ['root', {}],
    ['x', { derivedFrom: [['y'], ['root']] }],
    ['y', { derivedFrom: ['x'] }],
  ]);
  const result = propagateDerivation(slots);
  assert.equal(statusOf(result.slots, 'x'), 'founded');
});

test('premises naming unknown keys are reported, not ignored', () => {
  const slots = slotsFrom([['b', { derivedFrom: ['ghost'] }]]);
  const result = propagateDerivation(slots);
  assert.deepEqual(result.unknownPremises, ['ghost']);
  assert.equal(statusOf(result.slots, 'b'), 'retracted');
});

/* ------------------------------------------------------------------ */
/* Trust across a derivation                                           */
/* ------------------------------------------------------------------ */

test('the derivation ceiling is the weakest premise, not the strongest', () => {
  const a = { key: 'a' };
  const c = { key: 'c' };
  const slot = {
    key: 'b',
    claims: [{ key: 'b', value: 'v', derivedFrom: [['a', 'c']] }],
  };
  const trustByKey = new Map([
    ['a', Trust.TRUSTED],
    ['c', Trust.UNTRUSTED],
  ]);
  assert.equal(derivationTrustCeiling(slot, (k) => trustByKey.get(k)), Trust.UNTRUSTED);
  assert.equal(derivationTrustCeiling(slot, () => Trust.TRUSTED), Trust.TRUSTED);
});

test('the ceiling uses the BEST route, not the worst', () => {
  const slot = {
    key: 'b',
    claims: [{ key: 'b', value: 'v', derivedFrom: [['weak'], ['strong']] }],
  };
  const trust = new Map([
    ['weak', Trust.UNTRUSTED],
    ['strong', Trust.TRUSTED],
  ]);
  assert.equal(derivationTrustCeiling(slot, (k) => trust.get(k)), Trust.TRUSTED);
});

test('an underived slot has no ceiling', () => {
  assert.equal(derivationTrustCeiling({ key: 'a', claims: [] }, () => Trust.TRUSTED), null);
});

test('INVARIANT: a derived claim may not outrank its weakest premise', () => {
  const slots = [
    {
      key: 'weak',
      type: 'Fact',
      state: { items: [{ value: 'v', source: 'a', evidence: 2 }] },
      decision: { outcome: 'resolved', winner: 'v', tied: [] },
      claims: [{ key: 'weak', value: 'v', evidence: 2, text: 'w', sourceId: 'a', trust: Trust.UNTRUSTED }],
    },
    {
      key: 'derived',
      type: 'Fact',
      state: { items: [{ value: 'v', source: 'a', evidence: 2 }] },
      decision: { outcome: 'resolved', winner: 'v', tied: [] },
      // Its own support looks trusted, but it rests on an untrusted premise.
      claims: [
        {
          key: 'derived',
          value: 'v',
          evidence: 2,
          text: 'd',
          sourceId: 'a',
          trust: Trust.TRUSTED,
          derivedFrom: ['weak'],
        },
      ],
    },
  ];
  const check = checkTrustInvariants(slots);
  assert.equal(check.ok, false);
  assert.ok(
    check.violations.some((v) => v.rule === 'derivation-ceiling'),
    JSON.stringify(check.violations),
  );
});

/* ------------------------------------------------------------------ */
/* Rendering and packing                                               */
/* ------------------------------------------------------------------ */

test('a retracted slot is marked and says why', () => {
  const slots = slotsFrom([['b', { derivedFrom: ['missing'] }]]);
  const { slots: annotated } = propagateDerivation(slots);
  const text = renderMerged(annotated, { budgetTokens: 1200 }).text;
  assert.match(text, /RETRACTED/);
  assert.match(text, /missing/);
});

test('a founded derived slot shows what it rests on', () => {
  const slots = slotsFrom([['a', {}], ['c', {}], ['b', { derivedFrom: [['a', 'c']] }]]);
  const { slots: annotated } = propagateDerivation(slots);
  const text = renderMerged(annotated, { budgetTokens: 1200 }).text;
  assert.match(text, /↳ _derived from: a, c_/);
  assert.doesNotMatch(text, /RETRACTED/);
});

test('a founded derived slot carries no retraction marker', () => {
  const slots = slotsFrom([['a', {}], ['b', { derivedFrom: ['a'] }]]);
  const { slots: annotated } = propagateDerivation(slots);
  const text = renderMerged(annotated, { budgetTokens: 1200 }).text;
  assert.doesNotMatch(text, /RETRACTED/);
});

test('retracted slots pack last and lose a tight budget', async () => {
  const { defaultWeights, personalUtility } = await import('../lib/core/index.js');
  const weights = defaultWeights();
  const live = slotsFrom([['a', {}]])[0];
  const dead = slotsFrom([['b', { derivedFrom: ['missing'] }]])[0];
  const { slots: annotated } = propagateDerivation([live, dead]);
  const [liveSlot, deadSlot] = annotated;

  assert.ok(
    personalUtility(deadSlot, weights) < personalUtility(liveSlot, weights) / 10,
    'a retracted claim must be worth far less',
  );
  assert.ok(personalUtility(deadSlot, weights) >= 0, 'utility must stay non-negative');
});
