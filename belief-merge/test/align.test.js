import test from 'node:test';
import assert from 'node:assert/strict';

import {
  alignSurfaces,
  buildAlignmentPrompt,
  extractJsonObject,
  mergeBranches,
  mergeSurfaces,
  mergeSurfacesAligned,
  normalizeAlignment,
} from '../lib/core/index.js';

/** A deterministic stand-in for ctx.llm. */
function fakeLlm(response) {
  return {
    calls: [],
    async complete(request) {
      this.calls.push(request);
      if (response instanceof Error) throw response;
      return response;
    },
  };
}

const SURFACES = [
  {
    id: 'branch-a',
    messages: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'We switched the database to PostgreSQL.' }],
      },
    ],
  },
  {
    id: 'branch-b',
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'reasoning', text: 'The database is probably MySQL.' }],
      },
    ],
  },
];

const ALIGNED = JSON.stringify({
  slots: [
    {
      key: 'database.engine',
      type: 'Fact',
      opinions: [
        { source: 'branch-a', value: 'PostgreSQL', evidence: 4, quote: 'We switched the database to PostgreSQL.' },
        { source: 'branch-b', value: 'MySQL', evidence: 1, quote: 'The database is probably MySQL.' },
      ],
    },
  ],
});

/* ------------------------------------------------------------------ */
/* The limitation this milestone exists to fix                          */
/* ------------------------------------------------------------------ */

test('the heuristic cannot align paraphrases (the known limitation)', () => {
  const merged = mergeSurfaces(SURFACES);
  // Two unrelated slots -> no conflict detected at all.
  assert.equal(merged.slots.length, 2);
});

test('M1: joint alignment DOES collapse paraphrases into one slot', async () => {
  const { branches } = await alignSurfaces(SURFACES, { llm: fakeLlm(ALIGNED) });
  const merged = mergeBranches(branches);

  assert.equal(merged.slots.length, 1, 'both opinions must land in ONE slot');
  assert.equal(merged.slots[0].key, 'database.engine');
});

test('M1: the aligned conflict is decided by evidence, not by order', async () => {
  const { branches } = await alignSurfaces(SURFACES, { llm: fakeLlm(ALIGNED) });
  const merged = mergeBranches(branches);
  const slot = merged.slots[0];

  // The user stated PostgreSQL (4); the model only speculated MySQL (1).
  assert.equal(slot.decision.winner, 'postgresql');
  assert.equal(slot.decision.outcome, 'resolved');
  // Both sides stay in the annotation -- nothing is discarded.
  assert.equal(slot.state.items.length, 2);
  assert.deepEqual(
    slot.state.items.map((i) => i.value).sort(),
    ['mysql', 'postgresql'],
  );
});

/* ------------------------------------------------------------------ */
/* Robustness                                                          */
/* ------------------------------------------------------------------ */

test('a markdown fence around the JSON is tolerated', async () => {
  const fenced = '```json\n' + ALIGNED + '\n```';
  const { branches } = await alignSurfaces(SURFACES, { llm: fakeLlm(fenced) });
  assert.equal(mergeBranches(branches).slots.length, 1);
});

test('prose around the JSON object is tolerated', async () => {
  const chatty = `Sure! Here is the result:\n${ALIGNED}\nLet me know if you need more.`;
  const { branches } = await alignSurfaces(SURFACES, { llm: fakeLlm(chatty) });
  assert.equal(mergeBranches(branches).slots.length, 1);
});

test('an invented source id is rejected, not trusted', () => {
  const parsed = {
    slots: [
      {
        key: 'x',
        opinions: [
          { source: 'branch-a', value: 'a', evidence: 2 },
          { source: 'branch-ZZZ', value: 'b', evidence: 4 }, // does not exist
        ],
      },
    ],
  };
  const normalized = normalizeAlignment(parsed, { knownSources: new Set(['branch-a']) });
  assert.equal(normalized.slots[0].opinions.length, 1);
  assert.equal(normalized.slots[0].opinions[0].source, 'branch-a');
});

