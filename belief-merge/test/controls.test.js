/**
 * Tests for the two controls that replace "edit YAML and restart": the
 * `merge_sessions` tool and the `/merge` command, plus the session discovery
 * and runtime state they run on.
 *
 * The states worth distinguishing, and the ones a naive implementation gets
 * wrong:
 *
 *   nothing configured        -> controls still offered, nothing injected
 *   runtime set               -> runtime wins over the config default
 *   runtime cleared           -> config default applies again
 *   runtime set to []         -> merge NOTHING, which is not the same as cleared
 *   state file corrupt        -> fall back to config, and say so
 *   session listed as itself  -> skipped, because that is a loop
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ageLabel,
  formatBytes,
  formatCandidates,
  rankCandidates,
  resolveSelection,
} from '../lib/core/sessions.js';
import { createSourceState } from '../lib/core/state.js';
import { registerControls } from '../lib/tools.js';

/* ------------------------------------------------------------------ */
/* A fake filesystem, so the state tests never touch the real one      */
/* ------------------------------------------------------------------ */

function fakeFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const dirs = new Set();
  return {
    files,
    dirs,
    existsSync: (p) => files.has(p),
    mkdirSync: (p) => dirs.add(p),
    readFileSync: (p) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      return files.get(p);
    },
    writeFileSync: (p, body) => files.set(p, body),
  };
}

function makeState({ defaults = [], stored = null, onWarn } = {}) {
  const fs = fakeFs(stored === null ? {} : { '/s.json': stored });
  const state = createSourceState({ file: '/s.json', defaults, fs, onWarn });
  return { state, fs };
}

/* ------------------------------------------------------------------ */
/* Discovery                                                           */
/* ------------------------------------------------------------------ */

const CANDIDATES = [
  { id: 'aaaaaaaa-1111', title: 'Bilibili video summary (1)' },
  { id: 'bbbbbbbb-2222', title: 'Bilibili video summary' },
  { id: 'cccccccc-3333', title: 'Unrelated deployment notes' },
];

test('rankCandidates preserves the platform order when mtimes are absent', () => {
  // listSessions() already returns newest-first but its header has no
  // modification time; re-sorting on a missing field would destroy that.
  const out = rankCandidates(CANDIDATES);
  assert.deepEqual(out.map((c) => c.id), CANDIDATES.map((c) => c.id));
});

test('rankCandidates sorts by mtime when mtimes are present', () => {
  const out = rankCandidates([
    { id: 'old', mtime: 1 },
    { id: 'new', mtime: 9 },
    { id: 'mid', mtime: 5 },
  ]);
  assert.deepEqual(out.map((c) => c.id), ['new', 'mid', 'old']);
});

test('rankCandidates excludes the named session', () => {
  const out = rankCandidates(CANDIDATES, { exclude: 'bbbbbbbb-2222' });
  assert.ok(!out.some((c) => c.id === 'bbbbbbbb-2222'));
});

test('rankCandidates filters on title and id', () => {
  assert.equal(rankCandidates(CANDIDATES, { query: 'deployment' }).length, 1);
  assert.equal(rankCandidates(CANDIDATES, { query: 'bbbb' }).length, 1);
  assert.equal(rankCandidates(CANDIDATES, { query: 'bilibili' }).length, 2);
  assert.equal(rankCandidates(CANDIDATES, { query: 'nothing' }).length, 0);
});

test('resolveSelection accepts exact ids, unique prefixes and #numbers', () => {
  assert.deepEqual(resolveSelection(['cccccccc-3333'], CANDIDATES).ids, ['cccccccc-3333']);
  assert.deepEqual(resolveSelection(['aaaa'], CANDIDATES).ids, ['aaaaaaaa-1111']);
  assert.deepEqual(resolveSelection(['1'], CANDIDATES).ids, ['aaaaaaaa-1111']);
  assert.deepEqual(resolveSelection(['1', '3'], CANDIDATES).ids, ['aaaaaaaa-1111', 'cccccccc-3333']);
});

