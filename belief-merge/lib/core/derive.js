/**
 * Derivation propagation -- milestone M4, and the last piece of the invariant
 * set the architecture promised.
 *
 * THE PROBLEM
 * -----------
 * Merging conclusions is not the same as merging reasoning. If branch A
 * concludes X because of Y, and the merge later retracts Y, then presenting X
 * as established is presenting a claim whose support is gone. Nothing in the
 * evidence arithmetic notices: X's own evidence weight is untouched.
 *
 * THE MECHANISM
 * -------------
 * Slots may declare premises (`derivedFrom`). A slot is:
 *
 *   axiom       no premises -- supported unless the merge failed to assert it
 *   founded     at least one justification has ALL premises IN
 *   retracted   it has justifications and none of them is fully satisfied
 *
 * and IN iff it is ASSERTED and founded. "Asserted" means the merge resolved
 * it (or adjudication chose a side); a disputed premise is not established, so
 * anything resting only on it falls with it.
 *
 * Several justifications means several independent routes to the same claim.
 * Retracting one premise then does NOT retract the conclusion -- which is the
 * whole reason to carry a graph rather than a boolean.
 *
 * The fixpoint is least-fixpoint, monotone and cycle-safe: a cycle with no
 * external support simply never becomes IN, which is the correct answer for a
 * circular argument.
 *
 * TRUST
 * -----
 * A derived claim can be no more trustworthy than its weakest premise
 * (`meet`, not `join`). This extends invariant I2 from aggregation to
 * derivation: merging on its own may never raise a claim's standing.
 */

/* ------------------------------------------------------------------ */
/* Reading the graph off the slots                                     */
/* ------------------------------------------------------------------ */

function normaliseJustifications(raw) {
  // Two shapes must not be confused:
  //
  //   [a, b]           ONE conjunction -- both premises are required
  //   [[a, b], [c]]    TWO alternative routes -- either is sufficient
  //
  // Mis-reading the flat form as a list of routes silently turns "these two
  // must both hold" into "either one is enough", which is the opposite
  // semantics. The shape is decided by whether any entry is itself an array.
  if (!Array.isArray(raw) || raw.length === 0) return [];

  if (!raw.some((entry) => Array.isArray(entry))) {
    const clean = raw.filter((p) => typeof p === 'string' && p.length > 0);
    return clean.length > 0 ? [clean] : [];
  }

  const out = [];
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.length > 0) out.push([entry]);
    else if (Array.isArray(entry)) {
      const clean = entry.filter((p) => typeof p === 'string' && p.length > 0);
      if (clean.length > 0) out.push(clean);
    }
  }
  return out;
}

/**
 * Every justification recorded for a slot, across all the claims that assert it.
 * Different branches may have reached the same conclusion by different routes;
 * each route is an independent justification.
 */
export function justificationsOf(slot) {
  const routes = [];
  const seen = new Set();
  for (const claim of slot.claims ?? []) {
    for (const justification of normaliseJustifications(claim.derivedFrom)) {
      const signature = [...justification].sort().join('\u0000');
      if (seen.has(signature)) continue;
      seen.add(signature);
      routes.push(justification);
    }
  }
  return routes;
}

/** The merge settled this slot on a value (by evidence or by adjudication). */
export function isAsserted(slot) {
  if (slot.decision?.outcome === 'resolved') return true;
  const outcome = slot.resolution?.outcome;
  return outcome === 'choose' || outcome === 'both' || outcome === 'conditional';
}

/* ------------------------------------------------------------------ */
/* Propagation                                                         */
/* ------------------------------------------------------------------ */

/**
 * Compute IN / retracted for every slot.
 *
 * @param {Array} slots
 * @returns {{slots: Array, inCount: number, retractedCount: number,
 *            retracted: string[], unknownPremises: string[]}}
 */