test('a fabricated corroboration cannot manufacture a majority', async () => {
  // The model tries to bolster value "mysql" with two non-existent branches.
  const forged = JSON.stringify({
    slots: [
      {
        key: 'database.engine',
        opinions: [
          { source: 'branch-a', value: 'postgresql', evidence: 4 },
          { source: 'ghost-1', value: 'mysql', evidence: 4 },
          { source: 'ghost-2', value: 'mysql', evidence: 4 },
        ],
      },
    ],
  });
  const { branches } = await alignSurfaces(SURFACES, { llm: fakeLlm(forged) });
  const slot = mergeBranches(branches).slots[0];
  assert.equal(slot.decision.winner, 'postgresql');
  assert.equal(slot.state.items.length, 1, 'ghost opinions must not enter the annotation');
});

test('evidence is clamped into 1..4', () => {
  const parsed = {
    slots: [
      {
        key: 'x',
        opinions: [
          { source: 'a', value: 'v1', evidence: 99 },
          { source: 'b', value: 'v2', evidence: -5 },
          { source: 'c', value: 'v3', evidence: 'nonsense' },
        ],
      },
    ],
  };
  const slots = normalizeAlignment(parsed, { knownSources: new Set(['a', 'b', 'c']) }).slots;
  const levels = slots[0].opinions.map((o) => o.evidence).sort();
  assert.deepEqual(levels, [1, 2, 4]);
});

test('malformed and empty responses both throw', () => {
  assert.throws(() => extractJsonObject('not json at all'));
  assert.throws(() => extractJsonObject(''));
  assert.throws(() => extractJsonObject('[1,2,3]'));
  assert.throws(() => normalizeAlignment({ slots: [] }, { knownSources: new Set() }));
  assert.throws(() => normalizeAlignment({}, { knownSources: new Set() }));
});

/* ------------------------------------------------------------------ */
/* Fallback                                                            */
/* ------------------------------------------------------------------ */

test('no llm configured -> heuristic mode', async () => {
  const merged = await mergeSurfacesAligned(SURFACES, {});
  assert.equal(merged.mode, 'heuristic');
});

test('llm failure -> warn and fall back, never throw', async () => {
  const warnings = [];
  const merged = await mergeSurfacesAligned(SURFACES, {
    llm: fakeLlm(new Error('provider exploded')),
    onWarn: (m) => warnings.push(m),
  });
  assert.equal(merged.mode, 'heuristic');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /heuristic fallback/);
});

test('a response with no usable slots falls back rather than emitting junk', async () => {
  const merged = await mergeSurfacesAligned(SURFACES, {
    llm: fakeLlm(JSON.stringify({ slots: [{ key: '', opinions: [] }] })),
  });
  assert.equal(merged.mode, 'heuristic');
});

/* ------------------------------------------------------------------ */
/* Prompt construction                                                 */
/* ------------------------------------------------------------------ */

test('the prompt lists exactly the valid branch ids', () => {
  const { system, prompt } = buildAlignmentPrompt(SURFACES);
  assert.match(prompt, /branch-a/);
  assert.match(prompt, /branch-b/);
  assert.match(system, /ALIGN BY MEANING/);
  // The reasoning block must reach the model -- that is the differentiator.
  assert.match(prompt, /The database is probably MySQL\./);
});

test('reasoning blocks can be excluded from the prompt', () => {
  const { prompt } = buildAlignmentPrompt(SURFACES, { includeReasoning: false });
  assert.doesNotMatch(prompt, /probably MySQL/);
});

test('a long branch is truncated from the front, keeping the recent tail', () => {
  const long = {
    id: 'long',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'OLD '.repeat(500) }] },
      { role: 'user', content: [{ type: 'text', text: 'THE RECENT FACT' }] },
    ],
  };
  const { prompt } = buildAlignmentPrompt([long], { maxCharsPerBranch: 200 });
  assert.match(prompt, /THE RECENT FACT/);
  assert.match(prompt, /truncated/);
});

test('alignment is deterministic for identical input', async () => {
  const first = await alignSurfaces(SURFACES, { llm: fakeLlm(ALIGNED) });
  const second = await alignSurfaces(SURFACES, { llm: fakeLlm(ALIGNED) });
  assert.deepEqual(first.branches, second.branches);
});

test('the llm receives the abort signal', async () => {
  const llm = fakeLlm(ALIGNED);
  const controller = new AbortController();
  await alignSurfaces(SURFACES, { llm, signal: controller.signal });
  assert.equal(llm.calls.length, 1);
  assert.equal(llm.calls[0].signal, controller.signal);
});

/* ------------------------------------------------------------------ */
/* INTEGRATION: the wiring, not just the parts                         */
/* ------------------------------------------------------------------ */

