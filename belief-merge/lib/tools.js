/**
 * The two controls that remove the YAML-and-restart ritual: a model-facing
 * tool and a slash command.
 *
 * WHY THESE AND NOT A SETTINGS CARD
 * ---------------------------------
 * A settings card needs a browser half in the client module system's lazy-CJS
 * factory format. That is writable by hand -- `dsh-plugin-console` ships one --
 * but it is the most expensive of the available options and the least urgent:
 * both controls here already remove the two frictions the card would remove
 * (hand-editing YAML, and restarting to apply it).
 *
 * The tool makes the operation conversational ("merge my two bilibili
 * sessions"); the command makes it direct (`/merge f975843c`). Both write the
 * same runtime state, so they never disagree.
 *
 * Command results do not enter model history, which is why the command is the
 * right surface for a control operation -- it configures the conversation
 * without becoming part of it.
 */

import { defineTool } from '@deepseek-ai/dsh-tools';

import { formatCandidates, rankCandidates, resolveSelection } from './core/sessions.js';

const ACTIONS = ['list', 'status', 'set', 'add', 'remove', 'clear'];

/**
 * @param {object} ctx cordis context
 * @param {{
 *   state: object,                       // createSourceState(...)
 *   listCandidates: () => Promise<Array>, // gathered by the host adapter
 *   onWarn?: Function,
 * }} opts
 */
