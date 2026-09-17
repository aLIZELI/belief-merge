/**
 * Slot-level annotation: the provenance-typed state of ONE semantic key.
 *
 * This is the type that Proposition P1 is about.  It keeps
 *
 *     (value, source, evidence)
 *
 * for every assertion.  Keeping `source` is not bookkeeping -- it is what
 * makes `union` a join over a join-semilattice, hence associative,
 * commutative and idempotent.
 *
 * Drop it (keep only the winner) and incremental merging becomes
 * order-dependent.  See ../README.md and the P1 regression tests.
 */

/** Evidence levels, ordered. Mirrors the architecture doc's epsilon. */
export const Evidence = Object.freeze({
  SPECULATIVE: 1, // model guess / hypothesis
  INFERRED: 2, // model conclusion backed by a reasoning chain
  TOOL_VERIFIED: 3, // tool output, file content, command result
  USER_STATED: 4, // explicit user statement
});

/** Additive weight per evidence level (egalitarian / Dalal-style score). */
export const WEIGHTS = Object.freeze({ 1: 1, 2: 2, 3: 4, 4: 8 });

/** Source id used when a merged state is deliberately collapsed. */
export const MERGED_SOURCE = '*merged*';

const SEP = '\u0000';

function itemKey(value, source, evidence) {
  return `${value}${SEP}${source}${SEP}${evidence}`;
}

/**
 * Canonical ordering of annotation items.
 *
 * This is not cosmetic.  Without a canonical form, two equal annotations can
 * carry their items in different array orders depending on merge order, which
 * would make serialization non-deterministic and silently break KV-cache
 * prefix reuse (invariant I5).  Sorting here makes `union` produce a true
 * canonical representative.
 */
function compareItems(a, b) {
  if (a.value !== b.value) return a.value < b.value ? -1 : 1;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  return a.evidence - b.evidence;
}

export class SlotState {
  /** @param {ReadonlyArray<{value:string, source:string, evidence:number}>} items */
  constructor(items = []) {
    /** @type {ReadonlyArray<{value:string, source:string, evidence:number}>} */
    this.items = Object.freeze([...items].sort(compareItems));
    Object.freeze(this);
  }

  static empty() {
    return EMPTY;
  }

  static of(...items) {
    return new SlotState(items).dedup();
  }

  /** @param {string} value @param {string} source @param {number} evidence */
  static singleton(value, source, evidence) {
    return new SlotState([{ value, source, evidence }]);
  }

  dedup() {
    const seen = new Map();
    for (const it of this.items) {
      seen.set(itemKey(it.value, it.source, it.evidence), it);
    }
    return new SlotState([...seen.values()]);
  }

  /**
   * Join of two annotations, deduplicated by (value, source, evidence).
   * Associative, commutative, idempotent -- by construction.
   */
  union(other) {
    const seen = new Map();
    for (const it of this.items) seen.set(itemKey(it.value, it.source, it.evidence), it);
    for (const it of other.items) seen.set(itemKey(it.value, it.source, it.evidence), it);
    return new SlotState([...seen.values()]);
  }

  /** @returns {Map<string, Array<{source:string, evidence:number}>>} */
  perValue() {
    const out = new Map();
    for (const { value, source, evidence } of this.items) {
      if (!out.has(value)) out.set(value, []);
      out.get(value).push({ source, evidence });
    }
    return out;
  }

  values() {
    return [...new Set(this.items.map((i) => i.value))].sort();
  }

  get size() {
    return this.items.length;
  }

  get isEmpty() {
    return this.items.length === 0;
  }

  toString() {
    if (this.isEmpty) return '<empty>';
    const parts = this.items
      .map((i) => `${i.value}@${i.evidence}(${i.source})`)
      .sort();
    return `{${parts.join(', ')}}`;
  }
}

const EMPTY = new SlotState();

/* ------------------------------------------------------------------ */
/* Scores                                                              */
/* ------------------------------------------------------------------ */

/** Weighted majority -- the Dalal-distance minimiser on a single slot. */
export function egalitarianScore(supports) {
  return supports.reduce((sum, s) => sum + (WEIGHTS[s.evidence] ?? 0), 0);
}

/** Sorted-descending evidence vector, compared lexicographically. */
export function elitistScore(supports) {
  return supports
    .map((s) => s.evidence)
    .sort((a, b) => b - a);
}

export const SCORES = Object.freeze({
  egalitarian: egalitarianScore,
  elitist: elitistScore,
});

function compareScores(a, b, scoreName) {
  if (scoreName === 'elitist') {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i += 1) {
      const x = a[i] ?? -Infinity;
      const y = b[i] ?? -Infinity;
      if (x !== y) return x - y;
    }
    return 0;
  }
  return a - b;
}

/**
 * Pick the winning value for one slot.
 * A genuine tie is reported as DISPUTED -- never guessed.
 *
 * @returns {{outcome:'empty'|'resolved'|'disputed', winner:string|null, tied:string[]}}
 */
export function select(state, scoreName = 'egalitarian') {
  const score = SCORES[scoreName];
  if (!score) throw new Error(`unknown score: ${scoreName}`);

  const perValue = state.perValue();
  if (perValue.size === 0) return { outcome: 'empty', winner: null, tied: [] };

  let scored = [];
  for (const [value, supports] of perValue) {
    scored.push([value, score(supports)]);
  }
  scored.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  let best = null;
  for (const [, s] of scored) {
    if (best === null || compareScores(s, best, scoreName) > 0) best = s;
  }
  const winners = scored
    .filter(([, s]) => compareScores(s, best, scoreName) === 0)
    .map(([v]) => v);

  if (winners.length === 1) {
    return { outcome: 'resolved', winner: winners[0], tied: [] };
  }
  return { outcome: 'disputed', winner: null, tied: winners };
}

export function decisionKey(d) {
  return `${d.outcome}|${d.winner ?? ''}|${d.tied.join(',')}`;
}

export function describeDecision(d) {
  if (d.outcome === 'empty') return '<empty>';
  if (d.outcome === 'resolved') return d.winner;
  return `disputed{${d.tied.join(',')}}`;
}
