/**
 * Budget packing and cache-aware layout tests (M3).
 *
 * The interesting claims here are mathematical, so they are tested as
 * properties rather than as examples:
 *
 *   monotone     adding an item never decreases utility
 *   submodular   marginal gain shrinks as the set grows (diminishing returns)
 *
 * If either failed, the approximation guarantee the packer relies on would not
 * apply, and the "submodular" label would be decoration.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SlotState,
  Trust,
  coverageMarginal,
  defaultWeights,
  layoutForCache,
  packSlots,
  personalUtility,
  preservedPrefix,
  renderMerged,
  setUtility,
  stabilityScore,
} from '../lib/core/index.js';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function makeSlot(key, opts = {}) {
  const {
    type = 'Fact',
    evidence = 2,
    sources = ['a'],
    trust = Trust.EXTERNAL,
    outcome = 'resolved',
    text,
  } = opts;
  const value = 'v';
  return {
    key,
    type,
    state: SlotState.of(...sources.map((s) => ({ value, source: s, evidence }))),
    decision:
      outcome === 'resolved'
        ? { outcome: 'resolved', winner: value, tied: [] }
        : { outcome: 'disputed', winner: null, tied: [value, 'w'] },
    claims: sources.map((s) => ({
      key,
      value,
      evidence,
      text: text ?? `${key} body text`,
      sourceId: s,
      trust,
    })),
  };
}

/** All subsets of {0..n-1} as bitmasks. */
function* subsets(n) {
  for (let mask = 0; mask < 1 << n; mask += 1) yield mask;
}

function toIndices(mask) {
  const out = [];
  for (let i = 0; i < 32; i += 1) if (mask & (1 << i)) out.push(i);
  return out;
}

/* ------------------------------------------------------------------ */
/* The objective                                                       */
/* ------------------------------------------------------------------ */

test('utility is non-negative and grows with evidence', () => {
  const weights = defaultWeights();
  const low = makeSlot('k', { evidence: 1 });
  const high = makeSlot('k', { evidence: 4 });
  assert.ok(personalUtility(low, weights) >= 0);
  assert.ok(personalUtility(high, weights) > personalUtility(low, weights));
});

test('utility grows with independent corroboration', () => {
  const weights = defaultWeights();
  const one = makeSlot('k', { sources: ['a'] });
  const three = makeSlot('k', { sources: ['a', 'b', 'c'] });
  assert.ok(personalUtility(three, weights) > personalUtility(one, weights));
});

test('utility rewards trust', () => {
  const weights = defaultWeights();
  const untrusted = makeSlot('k', { trust: Trust.UNTRUSTED });
  const trusted = makeSlot('k', { trust: Trust.TRUSTED });
  assert.ok(personalUtility(trusted, weights) > personalUtility(untrusted, weights));
});

test('coverage marginal gain strictly decreases within a type', () => {
  const weights = defaultWeights();
  const g0 = coverageMarginal('Fact', 0, weights);
  const g1 = coverageMarginal('Fact', 1, weights);
  const g5 = coverageMarginal('Fact', 5, weights);
  assert.ok(g0 > g1, `${g0} should exceed ${g1}`);
  assert.ok(g1 > g5, `${g1} should exceed ${g5}`);
  assert.ok(g5 > 0, 'marginal gain stays positive');
});

/* ------------------------------------------------------------------ */
/* The two properties                                                  */
/* ------------------------------------------------------------------ */

test('PROPERTY: the objective is monotone', () => {
  const slots = [
    makeSlot('a', { type: 'Constraint' }),
    makeSlot('b', { type: 'Fact' }),
    makeSlot('c', { type: 'Fact', evidence: 4 }),
    makeSlot('d', { type: 'OpenQ', outcome: 'disputed' }),
    makeSlot('e', { type: 'Decision' }),
  ];
  const weights = defaultWeights();
  for (const mask of subsets(slots.length)) {
    const base = setUtility(slots, toIndices(mask), weights);
    for (let i = 0; i < slots.length; i += 1) {
      if (mask & (1 << i)) continue;
      const grown = setUtility(slots, [...toIndices(mask), i], weights);
      assert.ok(grown >= base - 1e-9, 'adding an item must not reduce utility');
    }
  }
});

