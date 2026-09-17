import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SlotState,
  describeDecision,
  isConfluent,
  mergeIncremental,
  mergeNary,
  mergeStreaming,
  mergeSurfaces,
  reprCollapse,
  reprJoin,
  select,
  renderMerged,
  extractClaims,
} from '../lib/core/index.js';

/* ------------------------------------------------------------------ */
/* Proposition P1 -- the regression tests                              */
/* ------------------------------------------------------------------ */

const P1_WITNESS = [
  SlotState.singleton('a', 'b0', 1),
  SlotState.singleton('a', 'b1', 1),
  SlotState.singleton('b', 'b2', 2),
];

test('P1: the minimal counterexample is real', () => {
  // n-ary: a has weight 1+1 = 2, b has weight 2 -> tie -> disputed.
  const nary = mergeNary(P1_WITNESS, 'egalitarian').decision;
  assert.equal(nary.outcome, 'disputed');
  assert.deepEqual(nary.tied, ['a', 'b']);

  // Incremental with a lossy representation: merging B0+B1 first collapses
  // "two weak agreeing branches" into ONE weak assertion, so b wins.
  const incremental = mergeIncremental(P1_WITNESS, 'egalitarian', reprCollapse).decision;
  assert.equal(describeDecision(incremental), 'b');
});

test('P1: the failure is caused by the representation, not the score', () => {
  // Same witness, same score, information-preserving representation.
  const safe = mergeIncremental(P1_WITNESS, 'egalitarian', reprJoin).decision;
  assert.equal(describeDecision(safe), 'disputed{a,b}');
});

test('P1: join is confluent on the witness, collapse is not', () => {
  assert.equal(isConfluent(P1_WITNESS, 'egalitarian', reprJoin), true);
  assert.equal(isConfluent(P1_WITNESS, 'egalitarian', reprCollapse), false);
});

test('P1: the failure compounds along a derivation chain', () => {
  // b0 and b1 both assert; b2 refutes with equal weight.
  const branches = [
    SlotState.singleton('assert', 'b0', 1),
    SlotState.singleton('assert', 'b1', 1),
    SlotState.singleton('refute', 'b2', 1),
  ];
  // n-ary: assert 2 vs refute 1 -> assert wins -> the claim is IN.
  assert.equal(mergeNary(branches, 'egalitarian').decision.winner, 'assert');
  // Incremental collapse: corroboration is lost, it ties, the claim goes OUT.
  const collapsed = mergeIncremental(branches, 'egalitarian', reprCollapse).decision;
  assert.equal(collapsed.outcome, 'disputed');
});

test('P1: the production path (mergeStreaming) is confluent', () => {
  const witness = [
    SlotState.singleton('a', 'b0', 4),
    SlotState.singleton('b', 'b1', 3),
    SlotState.singleton('c', 'b2', 3),
    SlotState.of(
      { value: 'd', source: 'b3', evidence: 1 },
      { value: 'e', source: 'b3', evidence: 2 },
    ),
  ];
  assert.equal(isConfluent(witness, 'egalitarian', reprJoin), true);
  assert.equal(isConfluent(witness, 'elitist', reprJoin), true);
});

/* ------------------------------------------------------------------ */
/* Algebra                                                             */
/* ------------------------------------------------------------------ */

test('union is associative, commutative and idempotent', () => {
  const a = SlotState.of({ value: 'x', source: 'b0', evidence: 2 });
  const b = SlotState.of({ value: 'y', source: 'b1', evidence: 1 });
  const c = SlotState.of({ value: 'x', source: 'b2', evidence: 3 });

  assert.deepEqual(a.union(b).union(c).items, a.union(b.union(c)).items); // associativity
  assert.deepEqual(a.union(b).items, b.union(a).items); // commutativity
  assert.deepEqual(a.union(a).items, a.items); // idempotence
});

test('mergeStreaming is idempotent on a branch repeated', () => {
  const branch = SlotState.of(
    { value: 'a', source: 'b0', evidence: 2 },
    { value: 'b', source: 'b0', evidence: 1 },
  );
  const once = mergeStreaming([branch]).decision;
  const twice = mergeStreaming([branch, branch]).decision;
  assert.deepEqual(once, twice);
});

test('a genuine tie is reported, never guessed', () => {
  const tied = SlotState.of(
    { value: 'a', source: 'b0', evidence: 2 },
    { value: 'b', source: 'b1', evidence: 2 },
  );
  assert.equal(select(tied).outcome, 'disputed');
});

/* ------------------------------------------------------------------ */
/* Extraction                                                          */
/* ------------------------------------------------------------------ */

