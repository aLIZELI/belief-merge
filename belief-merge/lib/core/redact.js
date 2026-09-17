/**
 * Secret redaction.
 *
 * WHY THIS EXISTS
 * ---------------
 * A context-merge plugin is a credential-distribution mechanism. Anything that
 * happens to sit in a source conversation -- an API key the user pasted three
 * days ago, a token in a tool result -- gets extracted as a claim and injected
 * into every future turn of every conversation that merges that session.
 *
 * Worse, the alignment stage sends session text to a model API. Found the hard
 * way: merging two real sessions produced a claim whose value was a live API
 * key, which the reading model refused to echo back and flagged for rotation.
 *
 * So redaction runs at the SURFACE, before either extraction path sees the
 * text and before any prompt is built. The key never enters the claim graph,
 * and never leaves the machine.
 *
 * DELIBERATELY CONSERVATIVE
 * -------------------------
 * Only high-confidence shapes are matched: provider-specific prefixes, and an
 * explicit label (api_key / token / secret / ...) followed by a value. A
 * generic "long random-looking string" rule was rejected -- it would redact
 * commit hashes, arXiv ids, base64 image data and file paths, which is both
 * annoying and a silent correctness bug in a system whose whole job is
 * fidelity.
 */

/** Provider-prefixed credentials: high confidence, no false positives to speak of. */
const PROVIDER_PATTERNS = [
  { kind: 'openai', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { kind: 'anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'google', re: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { kind: 'github', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/g },
  { kind: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{30,}/g },
  { kind: 'huggingface', re: /\bhf_[A-Za-z0-9]{30,}/g },
  { kind: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'slack', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'stripe', re: /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]{20,}/g },
  { kind: 'npm', re: /\bnpm_[A-Za-z0-9]{30,}/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  // Shape-only rule for a dotted credential that carries no provider prefix.
  // Found by merging two real sessions: a 32-hex + '.' + 16-alnum key went
  // through every prefixed rule untouched and reached the rendered block.
  { kind: 'dotted-key', re: /\b[0-9a-f]{32}\.[A-Za-z0-9]{16}\b/g },
  { kind: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
];

/**
 * Labelled secrets. The label makes it high-confidence; the value still has to
 * look like a secret (>= 16 chars, no spaces) so "token budget" and
 * "the token expired" are left alone.
 */
const LABELLED = /(?<label>api[_\s-]*(?:key|密钥)|apikey|access[_\s-]*token|auth[_\s-]*token|secret[_\s-]*key|client[_\s-]*secret|password|passwd|bearer|密钥|密码)["'`]?\s*[:=＝]\s*["'`]?(?<value>[A-Za-z0-9_\-./+]{16,})["'`]?/gi;

const PLACEHOLDER = (kind) => `[REDACTED:${kind}]`;

/**
 * Redact secrets from one string.
 * @param {string} text
 * @returns {{text: string, found: Array<{kind: string}>}}
 */
export function redactSecrets(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { text: typeof text === 'string' ? text : '', found: [] };
  }

  const found = [];
  let out = text;

  for (const { kind, re } of PROVIDER_PATTERNS) {
    out = out.replace(re, () => {
      found.push({ kind });
      return PLACEHOLDER(kind);
    });
  }

  out = out.replace(LABELLED, (match, ...rest) => {
    // Named groups arrive as the last argument.
    const groups = rest[rest.length - 1];
    if (!groups || !groups.value) return match;
    // Leave obvious placeholders and variable references alone.
    if (/^[<{$]|^\.{3}|^(xxx+|aaa+|placeholder|redacted|your)/i.test(groups.value)) return match;
    found.push({ kind: 'labelled' });
    return match.replace(groups.value, PLACEHOLDER('labelled'));
  });

  return { text: out, found };
}

/** True when a string contains anything redactable. */
export function hasSecrets(text) {
  return redactSecrets(text).found.length > 0;
}

/**
 * Redact every text/reasoning block of a message array, in place-safe fashion.
 * Returns new objects; the caller's input is not mutated.
 *
 * @param {Array} messages
 * @returns {{messages: Array, found: Array<{kind: string}>}}
 */
export function redactMessages(messages) {
  const found = [];
  const out = (messages ?? []).map((message) => {
    if (!Array.isArray(message?.content)) return message;
    let changed = false;
    const content = message.content.map((block) => {
      if (!block || typeof block.text !== 'string') return block;
      const { text, found: hits } = redactSecrets(block.text);
      if (hits.length === 0) return block;
      found.push(...hits);
      changed = true;
      return { ...block, text };
    });
    return changed ? { ...message, content } : message;
  });
  return { messages: out, found };
}
