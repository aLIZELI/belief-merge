# Architecture — as built

> **What this is.** Design *rationale* is in [TECHNICAL-REPORT.md](TECHNICAL-REPORT.md);
> usage is in [README.md](README.md). This file is the map of the code as it
> actually exists — what runs, in what order, and where the guarantees come from.
> Every symbol named here was checked against the source, not recalled.
> (The code last changed in `0.3.0`; `0.3.1` is documentation only, so this map
> describes the current release too.)

---

## 1. Three layers, one rule

```
lib/core/       the engine           framework-agnostic — zero DSH imports
lib/tools.js    the control surface  the merge_sessions tool and the /merge command
lib/index.js    the adapter          the only file that imports DeepSeek Harness
```

**The rule: the merge engine does not know what a session is.** It consumes
`{ id, messages, trust }` and returns slots. That is why `lib/core/index.js`
imports nothing from `@deepseek-ai/*`, and why `npm test` needs no harness, no
network and no API key.

The practical consequence: **a second host is a new adapter, not a rewrite.** The
confluence properties, the trust lattice and the packer are all host-independent
by construction rather than by intention.

---

## 2. The pipeline

```
  session log on disk (zstd-compressed — never parsed directly)
        │
        │  ctx.sessionQuery.readSurface(id)          the only supported read path
        ▼
  surface EVENTS  ──eventsToMessages()──▶  [{ role, content, source }]
        │
        ▼
  ┌───────────────────────────────────────────────────────────────────────┐
  │ lib/core                                                              │
  │                                                                       │
  │  1  redact      surface.js → redact.js          before extraction,     │
  │                                                 before any prompt      │
  │  2  extract     align.js    alignSurfaces       one JOINT LLM call     │
  │                 claims.js   extractClaims       fallback, offline      │
  │  3  merge       merge.js    mergeStreaming      provenance retained    │
  │  4  adjudicate  adjudicate.js adjudicateConflicts   ONLY on ties       │
  │  5  derive      derive.js   propagateDerivation AFTER adjudication     │
  │  6  trust       trust.js    checkTrustInvariants fails CLOSED          │
  │  7  pack/render pack.js + render.js             budget enforced        │
  └───────────────────────────────────────────────────────────────────────┘
        │
        │  rendered.text
        ▼
  createUserMessage({ source: { kind: 'plugin', plugin: 'belief-merge' } })
  appended to the messages entering the step
```

| # | stage | entry point | module | runs when |
|---|---|---|---|---|
| 0 | read | `readSurface` → `eventsToMessages` | `lib/index.js` | adapter only |
| 1 | redact | `redactSecrets` per text block | `core/surface.js` → `core/redact.js` | always |
| 2 | extract | `alignSurfaces` / `extractClaims` | `core/align.js` / `core/claims.js` | LLM, falling back |
| 3 | merge | `mergeBranches` → `mergeStreaming` | `core/index.js` → `core/merge.js` | always |
| 4 | adjudicate | `adjudicateConflicts` | `core/adjudicate.js` | only if a slot is `disputed` |
| 5 | derive | `propagateDerivation` | `core/derive.js` | always, **last** |
| 6 | trust | `checkTrustInvariants` | `core/trust.js` | before injection, fails closed |
| 7 | pack + render | `renderMerged` | `core/render.js` + `core/pack.js` | always |

**Stage 5 runs after stage 4 on purpose.** A tie that adjudication settles is a
premise that stands; one it leaves unresolved is a premise that does not. Running
derivation first would retract conclusions that a later adjudication would have
saved.

---

## 3. The structure that carries the guarantee

One `SlotState` (`core/slot.js`) per **alignment key** — not per branch, and not
one merged scalar. It keeps the full per-source claim set, so "two weak branches
agree" stays distinguishable from "one strong branch asserts".

`core/merge.js` ships **two representations, and both are used**:

| | function | used by |
|---|---|---|
| provenance-retaining (join-semilattice) | `reprJoin` | **production** — `mergeBranches` |
| lossy collapse to the winner | `reprCollapse` | **tests only** |

`reprCollapse` is not dead code and not a leftover. It exists so the P1 unsafe
behaviour is *executable* rather than described in prose:

```js
isConfluent(witness, 'egalitarian', reprJoin)     // true
isConfluent(witness, 'egalitarian', reprCollapse) // false  ← the bug, reproduced
```

The collapse happens once, late, in rendering. Everything upstream of that keeps
provenance. That single decision is what the confluence result rests on, and the
cost of getting it wrong is a regression test, not a paragraph.

---

## 4. The three places a model is allowed to act

Everything else — packing, trust, derivation, serialization — is deterministic
code. The model touches exactly three points, and each is constrained:

