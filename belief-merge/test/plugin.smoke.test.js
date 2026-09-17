/**
 * Integration smoke test for the DSH adapter (lib/index.js).
 *
 * This loads the REAL adapter against the REAL @deepseek-ai/dsh-llm and
 * @deepseek-ai/schemastery packages, and drives it with a fake Cordis context.
 * It does not need a running harness, but it does exercise:
 *
 *   - plugin export shape (name / inject / Config / apply)
 *   - ctx.on('agent/pre-step', ..., { prepend: true }) registration
 *   - ctx.sessionQuery.readSurface() consumption, including partial failure
 *   - ctx.llm.stream() -> BlockAssembler -> text, using faithful chunk shapes
 *   - the fallback to the heuristic on any LLM failure
 *   - the guards: oncePerTurn, abort, reject, inert when no sources
 *
 * What it still does NOT prove: that a live harness injects the same payload
 * shape or that the model produces good JSON. See README.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  Config,
  apply,
  eventsToMessages,
  inject,
  latestUserText,
  name as pluginName,
} from '../lib/index.js';

/* ------------------------------------------------------------------ */
/* Fake Cordis context                                                 */
/* ------------------------------------------------------------------ */

/** Faithful text stream: matches BlockAssembler.push's switch. */
async function* streamText(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text };
  yield { type: 'block-end', index: 0, block: { type: 'text', text } };
  yield { type: 'finish', reason: { kind: 'stop' } };
}

/** A stream that terminates with an error, as an adapter failure would. */
async function* streamError(message, code) {
  yield { type: 'finish', reason: { kind: 'error', failure: { message, code } } };
}

/** A stream that hits the output cap mid-JSON. */
async function* streamTruncated(partial) {
  yield { type: 'block-start', index: 0, blockType: 'text' };
  yield { type: 'text-delta', index: 0, text: partial };
  yield { type: 'finish', reason: { kind: 'max-tokens' } };
}

function makeCtx({ surfaces = {}, stream = () => streamText('{}'), throwOn = [], sessions = [] } = {}) {
  const handlers = new Map();
  const warnings = [];
  const streamCalls = [];
  const tools = new Map();
  const commands = new Map();

  const ctx = {
    on(event, handler, options) {
      handlers.set(event, { handler, options });
    },
    // cordis runs registered effects and disposes them with the fiber.
    effect(fn) {
      return fn();
    },
    logger: { warn: (m) => warnings.push(m) },
    tools: {
      register(tool) {
        tools.set(tool.name, tool);
        return () => tools.delete(tool.name);
      },
    },
    commands: {
      register(command) {
        commands.set(command.name, command);
        return () => commands.delete(command.name);
      },
    },
    sessionQuery: {
      async readSurface(id) {
        if (throwOn.includes(id)) throw new Error(`unreadable session: ${id}`);
        if (!(id in surfaces)) throw new Error(`no such session: ${id}`);
        return surfaces[id];
      },
      async listSessions() {
        return sessions.map((s) => ({ header: { id: s.id, cwd: s.workspace }, live: !!s.live }));
      },
      async readTitleSnapshots(ids) {
        return sessions
          .filter((s) => ids.includes(s.id))
          .map((s) => ({ session: { id: s.id }, ...(s.title ? { title: s.title } : {}) }));
      },
    },
    llm: {
      stream(options) {
        streamCalls.push(options);
        return stream(options);
      },
    },
  };

  return { ctx, handlers, warnings, streamCalls, tools, commands };
}

const AGENT = {
  session: {
    id: 'current-session',
    requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-chat' } }),
  },
};

const SURFACES = {
  'branch-a': [
    { role: 'user', content: [{ type: 'text', text: 'We switched the database to PostgreSQL.' }] },
  ],
  'branch-b': [
    { role: 'assistant', content: [{ type: 'reasoning', text: 'The database is probably MySQL.' }] },
  ],
};

const ALIGNED_JSON = JSON.stringify({
  slots: [
    {
      key: 'database.engine',
      type: 'Fact',
      opinions: [
        { source: 'branch-a', value: 'postgresql', evidence: 4, quote: 'We switched the database to PostgreSQL.' },
        { source: 'branch-b', value: 'mysql', evidence: 1, quote: 'The database is probably MySQL.' },
      ],
    },
  ],
});

/** Drive one pre-step through the registered handler. */
async function runPreStep(handler, { step = 1, signal, existing = [] } = {}) {
  const decision = { kind: 'messages', messages: [...existing] };
  return handler(
    { agent: AGENT, step, signal: signal ?? new AbortController().signal },
    async () => decision,
  );
}

