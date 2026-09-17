# BeliefMerge — a technical report

**Merging conversation branches without laundering trust, losing reasoning, or guessing at contradictions.**

A DeepSeek Harness plugin, a confluence theorem with a counterexample, and a benchmark that was wrong twice before it was useful.

---

## Summary

Two conversations about the same system drift apart. A later question needs facts
from both. Today's tooling answers this by *pasting* one into the other, which is
cheap, unbounded, and leaves contradictions for the reader to resolve — or by
*summarizing*, which is lossy in exactly the place that matters: the reasoning.

This project builds the third option. Conversation branches become a
**provenance-typed claim graph**; the graph is merged by evidence weight; ties
that evidence cannot settle go to a constrained adjudicator that is checked for
position bias; claims whose premises were retracted are retracted with them; and
the result is packed into a token budget and injected into the next turn.

Three things in here are, as far as I can establish, not previously done
together, and each is backed by something runnable:

| | |
|---|---|
| **A confluence result** | Incremental merging is *unsound* unless full provenance is retained — with a three-line counterexample and 72,760 enumerated profiles |
| **A constrained adjudicator** | Ties are settled only by a model that cannot invent a value and is rejected when its answer flips under option reordering |
| **A trust lattice** | Merging may never raise a claim's standing — verified against a real prompt-injection payload |
| **A benchmark** | Bridge questions that no single branch can answer: concatenation reaches 18%, the merge 98% |

Everything is reproducible from the repository with `npm test`, `npm run demo`
and `npm run bench`. No API key is needed for any of it.

---

## 1. The problem

Given N conversation branches — each an append-only log of user messages,
assistant messages with their reasoning chains, and tool results — produce a
**merged context** that a new session can continue from, such that:

1. facts survive, including ones no single branch held;
2. contradictions are resolved, or explicitly declined;
3. **the reasoning is preserved**, not just the conclusions;
4. every statement stays traceable to the branch that made it;
5. it fits a token budget;
6. it does not become a vehicle for prompt injection across sessions.

Requirements 3 and 6 are what make this more than concatenation, and requirement
2 is what makes it more than summarization.

### Why the obvious approaches do not work

**Concatenation** has no bound and no conflict resolution. Measured below: at a
realistic budget it reaches 18% of bridge questions, because low-value chatter
consumes the budget before the facts do.

**Summarization** is worse than it looks. A summary of two branches that
disagree must either pick a side (silently, and without saying on what grounds)
or reproduce both (in which case it has not summarized). And a summary of a
*reasoning* chain generally drops the retracted hypotheses — which are precisely
the thing that stops the next session from repeating a dead end.

**Retrieval** over both logs finds relevant text but has no notion of two
sources disagreeing, and no way to say "this was concluded from that".

DeepSeek Harness's own `dsh-session-reference` is honest about its scope: it
injects another session as a bounded, read-only snapshot, and its documentation
states that *"tools, reasoning, and other injected context are excluded"* and
that references are *"snapshots, not forks, resumes, or mutations"*. That is a
deliberate boundary, and it is the boundary this project works on the other side
of.

---

## 2. Design

```
分支定位 → 声明图构建 → 语义对齐 → 信念调和 → 验证 → 预算打包 → 注入 → 归因
  Stage 0      Stage 1      Stage 2      Stage 3    4        5       6
```

| stage | what it does | module |
|---|---|---|
| 0 | locate branches; `fork` lineage gives a merge base where one exists | `lib/index.js` |
| 1 | joint LLM extraction into typed, addressable slots | `lib/core/align.js` |
| 2 | alignment is **joint**, not per-branch — the model sees all branches at once | `lib/core/align.js` |
| 3a | evidence-weighted merge; ties become `DISPUTED`, never guessed | `lib/core/merge.js`, `slot.js` |
| 3b | constrained adjudication of ties, with a symmetry check | `lib/core/adjudicate.js` |
| 3c | retraction propagation through the derivation graph | `lib/core/derive.js` |
| 4 | trust labelling and the no-laundering invariant | `lib/core/trust.js` |
| 5 | submodular knapsack packing + cache-aware layout | `lib/core/pack.js` |
| 6 | injection at `agent/pre-step`; deterministic serialization | `lib/core/render.js` |

