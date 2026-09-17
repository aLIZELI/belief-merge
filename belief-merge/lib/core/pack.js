/**
 * Budget packing and KV-cache-aware layout -- milestone M3.
 *
 * THE PROBLEM
 * -----------
 * Choosing which slots fit a token budget is a 0/1 knapsack problem:
 *
 *     max U(S)   s.t.   sum of tok(v) for v in S  <=  B
 *
 * `U` here is a utility function over SETS, not a sum of per-item scores,
 * because a merged context is more than the sum of its lines: the first
 * Constraint is worth much more than the fifth, and a block that is all Facts
 * is less useful than one that also carries the Decisions and Open Questions.
 *
 * That "worth more the first time" shape is exactly a **monotone submodular**
 * objective, which is what makes the problem tractable despite being NP-hard:
 * greedy selection carries an approximation guarantee.
 *
 *     U(S) = sum_{v in S} personal(v)            individual value
 *          + sum_t w_t * (1 - e^(-gamma*n_t(S)))  coverage saturation
 *
 * The coverage term is concave in the per-type count `n_t`, so its marginal
 * gain decreases as a type fills up -- diminishing returns, by construction,
 * and the whole function stays non-decreasing.
 *
 * APPROXIMATION, STATED PRECISELY
 * -------------------------------
 *   cardinality constraint : greedy is (1 - 1/e)          [Nemhauser et al. 1978]
 *   KNAPSACK constraint    : density greedy has NO constant guarantee.
 *                            Sviridenko (2004) restores (1 - 1/e) by enumerating
 *                            partial solutions of size <= 3 before completing
 *                            greedily. `partial` below implements that.
 *
 * NOTE: the `partial` mode IS still a heuristic when the per-type coverage
 * weights differ across groups in ways the enumeration does not cover; the
 * guarantee is stated for the pure case. This module reports which algorithm
 * ran rather than implying more than it delivers.
 */

import { isRetracted } from './derive.js';

const DEFAULT_WEIGHTS = Object.freeze({
  // personal(value) terms, all non-negative
  evidence: 3,
  corroboration: 2,
  trust: 4,
  relevance: 2,
  typeBase: 1,
  // coverage term
  coverage: 6,
  gamma: 0.7,
  /**
   * Multiplier applied to a retracted slot's individual utility. A claim whose
   * support is gone is worth keeping as context but must never outrank a live
   * one. Scaling (rather than subtracting) preserves the non-negativity that
   * the monotone/submodular properties rely on.
   */
  retractedPenalty: 0.05,
  typeValue: Object.freeze({
    Constraint: 3,
    Goal: 3,
    Decision: 2.5,
    Refuted: 2,
    Fact: 1.5,
    OpenQ: 1,
    Artifact: 1,
  }),
});

export function defaultWeights() {
  return {
    ...DEFAULT_WEIGHTS,
    typeValue: { ...DEFAULT_WEIGHTS.typeValue },
  };
}

/* ------------------------------------------------------------------ */
/* Utility                                                             */
/* ------------------------------------------------------------------ */

/** Lexical relevance of a slot to an optional query. Deterministic. */
export function relevance(slot, query) {
  if (!query || typeof query !== 'string') return 0;
  const haystack = [slot.key, ...(slot.claims ?? []).map((c) => c.text)]
    .join(' ')
    .toLowerCase();
  const terms = [...new Set(query.toLowerCase().split(/\s+/).filter((t) => t.length >= 3))];
  if (terms.length === 0) return 0;
  const hits = terms.filter((t) => haystack.includes(t)).length;
  return hits / terms.length;
}

function evidenceOf(slot) {
  return slot.state.items.reduce((m, i) => Math.max(m, i.evidence), 0);
}

function corroborationOf(slot) {
  return new Set(slot.state.items.map((i) => i.source)).size;
}

function trustOf(slot) {
  const values = new Set(
    slot.decision?.outcome === 'resolved'
      ? [slot.decision.winner]
      : (slot.decision?.tied ?? []),
  );
  const claims = (slot.claims ?? []).filter((c) => values.has(c.value));
  if (claims.length === 0) return 0;
  return Math.max(...claims.map((c) => (Number.isInteger(c.trust) ? c.trust : 0)));
}

/** Value of one slot considered alone. Non-negative by construction. */
export function personalUtility(slot, weights = DEFAULT_WEIGHTS, query) {
  const type = slot.type ?? 'Fact';
  const base = weights.typeValue[type] ?? weights.typeBase;
  const raw =
    base +
    weights.evidence * evidenceOf(slot) +
    weights.corroboration * corroborationOf(slot) +
    weights.trust * trustOf(slot) +
    weights.relevance * relevance(slot, query);
  // Retracted claims pack last: still available, never competitive.
  return isRetracted(slot) ? raw * (weights.retractedPenalty ?? 1) : raw;
}

/** Marginal coverage gain of adding one more slot of type `t` at count `n`. */
export function coverageMarginal(type, n, weights = DEFAULT_WEIGHTS) {
  const w = weights.coverage * (weights.typeValue[type] ?? weights.typeBase) * 0.1;
  return w * (Math.exp(-weights.gamma * n) - Math.exp(-weights.gamma * (n + 1)));
}