/* ------------------------------------------------------------------ */
/* Plugin shape                                                        */
/* ------------------------------------------------------------------ */

test('exports the Cordis plugin shape', () => {
  assert.equal(typeof apply, 'function');
  assert.equal(pluginName, 'belief-merge');
  assert.deepEqual(inject, ['agents', 'sessionQuery', 'llm', 'tools', 'commands']);
  assert.ok(Config, 'Config schema must be exported');
  assert.equal(typeof Config, 'function');
});

test('no sources -> mounts the controls and injects nothing', () => {
  // Returning early here was the original bug: a user with no sources
  // configured is exactly the user who needs the tool to turn merging on.
  const { ctx, handlers, tools, commands } = makeCtx();
  apply(ctx, { sources: [] });
  assert.equal(tools.size, 1, 'the tool must be offered even with nothing configured');
  assert.equal(commands.size, 1, 'the command must be offered too');
  assert.equal(handlers.size, 1, 'the pre-step listener is registered and decides per turn');
});

test('registers a prepended agent/pre-step listener', () => {
  const { ctx, handlers } = makeCtx({ surfaces: SURFACES });
  apply(ctx, { sources: ['branch-a'] });
  const entry = handlers.get('agent/pre-step');
  assert.ok(entry, 'agent/pre-step must be registered');
  assert.deepEqual(entry.options, { prepend: true });
});

/* ------------------------------------------------------------------ */
/* Happy path                                                          */
/* ------------------------------------------------------------------ */

test('injects the merged context as a user message', async () => {
  const { ctx, handlers } = makeCtx({
    surfaces: SURFACES,
    stream: () => streamText(ALIGNED_JSON),
  });
  apply(ctx, { sources: ['branch-a', 'branch-b'], useLlmAlignment: true });

  const existing = [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'hello' }] }];
  const result = await runPreStep(handlers.get('agent/pre-step').handler, { existing });

  assert.equal(result.kind, 'messages');
  assert.equal(result.messages.length, 2, 'existing message must be preserved');
  assert.equal(result.messages[0].id, 'm1');

  const injected = result.messages[1];
  assert.equal(injected.role, 'user');
  assert.equal(injected.source.kind, 'plugin');
  assert.equal(injected.source.plugin, 'belief-merge');
  const text = injected.content.map((b) => b.text).join('');
  assert.match(text, /database\.engine/);
  assert.match(text, /postgresql/, 'the user-stated value must win');
});

test('the LLM call carries the agent route and the abort signal', async () => {
  const { ctx, handlers, streamCalls } = makeCtx({
    surfaces: SURFACES,
    stream: () => streamText(ALIGNED_JSON),
  });
  apply(ctx, { sources: ['branch-a', 'branch-b'], useLlmAlignment: true });

  const controller = new AbortController();
  await runPreStep(handlers.get('agent/pre-step').handler, { signal: controller.signal });

  assert.equal(streamCalls.length, 1);
  assert.equal(streamCalls[0].provider, 'deepseek');
  assert.equal(streamCalls[0].model, 'deepseek-chat');
  assert.equal(streamCalls[0].sessionId, 'current-session');
  assert.equal(streamCalls[0].purpose, 'belief-merge-alignment');
  assert.equal(streamCalls[0].signal, controller.signal);
});

test('REGRESSION: alignment disables reasoning so the JSON budget is not burned', async () => {
  // Observed live: with the agent's own effort (high), the model spent the
  // whole output budget on reasoning deltas, returned 0 characters of text,
  // and the call ended `max-tokens`.
  const { ctx, handlers, streamCalls } = makeCtx({
    surfaces: SURFACES,
    stream: () => streamText(ALIGNED_JSON),
  });
  apply(ctx, { sources: ['branch-a'], useLlmAlignment: true });
  await runPreStep(handlers.get('agent/pre-step').handler);

  assert.equal(streamCalls[0].reasoningEffort, 'off');
});

test('alignment requests temperature 0 for reproducible extraction', async () => {
  const { ctx, handlers, streamCalls } = makeCtx({
    surfaces: SURFACES,
    stream: () => streamText(ALIGNED_JSON),
  });
  apply(ctx, { sources: ['branch-a'], useLlmAlignment: true });
  await runPreStep(handlers.get('agent/pre-step').handler);

  assert.equal(streamCalls[0].temperature, 0);
});