test('resolveSelection dedupes and keeps the order given', () => {
  assert.deepEqual(resolveSelection(['3', '1', '1'], CANDIDATES).ids, [
    'cccccccc-3333',
    'aaaaaaaa-1111',
  ]);
});

test('resolveSelection reports unknown, ambiguous and out-of-range input', () => {
  const unknown = resolveSelection(['zzzz'], CANDIDATES);
  assert.equal(unknown.ids.length, 0);
  assert.match(unknown.errors[0], /no session matches/);

  const ambiguous = resolveSelection(['aaaaaaaa-1111'], [
    { id: 'aaaaaaaa-1111' },
    { id: 'aaaaaaaa-1111-x' },
  ]);
  // exact match wins over prefix ambiguity
  assert.deepEqual(ambiguous.ids, ['aaaaaaaa-1111']);

  const range = resolveSelection(['9'], CANDIDATES);
  assert.equal(range.ids.length, 0);
  assert.match(range.errors[0], /out of range/);
});

test('formatCandidates lists ids and marks the current selection', () => {
  const text = formatCandidates(CANDIDATES, { current: ['bbbbbbbb-2222'] });
  assert.match(text, /aaaaaaaa-1111/);
  assert.match(text, /Bilibili video summary/);
  assert.match(text, /\*.*bbbbbbbb-2222/);
  assert.match(text, /currently merged/);
});

test('age and size helpers are stable', () => {
  const now = 1_000_000_000;
  assert.equal(ageLabel(now - 5 * 60 * 1000, now), '5m');
  assert.equal(ageLabel(now - 3 * 3600 * 1000, now), '3h');
  assert.equal(ageLabel(now - 2 * 86400 * 1000, now), '2d');
  assert.equal(ageLabel(undefined, now), '?');
  assert.equal(formatBytes(2048), '2K');
  assert.equal(formatBytes(0), '?');
});

/* ------------------------------------------------------------------ */
/* Runtime state                                                       */
/* ------------------------------------------------------------------ */

test('state falls back to the config default when nothing is stored', () => {
  const { state } = makeState({ defaults: ['from-config'] });
  assert.deepEqual(state.get(), ['from-config']);
  assert.equal(state.source(), 'config');
});

test('a runtime set wins over the config default', () => {
  const { state } = makeState({ defaults: ['from-config'] });
  state.set(['from-tool']);
  assert.deepEqual(state.get(), ['from-tool']);
  assert.equal(state.source(), 'runtime');
});

test('clearing drops the runtime layer and the default applies again', () => {
  const { state } = makeState({ defaults: ['from-config'] });
  state.set(['from-tool']);
  state.clear();
  assert.deepEqual(state.get(), ['from-config']);
  assert.equal(state.source(), 'config');
});

test('set([]) means MERGE NOTHING, which is not the same as clear()', () => {
  const { state } = makeState({ defaults: ['from-config'] });
  state.set([]);
  assert.deepEqual(state.get(), []);
  assert.equal(state.source(), 'runtime', 'an explicit empty list is still a runtime decision');
  state.clear();
  assert.deepEqual(state.get(), ['from-config'], 'clear restores the default');
});

test('state persists and reloads', () => {
  const fs = fakeFs();
  const a = createSourceState({ file: '/s.json', defaults: [], fs });
  a.set(['kept']);
  const b = createSourceState({ file: '/s.json', defaults: [], fs });
  assert.deepEqual(b.get(), ['kept']);
  assert.equal(b.source(), 'runtime');
});

test('state dedupes and drops junk', () => {
  const { state } = makeState();
  state.set(['a', 'a', '', null, undefined, 'b']);
  assert.deepEqual(state.get(), ['a', 'b']);
});