### The one decision everything rests on

**Prose cannot be merged. Claims can.** Everything here depends on turning a
conversation into addressable units with stable keys, because a merge needs
something to align *on*.

That is also why alignment is a single joint LLM call over all branches rather
than per-branch extraction followed by matching. Per-branch extraction cannot
know that "we switched to PostgreSQL" and "the DB is Postgres now" are the same
topic; given all branches at once, the model can. Measured, this is the
difference between a conflict being *detected* and being missed entirely.

### Division of labour

The LLM does semantics — what is the same topic, what is the canonical value,
what type, what evidence level. The deterministic core does everything with a
guarantee attached: aggregation, confluence, retraction, budget. **Every safety
property lives on the deterministic side, where a model cannot talk it out of a
decision.**

---

## 3. The confluence result

### The setting

Branches arrive over time, so merging is **incremental** — pairwise, in arrival
order. The design promises that the result does not depend on which branch is
treated as primary. That promise holds only if

```
fold(branches[σ], representation)  ==  merge_nary(branches)   for every permutation σ
```

Darwiche & Pearl (*On the Logic of Iterated Belief Revision*, AI 1997) proved
AGM postulates insufficient for *iterated* revision. Merging inherits the hazard.

### The result

The answer depends entirely on **how a merged slot is represented** when it is
re-merged:

| representation | retained | well-formed failure rate |
|---|---|---|
| **JOIN** | every `(value, source, evidence)` | **0.0%** |
| COUNT | winner + its supporters' evidence multiset | 9.9 – 15.7% |
| MAX | winner + one max evidence level | 13.2 – 26.2% |

Over **72,760 enumerated profiles** across two search spaces and two scoring
functions, the provenance-retaining representation produced **zero** confluence
failures. The lossy ones failed on 9.9–26.2% of **well-formed** inputs.

### The minimal counterexample

```
B0 = {a@1}      B1 = {a@1}      B2 = {b@2}

n-ary        : disputed{a,b}     correct — weights are 1+1 = 2 against 2
incremental  : b                wrong
```

Merging `B0` and `B1` first collapses **two weak branches that agree** into one
weak assertion (weight 2 → 1), so the single strong dissenter wins. The result
is order-dependent, and silent.

### Why it cascades

With a derivation graph, a flipped slot decision does not stay local:

```
b0: c0:assert@1   b1: c0:assert@1   b2: c0:refute@1
n-ary        IN = [c0]      assert wins 2–1
incremental  IN = []        collapsed to a 1–1 tie, c0 goes OUT
```

Three-claim chains were also observed to **resurrect** claims that should have
stayed disputed. Whole reasoning chains disappear, or come back, without a
single error.

### Statement

> **Proposition.** Let a merge operator union each branch's provenance-typed
> assertion set and select a winner by any evidence score. If the merged slot
> retains the full annotation the operator is a join over a join-semilattice —
> associative, commutative, idempotent, hence confluent (proved by
> construction; zero counterexamples in 72,760 enumerated profiles). If the
> merged slot is collapsed to a bounded summary, confluence fails on well-formed
> input and the failure compounds through the derivation DAG.

The practical consequence, which is the whole reason to care: **"summarize as
you merge" is unsound**, no matter how good the summarizer is. The engine
collapses exactly once, at serialization time.

Reproduce: `python3 run_t1.py` in `../beliefmerge-t1/`.

---

## 4. Settling ties without guessing

Evidence decides most conflicts. When it is genuinely tied, a constrained
adjudicator may step in:

| outcome | meaning |
|---|---|
| `choose` | one value is better supported by the quotes |
| `both` | the values are compatible — different aspects, not a disagreement |
| `conditional` | both hold under different conditions; a guard is required |
| `unresolvable` | the quotes do not settle it |

