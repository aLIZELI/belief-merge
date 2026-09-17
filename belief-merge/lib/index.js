/**
 * dsh-belief-merge -- DeepSeek Harness adapter.
 *
 * Reads N other sessions' model surfaces through `ctx.sessionQuery`, merges
 * them, and injects the result as durable user-role context at `agent/pre-step`.
 *
 * Design decisions that come from verified source, not guesswork:
 *
 *  - Session logs on disk are Zstandard-compressed (`session.v3.jsonl.zstd`),
 *    so this plugin MUST read through `ctx.sessionQuery` rather than parsing
 *    files.  `readSurface()` gives the current model surface directly.
 *
 *  - Injection happens at `agent/pre-step`, whose documented contract is that
 *    a listener "can reject a proposed step or replace the messages entering
 *    it".  This mirrors the shipped `dsh-time-context` plugin.
 *
 *  - Alignment runs through `ctx.llm.stream()`, assembled with
 *    `BlockAssembler`, exactly as `dsh-compaction-basic` does.  Any failure
 *    falls back to the deterministic heuristic so a turn never breaks.
 *
 *  - `dsh-session-reference` (the nearest official mechanism) deliberately
 *    excludes reasoning and tool content and does no merging.  This plugin
 *    includes reasoning blocks by default and merges rather than concatenates.
 *
 * ⚠️ STATUS: the core in ./core is fully tested (`npm test`).  This adapter is
 * written against the documented contracts above but has NOT been exercised
 * inside a live DSH process -- see README "Verified vs unverified".
 */

import z from '@deepseek-ai/schemastery';
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';

import { mergeSurfacesAligned, checkTrustInvariants, trustFromName } from './core/index.js';

export const name = 'belief-merge';

/**
 * Cordis service dependencies.
 *
 * `llm` MUST be listed: Cordis throws `cannot get property "llm" without
 * inject` on any undeclared access, and that failure is otherwise swallowed by
 * the alignment fallback (found by running against a live profile).
 */
export const inject = ['agents', 'sessionQuery', 'llm'];

export const Config = z.object({
  /** Session ids whose content should be merged into this session. */
  sources: z.array(z.string()).default([]),
  /** Token budget for the injected block. */
  budgetTokens: z.number().default(1200),
  /** Evidence aggregation: weighted majority or lexicographic priority. */
  score: z.union([z.const('egalitarian'), z.const('elitist')]).default('egalitarian'),
  /** Include `reasoning` content blocks (the differentiator vs session-reference). */
  includeReasoning: z.boolean().default(true),
  /**
   * Include plugin-injected user messages (sandbox policy, approval notices,
   * other plugins' context). Off by default: they are harness scaffolding, not
   * user statements, and including them floods the merge with boilerplate.
   */
  includeInjectedContext: z.boolean().default(false),
  /** Inject only on the first step of each turn (cheaper, KV-cache friendlier). */
  oncePerTurn: z.boolean().default(true),
  /** Run LLM joint alignment; false forces the deterministic heuristic. */
  useLlmAlignment: z.boolean().default(true),
  /** Optional explicit route for the alignment call; defaults to the agent's route. */
  alignmentProvider: z.string().default(''),
  alignmentModel: z.string().default(''),
  /**
   * Reasoning effort for the alignment call. Alignment is mechanical
   * extraction, not deliberation -- and with the agent's own effort (often
   * "high") the model can burn the entire output budget on reasoning deltas
   * and never emit the JSON. That was observed live: `finish=max-tokens` with
   * 0 characters of assembled text.
   */
  alignmentReasoningEffort: z
    .union([z.const('off'), z.const('low'), z.const('high'), z.const('max')])
    .default('off'),
  /** Max output tokens for one alignment call. */
  maxAlignmentTokens: z.number().default(4000),
  /** Per-branch input cap (chars) for the alignment prompt. */
  maxCharsPerBranch: z.number().default(6000),
  /** Upper bound on aligned slots (enforced even if the model ignores it). */
  maxSlots: z.number().default(40),
  /** Run the conflict adjudicator on slots whose evidence is tied (M2). */
  adjudicate: z.boolean().default(true),
  /**
   * Ask the adjudicator twice with the options order-reversed and keep only
   * the answers that agree. Position-dependent answers are downgraded to
   * unresolved rather than guessed. Costs a second call, only when ties exist.
   */
  symmetryCheck: z.boolean().default(true),
  /** Cap on how many tied slots are sent to the adjudicator. */
  maxAdjudications: z.number().default(12),
  /** Output cap for one adjudication call. */
  adjudicationTokens: z.number().default(2000),
  /**
   * Sampling temperature for the plugin's own model calls (alignment and
   * adjudication). Extraction must be reproducible: on the same input, a
   * non-zero temperature produced 25 slots on one run and 1 on the next.
   */
  temperature: z.number().default(0),
  /**
   * Trust level assigned to content read from the source sessions.
   * "external" by default: another session's content is untrusted background,
   * and merging must never launder it into established fact.
   */
  sourceTrust: z
    .union([z.const('untrusted'), z.const('external'), z.const('trusted')])
    .default('external'),
  /** Write diagnostics to stderr (`ctx.logger` is not visible on every surface). */
  debug: z.boolean().default(false),
  /** Packing algorithm: `partial` (seed enumeration) or `density` (greedy only). */
  packAlgorithm: z.union([z.const('partial'), z.const('density')]).default('partial'),
  /**
   * Weight slots by relevance to the current user message. Turning this off
   * makes the block maximally cache-stable at the cost of topical fit.
   */
  packForQuery: z.boolean().default(true),
});