test('a corrupt state file falls back to the default and warns', () => {
  const warnings = [];
  const { state } = makeState({
    defaults: ['from-config'],
    stored: '{ this is not json',
    onWarn: (m) => warnings.push(m),
  });
  assert.deepEqual(state.get(), ['from-config']);
  assert.equal(state.source(), 'config');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unreadable source state/);
});

test('a write failure is reported rather than throwing', () => {
  const warnings = [];
  const fs = fakeFs();
  fs.writeFileSync = () => {
    throw new Error('disk full');
  };
  const state = createSourceState({ file: '/s.json', defaults: [], fs, onWarn: (m) => warnings.push(m) });
  assert.equal(state.set(['x']), false);
  assert.ok(warnings.some((w) => /could not persist/.test(w)));
});

/* ------------------------------------------------------------------ */
/* The tool and the command                                            */
/* ------------------------------------------------------------------ */

function harness({ defaults = [], sessions = CANDIDATES, stateFile = null } = {}) {
  const tools = new Map();
  const commands = new Map();
  const warnings = [];
  const ctx = {
    effect: (fn) => fn(),
    logger: { warn: (m) => warnings.push(m) },
    tools: { register: (t) => tools.set(t.name, t) },
    commands: { register: (c) => commands.set(c.name, c) },
  };
  const fs = fakeFs(stateFile === null ? {} : { '/s.json': stateFile });
  const state = createSourceState({ file: '/s.json', defaults, fs, onWarn: (m) => warnings.push(m) });
  registerControls(ctx, {
    state,
    listCandidates: async () => sessions,
    onWarn: (m) => warnings.push(m),
  });
  return { ctx, tools, commands, warnings, state, fs };
}

const tool = (h) => h.tools.get('merge_sessions');
const cmd = (h) => h.commands.get('merge');

test('the tool and the command are both registered', () => {
  const h = harness();
  assert.ok(tool(h), 'merge_sessions tool missing');
  assert.ok(cmd(h), '/merge command missing');
  assert.equal(cmd(h).name, 'merge');
});

test('list reports candidates and the current selection', async () => {
  const h = harness({ defaults: ['bbbbbbbb-2222'] });
  const out = await tool(h).execute({ action: 'list' }, {});
  assert.equal(out.ok, true);
  assert.match(out.message, /aaaaaaaa-1111/);
  assert.match(out.message, /currently merged/);
});

test('set replaces the selection and reports that no restart is needed', async () => {
  const h = harness();
  const out = await tool(h).execute(
    { action: 'set', sessions: ['aaaaaaaa-1111', 'bbbbbbbb-2222'] },
    {},
  );
  assert.equal(out.ok, true);
  assert.match(out.message, /no restart needed/);
  assert.deepEqual(h.state.get(), ['aaaaaaaa-1111', 'bbbbbbbb-2222']);
});

test('add and remove edit the selection', async () => {
  const h = harness();
  await tool(h).execute({ action: 'set', sessions: ['aaaaaaaa-1111'] }, {});
  await tool(h).execute({ action: 'add', sessions: ['bbbbbbbb-2222'] }, {});
  assert.deepEqual(h.state.get(), ['aaaaaaaa-1111', 'bbbbbbbb-2222']);
  await tool(h).execute({ action: 'remove', sessions: ['aaaaaaaa-1111'] }, {});
  assert.deepEqual(h.state.get(), ['bbbbbbbb-2222']);
});

test('clear falls back to the deployment default', async () => {
  const h = harness({ defaults: ['from-config'] });
  await tool(h).execute({ action: 'set', sessions: ['aaaaaaaa-1111'] }, {});
  const out = await tool(h).execute({ action: 'clear' }, {});
  assert.equal(out.ok, true);
  assert.deepEqual(h.state.get(), ['from-config']);
  assert.equal(h.state.source(), 'config');
});