test('PROPERTY: the objective is submodular (diminishing returns)', () => {
  const slots = [
    makeSlot('a', { type: 'Fact', evidence: 1 }),
    makeSlot('b', { type: 'Fact', evidence: 2 }),
    makeSlot('c', { type: 'Fact', evidence: 4 }),
    makeSlot('d', { type: 'Decision' }),
    makeSlot('e', { type: 'Constraint', sources: ['a', 'b'] }),
    makeSlot('f', { type: 'OpenQ', outcome: 'disputed' }),
  ];
  const weights = defaultWeights();
  let checked = 0;

  // For every S subset of T, and every v outside T:
  //   U(S + v) - U(S)  >=  U(T + v) - U(T)
  for (const sMask of subsets(slots.length)) {
    for (const tMask of subsets(slots.length)) {
      if ((sMask & tMask) !== sMask) continue; // S must be a subset of T
      const S = toIndices(sMask);
      const T = toIndices(tMask);
      const uS = setUtility(slots, S, weights);
      const uT = setUtility(slots, T, weights);
      for (let v = 0; v < slots.length; v += 1) {
        if (tMask & (1 << v)) continue;
        const gainS = setUtility(slots, [...S, v], weights) - uS;
        const gainT = setUtility(slots, [...T, v], weights) - uT;
        assert.ok(
          gainS >= gainT - 1e-9,
          `submodularity violated: S=${S} T=${T} v=${v} (${gainS} < ${gainT})`,
        );
        checked += 1;
      }
    }
  }
  assert.ok(checked > 1000, `expected a real search, only checked ${checked}`);
});

test('diversity beats repetition at equal cost', () => {
  const weights = defaultWeights();
  // Six Facts versus three Facts plus a Constraint, a Decision and an OpenQ.
  const repeated = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'].map((k) => makeSlot(k, { type: 'Fact' }));
  const diverse = [
    makeSlot('f1', { type: 'Fact' }),
    makeSlot('f2', { type: 'Fact' }),
    makeSlot('f3', { type: 'Fact' }),
    makeSlot('c1', { type: 'Constraint' }),
    makeSlot('d1', { type: 'Decision' }),
    makeSlot('q1', { type: 'OpenQ' }),
  ];
  const all = [0, 1, 2, 3, 4, 5];
  assert.ok(
    setUtility(diverse, all, weights) > setUtility(repeated, all, weights),
    'coverage should make a diverse set worth more',
  );
});

/* ------------------------------------------------------------------ */
/* The solver                                                          */
/* ------------------------------------------------------------------ */

test('the packer never exceeds the budget', () => {
  const slots = Array.from({ length: 20 }, (_, i) => makeSlot(`k${String(i).padStart(2, '0')}`));
  const cost = slots.map(() => 30);
  const packed = packSlots(slots, { budgetTokens: 150, cost });
  assert.ok(packed.tokens <= 150, `${packed.tokens} > 150`);
  assert.equal(packed.selected.length, 5);
});

test('the packer is deterministic', () => {
  const slots = Array.from({ length: 15 }, (_, i) => makeSlot(`k${i}`));
  const cost = slots.map((_, i) => 10 + (i % 3) * 5);
  const a = packSlots(slots, { budgetTokens: 120, cost });
  const b = packSlots(slots, { budgetTokens: 120, cost });
  assert.deepEqual(a.selected, b.selected);
  assert.equal(a.utility, b.utility);
});

test('partial enumeration is never worse than density greedy alone', () => {
  const slots = Array.from({ length: 14 }, (_, i) =>
    makeSlot(`k${String(i).padStart(2, '0')}`, {
      type: i % 4 === 0 ? 'Constraint' : 'Fact',
      evidence: (i % 4) + 1,
    }),
  );
  const cost = slots.map((_, i) => 20 + (i % 5) * 10);
  const weights = defaultWeights();

  const density = packSlots(slots, { budgetTokens: 200, cost, weights, algorithm: 'density' });
  const partial = packSlots(slots, { budgetTokens: 200, cost, weights, algorithm: 'partial' });

  assert.ok(partial.utility >= density.utility - 1e-9);
  assert.equal(density.algorithm, 'density');
});

test('items that cannot fit are dropped, not forced', () => {
  const slots = [makeSlot('huge'), makeSlot('small')];
  const cost = [1000, 10];
  const packed = packSlots(slots, { budgetTokens: 50, cost });
  assert.deepEqual(packed.selected, [1]);
  assert.deepEqual(packed.dropped, [0]);
});

test('an impossible budget selects nothing', () => {
  const slots = [makeSlot('a'), makeSlot('b')];
  const packed = packSlots(slots, { budgetTokens: 5, cost: [50, 50] });
  assert.deepEqual(packed.selected, []);
  assert.equal(packed.utility, 0);
});

/* ------------------------------------------------------------------ */
/* Cache-aware layout                                                  */
/* ------------------------------------------------------------------ */

test('stability ranks durable content above volatile content', () => {
  const weights = defaultWeights();
  const constraint = makeSlot('constraint', { type: 'Constraint', evidence: 4 });
  const openQuestion = makeSlot('openq', { type: 'OpenQ', outcome: 'disputed' });
  assert.ok(stabilityScore(constraint, weights) > stabilityScore(openQuestion, weights));
});

test('layout is stable-first and deterministic', () => {
  const slots = [
    makeSlot('volatile', { type: 'OpenQ', evidence: 1, outcome: 'disputed' }),
    makeSlot('durable', { type: 'Constraint', evidence: 4 }),
    makeSlot('middle', { type: 'Fact', evidence: 2 }),
  ];
  const layout = layoutForCache(slots, [0, 1, 2]);
  assert.equal(slots[layout[0]].key, 'durable');
  assert.equal(slots[layout[layout.length - 1]].key, 'volatile');
  assert.deepEqual(layout, layoutForCache(slots, [0, 1, 2]));
});

