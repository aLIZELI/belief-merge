/**
 * Tests for surface handling -- the module that decides what counts as a
 * claim at all.
 *
 * The central rule, learned from a live run: DSH delivers injected context
 * (sandbox policy, approval notices, other plugins' blocks) as `user/message`
 * events with `source.kind === 'plugin'`. Treating those as "the user said it"
 * gives harness boilerplate the HIGHEST evidence level and floods the merge.
 * A live run over two real sessions produced 170 such "claims".
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Evidence,
  classifyBlock,
  extractClaims,
  flattenSurface,
  isInjected,
} from '../lib/core/index.js';

const human = (text) => ({
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
});

const injected = (text) => ({
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'plugin', plugin: 'some-plugin', form: 'snapshot' },
});

const assistant = (text) => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  source: { kind: 'model' },
});

/* ------------------------------------------------------------------ */

test('isInjected recognises plugin-sourced messages only', () => {
  assert.equal(isInjected(human('x')), true === false);
  assert.equal(isInjected(injected('x')), true);
  assert.equal(isInjected(assistant('x')), false);
  assert.equal(isInjected({ role: 'user' }), false);
});

test('classifyBlock labels injected content distinctly', () => {
  assert.equal(classifyBlock('user', 'text', human('x')), 'user');
  assert.equal(classifyBlock('user', 'text', injected('x')), 'injected');
  assert.equal(classifyBlock('assistant', 'reasoning', assistant('x')), 'reasoning');
  assert.equal(classifyBlock('tool', 'text', { role: 'tool' }), 'tool');
});

/* ------------------------------------------------------------------ */
/* The exclusion rule                                                  */
/* ------------------------------------------------------------------ */

test('flattenSurface excludes injected messages by default', () => {
  const messages = [
    injected('You have a file sandbox. Approval prompts are disabled.'),
    human('The database is PostgreSQL.'),
  ];
  const { text, skippedInjected } = flattenSurface(messages);
  assert.equal(skippedInjected, 1);
  assert.doesNotMatch(text, /sandbox/i);
  assert.match(text, /PostgreSQL/);
});

test('flattenSurface can include injected messages on request', () => {
  const messages = [injected('harness policy'), human('a real statement')];
  const { text, skippedInjected } = flattenSurface(messages, { includeInjected: true });
  assert.equal(skippedInjected, 0);
  assert.match(text, /harness policy/);
});

test('extractClaims excludes injected messages by default', () => {
  const messages = [
    injected('Any available operation enforced by the sandbox may modify files.'),
    human('We switched the database to PostgreSQL.'),
  ];
  const claims = extractClaims(messages, { sourceId: 'b' });
  assert.equal(claims.length, 1);
  assert.match(claims[0].text, /PostgreSQL/);
});

test('REGRESSION: injected text must never outrank a real user statement', () => {
  // Both are user-role messages; only one is actually the user speaking.
  const messages = [
    injected('The database is MySQL.'),
    human('The database is PostgreSQL.'),
  ];

  const withoutInjected = extractClaims(messages, { sourceId: 'b' });
  assert.equal(withoutInjected.length, 1);
  assert.equal(withoutInjected[0].text, 'The database is PostgreSQL.');
  assert.equal(withoutInjected[0].evidence, Evidence.USER_STATED);

  // Even when explicitly included, injected content is only SPECULATIVE.
  const withInjected = extractClaims(messages, { sourceId: 'b', includeInjected: true });
  const byText = new Map(withInjected.map((c) => [c.text, c.evidence]));
  assert.equal(byText.get('The database is PostgreSQL.'), Evidence.USER_STATED);
  assert.equal(byText.get('The database is MySQL.'), Evidence.SPECULATIVE);
});

test('the heuristic cannot align competing values for one topic (known limitation)', () => {
  // Exact-text keying has no way to know that "MySQL" and "PostgreSQL" are
  // competing answers to the SAME question, so they become two slots and the
  // conflict is missed. That is precisely what the LLM alignment path fixes --
  // see test/align.test.js for the same input collapsing to one slot.
  const messages = [
    injected('The database is MySQL.'),
    human('The database is PostgreSQL.'),
  ];
  const claims = extractClaims(messages, { sourceId: 'b', includeInjected: true });
  assert.equal(new Set(claims.map((c) => c.key)).size, 2);
});

/* ------------------------------------------------------------------ */

test('reasoning blocks are kept by default and can be dropped', () => {
  const messages = [
    { role: 'assistant', content: [{ type: 'reasoning', text: 'maybe MySQL' }], source: { kind: 'model' } },
  ];
  assert.equal(extractClaims(messages, { sourceId: 'b' }).length, 1);
  assert.equal(extractClaims(messages, { sourceId: 'b', includeReasoning: false }).length, 0);
});

test('truncation keeps the recent tail', () => {
  const messages = [human('OLD '.repeat(400)), human('THE RECENT FACT')];
  const { text, truncated } = flattenSurface(messages, { maxChars: 120 });
  assert.equal(truncated, true);
  assert.match(text, /THE RECENT FACT/);
});
