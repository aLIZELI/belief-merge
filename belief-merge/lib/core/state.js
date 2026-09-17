/**
 * Where "which sessions do I merge" actually lives.
 *
 * Two layers, in priority order:
 *
 *   runtime   set by the model tool or the /merge command, persisted to a
 *             small JSON file. This is what makes the feature usable without
 *             editing YAML or restarting.
 *   config    the `sources` value from cordis.patch.yml, which remains the
 *             deployment default and still works exactly as before.
 *
 * `clear()` removes the runtime layer so the config default takes over again;
 * `set([])` is different -- it is an explicit "merge nothing". Collapsing those
 * two into one would make "reset" and "off" indistinguishable, and users need
 * both.
 *
 * The file is deliberately plain JSON in a predictable place: inspectable,
 * hand-editable, and deletable when something goes wrong.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const EMPTY = Object.freeze({ version: 1, sources: null });

/**
 * @param {{file: string, defaults?: string[], fs?: object, onWarn?: Function}} opts
 */
export function createSourceState(opts) {
  const { file, defaults = [], onWarn } = opts;
  const io = opts.fs ?? { existsSync, mkdirSync, readFileSync, writeFileSync };

  let override = readOverride();

  function readOverride() {
    try {
      if (!io.existsSync(file)) return null;
      const raw = JSON.parse(io.readFileSync(file, 'utf8'));
      if (!raw || !Array.isArray(raw.sources)) return null;
      return raw.sources.filter((s) => typeof s === 'string' && s.length > 0);
    } catch (error) {
      // A corrupt file must not take the plugin down; fall back to config and
      // say so, rather than silently merging the wrong conversations.
      onWarn?.(`belief-merge: ignoring unreadable source state at ${file}: ${error?.message ?? error}`);
      return null;
    }
  }

  function persist() {
    try {
      io.mkdirSync(dirname(file), { recursive: true });
      const body = override === null ? EMPTY : { version: 1, sources: override };
      io.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
      return true;
    } catch (error) {
      onWarn?.(`belief-merge: could not persist source state to ${file}: ${error?.message ?? error}`);
      return false;
    }
  }

  return {
    /** Effective list: the runtime override if one is set, else the config default. */
    get() {
      return override === null ? [...defaults] : [...override];
    },

    /** Which layer is in effect. Reported by /merge status so it is never a mystery. */
    source() {
      return override === null ? 'config' : 'runtime';
    },

    /** The runtime override, or null when the config default is in effect. */
    override() {
      return override === null ? null : [...override];
    },

    /** The deployment default from cordis.patch.yml. */
    defaults() {
      return [...defaults];
    },

    /** Override with an explicit list. An empty list means "merge nothing". */
    set(ids) {
      override = [...new Set((ids ?? []).filter((s) => typeof s === 'string' && s.length > 0))];
      return persist();
    },

    /** Drop the runtime layer so the config default applies again. */
    clear() {
      override = null;
      return persist();
    },

    /** Re-read from disk; used when the file may have been edited by hand. */
    reload() {
      override = readOverride();
      return override;
    },

    /** Where the state lives, for status output. */
    file,
  };
}