/**
 * `ctx.sessionQuery.readSurface(id)` returns the current model surface as
 * **surface EVENTS**, not messages:
 *
 *     { session, inheritedEventCount, capturedThroughSeq, events: [...] }
 *
 * Each event is `{ type, data }` where `data` carries the message payload.
 * Mapping these is mandatory -- reading `surface.messages` (which does not
 * exist) yields an empty branch and an empty merge. That was a real bug found
 * by running against a live profile.
 */
export function eventsToMessages(events) {
  const messages = [];
  for (const event of events ?? []) {
    const type = event?.type;
    const data = event?.data;
    if (!data || !Array.isArray(data.content)) continue;

    let role;
    if (type === 'user/message') role = 'user';
    else if (type === 'assistant/message') role = 'assistant';
    else if (type === 'tool/result') role = 'tool';
    else if (type === 'system/message') continue; // the prompt is not a branch claim
    else if (typeof data.role === 'string') role = data.role;
    else continue;

    messages.push({ role, content: data.content, source: data.source });
  }
  return messages;
}
/** Accept either shape, so a documented change on either side does not break us. */
export function toMessages(surface) {
  if (Array.isArray(surface)) return surface;
  if (Array.isArray(surface?.messages)) return surface.messages;
  if (Array.isArray(surface?.events)) return eventsToMessages(surface.events);
  return [];
}

/**
 * Replicated from dsh-compaction-basic (the helper is not exported by dsh-llm).
 * Turns a terminal `finish` chunk into an Error, or undefined on success.
 */
function finishError(finish) {
  if (!finish) return new Error('llm stream ended without a finish chunk');
  switch (finish.kind) {
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure?.message ?? 'llm stream failed');
      error.code = finish.failure?.code;
      return error;
    }
    case 'max-tokens': {
      const error = new Error('alignment truncated at the token cap (invalid JSON likely)');
      error.code = 'MAX_TOKENS';
      return error;
    }
    default:
      return undefined;
  }
}

