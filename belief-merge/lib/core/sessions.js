/**
 * Session discovery and selection.
 *
 * The plugin needs to answer two questions that used to require the user to
 * hand-copy a UUID out of a directory listing:
 *
 *   1. which conversations could I merge?  -> `rankCandidates`
 *   2. which one did the user just name?   -> `resolveSelection`
 *
 * Everything here is a pure function over an already-gathered list. Reading
 * sessions is the adapter's job (it needs `ctx.sessionQuery`), so this module
 * stays host-agnostic and testable without a harness.
 */

/**
 * @typedef {object} Candidate
 * @property {string} id        the session id, exactly as `sources` wants it
 * @property {string} [title]   the session's own title, if one was projected
 * @property {number} [mtime]   epoch ms of the last write, for recency ranking
 * @property {number} [bytes]   rough size, so a user can avoid a huge merge
 * @property {string} [workspace]
 * @property {boolean} [live]
 */

/** How recently the session was touched, as a short human string. */
export function ageLabel(mtime, now = Date.now()) {
  if (!Number.isFinite(mtime)) return '?';
  const secs = Math.max(0, Math.round((now - mtime) / 1000));
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h`;
  return `${Math.round(secs / 86400)}d`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '?';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

/**
 * Rank candidates newest-first, optionally filtered by a text query matched
 * against the title and the id.
 *
 * The session the merge is running *in* must be excluded by the caller: a
 * session that merges itself is a loop, not a feature.
 *
 * @param {Candidate[]} list
 * @param {{query?: string, exclude?: string|string[], limit?: number}} opts
 * @returns {Candidate[]}
 */
export function rankCandidates(list, opts = {}) {
  const { query, limit = 20 } = opts;
  const exclude = new Set(
    (Array.isArray(opts.exclude) ? opts.exclude : [opts.exclude]).filter(Boolean),
  );

  let out = (list ?? []).filter((c) => c && typeof c.id === 'string' && !exclude.has(c.id));

  if (typeof query === 'string' && query.trim().length > 0) {
    const needle = query.trim().toLowerCase();
    out = out.filter((c) => {
      const hay = `${c.title ?? ''} ${c.id} ${c.workspace ?? ''}`.toLowerCase();
      return hay.includes(needle);
    });
  }

  // Sort by mtime only when mtimes are actually present. `ctx.sessionQuery
  // .listSessions()` already returns "newest first" but its header carries
  // `createdAt` and no modification time, so the adapter passes that order
  // through. Ties therefore return 0 and the stable sort preserves it -- a
  // tie-break on id would have silently reordered the platform's ranking.
  out.sort((a, b) => {
    const am = Number.isFinite(a.mtime) ? a.mtime : 0;
    const bm = Number.isFinite(b.mtime) ? b.mtime : 0;
    return bm - am;
  });

  return out.slice(0, limit);
}

/**
 * Resolve what the user typed into concrete session ids.
 *
 * Accepts, in order of preference:
 *   - an exact id
 *   - a unique id prefix ("f975843c") -- what a person will actually type
 *   - a 1-based index into the list they were just shown
 *
 * @param {string[]} inputs
 * @param {Candidate[]} candidates the list the user is choosing from
 * @returns {{ids: string[], errors: string[]}}
 */
export function resolveSelection(inputs, candidates) {
  const ids = [];
  const errors = [];
  const pool = candidates ?? [];

  for (const raw of inputs ?? []) {
    const token = String(raw).trim();
    if (token.length === 0) continue;

    const exact = pool.find((c) => c.id === token);
    if (exact) {
      if (!ids.includes(exact.id)) ids.push(exact.id);
      continue;
    }

    // 1-based index into the displayed list.
    if (/^\d+$/.test(token)) {
      const index = Number(token) - 1;
      if (index >= 0 && index < pool.length) {
        const picked = pool[index].id;
        if (!ids.includes(picked)) ids.push(picked);
        continue;
      }
      errors.push(`#${token} is out of range (the list has ${pool.length})`);
      continue;
    }

    const matches = pool.filter((c) => c.id.startsWith(token));
    if (matches.length === 1) {
      if (!ids.includes(matches[0].id)) ids.push(matches[0].id);
    } else if (matches.length === 0) {
      errors.push(`no session matches "${token}"`);
    } else {
      errors.push(`"${token}" is ambiguous: ${matches.length} sessions match`);
    }
  }

  return { ids, errors };
}

/**
 * Render the list a user or model reads before choosing.
 *
 * @param {Candidate[]} candidates
 * @param {{current?: string[], now?: number, header?: string}} opts
 */
export function formatCandidates(candidates, opts = {}) {
  const { current = [], now = Date.now(), header } = opts;
  const lines = [];
  if (header) lines.push(header);
  if (!candidates || candidates.length === 0) {
    lines.push('No sessions found.');
    return lines.join('\n');
  }

  lines.push('  #   id                                      age  size  title');
  candidates.forEach((c, i) => {
    const mark = current.includes(c.id) ? '*' : ' ';
    const num = String(i + 1).padStart(3, ' ');
    const id = String(c.id).padEnd(39, ' ');
    const age = ageLabel(c.mtime, now).padStart(3, ' ');
    const size = formatBytes(c.bytes).padStart(5, ' ');
    const title = (c.title ?? '(untitled)').slice(0, 46);
    lines.push(`${mark}${num}  ${id} ${age} ${size}  ${title}`);
  });
  if (current.length > 0) {
    lines.push('');
    lines.push(`* = currently merged into this session (${current.length})`);
  }
  return lines.join('\n');
}