**① Joint extraction** (`core/align.js`). One call over *all* branches, so the
model can see that "we switched to PostgreSQL" and "the DB is Postgres now" are
the same key. A per-branch extractor cannot. Constraints: `maxSlots` enforced
even if the model ignores it, invented branch ids rejected, evidence clamped to
the known scale.

**② Adjudication of genuine ties** (`core/adjudicate.js`). The adjudicator may
**not invent a value** — it chooses among candidates that already exist. It is
asked twice with the options **order-reversed**, and an answer that flips is
downgraded to `unresolvable`. That turns axiom IC2 (permutation invariance) into
a runtime check. `unresolvable` is a first-class answer.

**③ Nothing else.** If the model misbehaves at ③ the result is a worse block; at
① or ② the result is a rejected call and a fallback, never a broken turn.

---

## 5. Degradation ladder

Every failure has a defined landing place. A degraded merge beats a broken turn.

| failure | behaviour |
|---|---|
| no LLM route available | heuristic extraction (`claims.js`) |
| alignment throws / returns unparseable JSON | heuristic fallback, `mode: 'heuristic'` |
| alignment truncated at the token cap | treated as an error, carries `assembled N chars, finish=…` evidence |
| adjudication fails | ties stay `DISPUTED`; it never blocks the merge |
| a source session is unreadable | that source is dropped, the rest are merged |
| **trust invariant violated** | **injection refused** — fails *closed*, not open |
| nothing survives the budget | no injection at all, rather than an empty section |
| the step is aborted | returns the decision untouched |

The guard on the last-but-one row is on **content** (`slots.length === 0 ||
rendered.included === 0`), not on the rendered string — the header alone is
non-empty, so a text check would have injected an empty section. That was a real
bug, observed in a live headless run.

---

## 6. The injection shape

Identical to the official `dsh-time-context`, which is the smallest shipped
example of the pattern:

```js
return {
  ...decision,
  messages: [...decision.messages, createUserMessage({
    content: [{ type: 'text', text: rendered.text }],
    source: { kind: 'plugin', plugin: name, form: 'snapshot',
              sections: [{ name, text: rendered.text }] },
  })],
};
```

Three details that are easy to get wrong:

- **The message is appended, not prepended.** `dsh-session-reference` documents
  the order as "direct messages followed by their session-reference context".
  `{ prepend: true }` on `ctx.on` is *listener* order, not message position — a
  distinction the README got wrong until it was checked against the source.
- **`source.kind === 'plugin'`** is what lets the plugin's own `isInjected()`
  later exclude such messages from being read back as user testimony.
- **`oncePerTurn`** injects only at `step === 1`, which keeps the block at a
  stable position in the message series. `packForQuery: false` then makes it
  maximally cache-stable at the cost of topical fit.

---

## 7. Configuration has two layers

```
config (cordis.patch.yml)   deployment default
        ▲ overridden by
runtime (sources.json)      set by merge_sessions / /merge, read per turn
```

`createSourceState` (`core/state.js`) merges the two, so a tool call takes effect
on the **next turn** without editing YAML or restarting. `set([])` and `clear()`
are deliberately different: "merge nothing" versus "fall back to config".

The tool and the command call the same `run()` in `lib/tools.js`, so they cannot
disagree. They are registered **unconditionally** — a user with no sources
configured is exactly the user who needs the tool.

---

## 8. Deliberately absent

Recorded so nobody goes looking:

- **No summarization or compaction.** It would reintroduce the P1 unsoundness.
- **No Shapley attribution, no learned merge policy.** Both appear in the
  original design proposal; neither was built. See the banner in
  [`../docs/会话融合引擎-BeliefMerge-可行性与算法架构.md`](../docs/会话融合引擎-BeliefMerge-可行性与算法架构.md).
- **No settings-panel card.** Configuration is the tool, the command, or YAML.
- **No cross-workspace session discovery.** Candidates come from
  `ctx.sessionQuery.listSessions()`.

---

## 9. File map

See [README.md § Layout](README.md#layout) for the one-line-per-file listing.
The short version:

```
lib/core/slot.js        SlotState, Evidence, scores, select()
lib/core/merge.js       the two representations, mergeNary/Incremental/Streaming
lib/core/surface.js     flatten + redact a surface into prompt text
lib/core/align.js       joint LLM extraction
lib/core/claims.js      heuristic extraction (offline path)
lib/core/adjudicate.js  constrained tie-breaking + symmetry check
lib/core/derive.js      JTMS label propagation
lib/core/trust.js       trust lattice, invariant I2
lib/core/pack.js        submodular utility, knapsack, cache layout
lib/core/render.js      deterministic serialization
lib/core/state.js       the runtime config layer
lib/core/sessions.js    candidate ranking and selection
lib/tools.js            the tool and the command
lib/index.js            the adapter
```
