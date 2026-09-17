/**
 * BeliefMerge core -- framework-agnostic.
 *
 * Deliberately has ZERO dependencies on DeepSeek Harness: the merge engine is
 * host-independent (so a second host is an adapter rather than a rewrite).
 * The DSH adapter lives in ../index.js.
 *
 * Two extraction paths:
 *
 *   mergeSurfaces()        deterministic heuristic (claims.js) -- offline, no keys
 *   mergeSurfacesAligned() LLM joint alignment + extraction (align.js), with a
 *                          graceful fall back to the heuristic on any failure
 *
 * Either way the MERGE itself is the same deterministic, provenance-retaining
 * core with the proven confluence properties.
 */

import { extractClaims } from './claims.js';
import { alignSurfaces } from './align.js';
import { adjudicateConflicts } from './adjudicate.js';
import { propagateDerivation } from './derive.js';
import { SlotState } from './slot.js';
import { Trust } from './trust.js';
import { mergeStreaming } from './merge.js';
import { renderMerged } from './render.js';

export * from './slot.js';
export * from './merge.js';
export * from './claims.js';
export * from './render.js';
export * from './surface.js';
export * from './align.js';
export * from './adjudicate.js';
export * from './trust.js';
export * from './pack.js';
export * from './derive.js';

/**
 * Merge a set of branches, each a list of already-extracted claims.
 *
 * @param {Array<{id: string, claims: Array}>} branches
 * @param {{score?: 'egalitarian'|'elitist'}} opts
 * @returns {{slots: Array, render: Function}}
 */
export function mergeBranches(branches, opts = {}) {
  const score = opts.score ?? 'egalitarian';

  // Group claims by alignment key -> one slot per semantic key.
  const byKey = new Map();
  for (const branch of branches) {
    for (const claim of branch.claims ?? []) {
      // Trust travels with the claim, defaulting to the branch's level and
      // then to UNTRUSTED -- an unlabelled claim is never assumed benign.
      const labelled = Number.isInteger(claim.trust)
        ? claim
        : { ...claim, trust: Number.isInteger(branch.trust) ? branch.trust : Trust.UNTRUSTED };
      if (!byKey.has(labelled.key)) byKey.set(labelled.key, []);
      byKey.get(labelled.key).push(labelled);
    }
  }

  const slots = [];
  for (const key of [...byKey.keys()].sort()) {
    const claims = byKey.get(key);

    // One SlotState per source branch, then a STREAMING merge.
    // mergeStreaming uses the provenance-retaining representation -- the
    // P1-safe path.  Using reprCollapse here is the bug P1 warns about.
    const perSource = new Map();
    for (const claim of claims) {
      if (!perSource.has(claim.sourceId)) perSource.set(claim.sourceId, []);
      perSource.get(claim.sourceId).push(claim);
    }

    const branchStates = [...perSource.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([sourceId, cs]) =>
        SlotState.of(
          ...cs.map((c) => ({ value: c.value, source: sourceId, evidence: c.evidence })),
        ),
      );

    const { state, decision } = mergeStreaming(branchStates, score);
    slots.push({
      key,
      state,
      decision,
      claims,
      type: claims[0]?.slotType ?? 'Fact',
    });
  }

  return {
    slots,
    render: (o = {}) => renderMerged(slots, o),
  };
}

/**
 * Heuristic path: extract each branch independently, then merge.
 *
 * @param {Array<{id: string, messages: Array}>} surfaces
 * @param {{score?: string, keyStrategy?: 'exact'|'bag', includeReasoning?: boolean}} opts
 */
export function mergeSurfaces(surfaces, opts = {}) {
  const branches = surfaces.map(({ id, messages, trust }) => ({
    id,
    trust: Number.isInteger(trust) ? trust : Trust.UNTRUSTED,
    claims: extractClaims(messages, {
      sourceId: id,
      keyStrategy: opts.keyStrategy ?? 'exact',
      includeReasoning: opts.includeReasoning ?? true,
      includeInjected: opts.includeInjected ?? false,
    }),
  }));
  return { ...mergeBranches(branches, opts), mode: 'heuristic' };
}

/**
 * LLM path: one joint alignment call, then adjudication of whatever came out
 * tied, falling back to the heuristic on ANY alignment failure.
 *
 * A degraded result beats a broken turn.
 *
 * @param {Array<{id: string, messages: Array}>} surfaces
 * @param {{llm?: {complete: Function}, onWarn?: Function, score?: string,
 *          includeReasoning?: boolean, includeInjected?: boolean,
 *          maxCharsPerBranch?: number, maxSlots?: number, maxTokens?: number,
 *          adjudicate?: boolean, symmetryCheck?: boolean,
 *          maxAdjudications?: number, adjudicationTokens?: number,
 *          signal?: AbortSignal}} opts
 */
export async function mergeSurfacesAligned(surfaces, opts = {}) {
  const {
    llm,
    onWarn,
    adjudicate = true,
    symmetryCheck = true,
    maxAdjudications = 12,
    adjudicationTokens = 2000,
    ...rest
  } = opts;

  const hasLlm = llm && typeof llm.complete === 'function';

  let merged;
  let mode = 'heuristic';

  if (hasLlm) {
    try {
      const { branches } = await alignSurfaces(surfaces, { llm, ...rest });
      merged = mergeBranches(branches, rest);
      mode = 'llm';
    } catch (error) {
      onWarn?.(`belief-merge: LLM alignment failed, using heuristic fallback: ${error?.message ?? error}`);
    }
  }
  if (!merged) {
    merged = mergeBranches(
      surfaces.map(({ id, messages, trust }) => ({
        id,
        trust: Number.isInteger(trust) ? trust : Trust.UNTRUSTED,
        claims: extractClaims(messages, {
          sourceId: id,
          keyStrategy: rest.keyStrategy ?? 'exact',
          includeReasoning: rest.includeReasoning ?? true,
          includeInjected: rest.includeInjected ?? false,
        }),
      })),
      rest,
    );
  }

  // Stage 3c: settle what the evidence could not. Only runs on ties.
  let slots = merged.slots;
  let adjudication = { mode: 'none', conflicts: 0, resolved: 0, orderSensitive: 0 };

  const hasTies = slots.some((s) => s.decision?.outcome === 'disputed');
  if (adjudicate && hasLlm && hasTies) {
    const result = await adjudicateConflicts(slots, {
      llm,
      symmetryCheck,
      maxConflicts: maxAdjudications,
      maxTokens: adjudicationTokens,
      signal: rest.signal,
    });
    slots = result.slots;
    adjudication = {
      mode: result.mode,
      conflicts: result.conflicts,
      resolved: result.resolved,
      orderSensitive: result.orderSensitive,
      ...(result.error ? { error: result.error } : {}),
    };
    if (result.error) onWarn?.(`belief-merge: adjudication failed: ${result.error}`);
  }

  // Stage 3d: retract anything whose support was retracted. This runs LAST,
  // after adjudication, because a tie that adjudication settles is a premise
  // that stands -- and one it leaves unresolved is a premise that does not.
  const derivation = propagateDerivation(slots);
  slots = derivation.slots;

  return {
    slots,
    mode,
    adjudication,
    derivation: {
      inCount: derivation.inCount,
      retractedCount: derivation.retractedCount,
      retracted: derivation.retracted,
      unknownPremises: derivation.unknownPremises,
      derivedCount: derivation.derivedCount,
    },
    render: (o = {}) => renderMerged(slots, o),
  };
}
