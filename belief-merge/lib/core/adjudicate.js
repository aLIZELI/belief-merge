/**
 * Conflict adjudication -- Stage 3c (milestone M2).
 *
 * Up to here the pipeline decides by evidence weight and, on a genuine tie,
 * reports DISPUTED. That is safe but incomplete: real merges contain ties that
 * a reader could settle, and leaving every one of them unresolved makes the
 * merged context less useful than it should be.
 *
 * The adjudicator is deliberately boxed in:
 *
 *   1. It runs ONLY on slots whose evidence is already tied. It never
 *      overrides a decision the evidence made.
 *   2. It may only choose a value that is ALREADY PRESENT in that conflict.
 *      It cannot invent a third answer. (An invented value is rejected.)
 *   3. It must cite which opinions it relied on.
 *   4. It is subjected to a SYMMETRY TEST: the same conflicts are asked again
 *      with the options order-reversed. A conclusion that flips was position
 *      bias, not reasoning, and is downgraded to unresolvable.
 *      This is IC2 (permutation invariance) turned into a runtime check.
 *   5. "unresolvable" is an explicitly good answer.
 *
 * The result is attached as `slot.resolution`; the underlying SlotState is
 * never mutated, so the full provenance stays auditable.
 */

import { extractJsonObject } from './align.js';

export const OUTCOMES = Object.freeze(['choose', 'both', 'conditional', 'unresolvable']);

/**
 * Collect the slots whose evidence is tied.
 *
 * @param {Array} slots
 * @returns {Array<{key: string, type: string, options: Array}>}
 */
export function findConflicts(slots) {
  const conflicts = [];
  for (const slot of slots ?? []) {
    if (slot.decision?.outcome !== 'disputed') continue;

    const perValue = slot.state.perValue();
    const options = slot.decision.tied.map((value) => {
      const supporters = [...(perValue.get(value) ?? [])];
      const quotes = (slot.claims ?? [])
        .filter((c) => c.value === value)
        .sort((a, b) => b.evidence - a.evidence)
        .slice(0, 3)
        .map((c) => ({ source: c.sourceId, quote: c.text }));
      return {
        value,
        sources: [...new Set(supporters.map((s) => s.source))].sort(),
        maxEvidence: supporters.length ? Math.max(...supporters.map((s) => s.evidence)) : 0,
        quotes,
      };
    });

    conflicts.push({ key: slot.key, type: slot.type ?? 'Fact', options });
  }
  return conflicts;
}

/* ------------------------------------------------------------------ */
/* Prompt                                                              */
/* ------------------------------------------------------------------ */

const SYSTEM_PROMPT = `You settle contradictions between branches of one conversation.

You receive CONFLICTS. Each has one topic ("key") and two or more competing
values ("options"), each with quotes from the branches that asserted it.

For EVERY conflict, decide exactly one outcome:
- "choose"       one value is better supported by what the quotes actually say.
                 Provide "value".
- "both"         the values are compatible -- different aspects of the topic,
                 not a real disagreement.
- "conditional"  both hold, but under different conditions. Provide "guard",
                 a short statement of the condition.
- "unresolvable" the quotes do not settle it.

Rules:
1. "value" MUST be one of the option values listed for that conflict. Never
   invent a value, a source, or a fact that is not in the input.
2. ALL options have EQUAL evidence by construction. Do not prefer a value
   because of the order it is listed in -- order carries no meaning here.
3. List in "premises" the ids of the options you actually relied on.
4. "unresolvable" is a GOOD answer when the quotes are genuinely inconclusive.
   Do not guess to seem decisive.
5. Output ONLY a JSON object, no prose and no markdown fence:
{"resolutions":[{"key":"<conflict key>","outcome":"choose","value":"<option value>","premises":["c0.o1"],"rationale":"<one sentence>"}]}`;

/**
 * @param {Array} conflicts
 * @param {{reverse?: boolean}} opts - reverse flips option order for the
 *   symmetry test; it must not change what a correct answer looks like.
 */