export function propagateDerivation(slots) {
  const byKey = new Map((slots ?? []).map((s) => [s.key, s]));
  const routes = new Map();
  const asserted = new Set();
  const unknownPremises = new Set();

  for (const slot of slots ?? []) {
    const justifications = justificationsOf(slot);
    routes.set(slot.key, justifications);
    if (isAsserted(slot)) asserted.add(slot.key);
    for (const justification of justifications) {
      for (const premise of justification) {
        if (!byKey.has(premise)) unknownPremises.add(premise);
      }
    }
  }

  // Least fixpoint: repeatedly admit any asserted slot whose justification is
  // fully IN. Slots in an unsupported cycle are simply never admitted.
  const inSet = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const slot of slots ?? []) {
      if (inSet.has(slot.key)) continue;
      if (!asserted.has(slot.key)) continue;
      const justifications = routes.get(slot.key);
      if (justifications.length === 0) {
        inSet.add(slot.key);
        changed = true;
        continue;
      }
      if (justifications.some((j) => j.every((p) => inSet.has(p)))) {
        inSet.add(slot.key);
        changed = true;
      }
    }
  }

  const annotated = (slots ?? []).map((slot) => {
    const justifications = routes.get(slot.key);
    if (justifications.length === 0) {
      const status = asserted.has(slot.key) ? 'axiom' : 'unasserted';
      return {
        ...slot,
        derivation: {
          status,
          justifications: [],
          unmet: asserted.has(slot.key) ? [] : ['the merge did not settle this slot'],
          trustCeiling: null,
        },
      };
    }

    const satisfied = justifications.find((j) => j.every((p) => inSet.has(p)));
    if (satisfied) {
      return {
        ...slot,
        derivation: { status: 'founded', justifications, satisfiedBy: satisfied, unmet: [], trustCeiling: null },
      };
    }

    const unmet = [
      ...new Set(
        justifications.flatMap((j) => j).filter((p) => !inSet.has(p)),
      ),
    ].sort();

    return {
      ...slot,
      derivation: {
        status: 'retracted',
        justifications,
        unmet,
        // Every route to this claim is broken; say why in one line.
        reason: `every supporting route is unmet (${unmet.join(', ')})`,
        trustCeiling: null,
      },
    };
  });

  const retracted = annotated.filter((s) => s.derivation.status === 'retracted').map((s) => s.key);
  const inCount = annotated.filter(
    (s) => s.derivation.status === 'axiom' || s.derivation.status === 'founded',
  ).length;

  return {
    slots: annotated,
    inCount,
    retractedCount: retracted.length,
    retracted: retracted.sort(),
    unknownPremises: [...unknownPremises].sort(),
    // How many slots actually declared a premise. When this is 0 the whole
    // mechanism is inert, which is worth seeing directly rather than inferring
    // from "nothing was retracted".
    derivedCount: annotated.filter((s) => justificationsOf(s).length > 0).length,
  };
}

/** A slot whose support is gone must not be presented as an assertion. */
export function isRetracted(slot) {
  return slot?.derivation?.status === 'retracted';
}

export function isUnasserted(slot) {
  return slot?.derivation?.status === 'unasserted';
}

/* ------------------------------------------------------------------ */
/* Trust across a derivation                                           */
/* ------------------------------------------------------------------ */

/**
 * The most a derived claim may be trusted: the weakest link across the route
 * that actually supports it -- `meet`, never `join`.
 *
 * This is the derivation half of invariant I2. Aggregation may raise trust by
 * independent corroboration; derivation may only lower it.
 *
 * @param {object} slot
 * @param {(key: string) => number} trustOfPremise
 * @returns {number|null} the ceiling, or null when the slot is not derived
 */
export function derivationTrustCeiling(slot, trustOfPremise) {
  const routes = justificationsOf(slot);
  if (routes.length === 0) return null;
  // Each route has its own ceiling (its weakest premise). The claim is
  // supported by whichever route actually holds, so its ceiling is the BEST
  // route's -- taking the minimum would let one weak alternative drag down a
  // claim that a strong alternative fully supports.
  const ceilings = routes.map((route) =>
    route.reduce((lowest, premise) => Math.min(lowest, trustOfPremise(premise) ?? 0), Infinity),
  );
  const best = Math.max(...ceilings);
  return Number.isFinite(best) ? best : null;
}