export function registerControls(ctx, opts) {
  const { state, listCandidates, onWarn } = opts;

  /**
   * Effective sources right now. Deliberately NOT async: it only reads memory,
   * and an `async` here silently turned every use into a Promise -- which the
   * tests caught as "current.includes is not a function".
   */
  function current() {
    return state.get();
  }

  /** The display list: filtered and capped, because a model reads this. */
  async function gather(query, excludeSessionId) {
    const all = await listCandidates();
    return rankCandidates(all, { query, exclude: excludeSessionId, limit: 20 });
  }

  /**
   * The resolution list: EVERY session, uncapped.
   *
   * Resolving against the displayed page was a real bug -- a user who pasted a
   * full id for an older session was told "no session matches", because that
   * session was the 21st most recent and the page had been truncated. An
   * explicit id names a session, not a row on a page.
   */
  async function gatherAll(excludeSessionId) {
    const all = await listCandidates();
    return rankCandidates(all, { exclude: excludeSessionId, limit: Number.MAX_SAFE_INTEGER });
  }

  function statusText(excludeSessionId) {
    const effective = current();
    const active = effective.filter((id) => id !== excludeSessionId);
    const lines = [
      `Merging is ${active.length > 0 ? 'ON' : 'OFF'} (set by: ${state.source()}).`,
    ];
    if (active.length > 0) {
      lines.push(`Sessions merged into every turn (${active.length}):`);
      for (const id of active) lines.push(`  - ${id}`);
      if (effective.includes(excludeSessionId)) {
        lines.push(`  (this session is listed and is being skipped: merging a session into itself is a loop)`);
      }
    } else if (state.defaults().length > 0) {
      lines.push(`Config default has ${state.defaults().length} source(s) but the runtime layer turned them off.`);
    } else {
      lines.push('No sessions are merged. Use "list" to see what is available.');
    }
    lines.push(`State file: ${state.file}`);
    return lines.join('\n');
  }

  /**
   * Shared implementation, so the tool and the command cannot drift apart.
   * Returns { ok, message, sources }.
   */
  async function run(action, inputs, excludeSessionId, query) {
    const act = ACTIONS.includes(action) ? action : 'status';

    if (act === 'list') {
      const candidates = await gather(query, excludeSessionId);
      return {
        ok: true,
        message: formatCandidates(candidates, {
          current: current(),
          header:
            `Candidate sessions${query ? ` matching "${query}"` : ' (newest first)'}` +
            `${candidates.length === 20 ? ', showing the 20 most recent — pass a query to narrow' : ''}. ` +
            'Pick by id, or by the # number:',
        }),
        sources: current(),
      };
    }

    if (act === 'status') {
      return { ok: true, message: statusText(excludeSessionId), sources: current() };
    }

    if (act === 'clear') {
      state.clear();
      return {
        ok: true,
        message:
          `Cleared the runtime override. Merging now follows the config default: ` +
          `${state.get().length} source(s).`,
        sources: current(),
      };
    }

    // set / add / remove resolve against every session, not the displayed
    // page: the ids came from the user, and they may be older than the top 20.
    const candidates = await gatherAll(excludeSessionId);
    const { ids, errors } = resolveSelection(inputs, candidates);
    if (errors.length > 0) {
      return {
        ok: false,
        message:
          `Could not resolve: ${errors.join('; ')}.\n\n` +
          formatCandidates(candidates, {
            current: current(),
            header: 'Available sessions:',
          }),
        sources: current(),
      };
    }
    if (ids.length === 0) {
      return {
        ok: false,
        message:
          'No sessions named. Call again with "list" first, then pass the ids or # numbers you want.',
        sources: current(),
      };
    }

    let next;
    if (act === 'add') next = [...new Set([...current(), ...ids])];
    else if (act === 'remove') next = current().filter((id) => !ids.includes(id));
    else next = ids;

    if (!state.set(next)) {
      return { ok: false, message: `Could not write ${state.file}.`, sources: current() };
    }

    const active = next.filter((id) => id !== excludeSessionId);
    return {
      ok: true,
      message:
        `Merging is now ${active.length > 0 ? 'ON' : 'OFF'} with ${active.length} source(s):\n` +
        active.map((id) => `  - ${id}`).join('\n') +
        `\n\nTakes effect on the next turn; no restart needed.`,
      sources: current(),
    };
  }

  /* ---------------- model-facing tool ---------------- */

  ctx.tools.register(
    defineTool({
      name: 'merge_sessions',
      description:
        'Control which OTHER conversations have their context merged into this one. ' +
        'Call with action="list" first to see candidate sessions and their ids, then ' +
        'action="set" with the ids the user picked. Use this whenever the user asks to ' +
        'combine, merge, or continue from another conversation. Merging is per-turn and ' +
        'costs tokens, so confirm the choice with the user before setting it.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ACTIONS,
          description:
            'list = show candidate sessions with ids; status = what is merged now; ' +
            'set = replace the set; add / remove = edit it; clear = fall back to the ' +
            'deployment default from cordis.patch.yml.',
        },
        sessions: {
          type: 'array',
          description:
            'Session ids (or unique id prefixes, or the # numbers from a previous ' +
            'list) to set, add, or remove. Required for set/add/remove.',
          items: { type: 'string' },
        },
        query: {
          type: 'string',
          description:
            'For action="list": filter candidates by title, id or working directory. ' +
            'The list is capped at the 20 most recent, so pass a query whenever the ' +
            'user described the conversation instead of naming it by id.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            message: { type: 'string', required: true },
            sources: { type: 'array', required: true, items: { type: 'string' } },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.message }],
      },
      execute(args, exec) {
        const exclude = exec?.agent?.session?.id;
        return run(args.action, args.sessions ?? [], exclude, args.query);
      },
    }),
  );

  /* ---------------- human-facing command ---------------- */

  if (ctx.commands && typeof ctx.commands.register === 'function') {
    ctx.effect(() =>
      ctx.commands.register({
        name: 'merge',
        description: 'Choose which other conversations are merged into this one',
        input: { hint: 'list [text] | status | off | <session-id-or-prefix>...' },
        handler: async ({ agent, rawInput }) => {
          const raw = String(rawInput ?? '').trim();
          const exclude = agent?.session?.id;
          const lower = raw.toLowerCase();

          let action = 'set';
          let inputs = raw.length === 0 ? [] : raw.split(/\s+/);
          let query;

          if (raw.length === 0 || lower === 'list') action = 'list';
          else if (lower === 'status') action = 'status';
          else if (lower === 'off' || lower === 'clear' || lower === 'none') action = 'clear';
          else if (lower.startsWith('find ')) {
            action = 'list';
            query = raw.slice(5).trim();
          } else if (lower.startsWith('list ')) {
            action = 'list';
            query = raw.slice(5).trim();
          }
          else if (lower.startsWith('add ')) {
            action = 'add';
            inputs = raw.slice(4).trim().split(/\s+/);
          } else if (lower.startsWith('remove ') || lower.startsWith('rm ')) {
            action = 'remove';
            inputs = raw.slice(lower.startsWith('rm ') ? 3 : 7).trim().split(/\s+/);
          }

          const result = await run(action, inputs, exclude, query);
          return result.ok
            ? { kind: 'success', text: result.message }
            : { kind: 'error', text: result.message };
        },
      }),
    );
  } else if (opts.onWarn) {
    onWarn('belief-merge: ctx.commands is unavailable, so the /merge command was not registered');
  }
}