export function buildAdjudicationPrompt(conflicts, opts = {}) {
  const { reverse = false } = opts;
  const blocks = conflicts.map((conflict, index) => {
    const options = reverse ? [...conflict.options].reverse() : conflict.options;
    const lines = [`CONFLICT ${index}  key="${conflict.key}"  type="${conflict.type}"`];
    options.forEach((option, position) => {
      lines.push(`  option id="c${index}.o${position}" value="${option.value}"`);
      for (const quote of option.quotes) {
        lines.push(`    asserted in [${quote.source}]: ${quote.quote}`);
      }
      if (option.quotes.length === 0) {
        lines.push(`    (no verbatim quote recorded; sources: ${option.sources.join(', ') || 'unknown'})`);
      }
    });
    return lines.join('\n');
  });

  const prompt = [
    `${conflicts.length} conflict(s) to resolve. Keys are: ${conflicts.map((c) => c.key).join(', ')}`,
    '',
    ...blocks,
  ].join('\n');

  return { system: SYSTEM_PROMPT, prompt };
}

/* ------------------------------------------------------------------ */
/* Parsing and validation                                              */
/* ------------------------------------------------------------------ */

/**
 * @param {string} text - raw model output
 * @param {{conflicts: Array, reverse?: boolean}} opts
 * @returns {Map<string, object>} key -> resolution
 */
export function parseAdjudications(text, opts) {
  const { conflicts, reverse = false } = opts;
  const parsed = extractJsonObject(text);
  const resolutions = parsed?.resolutions;
  if (!Array.isArray(resolutions)) {
    throw new Error('adjudication response has no "resolutions" array');
  }

  const byKey = new Map(conflicts.map((c) => [c.key, c]));
  const out = new Map();
  const dropped = { unknownKey: 0, badOutcome: 0, inventedValue: 0, missingGuard: 0, duplicate: 0 };

  for (const entry of resolutions) {
    if (!entry || typeof entry !== 'object') continue;
    const key = typeof entry.key === 'string' ? entry.key : '';
    const conflict = byKey.get(key);
    if (!conflict) {
      dropped.unknownKey += 1;
      continue;
    }
    if (out.has(key)) {
      dropped.duplicate += 1;
      continue;
    }

    const outcome = typeof entry.outcome === 'string' ? entry.outcome : '';
    if (!OUTCOMES.includes(outcome)) {
      dropped.badOutcome += 1;
      continue;
    }

    // Order-independent membership: reversing the prompt changes option ids,
    // so validation must be against the VALUES, not the ids.
    const allowed = new Set(conflict.options.map((o) => o.value));
    let value = null;
    if (outcome === 'choose') {
      const candidate = typeof entry.value === 'string' ? entry.value.trim().toLowerCase() : '';
      if (!allowed.has(candidate)) {
        // Hallucination guard: the adjudicator may not invent an answer.
        dropped.inventedValue += 1;
        continue;
      }
      value = candidate;
    }

    let guard = null;
    if (outcome === 'conditional') {
      guard = typeof entry.guard === 'string' ? entry.guard.trim() : '';
      if (guard.length === 0) {
        dropped.missingGuard += 1;
        continue;
      }
    }

    out.set(key, {
      key,
      outcome,
      value,
      guard,
      premises: Array.isArray(entry.premises) ? entry.premises.filter((p) => typeof p === 'string') : [],
      rationale: typeof entry.rationale === 'string' ? entry.rationale : '',
      reversed: reverse,
    });
  }

  return { resolutions: out, dropped };
}

/* ------------------------------------------------------------------ */
/* The symmetry test (IC2 as a runtime check)                          */
/* ------------------------------------------------------------------ */

/**
 * Keep a resolution only when the forward and reversed runs agree.
 * Agreement is on OUTCOME plus, for "choose", the chosen VALUE -- never on
 * option ids, which differ between the two runs by construction.
 */