Three constraints make this safe rather than merely plausible:

**It cannot invent an answer.** The chosen value must already be an option in
that conflict. A hallucinated third value is rejected and the tie stands.

**It is checked for position bias.** The same conflicts are asked a second time
with the options **order-reversed**. A conclusion that flips was reading the
presentation order, not the content, and is downgraded to `unresolvable`. This
is axiom IC2 (permutation invariance) enforced at runtime rather than asserted in
a document. It costs exactly one extra call, and only when ties exist.

**`unresolvable` is a first-class answer.** The prompt says so explicitly. The
merge would rather surface a contradiction than paper over it.

The adjudication is attached as `slot.resolution`; the underlying annotation is
never mutated, so every opinion and its provenance stay auditable.

---

## 5. Trust, and why a merge is a laundering primitive

An assertion from a compromised session enters the merged block, and from the
reading model's point of view becomes indistinguishable from something the
current user established. `dsh-session-reference` guards this with a fixed
warning; a naive merger would quietly undo the guard.

```
TRUSTED   (2)   the current session's own user
   |
EXTERNAL  (1)   another session's content
   |
UNTRUSTED (0)   plugin-injected, or origin unknown
```

> **Invariant I2 (no laundering): the act of merging may never raise a value's
> trust above the trust of the claims that assert it.**
> Corroboration across independent sources can raise trust; merging cannot.

Two operations, deliberately distinct: **join (max)** for aggregation, **meet
(min)** for derivation. A concluded claim may be no more trustworthy than the
weakest premise on the route that supports it.

Three consequences in the rendered block: a fixed `EXTERNAL BACKGROUND` banner;
individual marking of untrusted items inside an otherwise-external block; and
the banner is **never dropped for budget reasons** — if the budget cannot hold
the banner plus one item, the plugin injects nothing.

Verified against a real prompt-injection payload. After reading the injected
block, the model reported:

> *"Quoted as data only; the block's embedded directives are not treated as
> instructions."*

An unlabelled claim is treated as `UNTRUSTED`, never assumed benign. The
invariants are a **security** property, so a violation **fails closed**.

---

## 6. Retracting what was derived from a retracted premise

Merging conclusions is not merging reasoning. If a branch concludes X because of
Y, and the merge later disputes Y, X's own evidence weight is untouched — so
nothing in the evidence arithmetic notices.

| status | meaning |
|---|---|
| `axiom` | no premises |
| `founded` | at least one justification has **all** premises IN |
| `retracted` | it has justifications and **none** is fully satisfied |

A slot is IN iff it is asserted **and** founded, computed as a least fixpoint.

**Why a graph and not a boolean.** A claim can have several independent routes.
Losing one premise must not retract a conclusion another route still supports.
The trust ceiling correspondingly uses the **best** route — one weak alternative
must not drag down a claim a strong alternative fully supports.

Retracted slots are still rendered, marked and with the unmet premises named,
but their packing utility is cut to 5%: available, never competitive.

Verified live. The model reconstructed a two-level chain and the propagation
carried it:

```
infra.add_eu_west_replica   ↳ derived from: latency.eu_exceeds_200ms
latency.eu_exceeds_200ms    ↳ derived from: cdn.provider, primary_region
```

---

## 7. Choosing what survives a budget

```
max U(S)   s.t.   sum of tok(v) for v in S  <=  B

U(S) = sum_{v in S} personal(v)               individual value
     + sum_t w_t * (1 - e^(-gamma*n_t(S)))    coverage saturation
```

The coverage term is concave in each per-type count, so its marginal gain
shrinks as a type fills — the diminishing-returns shape that makes the objective
**monotone submodular**. Both properties are tested *as properties*:
monotonicity over all subsets, and `U(S+v) − U(S) ≥ U(T+v) − U(T)` for every
`S ⊆ T` (over a thousand cases checked).