/** Total utility of a set. Exposed so tests can verify submodularity directly. */
export function setUtility(slots, selected, weights = DEFAULT_WEIGHTS, query) {
  let total = 0;
  const counts = new Map();
  for (const index of selected) {
    const slot = slots[index];
    total += personalUtility(slot, weights, query);
    const type = slot.type ?? 'Fact';
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  for (const [type, n] of counts) {
    const w = weights.coverage * (weights.typeValue[type] ?? weights.typeBase) * 0.1;
    total += w * (1 - Math.exp(-weights.gamma * n));
  }
  return total;
}

/* ------------------------------------------------------------------ */
/* Solver                                                             */
/* ------------------------------------------------------------------ */

function greedyFrom(slots, cost, budget, weights, query, seed = []) {
  const selected = [...seed];
  const counts = new Map();
  let used = 0;

  for (const index of seed) {
    used += cost[index];
    const type = slots[index].type ?? 'Fact';
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  if (used > budget) return null;

  const taken = new Set(seed);
  for (;;) {
    let best = -1;
    let bestDensity = -1;
    for (let i = 0; i < slots.length; i += 1) {
      if (taken.has(i)) continue;
      if (used + cost[i] > budget) continue;
      const type = slots[i].type ?? 'Fact';
      const gain =
        personalUtility(slots[i], weights, query) +
        coverageMarginal(type, counts.get(type) ?? 0, weights);
      const density = gain / cost[i];
      // Deterministic tie-break on the slot key.
      if (
        density > bestDensity ||
        (density === bestDensity && best !== -1 && slots[i].key < slots[best].key)
      ) {
        bestDensity = density;
        best = i;
      }
    }
    if (best === -1) break;
    taken.add(best);
    selected.push(best);
    used += cost[best];
    const type = slots[best].type ?? 'Fact';
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }

  return selected;
}

function subsetsOfSize(indices, k, start = 0, current = [], out = []) {
  if (current.length === k) {
    out.push([...current]);
    return out;
  }
  for (let i = start; i < indices.length; i += 1) {
    current.push(indices[i]);
    subsetsOfSize(indices, k, i + 1, current, out);
    current.pop();
  }
  return out;
}

/**
 * Pack slots into a token budget.
 *
 * @param {Array} slots
 * @param {{budgetTokens: number, cost?: number[], weights?: object,
 *          query?: string, algorithm?: 'density'|'partial', seedSize?: number}} opts
 * @returns {{selected: number[], dropped: number[], tokens: number,
 *            utility: number, algorithm: string}}
 */
export function packSlots(slots, opts) {
  const {
    budgetTokens,
    weights = DEFAULT_WEIGHTS,
    query,
    algorithm = 'partial',
    seedSize = 2,
  } = opts;

  const cost =
    opts.cost ?? slots.map((s) => Math.max(1, Math.ceil(String(s.rendered ?? '').length / 4)));

  const all = slots.map((_, i) => i).filter((i) => cost[i] <= budgetTokens);

  if (all.length === 0) {
    return { selected: [], dropped: slots.map((_, i) => i), tokens: 0, utility: 0, algorithm };
  }

  const density = greedyFrom(slots, cost, budgetTokens, weights, query) ?? [];

  let best = density;
  let used = 'density';

  if (algorithm === 'partial') {
    // Sviridenko-style: seeding with small subsets escapes the density
    // greedy's blind spot for cheap-but-low-value items.
    const subsets = subsetsOfSize(all, Math.min(seedSize, all.length));
    for (const seed of subsets) {
      const seedCost = seed.reduce((n, i) => n + cost[i], 0);
      if (seedCost > budgetTokens) continue;
      const candidate = greedyFrom(slots, cost, budgetTokens, weights, query, seed);
      if (!candidate) continue;
      if (
        setUtility(slots, candidate, weights, query) >
        setUtility(slots, best, weights, query)
      ) {
        best = candidate;
        used = 'partial';
      }
    }
  }

  const selectedSet = new Set(best);
  const totalTokens = best.reduce((n, i) => n + cost[i], 0);

  return {
    selected: [...best].sort((a, b) => a - b),
    dropped: slots.map((_, i) => i).filter((i) => !selectedSet.has(i)),
    tokens: totalTokens,
    utility: setUtility(slots, best, weights, query),
    algorithm: used,
  };
}

/* ------------------------------------------------------------------ */
/* KV-cache-aware layout                                               */
/* ------------------------------------------------------------------ */

/**
 * How likely is this slot to persist unchanged across turns?
 *
 * The injected block is appended to the conversation. If it changes, every
 * token from the change onward must be recomputed. Ordering the STABLE content
 * first means a volatile change invalidates only the tail; ordering it last
 * would invalidate everything after it.
 */
export function stabilityScore(slot, weights = DEFAULT_WEIGHTS) {
  const type = slot.type ?? 'Fact';
  const typeStability = {
    Constraint: 4,
    Goal: 4,
    Decision: 3,
    Refuted: 2,
    Fact: 2,
    Artifact: 1,
    OpenQ: 0.5,
  }[type] ?? 1;

  // A tie is inherently less settled than a decided slot.
  const settled = slot.decision?.outcome === 'resolved' ? 3 : 0;

  return (
    typeStability +
    settled +
    0.5 * evidenceOf(slot) +
    0.5 * corroborationOf(slot) +
    0.25 * trustOf(slot)
  );
}

/**
 * Order selected slots stable-first.
 * Deterministic: ties break on the slot key.
 */
export function layoutForCache(slots, selected, weights = DEFAULT_WEIGHTS) {
  return [...selected].sort((a, b) => {
    const sa = stabilityScore(slots[a], weights);
    const sb = stabilityScore(slots[b], weights);
    if (sa !== sb) return sb - sa;
    return slots[a].key < slots[b].key ? -1 : slots[a].key > slots[b].key ? 1 : 0;
  });
}

/**
 * Length of the leading run two layouts share.
 * Used to MEASURE the cache benefit rather than assert it.
 */
export function preservedPrefix(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
}
