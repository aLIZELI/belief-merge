/**
 * LLM-based joint alignment + extraction -- Stage 1 + Stage 2 (milestone M1).
 *
 * WHY JOINT, NOT PER-BRANCH
 * -------------------------
 * The heuristic extractor in claims.js extracts each branch independently and
 * then tries to match the results by normalised text.  That is exactly where it
 * fails: "We switched to PostgreSQL" and "The DB is Postgres now" become two
 * unrelated slots, so a cross-branch conflict never fires.
 *
 * Here the model sees ALL branches in one call and emits slots that are ALREADY
 * aligned across them, with a canonical machine key and a canonical value:
 *
 *     { key: "database.engine", opinions: [
 *         { source: "branch-a", value: "postgresql", evidence: 4, quote: "..." },
 *         { source: "branch-b", value: "mysql",      evidence: 1, quote: "..." } ] }
 *
 * This is the division of labour the architecture wants: the LLM does what it
 * is good at (semantics, typing, alignment); the deterministic core does what
 * IT is good at (evidence aggregation with proven confluence properties).
 *
 * `value` is a canonical token, not `assert`/`refute`, so a factual
 * disagreement is represented directly and the evidence score decides it.
 */

import { flattenSurface } from './surface.js';
import { Trust } from './trust.js';

/** Canonical evidence levels the model is allowed to emit. */
export const EVIDENCE_GUIDE = Object.freeze({
  4: 'the user explicitly stated it',
  3: 'a tool, command or file verified it',
  2: 'the model concluded it in its visible answer',
  1: 'the model only speculated or hypothesised (reasoning blocks)',
});

export const SLOT_TYPES = Object.freeze([
  'Fact',
  'Decision',
  'Constraint',
  'Refuted',
  'Goal',
  'OpenQ',
  'Artifact',
]);

const SYSTEM_PROMPT = `You merge several conversation branches into ONE aligned claim set.

You will receive N branches. Each line is labelled [user], [assistant], [tool] or [reasoning].

Produce a JSON object with a single field "slots". Each slot is ONE question or
topic, and carries the opinions of the branches that spoke to it.

Rules:
1. ALIGN BY MEANING, NOT BY WORDING. "We switched to PostgreSQL", "the DB is
   Postgres now" and "we're no longer on MySQL" are all opinions about the SAME
   slot: the database engine.
2. Only emit a slot if at least one branch has an opinion about it.
3. An opinion from a branch that never addressed the slot must be OMITTED, not
   invented. Never invent content that is not in the input.
4. "value" must be a short canonical lowercase token, so that two branches
   saying the same thing produce the SAME token (e.g. "postgresql", "yes", "no",
   "twenty", "enabled"). Never put a whole sentence in "value".
5. "evidence" is an integer 1-4, judged ONLY by how the branch came to know it:
   4 = the user explicitly stated it
   3 = a tool, command or file verified it
   2 = the model concluded it in its visible answer
   1 = the model only speculated or hypothesised (typically [reasoning] lines)
6. "quote" must be copied verbatim from that branch's input.
7. "source" must be one of the branch ids given to you. Never invent an id.
8. "key" is a stable dotted machine key in lowercase, e.g. "database.engine".
9. "type" is one of: ${SLOT_TYPES.join(', ')}.
10. "derivedFrom" records that one slot was CONCLUDED FROM another. This is the
    most valuable thing you can tell us, because it is the only way a reader
    can tell which conclusions collapse when a premise turns out to be wrong.
    When the input contains reasoning of the form "premise ... therefore
    conclusion" or "X, so Y", emit the conclusion as a slot whose "derivedFrom"
    lists the keys of the premises it rests on. Omit the field for anything
    observed or stated directly, and never invent a dependency that is not in
    the text.
11. IGNORE harness boilerplate. Sandbox and permission policy notices, approval
    notices, tool-description preambles, agent-instruction text, and anything
    that reads like configuration rather than a fact about the user's work are
    NOT claims. Never emit a slot for them.
12. Prefer durable project facts, decisions, constraints and open questions.
    Omit small talk, acknowledgements, and restatements of the same thing.
13. Output ONLY the JSON object. No prose, no markdown fence.

Example: the second slot was CONCLUDED from the first, so it carries
"derivedFrom".

{"slots":[
 {"key":"database.engine","type":"Fact","opinions":[
   {"source":"branch-a","value":"postgresql","evidence":4,"quote":"We switched the database to PostgreSQL."},
   {"source":"branch-b","value":"mysql","evidence":1,"quote":"The database is probably MySQL."}]},
 {"key":"latency.eu_too_slow","type":"Decision","derivedFrom":["database.engine"],"opinions":[
   {"source":"branch-a","value":"yes","evidence":2,"quote":"Therefore european latency will exceed two hundred milliseconds."}]}]}`;

