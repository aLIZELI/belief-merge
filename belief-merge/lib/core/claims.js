/**
 * Claim extraction -- Stage 1 (Graphify) baseline.
 *
 * ⚠️ HONEST SCOPE: this is a deterministic, LLM-free HEURISTIC.  It exists so
 * that the pipeline, the merge core and the tests all run end-to-end with no
 * API key and no network.  The architecture calls for a structured-output LLM
 * extractor here (typed nodes: Fact/Decision/Constraint/Refuted/...), which is
 * milestone M1.  The interface below is what that extractor must satisfy:
 *
 *     extractClaims(messages, { sourceId }) -> Claim[]
 *
 * A `Claim` is `{ key, value, evidence, text, sourceId }` where `value` is
 * 'assert' or 'refute' and `key` is the alignment key (Stage 2 collapses
 * claims that share a key into one slot).
 */

import { Evidence } from './slot.js';
import { isInjected, textBlocks } from './surface.js';

const NEGATION_EN = /(^|\s)(not|no|never|cannot|can't|don't|doesn't|isn't|aren't|won't|without)\b/i;
const NEGATION_ZH = /(不|没|无|非|未|别|莫)/;

/** Split text into sentence-ish units, keeping CJK punctuation. */
export function splitSentences(text) {
  return String(text)
    .split(/(?<=[.!?。！？；;])\s*/u)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Normalise to an alignment key.
 * `exact` compares normalised text; `bag` compares a sorted content-word set
 * (a crude near-duplicate matcher standing in for embeddings + NLI).
 */
export function normalizeKey(text, strategy = 'exact') {
  const norm = String(text)
    .toLowerCase()
    .replace(/[`*_#>\[\]()]/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (strategy === 'exact') return norm;
  const words = norm
    .split(' ')
    .filter((w) => w.length >= 2)
    .sort();
  return words.join(' ');
}

/** Evidence level for one content block. */
function evidenceFor(role, blockType, injected) {
  // Plugin-injected context is harness scaffolding, not testimony. It must
  // never outrank something the user actually said.
  if (injected) return Evidence.SPECULATIVE;
  if (blockType === 'reasoning') return Evidence.SPECULATIVE;
  if (role === 'user') return Evidence.USER_STATED;
  if (role === 'tool') return Evidence.TOOL_VERIFIED;
  return Evidence.INFERRED;
}

/**
 * Extract claims from a DSH model surface (the array returned by
 * `ctx.sessionQuery.readSurface(id)`).
 *
 * @param {Array} messages
 * @param {{sourceId: string, keyStrategy?: 'exact'|'bag',
 *          includeReasoning?: boolean, includeInjected?: boolean}} opts
 */
export function extractClaims(messages, opts = {}) {
  const {
    sourceId,
    keyStrategy = 'exact',
    includeReasoning = true,
    includeInjected = false,
  } = opts;
  if (!sourceId) throw new Error('extractClaims requires opts.sourceId');

  const claims = [];
  for (const message of messages ?? []) {
    const injected = isInjected(message);
    if (injected && !includeInjected) continue;
    const role = message?.role ?? 'assistant';
    for (const block of textBlocks(message)) {
      if (block.type === 'reasoning' && !includeReasoning) continue;
      const evidence = evidenceFor(role, block.type, injected);
      for (const sentence of splitSentences(block.text)) {
        const negated = NEGATION_EN.test(sentence) || NEGATION_ZH.test(sentence);
        // Keep the negation marker inside the key so "X" and "not X" land in
        // the SAME slot (they are opinions about the same proposition).
        const bare = sentence.replace(NEGATION_EN, ' ').replace(NEGATION_ZH, ' ');
        claims.push({
          key: normalizeKey(bare, keyStrategy),
          value: negated ? 'refute' : 'assert',
          evidence,
          text: sentence,
          sourceId,
        });
      }
    }
  }
  return claims.filter((c) => c.key.length > 0);
}
