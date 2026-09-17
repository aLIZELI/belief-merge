# dsh-belief-merge

Cross-session context merge for **DeepSeek Harness**. Reads N other sessions'
model surfaces, merges them, and injects the result as durable context on the
next turn.

It differs from the official `dsh-session-reference` in exactly three ways:

| | `dsh-session-reference` | this |
|---|---|---|
| reasoning blocks | excluded | **included** |
| tool content | excluded | **included** |
| merge strategy | concatenate bounded snapshots | **per-slot merge with evidence weighting** |
| contradictions | not considered | **detected and decided, or surfaced unresolved** |

```
npm test        # 242 tests, no dependencies, no network
npm run demo    # offline end-to-end demonstration
```

> Installing into a real harness: see **[VERIFY.md](VERIFY.md)**.

---

## The result in one example

Two branches discuss the same system. Branch A's **user** says the database is
PostgreSQL; branch B's assistant **speculates** MySQL in a reasoning block.

```
WITHOUT LLM alignment          WITH LLM alignment
─────────────────────────      ─────────────────────────
4 slots                        3 slots
  …PostgreSQL   (own slot)       database.engine = postgresql
  …MySQL        (own slot)         ← user (e=4) beats speculation (e=1)
  ↑ conflict never detected      ↑ conflict detected and decided
```

Merging is **not** concatenation and **not** a summary: every branch's opinion
stays in the annotation, and the decision is a function of evidence weight.

---

## Status: what is verified and what is not

Being precise about this matters more than looking finished.

### ✅ Verified — including a real end-to-end run

**The plugin has been run inside a real harness.** A throwaway `headless`
profile was created, the plugin installed, mounted, and executed against two
real sessions with a real model. Observed debug output:

```
read afd09707-…: wrapper=session|inheritedEventCount|capturedThroughSeq|events messages=2
read fbff76e5-…: wrapper=session|inheritedEventCount|capturedThroughSeq|events messages=2
mode=llm slots=25 rendered included=25 dropped=0 tokens=1065
```

and the model then quoted the injected block back verbatim:

```
- `papers.cacheblend.arxiv_id` = **2405.16444**
- `papers.epic.arxiv_id` = **2410.15332**
- `papers.factcc.arxiv_id` = **2005.00661**
```