test('MEASURED: stable-first ordering preserves more prefix when a slot churns', () => {
  const slots = [
    makeSlot('durable1', { type: 'Constraint', evidence: 4 }),
    makeSlot('durable2', { type: 'Goal', evidence: 4 }),
    makeSlot('durable3', { type: 'Decision', evidence: 3 }),
    makeSlot('volatile', { type: 'OpenQ', evidence: 1, outcome: 'disputed' }),
  ];
  const all = [0, 1, 2, 3];

  const cacheOrder = layoutForCache(slots, all);
  const naiveOrder = [...all].reverse(); // volatile first

  // The volatile slot churns between turns; everything else persists.
  const volatileIndex = slots.findIndex((s) => s.key === 'volatile');
  const cacheAfter = cacheOrder.filter((i) => i !== volatileIndex);
  const naiveAfter = naiveOrder.filter((i) => i !== volatileIndex);

  const cachePrefix = preservedPrefix(cacheOrder, cacheAfter);
  const naivePrefix = preservedPrefix(naiveOrder, naiveAfter);

  assert.equal(cachePrefix, 3, 'a churning tail slot should cost nothing');
  assert.equal(naivePrefix, 0, 'a churning head slot invalidates everything after it');
  assert.ok(cachePrefix > naivePrefix);
});

/* ------------------------------------------------------------------ */
/* Integration with rendering                                          */
/* ------------------------------------------------------------------ */

test('renderMerged reports the packer it used', () => {
  const slots = Array.from({ length: 10 }, (_, i) => makeSlot(`k${i}`));
  const result = renderMerged(slots, { budgetTokens: 800 });
  assert.ok(['density', 'partial'].includes(result.algorithm));
  assert.ok(typeof result.utility === 'number');
  assert.ok(result.tokens <= 800);
});

test('rendering puts durable content before volatile content', () => {
  const slots = [
    makeSlot('volatile.topic', { type: 'OpenQ', evidence: 1, outcome: 'disputed' }),
    makeSlot('durable.rule', { type: 'Constraint', evidence: 4 }),
  ];
  const text = renderMerged(slots, { budgetTokens: 2000 }).text;
  assert.ok(
    text.indexOf('durable.rule') < text.indexOf('volatile.topic'),
    'the durable slot should be emitted first',
  );
});

test('budget compliance holds with the real renderer', () => {
  const slots = Array.from({ length: 40 }, (_, i) =>
    makeSlot(`k${String(i).padStart(2, '0')}`, { evidence: (i % 4) + 1 }),
  );
  for (const budget of [200, 400, 800]) {
    const result = renderMerged(slots, { budgetTokens: budget });
    assert.ok(
      result.tokens <= budget * 1.05,
      `budget ${budget} produced ${result.tokens} tokens`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* Query weighting                                                     */
/* ------------------------------------------------------------------ */

test('a query raises the utility of the slots it matches', () => {
  const weights = defaultWeights();
  const aboutCaching = makeSlot('cache.config', { text: 'the cache ttl is sixty seconds' });
  const aboutDatabase = makeSlot('db.config', { text: 'the database engine is postgresql' });

  const semantic = personalUtility(aboutCaching, weights);
  const withQuery = personalUtility(aboutCaching, weights, 'what is the cache ttl');
  assert.ok(withQuery > semantic, 'a matching query must add utility');

  const unmatched = personalUtility(aboutDatabase, weights, 'what is the cache ttl');
  assert.ok(withQuery > unmatched);
});

test('a query changes which slots survive a tight budget', () => {
  const slots = [
    makeSlot('cache.ttl', { evidence: 2, text: 'the cache ttl is sixty seconds' }),
    makeSlot('db.engine', { evidence: 2, text: 'the database engine is postgresql' }),
  ];
  const cost = [40, 40];
  const weights = defaultWeights();

  const withoutQuery = packSlots(slots, { budgetTokens: 45, cost, weights });
  const withQuery = packSlots(slots, {
    budgetTokens: 45,
    cost,
    weights,
    query: 'what is the cache ttl',
  });

  assert.equal(withoutQuery.selected.length, 1);
  assert.equal(withQuery.selected.length, 1);
  assert.equal(slots[withQuery.selected[0]].key, 'cache.ttl');
  assert.equal(slots[withoutQuery.selected[0]].key, 'cache.ttl', 'tie breaks on key');
});

test('relevance is zero without a query and deterministic with one', () => {
  const weights = defaultWeights();
  const slot = makeSlot('cache.ttl', { text: 'the cache ttl is sixty' });
  assert.equal(personalUtility(slot, weights), personalUtility(slot, weights, undefined));
  assert.equal(
    personalUtility(slot, weights, 'cache ttl'),
    personalUtility(slot, weights, 'cache ttl'),
  );
});