test('evidence levels follow role and block type', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'The pool size is twenty.' }] },
    { role: 'assistant', content: [{ type: 'reasoning', text: 'Maybe the pool is thirty.' }] },
  ];
  const claims = extractClaims(messages, { sourceId: 'b0' });
  const byText = new Map(claims.map((c) => [c.text, c]));
  assert.equal(byText.get('The pool size is twenty.').evidence, 4); // USER_STATED
  assert.equal(byText.get('Maybe the pool is thirty.').evidence, 1); // SPECULATIVE
});

test('a negated sentence lands in the same slot as its positive form', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'The migration is finished.' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'The migration is not finished.' }] },
  ];
  const claims = extractClaims(messages, { sourceId: 'b0' });
  assert.equal(claims.length, 2);
  assert.equal(claims[0].key, claims[1].key, 'both must share one semantic key');
  assert.deepEqual(
    claims.map((c) => c.value).sort(),
    ['assert', 'refute'],
  );
});

/* ------------------------------------------------------------------ */
/* End to end                                                          */
/* ------------------------------------------------------------------ */

test('a user statement outranks a speculative model guess', () => {
  const surfaces = [
    {
      id: 'branch-a',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'The database is PostgreSQL.' }] },
      ],
    },
    {
      id: 'branch-b',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'reasoning', text: 'The database is MySQL.' }],
        },
      ],
    },
  ];
  const merged = mergeSurfaces(surfaces);
  const postgres = merged.slots.find((s) => s.key.includes('postgresql'));
  const mysql = merged.slots.find((s) => s.key.includes('mysql'));
  // Different keys (no real alignment yet) -> both survive as separate slots.
  assert.ok(postgres, 'expected the postgres slot');
  assert.ok(mysql, 'expected the mysql slot');
  assert.equal(postgres.decision.winner, 'assert');
});

test('contradiction on the SAME key is decided by evidence', () => {
  const surfaces = [
    {
      id: 'branch-a',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'The cache is enabled.' }] }],
    },
    {
      id: 'branch-b',
      messages: [
        { role: 'assistant', content: [{ type: 'reasoning', text: 'The cache is not enabled.' }] },
      ],
    },
  ];
  const merged = mergeSurfaces(surfaces);
  assert.equal(merged.slots.length, 1, 'both opinions must collapse to one slot');
  const slot = merged.slots[0];
  assert.equal(slot.decision.winner, 'assert'); // user (4) beats speculation (1)
  assert.equal(slot.state.items.length, 2, 'both sides stay in the annotation');
});

test('rendering is deterministic and keeps disputes explicit', () => {
  const slots = [
    {
      key: 'x',
      state: SlotState.of(
        { value: 'a', source: 'b0', evidence: 2 },
        { value: 'b', source: 'b1', evidence: 2 },
      ),
      decision: { outcome: 'disputed', winner: null, tied: ['a', 'b'] },
    },
  ];
  const first = renderMerged(slots, { budgetTokens: 500 }).text;
  const second = renderMerged(slots, { budgetTokens: 500 }).text;
  assert.equal(first, second);
  assert.match(first, /DISPUTED/);
});

test('rendering respects the token budget', () => {
  const slots = Array.from({ length: 50 }, (_, i) => ({
    key: `key-${String(i).padStart(3, '0')}`,
    state: SlotState.of({ value: 'assert', source: 'b0', evidence: 2 }),
    decision: { outcome: 'resolved', winner: 'assert', tied: [] },
  }));
  // The trust banner is mandatory overhead (~90 tokens), so a realistic
  // budget is used here; the tiny-budget case is covered separately below.
  const small = renderMerged(slots, { budgetTokens: 200 });
  const large = renderMerged(slots, { budgetTokens: 5000 });
  assert.ok(small.included < large.included, 'a small budget must include fewer slots');
  assert.ok(small.tokens <= 200 * 1.2, 'budget should bound the output');
  assert.ok(large.tokens > small.tokens);
});

test('a budget below the mandatory banner overhead injects nothing', () => {
  const slots = [
    {
      key: 'k',
      state: SlotState.of({ value: 'assert', source: 'b0', evidence: 2 }),
      decision: { outcome: 'resolved', winner: 'assert', tied: [] },
    },
  ];
  const result = renderMerged(slots, { budgetTokens: 40 });
  // Neither dropping the safety banner nor silently exceeding the caller's
  // limit is acceptable, so the only honest output is nothing.
  assert.equal(result.text, '');
  assert.equal(result.included, 0);
  assert.equal(result.reason, 'budget-below-mandatory-overhead');
});