The live run found and fixed four bugs that no amount of unit testing would
have surfaced — see [VERIFY.md](VERIFY.md#what-the-live-run-actually-found).

- **The merge core** — 242 tests. Union is associative, commutative and
  idempotent; the P1 counterexample is a regression test; rendering is
  deterministic; disputes stay explicit; the token budget is enforced.
- **The DSH adapter loads against the real packages and runs in a real process.**
- **LLM alignment** — tested against a stub *and* observed working against a
  real model: fenced/prose-wrapped JSON tolerated, invented branch ids rejected,
  fabricated corroboration unable to manufacture a majority, evidence clamped.
- **Degradation paths** — provider error, `max-tokens` truncation, missing
  route, unreadable source, aborted signal: all degrade, none break the turn.
- **The P1 experimental result** (`../beliefmerge-t1/`) — 72,760 enumerated
  profiles, 0 confluence failures with full provenance, 9.9–26.2% with a
  collapsed representation.

### ⚠️ Still not verified

- **Only one model route has been exercised** (`deepseek-official` /
  `deepseek-flash`). Prompt quality on other models is unknown.
- **Only two branches, both from one workspace.** Scale behaviour is untested
  (needs M3 packing).
- **M4 needed a stronger prompt than expected.** Asked politely for
  `derivedFrom`, the model emitted **zero** edges (`edges:0`) even on a session
  with explicit "Premise 1 / Premise 2 / Therefore" structure. Adding a worked
  example to the prompt produced edges immediately (`edges:2`). The mechanism is
  now verified end to end, but edge extraction is prompt-sensitive and a model
  that ignores the field would silently disable it.
- **The pipeline is not end-to-end reproducible.** The deterministic core is
  deterministic, and both model calls now request `temperature: 0`, but the
  provider still returned 25 slots on one live run and 16 on the next for
  identical input. Invariant I5 (byte-identical serialization) therefore holds
  *given* a slot set, not across runs.
- **The approximation guarantee is stated narrowly.** Sviridenko's `(1 - 1/e)`
  for a knapsack constraint assumes the pure coverage form; this objective
  mixes in per-item terms, so `partial` is a heuristic that is *never worse*
  than density greedy, not a certified ratio. See `lib/core/pack.js`.

---

## Install

Published on npm, so no build step and no build-approval prompt:

```sh
dsh plugin --profile web add dsh-belief-merge
```

From a checkout instead:

```sh
dsh plugin --profile web add /absolute/path/to/belief-merge
```

> **`dsh-belief-merge@0.0.1` is not installable as a profile layer** — it
> predates the `dsh.bundle` manifest. If you installed it, `^0.0.1` will not
> upgrade on its own (caret on a `0.0.x` version does not cross into `0.1.0`);
> ask for `dsh-belief-merge@0.1.0` explicitly.

Then enable it in the profile's `cordis.patch.yml`:

```yaml
- name: dsh-belief-merge
  config:
    sources:
      - <session-id-1>
      - <session-id-2>
    budgetTokens: 1200
    useLlmAlignment: true
```

`inject = ['agents', 'sessionQuery']`. Alignment additionally needs a mounted
LLM route (`ctx.llm`); without one the plugin degrades to the heuristic rather
than failing.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `sources` | `[]` | Session ids to merge. Empty = mounted but inert. |
| `budgetTokens` | `1200` | Token budget for the injected block. |
| `score` | `egalitarian` | `egalitarian` = weighted majority; `elitist` = lexicographic evidence priority. |
| `includeReasoning` | `true` | Include `reasoning` content blocks. |
| `oncePerTurn` | `true` | Inject only on step 1 of each turn (cheaper, KV-cache friendlier). |
| `useLlmAlignment` | `true` | `false` forces the deterministic heuristic. |
| `alignmentProvider` / `alignmentModel` | derived | Route for the alignment call; defaults to the agent's own route. |
| `alignmentReasoningEffort` | `off` | Reasoning effort for the alignment call. See the note below — leaving this at the agent's effort breaks alignment. |
| `maxAlignmentTokens` | `4000` | Output cap for one alignment call. |
| `maxCharsPerBranch` | `6000` | Per-branch input cap (the recent tail is kept). |
| `maxSlots` | `40` | Upper bound on aligned slots, enforced client-side too. |
| `includeInjectedContext` | `false` | Include plugin-injected user messages. Leave off — see below. |
| `adjudicate` | `true` | Settle ties with a constrained adjudicator (M2). |
| `symmetryCheck` | `true` | Ask the adjudicator twice with options reversed; keep only agreeing answers. Costs one extra call, only when ties exist. |
| `maxAdjudications` | `12` | Cap on tied slots sent to the adjudicator. |
| `adjudicationTokens` | `2000` | Output cap for one adjudication call. |
| `temperature` | `0` | Sampling temperature for the plugin's own model calls. |
| `sourceTrust` | `external` | Trust level for content read from the source sessions: `untrusted`, `external`, or `trusted`. |
| `packAlgorithm` | `partial` | `partial` = seed enumeration + density greedy; `density` = greedy only. |
| `packForQuery` | `true` | Weight slots by relevance to the current user message. |
| `debug` | `false` | Write diagnostics to stderr (`ctx.logger` is not visible on every surface). |

### Two settings that matter more than they look

**`alignmentReasoningEffort`** — alignment is mechanical extraction, not
deliberation. Inheriting the agent's own effort (often `high`) lets the model
spend the *entire* output budget on reasoning deltas and never emit the JSON.
Observed live: `finish=max-tokens` with **0 characters** of assembled text.

**`includeInjectedContext`** — DSH delivers injected context (sandbox policy,
approval notices, another plugin's block) as `user/message` events with
`source.kind === 'plugin'`. They are *not* user statements, but a naive
"user message ⇒ evidence 4" rule promotes harness boilerplate to the highest
evidence level. A live run over two real sessions produced **170** such
"claims", almost all policy text. They are excluded by default and, when
included, capped at `SPECULATIVE`.

---

## Does it actually help? MergeBench

Every claim above is illustrated with hand-built examples. MergeBench exists to
replace that with measurement — and the first version of it was broken in ways
worth recording, because a benchmark that cannot fail is not evidence.

**Bridge questions** need facts from *different* branches; **local questions**
need facts from one, and exist so the single-branch baseline is not trivially
zero. Every arm respects the same token budget, so a baseline cannot "win" by
spending tokens nobody offered it.

At a realistic 400-token budget over 5 scenarios and 50 bridge questions:

```
arm                         local   bridge   best 1     GAIN  unambig   both   invent   tokens
none                           0%       0%       0%      +0%       0%    0.0       0%        0
single:branch-a               50%       0%       0%      +0%      50%    0.0       0%      388
concat                        60%      18%       0%     +18%      50%    0.0       0%      399
beliefmerge-heuristic         95%      98%       0%     +98%      50%    0.8       0%      401
beliefmerge-oracle           100%     100%       0%    +100%     100%    0.0       0%      258
```

**Concatenation collapses at a realistic budget**: 18% bridge coverage against
the merge's 98%, at the same cost — because chatter consumes the budget before
the facts do.

At a *loose* budget everything fits and concatenation keeps up on coverage; what
it cannot do is resolve anything. On every key asserted twice, both values
appear and the reader is left to work it out. The merge presents one value,
100% of the time, and does it in **a third of the tokens**.

Run it: `npm run bench`, or `npm run bench:tight` for the budgeted comparison.
Full numbers, and an honest account of what it does *not* measure, in
**[bench/README.md](bench/README.md)**.

---

## Why the merge state keeps provenance

This is the one design decision the whole engine is built around, and it is not
a style preference — it is forced.

Merging branches one at a time is the only practical option (sessions arrive
over time). But if a merged slot is stored as *“the winner, plus its evidence”*,
then merging `B0, B1` first collapses **two weak branches that agree** into **one
weak assertion**, and a single strong dissenter then wins:

```
B0 = {a@1}   B1 = {a@1}   B2 = {b@2}

n-ary merge                        : disputed{a,b}    correct
incremental, keeps sources         : disputed{a,b}    correct
incremental, keeps only the winner : b                WRONG
```

The wrong answer is also **order-dependent and silent**. An exhaustive search
over 72,760 profiles found this failure in **9.9–26.2% of well-formed inputs**
(see `../beliefmerge-t1/`).

So the API is shaped to make the mistake hard to commit:

- `mergeStreaming()` — the production path, always provenance-retaining.
- `reprCollapse()` — exported **only** so the regression test can demonstrate
  the failure, and for one-shot serialization.
- `SlotState` sorts its items canonically, so identical annotations serialize
  identically regardless of merge order (KV-cache prefix reuse depends on this).

**Rule: collapse once, at serialization time. Never between merges.**

---

## Settling ties without guessing

When the evidence is genuinely symmetric the merge reports `DISPUTED`. That is
safe but incomplete, so a constrained adjudicator (M2) settles what it can:

| Outcome | Meaning | Rendered as |
|---|---|---|
| `choose` | one value is better supported by the quotes | the value, noting the tie was broken |
| `both` | the values are compatible, not a disagreement | both, labelled compatible |
| `conditional` | both hold under different conditions | both, with the guard |
| `unresolvable` | the quotes do not settle it | `DISPUTED`, unchanged |

Three things keep it honest:

**It cannot invent an answer.** The chosen value must already be an option in
that conflict. A hallucinated third value is rejected and the tie stands.

**It is checked for position bias.** The same conflicts are asked a second time
with the options order-reversed. A conclusion that flips was reading the
presentation order, not the content, and is downgraded to `unresolvable`. This
is axiom IC2 (permutation invariance) enforced at runtime rather than asserted
in a document. It costs exactly one extra call, and only when ties exist.

**`unresolvable` is a first-class answer.** The prompt says so explicitly, and
the merge would rather surface a contradiction than paper over it.

The result is attached as `slot.resolution` — the underlying `SlotState` is
never mutated, so every opinion and its provenance remain auditable.

---

## Choosing what survives a budget

Fitting slots into a token budget is a 0/1 knapsack problem:

```
max U(S)   s.t.   sum of tok(v) for v in S  <=  B
```

`U` is a utility over **sets**, not a sum of per-line scores, because a merged
context is more than the sum of its lines — the first `Constraint` is worth far
more than the fifth `Fact`:

```
U(S) = sum_{v in S} personal(v)              individual value
     + sum_t w_t * (1 - e^(-gamma*n_t(S)))   coverage saturation
```

The coverage term is concave in each per-type count, so its marginal gain
shrinks as a type fills up. That is the **diminishing-returns (submodular)**
shape, and both properties are tested as properties rather than asserted:

- **monotone** — adding an item never decreases utility
- **submodular** — `U(S+v) - U(S) >= U(T+v) - U(T)` for every `S ⊆ T`

**Approximation, stated precisely.** Under a *cardinality* constraint, greedy is
`(1 - 1/e)`. Under a **knapsack** constraint, plain density greedy has **no
constant guarantee**; Sviridenko (2004) restores `(1 - 1/e)` by enumerating
partial solutions before completing greedily. That is `packAlgorithm: partial`.
Because this objective also mixes in per-item terms, `partial` is honestly a
heuristic that is *never worse* than density greedy — not a certified ratio.
The module reports which algorithm ran rather than implying more.

### Cache-aware layout

The injected block is appended to the conversation. If it changes, every token
from the change onward is recomputed. Ordering **stable content first** means a
volatile change invalidates only the tail; ordering it last would invalidate
everything after it.

This is measured, not asserted. With four slots where the volatile one churns:

```
stable-first layout : preserved prefix = 3 of 4
volatile-first      : preserved prefix = 0 of 4
```

`packForQuery` weights slots by relevance to the current user message. It is
coherent with cache-aware layout rather than in tension with it: a slot that
becomes relevant this turn is a volatile one, and volatile slots land in the
tail.

---

## Retracting what was derived from a retracted premise

Merging conclusions is not merging reasoning. If a branch concludes X because
of Y, and Y is later disputed, the merged context has no reason to keep
presenting X — yet **X's own evidence weight is untouched**, so nothing in the
evidence arithmetic notices.

Slots may declare premises. One is:

| status | meaning |
|---|---|
| `axiom` | no premises — supported unless the merge failed to assert it |
| `founded` | at least one justification has **all** premises IN |
| `retracted` | it has justifications and **none** is fully satisfied |

A slot is IN iff it is *asserted* **and** founded. A disputed premise is not
established, so anything resting only on it falls with it — transitively.

**Why a graph and not a boolean.** A claim can have several independent routes.
Losing one premise must not retract a conclusion that another route still
supports:

```
migration.complete  = DISPUTED          <- the premise falls
qa.signed_off       = axiom
release.ship_friday = FOUNDED           <- survives: a second route holds
```

Remove that second route and the conclusion retracts with its only support:

```
release.ship_friday = RETRACTED — every supporting route is unmet
```

The fixpoint is least-fixpoint, so a circular argument with no external support
simply never becomes IN — the correct answer for `x ← y, y ← x`.

**Trust crosses a derivation too.** A concluded claim may be no more
trustworthy than the weakest premise on the route that supports it — `meet`,
never `join`. This extends invariant I2 from aggregation to derivation, and it
uses the **best** route: one weak alternative must not drag down a claim a
strong alternative fully supports.

Retracted slots are still rendered — marked, with the unmet premises named — but
their packing utility is cut to 5%, so they appear only if there is room and
never outrank a live claim.

---

## A merge must not distribute secrets either

Found the hard way. Merging two real sessions produced a claim whose value was a
**live API key** that happened to sit in one of them. A context-merge plugin is a
credential-distribution mechanism: anything in a source conversation gets
extracted and injected into every future turn. Worse, the alignment stage sends
session text to a model API, so the key had already left the machine.

Redaction now runs at the **surface**, before either extraction path sees the
text and before any prompt is built:

```
source conversation  ->  redact  ->  claim graph  ->  rendered block
                            \-->  alignment prompt  (never reaches the model)
```

**Deliberately conservative.** Only high-confidence shapes match: provider
prefixes (`sk-`, `ghp_`, `AIza`, `AKIA`, `hf_`, `npm_`, JWTs, PEM blocks) and an
explicit label (`api_key`, `token`, `密钥`, ...) followed by a value. A generic
"long random-looking string" rule was rejected — it would silently rewrite
commit hashes, arXiv ids and file paths, which in a system built on fidelity is
a correctness bug, not a safety win.

A credential with **no prefix and no label** is still caught if its shape is
distinctive. The one that got through was `32-hex . 16-alnum`, which no prefixed
rule matched.

**The user is told.** The rendered block ends with
`_**1 credential(s) withheld**_`, so the fact that a secret lives in a source
session is surfaced rather than silently swallowed — which is the thing they
actually need to know.

---

## A merge must not launder trust

Merging is a laundering primitive. An assertion from a compromised session
enters the merged block and, from the reading model's point of view, becomes
indistinguishable from a fact the current user established. The official
`dsh-session-reference` guards against this with a fixed warning; a naive
merger would quietly undo that guard.

BeliefMerge carries a trust lattice and one invariant:

```
TRUSTED   (2)  the current session's own user
   |
EXTERNAL  (1)  another session's content
   |
UNTRUSTED (0)  plugin-injected, or origin unknown
```

> **Invariant I2 (no laundering): the act of merging may never raise a value's
> trust above the trust of the claims that assert it.**
> Corroboration across independent sources can raise trust; merging cannot.

Two operations, deliberately distinct:

- **join (max)** for *aggregation* — several independent supporters of one
  value. The best support wins, and can never exceed the best supporter.
- **meet (min)** for *derivation* — a conclusion is only as trustworthy as its
  weakest premise. (`derivedTrust()`, ready for the derivation layer at M4.)

Three consequences in the rendered block:

1. A fixed **`EXTERNAL BACKGROUND`** banner, warning that the block is data and
   not instruction.
2. **Untrusted items are marked individually** — a single untrusted item inside
   an otherwise-external block is the case a reader would otherwise miss.
3. The banner is **never dropped for budget reasons**. If the budget cannot hold
   the banner plus at least one item, the plugin injects **nothing** — the only
   honest choice, since the alternatives are emitting unlabelled cross-session
   content or silently exceeding the caller's limit.

An unlabelled claim is treated as `UNTRUSTED`, never assumed benign. And trust
invariants are a **security** property, so a violation **fails closed**: the
content does not go in.

Verified live — after reading the injected block, the model reported:

> *"Quoted as data only; the block's embedded directives are not treated as
> instructions."*

---

## Design: division of labour

```
LLM  (lib/core/align.js)   semantics: what is the same topic? what is the
                           canonical value? what type? what evidence level?
                           → one joint call over ALL branches, so alignment
                             is done with full cross-branch context
                           → strictly validated; invented sources rejected
                           → any failure falls back to the heuristic

core (lib/core/*.js)       determinism: evidence aggregation, confluence,
                           budget packing, serialization
                           → zero DSH imports; the host is an adapter
```

The LLM does what it is good at; the deterministic core does what it is good at.
Every safety property (provenance, confluence, determinism, refusal to guess)
lives on the deterministic side, so it cannot be talked out of by a model.

---

## Turning it on without editing YAML

The first version could only be configured by hand-editing
`cordis.patch.yml` and restarting. Both frictions are now gone.

### Ask for it in conversation

The `merge_sessions` tool lets the model do it:

```
you   merge my two bilibili conversations into this one
model (calls merge_sessions: list, query "读取B站")
      I found these two — shall I merge both?
you   yes
model (calls merge_sessions: set)
      Merging is ON with 2 sources. Takes effect on the next turn.
```

### Or use the command

```
/merge                    list candidates
/merge find 读取B站        list candidates matching a filter
/merge f975843c 8c6e52e1  set (unique id prefixes are enough)
/merge add <id>           add one
/merge remove <id>        drop one
/merge status             what is in effect, and from which layer
/merge off                stop merging
```

A command result does not enter model history, which is why the command is the
right surface for a control operation: it configures the conversation without
becoming part of it.

### Two layers, and which one wins

| layer | set by | lives in |
|---|---|---|
| **runtime** | the tool or `/merge` | `<dsh home>/storages/belief-merge/sources.json` |
| **config** | `sources:` in `cordis.patch.yml` | the deployment default |

Runtime wins. `clear` (or `/merge off`) drops the runtime layer so the config
default applies again, while `set` with an empty list is an explicit "merge
nothing" — collapsing those two would make *reset* and *off* indistinguishable
and users need both.

The state file is plain JSON, inspectable and hand-editable, and the plugin
reads it **per turn**, so a change applies on the next turn rather than at the
next restart. That is also why the pre-step listener is registered even when
nothing is configured: a user with no sources is exactly the user who needs the
tool to turn merging on.

### What is still missing

The settings-panel card is the remaining increment. `/merge` and the tool cover
the operation, but neither shows a checkbox list. A card needs a browser half in
the client module system's lazy-CJS factory format — writable by hand
(`dsh-plugin-console` ships one) but the largest of the available changes, so it
is deferred rather than skipped for a reason.

---

## Layout

```
lib/core/slot.js      SlotState, evidence levels, scores, select()
lib/core/merge.js     representations, mergeNary, mergeStreaming, isConfluent
lib/core/surface.js   flatten a DSH model surface into prompt text
lib/core/claims.js    heuristic extraction (offline baseline / fallback)
lib/core/align.js     LLM joint alignment + extraction, validation, fallback
lib/core/pack.js      submodular utility, knapsack solver, cache-aware layout
lib/core/derive.js    derivation graph, JTMS label propagation, trust ceiling
lib/core/render.js    assembly + deterministic serialization
lib/core/index.js     mergeBranches / mergeSurfaces / mergeSurfacesAligned
lib/index.js          DSH adapter: ctx.sessionQuery + ctx.llm + agent/pre-step
test/merge.test.js    P1 regression + algebra + rendering
test/align.test.js    alignment, validation, adversarial inputs, fallback
test/plugin.smoke.test.js  loads the REAL adapter against the REAL dsh-llm
demo.js               offline end-to-end demonstration
VERIFY.md             step-by-step install + verification in a real harness
```

---

## Roadmap

| | Milestone | State |
|---|---|---|
| M0 | Read sessions, merge, inject end-to-end | core ✅ / adapter **load-tested** against real packages, live payload ⚠️ |
| M1 | LLM structured extraction + joint alignment | ✅ implemented & tested against a stub; **not yet run against a real model** |
| M2 | Conflict adjudicator for equal evidence | ✅ implemented, unit + integration tested |
| M3 | Submodular budget packing + KV-cache-aware layout | ✅ implemented, property-tested, verified live |
| M4 | JTMS derivation propagation | ✅ implemented, unit-tested, and **verified live** — see below |
| M5 | Trust lattice + no-laundering invariant | ✅ implemented, adversarial tests, verified live |
| M6 | MergeBench — bridge questions, budgeted baselines | ✅ implemented, measured — see [bench/README.md](bench/README.md) |
| T1 | Confluence theorem | ✅ done (`../beliefmerge-t1/`) |

**Next step:** run it against a real model. Prompt quality is the one thing that
cannot be settled by unit tests.

## License

MIT