test('an unresolvable selection fails and shows the list again', async () => {
  const h = harness();
  const out = await tool(h).execute({ action: 'set', sessions: ['nope'] }, {});
  assert.equal(out.ok, false);
  assert.match(out.message, /no session matches/);
  assert.match(out.message, /Available sessions/);
  assert.deepEqual(h.state.get(), [], 'a failed selection must not change anything');
});

test('set with no sessions is refused rather than clearing silently', async () => {
  const h = harness({ defaults: ['from-config'] });
  const out = await tool(h).execute({ action: 'set', sessions: [] }, {});
  assert.equal(out.ok, false);
  assert.match(out.message, /No sessions named/);
  assert.deepEqual(h.state.get(), ['from-config'], 'the default must survive');
});

test('the owning session is excluded from the candidate list and from merging', async () => {
  const h = harness({ defaults: ['aaaaaaaa-1111'] });
  const out = await tool(h).execute({ action: 'list' }, { agent: { session: { id: 'aaaaaaaa-1111' } } });
  assert.ok(!out.message.includes('aaaaaaaa-1111') || !/^\s*1\s/m.test(out.message));
  const status = await tool(h).execute({ action: 'status' }, { agent: { session: { id: 'aaaaaaaa-1111' } } });
  assert.match(status.message, /Merging is OFF/, 'a self-merge is a loop, so it is skipped');
});

test('status reports the layer in effect and the state file', async () => {
  const h = harness({ defaults: ['from-config'] });
  const before = await tool(h).execute({ action: 'status' }, {});
  assert.match(before.message, /set by: config/);
  await tool(h).execute({ action: 'set', sessions: ['aaaaaaaa-1111'] }, {});
  const after = await tool(h).execute({ action: 'status' }, {});
  assert.match(after.message, /set by: runtime/);
  assert.match(after.message, /State file: \/s\.json/);
});

test('the command parses list, status, off, add and remove', async () => {
  const h = harness({ defaults: ['from-config'] });
  const runCmd = (raw) => cmd(h).handler({ agent: { session: { id: 'self' } }, rawInput: raw });

  assert.equal((await runCmd('')).kind, 'success');
  assert.match((await runCmd('')).text, /Candidate sessions/);
  assert.match((await runCmd('list')).text, /Candidate sessions/);
  assert.match((await runCmd('status')).text, /set by: config/);
  assert.equal((await runCmd('f975843c')).kind, 'error', 'unknown prefix should error');

  assert.equal((await runCmd('aaaaaaaa')).kind, 'success');
  assert.deepEqual(h.state.get(), ['aaaaaaaa-1111']);

  await runCmd('add bbbb');
  assert.deepEqual(h.state.get(), ['aaaaaaaa-1111', 'bbbbbbbb-2222']);

  await runCmd('remove aaaa');
  assert.deepEqual(h.state.get(), ['bbbbbbbb-2222']);

  const off = await runCmd('off');
  assert.equal(off.kind, 'success');
  assert.deepEqual(h.state.get(), ['from-config']);
});

test('an empty candidate list does not crash the list action', async () => {
  const h = harness({ sessions: [] });
  const out = await tool(h).execute({ action: 'list' }, {});
  assert.equal(out.ok, true);
  assert.match(out.message, /No sessions found/);
});

test('a failing sessionQuery surfaces as an error, not a crash', async () => {
  const tools = new Map();
  const ctx = {
    effect: (fn) => fn(),
    logger: { warn: () => {} },
    tools: { register: (t) => tools.set(t.name, t) },
    commands: { register: () => {} },
  };
  const fs = fakeFs();
  const state = createSourceState({ file: '/s.json', defaults: [], fs });
  registerControls(ctx, {
    state,
    listCandidates: async () => {
      throw new Error('sessionQuery exploded');
    },
    onWarn: () => {},
  });
  await assert.rejects(() => tools.get('merge_sessions').execute({ action: 'list' }, {}), /exploded/);
});