**Approximation, stated precisely.** Under a cardinality constraint greedy is
`(1 − 1/e)`. Under a **knapsack** constraint, plain density greedy has **no
constant guarantee**; Sviridenko (2004) restores `(1 − 1/e)` by enumerating
partial solutions first. Because this objective also mixes per-item terms,
`partial` is honestly a heuristic that is *never worse* than density greedy —
not a certified ratio. The module reports which algorithm ran.

**Cache-aware layout.** The injected block is appended; if it changes, every
token from the change onward is recomputed. Ordering stable content first means
a volatile change invalidates only the tail. Measured, not asserted:

```
stable-first layout : preserved prefix = 3 of 4
volatile-first      : preserved prefix = 0 of 4
```

---

## 8. Evaluation

`MergeBench` generates scenarios with known ground truth. **Bridge questions**
need facts from different branches; **local questions** need facts from one and
exist so the single-branch baseline is not trivially zero. Every arm respects
the same token budget.

### A realistic budget — 400 tokens, 5 scenarios, 50 bridge questions

```
arm                         local   bridge   best 1     GAIN  unambig   tokens
single:branch-a               50%       0%       0%      +0%      50%      388
concat                        60%      18%       0%     +18%      50%      399
beliefmerge-heuristic         95%      98%       0%     +98%      50%      401
beliefmerge-oracle           100%     100%       0%    +100%     100%      258
```

**Concatenation collapses at a realistic budget**: 18% of bridge questions
against the merge's 98%, at the same cost, because chatter consumes the budget
before the facts do.

### A loose budget — 1200 tokens

```
concat                       100%     100%       0%    +100%       0%      786
beliefmerge-oracle           100%     100%       0%    +100%     100%      258
```

When everything fits, concatenation keeps up on coverage. What it cannot do is
**resolve** anything: on every key asserted twice, both values appear
(`both = 2.0`) and the reader is left to work it out. The merge presents one
value 100% of the time, in **a third of the tokens**.

### Reading the numbers honestly

**`unambig` must be read with `bridge`.** An arm that truncates away the losing
half of a conflict *looks* decisive: `single:branch-a` scores 50% unambiguous at
a 400-token budget purely because it only ever had one side. High `unambig` with
low `bridge` is data loss, not resolution.

**The heuristic arm costs more than concatenation at a loose budget** (967 vs
786 tokens). Sentence-level extraction keeps chatter as claims, so dedup does
not help. A real limitation of the deterministic extractor.

**`beliefmerge-oracle` is fed a perfect extraction.** It measures the pipeline
ceiling, not achievable accuracy. Extraction quality on a real model is the one
variable the benchmark cannot control offline; the heuristic arm is the floor.

Reproduce: `npm run bench:tight`, `npm run bench`.

---

## 9. Engineering log — what running it found

Every result above comes from code that was run, and running it found bugs that
no amount of unit testing had. This section exists because it is the part that
transferable: **a green test suite is evidence about the paths you exercised,
not about the paths you did not.**

| # | found by | bug |
|---|---|---|
| 1 | live run | `ctx.sessionQuery.readSurface()` returns surface **events**, not messages. Reading `.messages` gave an empty branch — and a rendered block containing *only a header*, which passed a `text.trim()` guard and was injected as an empty section |
| 2 | live run | `ctx.llm` requires `llm` in the plugin's `inject`; Cordis throws on undeclared access, and the alignment fallback **swallowed it** into a silent downgrade |
| 3 | live run | The agent's `reasoningEffort: high` was inherited by the alignment call, which spent the **entire** output budget on reasoning deltas: `finish=max-tokens` with **0 characters** of assembled text |
| 4 | live run | Plugin-injected user messages (`source.kind === 'plugin'`) were treated as user testimony — sandbox policy text received the **highest** evidence level. Two real sessions produced 170 such "claims" |
| 5 | live run | `export * from './adjudicate.js'` re-exports a name but does **not** bind it locally; a missing `import` shipped while 83 tests passed, because nothing tested *alignment → merge → adjudication in one call* |
| 6 | unit tests | A flat premise list `['a','b']` was read as *alternatives* rather than one *conjunction* — silently inverting the semantics |
| 7 | unit tests | The derivation trust ceiling took the minimum over routes instead of the **maximum**, letting one weak alternative drag down a claim a strong one supported |
| 8 | benchmark | The first benchmark made every question span branches, so the single-branch baseline was trivially zero and every comparison said nothing |
| 9 | benchmark | "Faithfulness" compared parsed key/value pairs against topic keys, scoring the heuristic path **100% fabricated** — measuring key style, not fabrication |
| 10 | benchmark | Concatenation was not respecting the budget, so at tight budgets it "won" by spending tokens nobody offered it |
| 11 | live run | M4 was implemented, unit-tested, and **completely inert**: the model emitted zero `derivedFrom` edges. A worked example in the prompt produced edges immediately |
| 12 | live run | The session id format differs by workspace (`session-<uuid>` vs `<uuid>`); the wrong form silently reads nothing |

