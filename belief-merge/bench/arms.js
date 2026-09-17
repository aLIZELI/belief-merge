/**
 * MergeBench -- systems under test (M6).
 *
 * Each arm turns the branches into a block of text and reports its token cost.
 * The arms are deliberately graded, because the interesting question is not
 * "does the merge work" but "which part of it earns its keep":
 *
 *   none                 no context at all -- the floor
 *   branch-a             one branch alone -- a concrete single-branch arm
 *   concat               every branch pasted together -- the naive baseline
 *   beliefmerge-heuristic  the deterministic core, no model calls at all
 *   beliefmerge-oracle   full pipeline fed a PERFECT extraction
 *
 * `beliefmerge-oracle` exists to separate two questions that are easy to
 * conflate: how much does the PIPELINE contribute (oracle), and how much does
 * extraction quality cost (heuristic vs a real model). It is labelled as a
 * ceiling, not presented as a result.
 */

import {
  Trust,
  estimateTokens,
  mergeSurfaces,
  mergeSurfacesAligned,
} from '../lib/core/index.js';
import { branchText, normalise } from './score.js';

/** Surfaces shaped for the core, with cross-session trust applied. */
function toSurfaces(branches) {
  return branches.map((b) => ({
    id: b.id,
    messages: b.messages,
    trust: Trust.EXTERNAL,
  }));
}

/* ------------------------------------------------------------------ */
/* Baseline arms                                                       */
/* ------------------------------------------------------------------ */

/**
 * Truncate to a token budget, on line boundaries.
 *
 * Every arm MUST respect the same budget or the comparison is meaningless: a
 * baseline that ignores the limit "wins" by spending tokens nobody offered it.
 * An earlier version of this benchmark let concatenation run unbounded.
 */
export function truncateToBudget(text, budgetTokens) {
  const maxChars = Math.max(0, budgetTokens) * 4;
  if (text.length <= maxChars) return text;
  const out = [];
  let used = 0;
  for (const line of text.split('\n')) {
    if (used + line.length + 1 > maxChars) break;
    out.push(line);
    used += line.length + 1;
  }
  return out.join('\n');
}

export function armNone() {
  return { name: 'none', text: '', tokens: 0 };
}

export function armSingleBranch(branches, budgetTokens, id = branches[0].id) {
  const branch = branches.find((b) => b.id === id);
  const text = truncateToBudget(branch ? branchText(branch) : '', budgetTokens);
  return { name: `single:${id}`, text, tokens: estimateTokens(text) };
}

export function armConcat(branches, budgetTokens) {
  const full = branches.map((b) => `### ${b.id}\n${branchText(b)}`).join('\n\n');
  const text = truncateToBudget(full, budgetTokens);
  return { name: 'concat', text, tokens: estimateTokens(text) };
}

/* ------------------------------------------------------------------ */
/* BeliefMerge arms                                                    */
/* ------------------------------------------------------------------ */

export function armHeuristic(branches, opts = {}) {
  const merged = mergeSurfaces(toSurfaces(branches), { score: opts.score ?? 'egalitarian' });
  const rendered = merged.render({ budgetTokens: opts.budgetTokens ?? 1200 });
  return { name: 'beliefmerge-heuristic', text: rendered.text, tokens: rendered.tokens || estimateTokens(rendered.text) };
}

/**
 * An oracle extractor built from the scenario's ground truth.
 *
 * This is a MEASURING INSTRUMENT, not a claim: it answers "if extraction were
 * perfect, what would the pipeline deliver?" Extraction quality is the one
 * variable this benchmark cannot control offline.
 */
export function oracleLlm(scenario) {
  const slots = new Map();
  for (const fact of scenario.facts) {
    if (!slots.has(fact.key)) slots.set(fact.key, { key: fact.key, type: 'Fact', opinions: [] });
    slots.get(fact.key).opinions.push({
      source: fact.branch,
      value: normalise(fact.value),
      evidence: fact.evidence,
      quote: fact.value,
    });
  }
  const alignment = JSON.stringify({ slots: [...slots.values()] });

  return {
    async complete({ prompt }) {
      // Adjudication prompts contain the literal marker; the oracle has no
      // opinion to add there, so it declines to settle anything.
      if (typeof prompt === 'string' && prompt.includes('CONFLICT')) {
        return JSON.stringify({ resolutions: [] });
      }
      return alignment;
    },
  };
}

export async function armOracle(branches, scenario, opts = {}) {
  const merged = await mergeSurfacesAligned(toSurfaces(branches), {
    llm: oracleLlm(scenario),
    score: opts.score ?? 'egalitarian',
    adjudicate: opts.adjudicate ?? true,
  });
  const rendered = merged.render({ budgetTokens: opts.budgetTokens ?? 1200 });
  return {
    name: 'beliefmerge-oracle',
    text: rendered.text,
    tokens: rendered.tokens || estimateTokens(rendered.text),
    mode: merged.mode,
  };
}

/* ------------------------------------------------------------------ */
/* The full panel                                                      */
/* ------------------------------------------------------------------ */

/**
 * @param {object} scenario
 * @param {{budgetTokens?: number, includeOracle?: boolean, direction?: string}} opts
 * @returns {Promise<Array<{name: string, text: string, tokens: number}>>}
 */
export async function buildArms(scenario, opts = {}) {
  const { budgetTokens = 1200, includeOracle = true } = opts;
  const branches = scenario.branches;

  const arms = [
    armNone(),
    armSingleBranch(branches, budgetTokens, branches[0].id),
    armConcat(branches, budgetTokens),
    armHeuristic(branches, { budgetTokens }),
  ];

  if (includeOracle) {
    arms.push(await armOracle(branches, scenario, { budgetTokens }));
  }

  return arms;
}