export function reconcileSymmetric(forward, backward) {
  const agreed = new Map();
  let rejected = 0;
  let orderSensitive = 0;

  for (const [key, a] of forward) {
    const b = backward.get(key);
    if (!b) {
      rejected += 1;
      continue;
    }
    const sameOutcome = a.outcome === b.outcome;
    const sameValue = a.outcome !== 'choose' || a.value === b.value;
    if (sameOutcome && sameValue) {
      agreed.set(key, a);
    } else {
      orderSensitive += 1;
      // The model's answer depended on presentation order, so it is not
      // reasoning about the content. Downgrade rather than guess.
      agreed.set(key, {
        key,
        outcome: 'unresolvable',
        value: null,
        guard: null,
        premises: [],
        rationale: 'order-sensitive: forward and reversed adjudication disagreed, so the tie stands',
        orderSensitive: true,
      });
    }
  }

  return { resolutions: agreed, rejected, orderSensitive };
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

async function runAdjudication(conflicts, { llm, reverse, maxTokens, signal }) {
  const { system, prompt } = buildAdjudicationPrompt(conflicts, { reverse });
  const text = await llm.complete({ system, prompt, maxTokens, signal });
  return parseAdjudications(text, { conflicts, reverse }).resolutions;
}

/**
 * Adjudicate every tied slot. Never throws on model failure -- returns the
 * slots unchanged with `mode` describing what happened.
 *
 * @param {Array} slots
 * @param {{llm?: {complete: Function}, symmetryCheck?: boolean,
 *          maxTokens?: number, signal?: AbortSignal, maxConflicts?: number}} opts
 * @returns {Promise<{slots: Array, conflicts: number, resolved: number,
 *                    orderSensitive: number, mode: string, error?: string}>}
 */
export async function adjudicateConflicts(slots, opts = {}) {
  const {
    llm,
    symmetryCheck = true,
    maxTokens = 2000,
    signal,
    maxConflicts = 12,
  } = opts;

  const allConflicts = findConflicts(slots);
  if (allConflicts.length === 0) {
    return { slots, conflicts: 0, resolved: 0, orderSensitive: 0, mode: 'none' };
  }
  if (!llm || typeof llm.complete !== 'function') {
    return { slots, conflicts: allConflicts.length, resolved: 0, orderSensitive: 0, mode: 'skipped' };
  }

  // Bound the cost: only the most corroborated ties are worth a model call.
  const conflicts = [...allConflicts]
    .sort((a, b) => {
      const ca = a.options.reduce((n, o) => n + o.sources.length, 0);
      const cb = b.options.reduce((n, o) => n + o.sources.length, 0);
      if (ca !== cb) return cb - ca;
      return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    })
    .slice(0, maxConflicts)
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  let resolutions;
  let orderSensitive = 0;
  try {
    const forward = await runAdjudication(conflicts, { llm, reverse: false, maxTokens, signal });
    if (symmetryCheck) {
      const backward = await runAdjudication(conflicts, { llm, reverse: true, maxTokens, signal });
      const reconciled = reconcileSymmetric(forward, backward);
      resolutions = reconciled.resolutions;
      orderSensitive = reconciled.orderSensitive;
    } else {
      resolutions = forward;
    }
  } catch (error) {
    return {
      slots,
      conflicts: conflicts.length,
      resolved: 0,
      orderSensitive: 0,
      mode: 'error',
      error: error?.message ?? String(error),
    };
  }

  const resolvedCount = [...resolutions.values()].filter((r) => r.outcome !== 'unresolvable').length;

  const out = slots.map((slot) => {
    const resolution = resolutions.get(slot.key);
    return resolution ? { ...slot, resolution } : slot;
  });

  return {
    slots: out,
    conflicts: conflicts.length,
    resolved: resolvedCount,
    orderSensitive,
    mode: 'llm',
  };
}