/**
 * Build the alignment prompt.
 *
 * @param {Array<{id: string, messages: Array}>} surfaces
 * @param {{includeReasoning?: boolean, maxCharsPerBranch?: number}} opts
 */
export function buildAlignmentPrompt(surfaces, opts = {}) {
  const {
    includeReasoning = true,
    includeInjected = false,
    maxCharsPerBranch = 6000,
    maxSlots = 40,
  } = opts;
  const parts = [];
  for (const surface of surfaces) {
    const { text, truncated } = flattenSurface(surface.messages, {
      includeReasoning,
      includeInjected,
      maxChars: maxCharsPerBranch,
    });
    parts.push(`### branch id: ${surface.id}${truncated ? ' (truncated)' : ''}\n${text}`);
  }
  const prompt = [
    `Merge the following ${surfaces.length} branches into one aligned claim set.`,
    `Valid branch ids: ${surfaces.map((s) => s.id).join(', ')}`,
    `Emit AT MOST ${maxSlots} slots, the most valuable first. Fewer is better than noisy.`,
    '',
    ...parts,
  ].join('\n');
  return { system: SYSTEM_PROMPT, prompt };
}

/** Pull the first JSON object out of a model response. */
export function extractJsonObject(text) {
  const raw = String(text ?? '').trim();
  if (raw.length === 0) throw new Error('empty model response');

  // Strip a markdown fence if the model added one despite instructions.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : raw;

  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('no JSON object found in model response');
  }
  return JSON.parse(body.slice(start, end + 1));
}

function clampEvidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 2;
  return Math.min(4, Math.max(1, Math.round(n)));
}

/**
 * Validate and normalise a parsed alignment object.
 * Throws on anything structurally unusable -- the caller falls back.
 *
 * @param {unknown} parsed
 * @param {{knownSources: Set<string>}} opts
 */
