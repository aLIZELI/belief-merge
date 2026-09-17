/**
 * Flatten a DSH model surface into plain text for an LLM prompt.
 *
 * Surfaces are the arrays returned by `ctx.sessionQuery.readSurface(id)`.
 * Message content is an array of typed blocks; `reasoning` blocks are the
 * differentiator over `dsh-session-reference`, which drops them.
 *
 * ── PLUGIN-INJECTED MESSAGES ARE NOT USER STATEMENTS ──
 * DSH delivers injected context (sandbox policy, approval notices, time
 * context, another plugin's merge block) as `user/message` events carrying
 * `source.kind === 'plugin'`. Treating those as "the user said it" gives them
 * the highest evidence level and floods the merge with harness boilerplate.
 * That was observed live: two real sessions produced 170 "claims" that were
 * almost entirely policy text. They are excluded by default and, when
 * included, are labelled `injected` so the evidence model can rank them last.
 */

/** Iterate `{ type, text }` blocks of one message. */
export function* textBlocks(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    const type = block.type ?? 'text';
    if ((type === 'text' || type === 'reasoning') && typeof block.text === 'string') {
      const text = block.text.trim();
      if (text.length > 0) yield { type, text };
    }
  }
}

/** True when a message was injected by a plugin rather than authored by a human. */
export function isInjected(message) {
  return message?.source?.kind === 'plugin';
}

/** `reasoning` blocks carry the model's reasoning chain -- a first-class signal. */
export function classifyBlock(role, blockType, message) {
  if (isInjected(message)) return 'injected';
  if (blockType === 'reasoning') return 'reasoning';
  if (role === 'user') return 'user';
  if (role === 'tool') return 'tool';
  return 'assistant';
}

/**
 * Render one surface as labelled text.
 *
 * @param {Array} messages
 * @param {{includeReasoning?: boolean, includeInjected?: boolean, maxChars?: number}} opts
 * @returns {{text: string, truncated: boolean, skippedInjected: number}}
 */
export function flattenSurface(messages, opts = {}) {
  const { includeReasoning = true, includeInjected = false, maxChars = 6000 } = opts;
  const lines = [];
  let skippedInjected = 0;

  for (const message of messages ?? []) {
    if (isInjected(message) && !includeInjected) {
      skippedInjected += 1;
      continue;
    }
    const role = message?.role ?? 'assistant';
    for (const block of textBlocks(message)) {
      if (block.type === 'reasoning' && !includeReasoning) continue;
      const label = classifyBlock(role, block.type, message);
      lines.push(`[${label}] ${block.text}`);
    }
  }

  let text = lines.join('\n');
  let truncated = false;
  if (text.length > maxChars) {
    // Keep the TAIL: the most recent state of a conversation matters most.
    text = `…(earlier content truncated)…\n${text.slice(text.length - maxChars)}`;
    truncated = true;
  }
  return { text, truncated, skippedInjected };
}