test('the alignment reasoning effort is configurable', async () => {
  const { ctx, handlers, streamCalls } = makeCtx({
    surfaces: SURFACES,
    stream: () => streamText(ALIGNED_JSON),
  });
  apply(ctx, { sources: ['branch-a'], useLlmAlignment: true, alignmentReasoningEffort: 'low' });
  await runPreStep(handlers.get('agent/pre-step').handler);

  assert.equal(streamCalls[0].reasoningEffort, 'low');
});

test('an explicit alignment route overrides the agent route', async () => {
  const { ctx, handlers, streamCalls } = makeCtx({
    surfaces: SURFACES,
    stream: () => streamText(ALIGNED_JSON),
  });
  apply(ctx, {
    sources: ['branch-a'],
    useLlmAlignment: true,
    alignmentProvider: 'other',
    alignmentModel: 'other-model',
  });
  await runPreStep(handlers.get('agent/pre-step').handler);

  assert.equal(streamCalls[0].provider, 'other');
  assert.equal(streamCalls[0].model, 'other-model');
});

/* ------------------------------------------------------------------ */
/* Guards                                                              */
/* ------------------------------------------------------------------ */

test('oncePerTurn: no injection after step 1', async () => {
  const { ctx, handlers, streamCalls } = makeCtx({
    surfaces: SURFACES,
    stream: () => streamText(ALIGNED_JSON),
  });
  apply(ctx, { sources: ['branch-a'], oncePerTurn: true });

  const result = await runPreStep(handlers.get('agent/pre-step').handler, { step: 2 });
  assert.equal(result.messages.length, 0);
  assert.equal(streamCalls.length, 0, 'no LLM call should happen off-turn-step');
});

test('an aborted signal short-circuits', async () => {
  const { ctx, handlers, streamCalls } = makeCtx({
    surfaces: SURFACES,
    stream: () => streamText(ALIGNED_JSON),
  });
  apply(ctx, { sources: ['branch-a'] });

  const controller = new AbortController();
  controller.abort();
  const result = await runPreStep(handlers.get('agent/pre-step').handler, {
    signal: controller.signal,
  });
  assert.equal(result.messages.length, 0);
  assert.equal(streamCalls.length, 0);
});

test('a rejected step is returned untouched', async () => {
  const { ctx, handlers } = makeCtx({ surfaces: SURFACES });
  apply(ctx, { sources: ['branch-a'] });

  const handler = handlers.get('agent/pre-step').handler;
  const result = await handler({ agent: AGENT, step: 1, signal: new AbortController().signal },
    async () => ({ kind: 'reject', reason: 'nope' }));
  assert.equal(result.kind, 'reject');
});

/* ------------------------------------------------------------------ */
/* Degradation                                                         */
/* ------------------------------------------------------------------ */

test('an unreadable source is skipped, the rest still merge', async () => {
  const { ctx, handlers, warnings } = makeCtx({
    surfaces: SURFACES,
    throwOn: ['branch-a'],
    stream: () => streamText(ALIGNED_JSON),
  });
  apply(ctx, { sources: ['branch-a', 'branch-b'], useLlmAlignment: true });

  const result = await runPreStep(handlers.get('agent/pre-step').handler);
  assert.equal(result.messages.length, 1, 'branch-b alone should still inject');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /cannot read session branch-a/);
});

test('all sources unreadable -> no injection, no crash', async () => {
  const { ctx, handlers, warnings } = makeCtx({ surfaces: {}, throwOn: ['branch-a'] });
  apply(ctx, { sources: ['branch-a'] });

  const result = await runPreStep(handlers.get('agent/pre-step').handler);
  assert.equal(result.messages.length, 0);
  assert.equal(warnings.length, 1);
});

test('an LLM error finish degrades to the heuristic and still injects', async () => {
  const { ctx, handlers, warnings } = makeCtx({
    surfaces: SURFACES,
    stream: () => streamError('provider exploded', 'LLM_ERROR'),
  });
  apply(ctx, { sources: ['branch-a', 'branch-b'], useLlmAlignment: true });

  const result = await runPreStep(handlers.get('agent/pre-step').handler);
  assert.equal(result.messages.length, 1, 'a degraded result beats a broken turn');
  const text = result.messages[0].content.map((b) => b.text).join('');
  assert.match(text, /Merged context/);
  assert.ok(warnings.some((w) => /heuristic fallback/.test(w)));
});