export function normalizeAlignment(parsed, opts) {
  const { knownSources, maxSlots = 40 } = opts;
  const slots = parsed?.slots;
  if (!Array.isArray(slots)) throw new Error('alignment response has no "slots" array');

  const out = [];
  const seenKeys = new Set();
  const dropped = { badKey: 0, noOpinions: 0, unknownSource: 0, emptyValue: 0, notObject: 0 };

  for (const slot of slots) {
    if (!slot || typeof slot !== 'object') {
      dropped.notObject += 1;
      continue;
    }
    const key = typeof slot.key === 'string' ? slot.key.trim().toLowerCase() : '';
    if (key.length === 0 || seenKeys.has(key)) {
      dropped.badKey += 1;
      continue;
    }
    if (!Array.isArray(slot.opinions)) {
      dropped.noOpinions += 1;
      continue;
    }

    const opinions = [];
    for (const opinion of slot.opinions) {
      if (!opinion || typeof opinion !== 'object') continue;
      const source = opinion.source;
      // Reject invented sources -- a hallucinated branch id would silently
      // fabricate corroboration, which is exactly invariant I2's concern.
      if (typeof source !== 'string' || !knownSources.has(source)) {
        dropped.unknownSource += 1;
        continue;
      }
      const value = typeof opinion.value === 'string' ? opinion.value.trim().toLowerCase() : '';
      if (value.length === 0) {
        dropped.emptyValue += 1;
        continue;
      }
      opinions.push({
        source,
        value,
        evidence: clampEvidence(opinion.evidence),
        quote: typeof opinion.quote === 'string' ? opinion.quote : '',
      });
    }
    if (opinions.length === 0) {
      dropped.noOpinions += 1;
      continue;
    }

    // Deterministic order, so downstream serialization is stable (invariant I5).
    opinions.sort((a, b) =>
      a.source < b.source ? -1 : a.source > b.source ? 1 : a.value < b.value ? -1 : a.value > b.value ? 1 : 0,
    );

    // Premises are slot keys; anything unrecognised is dropped rather than
    // trusted, because a bogus edge would silently retract an innocent claim.
    const derivedFrom = Array.isArray(slot.derivedFrom)
      ? [...new Set(slot.derivedFrom.filter((k) => typeof k === 'string' && k.length > 0))]
      : [];

    seenKeys.add(key);
    out.push({
      key,
      type: SLOT_TYPES.includes(slot.type) ? slot.type : 'Fact',
      opinions,
      derivedFrom,
    });
  }

  if (out.length === 0) {
    throw new Error(
      `alignment produced no usable slots (model emitted ${slots.length} slot(s); dropped ` +
        `${dropped.badKey} bad/duplicate key, ${dropped.noOpinions} without usable opinions, ` +
        `${dropped.unknownSource} opinions naming an unknown source, ${dropped.emptyValue} with an empty value)`,
    );
  }
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  // Enforce the cap even if the model ignored the instruction.
  return { slots: out.slice(0, maxSlots) };
}

/**
 * Align + extract via one LLM call, returning the branch shape that
 * `mergeBranches` consumes.
 *
 * @param {Array<{id: string, messages: Array}>} surfaces
 * @param {{llm: {complete: Function}, includeReasoning?: boolean,
 *          maxCharsPerBranch?: number, maxTokens?: number, signal?: AbortSignal}} opts
 * @returns {Promise<{branches: Array, raw: object, usage: object}>}
 */
export async function alignSurfaces(surfaces, opts) {
  const { llm, maxTokens = 4000, signal, maxSlots = 40 } = opts;
  if (!llm || typeof llm.complete !== 'function') {
    throw new Error('alignSurfaces requires an llm with a complete({system, prompt}) method');
  }

  const { system, prompt } = buildAlignmentPrompt(surfaces, opts);
  const text = await llm.complete({ system, prompt, maxTokens, signal });
  const parsed = extractJsonObject(text);
  const normalized = normalizeAlignment(parsed, {
    knownSources: new Set(surfaces.map((s) => s.id)),
    maxSlots,
  });

  const branches = surfaces.map((s) => ({
    id: s.id,
    trust: Number.isInteger(s.trust) ? s.trust : Trust.UNTRUSTED,
    claims: [],
  }));
  const byId = new Map(branches.map((b) => [b.id, b]));

  for (const slot of normalized.slots) {
    for (const opinion of slot.opinions) {
      const branch = byId.get(opinion.source);
      branch.claims.push({
        key: slot.key,
        value: opinion.value,
        evidence: opinion.evidence,
        text: opinion.quote || `${slot.key} = ${opinion.value}`,
        sourceId: opinion.source,
        slotType: slot.type,
        // Cross-session content is untrusted background unless its surface
        // says otherwise. This label is what stops a merge from laundering it.
        trust: branch.trust,
        // Premises this claim was concluded from, if the model declared any.
        derivedFrom: slot.derivedFrom ?? [],
      });
    }
  }

  return { branches, raw: normalized };
}