/**
 * The parts were each unit-tested and a missing import still shipped: the
 * module re-exported `adjudicateConflicts` with `export *` but never bound it
 * locally, and no test exercised alignment -> merge -> adjudication in one
 * call. These tests exist to close that gap.
 */
const TIED_SURFACES = [
  {
    id: 'branch-a',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'The cache TTL is sixty seconds.' }] },
    ],
  },
  {
    id: 'branch-b',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'The cache TTL is three hundred seconds.' }] },
    ],
  },
];

const TIED_ALIGNMENT = JSON.stringify({
  slots: [
    {
      key: 'cache.ttl_seconds',
      type: 'Fact',
      opinions: [
        { source: 'branch-a', value: 'sixty', evidence: 2, quote: 'The cache TTL is sixty seconds.' },
        { source: 'branch-b', value: 'three_hundred', evidence: 2, quote: 'The cache TTL is three hundred seconds.' },
      ],
    },
  ],
});

const TIED_RESOLUTION = JSON.stringify({
  resolutions: [
    { key: 'cache.ttl_seconds', outcome: 'choose', value: 'sixty', premises: ['c0.o0'], rationale: 'branch-a states it plainly' },
  ],
});

/** Returns a scripted response per call, cycling on the last one. */
function scriptedLlm(responses) {
  let call = 0;
  return {
    calls: [],
    async complete(request) {
      this.calls.push(request);
      const response = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return response;
    },
  };
}

test('INTEGRATION: alignment -> merge -> adjudication on a genuine tie', async () => {
  const llm = scriptedLlm([TIED_ALIGNMENT, TIED_RESOLUTION]);
  const merged = await mergeSurfacesAligned(TIED_SURFACES, { llm });

  assert.equal(merged.mode, 'llm', 'alignment must succeed');
  assert.equal(merged.adjudication.mode, 'llm', 'the tie must reach the adjudicator');
  assert.equal(merged.adjudication.conflicts, 1);
  assert.equal(merged.adjudication.resolved, 1);
  assert.equal(merged.slots[0].resolution.value, 'sixty');

  const text = merged.render({ budgetTokens: 500 }).text;
  assert.match(text, /cache\.ttl_seconds` = \*\*sixty\*\*/);
  assert.doesNotMatch(text, /DISPUTED/);

  // One alignment call, then the forward and reversed adjudication calls.
  assert.equal(llm.calls.length, 3);
});

test('INTEGRATION: adjudicate:false leaves the tie standing', async () => {
  const llm = scriptedLlm([TIED_ALIGNMENT, TIED_RESOLUTION]);
  const merged = await mergeSurfacesAligned(TIED_SURFACES, { llm, adjudicate: false });

  assert.equal(merged.adjudication.mode, 'none');
  assert.equal(merged.slots[0].resolution, undefined);
  assert.match(merged.render({ budgetTokens: 500 }).text, /DISPUTED/);
  assert.equal(llm.calls.length, 1, 'no adjudication call should be made');
});

test('INTEGRATION: an order-sensitive adjudicator leaves the tie standing', async () => {
  const flipped = JSON.stringify({
    resolutions: [
      { key: 'cache.ttl_seconds', outcome: 'choose', value: 'three_hundred', premises: [], rationale: '' },
    ],
  });
  const llm = scriptedLlm([TIED_ALIGNMENT, TIED_RESOLUTION, flipped]);
  const merged = await mergeSurfacesAligned(TIED_SURFACES, { llm });

  assert.equal(merged.adjudication.orderSensitive, 1);
  assert.equal(merged.adjudication.resolved, 0);
  assert.equal(merged.slots[0].resolution.outcome, 'unresolvable');
  assert.match(merged.render({ budgetTokens: 500 }).text, /DISPUTED/);
});

test('INTEGRATION: a failing adjudicator does not break the merge', async () => {
  const llm = scriptedLlm([TIED_ALIGNMENT, 'total nonsense']);
  const warnings = [];
  const merged = await mergeSurfacesAligned(TIED_SURFACES, {
    llm,
    onWarn: (m) => warnings.push(m),
  });

  assert.equal(merged.mode, 'llm', 'alignment still succeeded');
  assert.equal(merged.adjudication.mode, 'error');
  assert.equal(merged.slots.length, 1, 'the merged context survives');
  assert.match(merged.render({ budgetTokens: 500 }).text, /DISPUTED/);
  assert.ok(warnings.some((w) => /adjudication failed/.test(w)));
});