test('a truncated (max-tokens) response degrades to the heuristic', async () => {
  const { ctx, handlers } = makeCtx({
    surfaces: SURFACES,
    stream: () => streamTruncated('{"slots":[{"key":"database.engine","opinions":[{"sou'),
  });
  apply(ctx, { sources: ['branch-a', 'branch-b'], useLlmAlignment: true });

  const result = await runPreStep(handlers.get('agent/pre-step').handler);
  assert.equal(result.messages.length, 1);
  const text = result.messages[0].content.map((b) => b.text).join('');
  assert.match(text, /Merged context/);
});

test('useLlmAlignment: false never touches the LLM', async () => {
  const { ctx, handlers, streamCalls } = makeCtx({ surfaces: SURFACES });
  apply(ctx, { sources: ['branch-a', 'branch-b'], useLlmAlignment: false });

  const result = await runPreStep(handlers.get('agent/pre-step').handler);
  assert.equal(streamCalls.length, 0);
  assert.equal(result.messages.length, 1);
});

test('no llm service mounted -> heuristic, no throw', async () => {
  const { ctx, handlers } = makeCtx({ surfaces: SURFACES });
  delete ctx.llm;
  apply(ctx, { sources: ['branch-a', 'branch-b'], useLlmAlignment: true });

  const result = await runPreStep(handlers.get('agent/pre-step').handler);
  assert.equal(result.messages.length, 1);
});

test('readSurface returning a wrapper object is handled', async () => {
  const { ctx, handlers } = makeCtx({
    surfaces: { 'branch-a': { messages: SURFACES['branch-a'] } },
    stream: () => streamText(ALIGNED_JSON),
  });
  apply(ctx, { sources: ['branch-a'], useLlmAlignment: true });

  const result = await runPreStep(handlers.get('agent/pre-step').handler);
  assert.equal(result.messages.length, 1);
});

/* ------------------------------------------------------------------ */
/* Regression: the REAL readSurface shape                              */
/* ------------------------------------------------------------------ */

test('eventsToMessages maps surface events, skipping the system prompt', () => {
  const events = [
    { type: 'system/message', data: { role: 'system', content: [{ type: 'text', text: 'prompt' }] } },
    { type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'u' }] } },
    { type: 'assistant/message', data: { role: 'assistant', content: [{ type: 'text', text: 'a' }] } },
    { type: 'tool/result', data: { role: 'tool', content: [{ type: 'text', text: 't' }] } },
    { type: 'compaction/start', data: { foo: 1 } },
    { type: 'user/message' }, // malformed, must be skipped
  ];
  const messages = eventsToMessages(events);
  assert.deepEqual(
    messages.map((m) => m.role),
    ['user', 'assistant', 'tool'],
  );
});

test('REGRESSION: readSurface returns surface EVENTS, not messages', async () => {
  // The real shape from ctx.sessionQuery.readSurface():
  //   { session, inheritedEventCount, capturedThroughSeq, events: [...] }
  // Reading `.messages` off this yields an empty branch and an EMPTY merge.
  const surfaceAsEvents = {
    session: { id: 'branch-a' },
    inheritedEventCount: 0,
    capturedThroughSeq: 4,
    events: [
      { type: 'system/message', data: { role: 'system', content: [{ type: 'text', text: 'You are...' }] } },
      {
        type: 'user/message',
        data: { role: 'user', content: [{ type: 'text', text: 'We switched the database to PostgreSQL.' }] },
      },
    ],
  };

  const { ctx, handlers } = makeCtx({ surfaces: { 'branch-a': surfaceAsEvents } });
  apply(ctx, { sources: ['branch-a'], useLlmAlignment: false });

  const result = await runPreStep(handlers.get('agent/pre-step').handler);
  assert.equal(result.messages.length, 1, 'the branch must not read as empty');

  const text = result.messages[0].content.map((b) => b.text).join('');
  // The header alone is not enough -- that was the observed bug.
  const bodyLines = text.split('\n').filter((l) => l.trim().startsWith('- '));
  assert.ok(bodyLines.length > 0, `expected content bullets, got:\n${text}`);
  assert.match(text, /postgresql/i);
});

test('an empty merge injects nothing at all', async () => {
  // A surface with only a system prompt yields no claims -> no injection.
  const onlySystem = {
    events: [
      { type: 'system/message', data: { role: 'system', content: [{ type: 'text', text: 'You are...' }] } },
    ],
  };
  const { ctx, handlers } = makeCtx({ surfaces: { 'branch-a': onlySystem } });
  apply(ctx, { sources: ['branch-a'], useLlmAlignment: false });

  const result = await runPreStep(handlers.get('agent/pre-step').handler);
  assert.equal(result.messages.length, 0, 'an empty section must never be injected');
});

