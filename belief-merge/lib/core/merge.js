/**
 * Merge operators and the two merge SHAPES.
 *
 * Proposition P1 (settled by the exhaustive experiment in ../beliefmerge-t1):
 *
 *   Retaining full provenance  => the merge is a join over a join-semilattice,
 *                                 hence associative, commutative, idempotent
 *                                 and therefore confluent.  (0 / 72,760 counterexamples)
 *
 *   Collapsing to a bounded summary (winner + evidence)
 *                              => confluence FAILS, even on well-formed branches
 *                                 (9.9% - 26.2%), and the failure compounds
 *                                 through derivation structure.
 *
 * To make the theorem hard to violate, the API is shaped so that the lossy
 * representation is only reachable through `collapseForInjection()`, which is
 * meant to be called ONCE, at serialization time.
 */

import {
  MERGED_SOURCE,
  SCORES,
  SlotState,
  decisionKey,
  select,
} from './slot.js';

/* ------------------------------------------------------------------ */
/* Representations: what a merged slot looks like when re-merged       */
/* ------------------------------------------------------------------ */

/** Information-preserving. This is the only safe choice for streaming. */
export function reprJoin(state) {
  return state;
}

/**
 * Lossy: keep the winner plus a single max evidence level.
 * Exported for the regression test and for one-shot serialization only.
 * NOT safe between merges (P1).
 */
export function reprCollapse(state, scoreName = 'egalitarian') {
  const d = select(state, scoreName);
  if (d.outcome === 'empty') return SlotState.empty();
  const perValue = state.perValue();
  const keep = d.outcome === 'resolved' ? [d.winner] : d.tied;
  const items = [];
  for (const value of keep) {
    const maxEvidence = Math.max(...perValue.get(value).map((s) => s.evidence));
    items.push({ value, source: MERGED_SOURCE, evidence: maxEvidence });
  }
  return new SlotState(items);
}

export const REPRESENTATIONS = Object.freeze({
  join: reprJoin,
  collapse: reprCollapse,
});

/* ------------------------------------------------------------------ */
/* The two merge shapes                                                */
/* ------------------------------------------------------------------ */

/** Merge every branch at once -- the reference semantics. */
export function mergeNary(branches, scoreName = 'egalitarian') {
  let acc = SlotState.empty();
  for (const b of branches) acc = acc.union(b);
  return { state: acc, decision: select(acc, scoreName) };
}

/**
 * Fold branches pairwise, re-representing the accumulator each step.
 *
 * @param representation - pass `reprJoin` in production.  `reprCollapse`
 *   exists to demonstrate the failure mode (see the P1 tests).
 */
export function mergeIncremental(branches, scoreName = 'egalitarian', representation = reprJoin) {
  if (branches.length === 0) {
    return { state: SlotState.empty(), decision: select(SlotState.empty(), scoreName) };
  }
  let acc = branches[0];
  for (let i = 1; i < branches.length; i += 1) {
    acc = representation(acc.union(branches[i]), scoreName);
  }
  return { state: acc, decision: select(acc, scoreName) };
}

/**
 * Streaming merge of branches as they arrive.
 * Uses the provenance-retaining representation -- the P1-safe path.
 */
export function mergeStreaming(branches, scoreName = 'egalitarian') {
  return mergeIncremental(branches, scoreName, reprJoin);
}

/** True when every arrival order agrees with the n-ary merge. */
export function isConfluent(branches, scoreName = 'egalitarian', representation = reprJoin) {
  const ref = mergeNary(branches, scoreName).decision;
  for (const order of permutations(branches.map((_, i) => i))) {
    const got = mergeIncremental(
      order.map((i) => branches[i]),
      scoreName,
      representation,
    ).decision;
    if (decisionKey(got) !== decisionKey(ref)) return false;
  }
  return true;
}

function* permutations(arr) {
  if (arr.length <= 1) {
    yield arr;
    return;
  }
  for (let i = 0; i < arr.length; i += 1) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) yield [arr[i], ...p];
  }
}