/** Concatenate the text blocks of an assembled assistant response. */
function blocksToText(blocks) {
  const all = blocks ?? [];
  const text = all
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
  if (text.trim().length > 0) return text;
  // Defensive: some routes emit the payload as reasoning and leave no text
  // block. Better to try it than to report an empty response.
  return all
    .filter((b) => b && b.type === 'reasoning' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

/**
 * Resolve which provider/model the alignment call should use.
 * Same precedence as compaction: explicit config, then the agent's route.
 */
function resolveTarget(agent, cfg) {
  if (cfg.alignmentProvider && cfg.alignmentModel) {
    return { provider: cfg.alignmentProvider, model: cfg.alignmentModel };
  }
  const header = agent?.session?.requestHeader?.()?.config;
  if (header?.provider && header?.model) {
    return { provider: header.provider, model: header.model };
  }
  const options = agent?.options;
  if (options?.provider && options?.model) {
    return { provider: options.provider, model: options.model };
  }
  return undefined;
}

/** The most recent human text entering this step, for relevance weighting. */
export function latestUserText(decision) {
  const messages = decision?.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    const text = (message.content ?? [])
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join(' ');
    if (text.trim().length > 0) return text;
  }
  return undefined;
}

/** Minimal `{ complete }` bridge over `ctx.llm`, consumed by lib/core/align.js. */
function makeLlmBridge(ctx, agent, cfg) {
  return {
    async complete({ system, prompt, maxTokens, signal }) {
      const target = resolveTarget(agent, cfg);
      if (!target) throw new Error('no provider/model route available for alignment');

      const assembler = new BlockAssembler();
      const messages = [
        createUserMessage({
          content: [{ type: 'text', text: `${system}\n\n---\n\n${prompt}` }],
          source: { kind: 'plugin', plugin: name, form: 'snapshot' },
        }),
      ];

      const streamOptions = {
        provider: target.provider,
        model: target.model,
        messages,
        maxTokens: maxTokens ?? cfg.maxAlignmentTokens,
        purpose: 'belief-merge-alignment',
        // Mechanical extraction: keep the output budget for the JSON, and keep
        // the result reproducible.
        ...(cfg.alignmentReasoningEffort ? { reasoningEffort: cfg.alignmentReasoningEffort } : {}),
        ...(typeof cfg.temperature === 'number' ? { temperature: cfg.temperature } : {}),
        ...(agent?.session?.id ? { sessionId: agent.session.id } : {}),
        ...(signal ? { signal } : {}),
      };

      for await (const chunk of ctx.llm.stream(streamOptions)) assembler.push(chunk);

      const assembled = blocksToText(assembler.blocks());
      const error = finishError(assembler.finish);
      if (error) {
        // Carry the evidence: without it a truncation is indistinguishable
        // from a provider fault.
        error.message +=
          ` [assembled ${assembled.length} chars, finish=${assembler.finish?.kind}` +
          `${assembled.length ? `, head=${JSON.stringify(assembled.slice(0, 160))}` : ''}]`;
        throw error;
      }
      return assembled;
    },
  };
}

export function apply(ctx, config) {
  const cfg = {
    sources: [],
    budgetTokens: 1200,
    score: 'egalitarian',
    includeReasoning: true,
    includeInjectedContext: false,
    oncePerTurn: true,
    useLlmAlignment: true,
    alignmentProvider: '',
    alignmentModel: '',
    alignmentReasoningEffort: 'off',
    maxAlignmentTokens: 4000,
    maxCharsPerBranch: 6000,
    maxSlots: 40,
    adjudicate: true,
    symmetryCheck: true,
    maxAdjudications: 12,
    adjudicationTokens: 2000,
    temperature: 0,
    sourceTrust: 'external',
    debug: false,
    packAlgorithm: 'partial',
    packForQuery: true,
    ...config,
  };

  if (!Array.isArray(cfg.sources) || cfg.sources.length === 0) {
    // Nothing to merge -- stay mounted but inert rather than failing boot.
    return;
  }

  const warn = (message) => ctx.logger?.warn?.(message);
  // ctx.logger does not reach stderr on every surface (headless proved this),
  // so debug output goes straight to stderr.
  const debug = cfg.debug
    ? (message) => process.stderr.write(`belief-merge[debug]: ${message}\n`)
    : () => {};

  ctx.on(
    'agent/pre-step',
    async (payload, next) => {
      const decision = await next();
      if (decision?.kind === 'reject') return decision;
      if (payload?.signal?.aborted) return decision;
      if (cfg.oncePerTurn && payload?.step !== 1) return decision;

      const surfaces = [];
      const sourceTrust = trustFromName(cfg.sourceTrust);
      for (const id of cfg.sources) {
        try {
          const surface = await ctx.sessionQuery.readSurface(id);
          const messages = toMessages(surface);
          debug(
            `read ${id}: wrapper=${Array.isArray(surface) ? 'array' : Object.keys(surface ?? {}).join('|')} ` +
              `messages=${messages.length} trust=${cfg.sourceTrust}`,
          );
          surfaces.push({ id, messages, trust: sourceTrust });
        } catch (error) {
          warn(`belief-merge: cannot read session ${id}: ${error?.message ?? error}`);
          debug(`readSurface(${id}) threw: ${error?.message ?? error}`);
        }
      }
      if (surfaces.length === 0) return decision;

      // Alignment: prefer the LLM, fall back to the heuristic on any failure.
      const llm = cfg.useLlmAlignment ? makeLlmBridge(ctx, payload?.agent, cfg) : undefined;

      let merged;
      try {
        merged = await mergeSurfacesAligned(surfaces, {
          llm,
          onWarn: (m) => {
            warn(m);
            debug(m);
          },
          score: cfg.score,
          includeReasoning: cfg.includeReasoning,
          includeInjected: cfg.includeInjectedContext,
          maxCharsPerBranch: cfg.maxCharsPerBranch,
          maxSlots: cfg.maxSlots,
          maxTokens: cfg.maxAlignmentTokens,
          adjudicate: cfg.adjudicate,
          symmetryCheck: cfg.symmetryCheck,
          maxAdjudications: cfg.maxAdjudications,
          adjudicationTokens: cfg.adjudicationTokens,
          signal: payload?.signal,
        });
      } catch (error) {
        // Both channels: warn() reaches the harness log, debug() reaches
        // stderr. On a surface where the logger is silent, a bare warn() makes
        // a wiring failure look like "the plugin did nothing".
        warn(`belief-merge: merge failed entirely: ${error?.message ?? error}`);
        debug(`mergeSurfacesAligned threw: ${error?.stack ?? error}`);
        return decision;
      }

      debug(
        `mode=${merged.mode} slots=${merged.slots.length} ` +
          `adjudication=${merged.adjudication.mode}(` +
          `conflicts=${merged.adjudication.conflicts} resolved=${merged.adjudication.resolved} ` +
          `orderSensitive=${merged.adjudication.orderSensitive}) ` +
          `derivation=in:${merged.derivation.inCount}/retracted:${merged.derivation.retractedCount}` +
          `/edges:${merged.derivation.derivedCount}` +
          `${merged.derivation.retracted.length ? ` [${merged.derivation.retracted.join(', ')}]` : ''} ` +
          `perBranch=[${surfaces.map((s) => `${s.id}:${s.messages.length}msg`).join(' ')}]`,
      );

      // Tell the user when credentials were withheld. Silently dropping them
      // would hide the fact that a secret is sitting in a source session --
      // which is exactly the thing they need to know.
      if (merged.redacted > 0) {
        warn(
          `belief-merge: withheld ${merged.redacted} credential(s) found in the source ` +
            `session(s). They were never extracted and never sent to a model. ` +
            `Consider rotating any key that lives in a session you merge.`,
        );
        debug(`redacted=${merged.redacted}`);
      }

      // Trust invariants are a SECURITY property, so a violation fails closed:
      // if the labels cannot be vouched for, the content does not go in.
      const trust = checkTrustInvariants(merged.slots);
      if (!trust.ok) {
        warn(
          `belief-merge: refusing to inject -- ${trust.violations.length} trust invariant violation(s): ` +
            trust.violations.map((v) => `${v.key}/${v.rule}`).join(', '),
        );
        debug(`trust violations: ${JSON.stringify(trust.violations.slice(0, 5))}`);
        return decision;
      }

      const query = cfg.packForQuery ? latestUserText(decision) : undefined;
      const rendered = merged.render({
        budgetTokens: cfg.budgetTokens,
        algorithm: cfg.packAlgorithm,
        query,
        redacted: merged.redacted,
      });
      debug(
        `rendered included=${rendered.included} dropped=${rendered.dropped} ` +
          `tokens=${rendered.tokens} algo=${rendered.algorithm} ` +
          `utility=${Number(rendered.utility ?? 0).toFixed(1)}` +
          `${query ? ' (query-weighted)' : ''}`,
      );

      // Guard on CONTENT, not on the rendered string: the header alone is
      // non-empty, so a text check would inject an empty section. That was a
      // real bug observed in a live headless run.
      if (merged.slots.length === 0 || rendered.included === 0) {
        debug(`nothing to inject${rendered.reason ? ` (${rendered.reason})` : ''}`);
        return decision;
      }

      return {
        ...decision,
        messages: [
          ...decision.messages,
          createUserMessage({
            content: [{ type: 'text', text: rendered.text }],
            source: {
              kind: 'plugin',
              plugin: name,
              form: 'snapshot',
              sections: [{ name, text: rendered.text }],
            },
          }),
        ],
      };
    },
    { prepend: true },
  );
}