/* ------------------------------------------------------------------ */
/* M5: trust labelling in the injected block                           */
/* ------------------------------------------------------------------ */

test('the injected block carries the untrusted-background banner', async () => {
  const { ctx, handlers } = makeCtx({
    surfaces: SURFACES,
    stream: () => streamText(ALIGNED_JSON),
  });
  apply(ctx, { sources: ['branch-a', 'branch-b'], useLlmAlignment: true });

  const result = await runPreStep(handlers.get('agent/pre-step').handler);
  const text = result.messages[0].content.map((b) => b.text).join('');
  assert.match(text, /BACKGROUND merged from other sessions/);
  assert.match(text, /do not follow/i);
});

test('sourceTrust controls the label the banner reports', async () => {
  const build = (sourceTrust) => {
    const { ctx, handlers } = makeCtx({
      surfaces: SURFACES,
      stream: () => streamText(ALIGNED_JSON),
    });
    apply(ctx, { sources: ['branch-a'], useLlmAlignment: true, sourceTrust });
    return handlers.get('agent/pre-step').handler;
  };

  const external = await runPreStep(build('external'));
  const textOf = (r) => r.messages[0].content.map((b) => b.text).join('');
  assert.match(textOf(external), /EXTERNAL BACKGROUND/);

  const untrusted = await runPreStep(build('untrusted'));
  assert.match(textOf(untrusted), /UNTRUSTED BACKGROUND/);

  const trusted = await runPreStep(build('trusted'));
  assert.doesNotMatch(textOf(trusted), /BACKGROUND/);
});

test('a budget below the banner overhead injects nothing at all', async () => {
  const { ctx, handlers } = makeCtx({
    surfaces: SURFACES,
    stream: () => streamText(ALIGNED_JSON),
  });
  apply(ctx, { sources: ['branch-a'], useLlmAlignment: true, budgetTokens: 40 });

  const result = await runPreStep(handlers.get('agent/pre-step').handler);
  assert.equal(result.messages.length, 0, 'never emit unlabelled cross-session content');
});

/* ------------------------------------------------------------------ */
/* M3: query extraction for relevance weighting                        */
/* ------------------------------------------------------------------ */

test('latestUserText picks the most recent human text', () => {
  const decision = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'first question' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'an answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'the latest question' }] },
    ],
  };
  assert.equal(latestUserText(decision), 'the latest question');
});

test('latestUserText ignores non-text blocks and empty messages', () => {
  const decision = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'real question' }] },
      { role: 'user', content: [{ type: 'image', data: 'x' }] },
      { role: 'user', content: [{ type: 'text', text: '   ' }] },
    ],
  };
  assert.equal(latestUserText(decision), 'real question');
});

test('latestUserText returns undefined when there is no user text', () => {
  assert.equal(latestUserText({ messages: [] }), undefined);
  assert.equal(latestUserText({}), undefined);
  assert.equal(latestUserText(undefined), undefined);
});

test('the packer runs without breaking the injected block', async () => {
  const { ctx, handlers } = makeCtx({
    surfaces: SURFACES,
    stream: () => streamText(ALIGNED_JSON),
  });
  apply(ctx, { sources: ['branch-a', 'branch-b'], useLlmAlignment: true });

  const result = await runPreStep(handlers.get('agent/pre-step').handler, {
    existing: [{ role: 'user', content: [{ type: 'text', text: 'what about the database engine?' }] }],
  });
  assert.equal(result.messages.length, 2);
  const text = result.messages[1].content.map((b) => b.text).join('');
  assert.match(text, /Merged context/);
  assert.match(text, /database\.engine/);
});

/* ------------------------------------------------------------------ */
/* Determinism                                                         */
/* ------------------------------------------------------------------ */

test('two identical runs inject byte-identical text', async () => {
  const build = () => {
    const { ctx, handlers } = makeCtx({
      surfaces: SURFACES,
      stream: () => streamText(ALIGNED_JSON),
    });
    apply(ctx, { sources: ['branch-a', 'branch-b'], useLlmAlignment: true });
    return handlers.get('agent/pre-step').handler;
  };

  const a = await runPreStep(build());
  const b = await runPreStep(build());
  const textOf = (r) => r.messages[0].content.map((x) => x.text).join('');
  assert.equal(textOf(a), textOf(b));
});