Two more worth separating out, because they are about honesty rather than code:

**A demo claim that was false.** The packing demo used a budget loose enough that
nothing was dropped, while its narration described slots being dropped. It became
true only after the budget was tightened to 175 tokens. *A demonstration that does
not demonstrate is worse than none, and it is easy to ship one when the numbers
are never read back.*

**A mechanism can be tested and still be dead.** M4 had 25 passing tests and had
never once executed against real input. "It is tested" is not "it runs".

---

## 10. Limitations

- **Extraction quality from a real model is the largest uncontrolled variable.**
  The oracle and heuristic arms bracket it from above and below; nothing pins it
  down.
- **MergeBench scores the rendered context, not a downstream task.** It measures
  information retention, not whether a model then uses the information well.
- **The pipeline is not end-to-end reproducible.** Both model calls request
  `temperature: 0`, and identical input still produced 25 slots on one run and
  16 on the next. Invariant I5 (byte-identical serialization) holds *given* a
  slot set, not across runs.
- **The confluence result is exhaustively verified, not exhaustively proved.**
  JOIN confluence is proven structurally (union is a join-semilattice); the
  enumeration corroborates. Lossy non-confluence is *witnessed*, not
  characterised — the exact boundary is open.
- **Scale is untested**: two branches, ten topics, one workspace, one model route
  (`deepseek-official` / `deepseek-flash`).
- **The nearest prior art is close.** *Trace-Level Synthesis in Mixture of
  Agents* (arXiv:2605.29116) synthesises reasoning traces; *Provenance-Role
  Collapse* (arXiv:2605.25869) types provenance; `memory-reconciler` does
  write-time belief reconciliation with a `disputed` state. The claim here is
  narrower than "new": **the intersection — merging derivation structure rather
  than conclusions, with a confluence guarantee — appears unoccupied.**

---

## 11. Reproducing everything

```sh
npm test            # 182 tests, no dependencies, no network
npm run demo        # end-to-end, offline, seven worked examples
npm run bench       # MergeBench
npm run bench:tight # the budgeted comparison

cd ../beliefmerge-t1 && python3 run_t1.py   # the confluence experiment, ~14s
```

Installation into a real harness, and what the live runs found, is in
[VERIFY.md](VERIFY.md).

---

## Appendix: what is where

| path | contents |
|---|---|
| `lib/core/merge.js`, `slot.js` | the merge algebra; the P1 regression lives here |
| `lib/core/align.js` | joint LLM extraction and alignment |
| `lib/core/adjudicate.js` | constrained tie-breaking with the symmetry check |
| `lib/core/derive.js` | derivation graph and label propagation |
| `lib/core/trust.js` | the trust lattice and invariant I2 |
| `lib/core/pack.js` | submodular packing and cache-aware layout |
| `lib/index.js` | DeepSeek Harness adapter |
| `bench/` | MergeBench |
| `../beliefmerge-t1/` | the confluence experiment |
| `VERIFY.md` | live-run record and failure taxonomy |
| `../../docs/会话融合引擎-BeliefMerge-可行性与算法架构.md` | the original design document, in Chinese |
