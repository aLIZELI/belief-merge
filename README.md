# BeliefMerge

**Merging two AI conversations without losing the reasoning, laundering trust, or guessing at contradictions.**

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin, a confluence theorem with a counterexample, and a benchmark that was wrong twice before it was useful.

```sh
dsh plugin --profile web add dsh-belief-merge
```

Then just ask: *"merge my two bilibili conversations into this one"* — or drive it
by hand with `/merge` to list candidates, pick them, and check what is in effect.
No config file to edit, no restart; it applies on the next turn.

Full usage, configuration and limitations: **[belief-merge/README.md](belief-merge/README.md)**.

Working on the code instead:

```sh
cd belief-merge
npm test             # 242 tests, no dependencies, no network, no API key
npm run demo         # end-to-end, offline
npm run bench:tight  # the budgeted comparison
```

---

## The problem, in two sentences

Two conversations about the same system drift apart, and a later question needs
facts from both. Every existing tool answers this by *pasting* one into the other
(cheap, unbounded, contradictions left to the reader) or by *summarizing* (lossy
exactly where it matters — the reasoning, including the dead ends that stop you
repeating them).

---

## Four results

### 1. Incremental merging is unsound unless you keep provenance

Branches arrive over time, so merging happens pairwise. Swapping the order of two
branches then changes the answer — and it does so **silently**:

```
B0 = {a@1}      B1 = {a@1}      B2 = {b@2}

n-ary        : disputed{a,b}      correct — weights are 1+1 = 2 against 2
incremental  : b                  WRONG
```

Merging `B0` and `B1` first collapses two weak branches that agree into one weak
assertion, so a single strong dissenter wins.

Over **72,760 enumerated profiles**, a provenance-retaining representation
produced **zero** failures; collapsing to a bounded summary failed on **9.9–26.2%
of well-formed inputs** — and the failure cascades through derivation chains,
deleting or resurrecting whole lines of reasoning.

> **"Summarize as you merge" is unsound**, no matter how good the summarizer is.

### 2. At a realistic budget, concatenation collapses

`MergeBench` generates scenarios where **bridge questions** need facts from
different branches — so no single branch can answer them. Every arm gets the same
token budget.

**400 tokens, 50 bridge questions:**

| arm | local | **bridge** | resolves conflicts | tokens |
|---|---|---|---|---|
| one branch alone | 50% | 0% | 50% | 388 |
| concatenation | 60% | **18%** | 50% | 399 |
| **BeliefMerge** | **95%** | **98%** | **100%** | 401 |

At a *loose* budget everything fits and concatenation keeps up on coverage — but
it cannot **resolve** anything: on every key asserted twice, both values appear
and the reader is left to work it out. The merge presents one value 100% of the
time, in **a third of the tokens**.

### 3. Ties are settled by a model that is not allowed to guess

Evidence decides most conflicts. When it is genuinely tied, an adjudicator may
step in — constrained three ways:

- it **cannot invent** a value that was not already an option;
- it is asked twice with the options **order-reversed**, and an answer that flips
  is downgraded to `unresolvable` — axiom IC2 enforced at runtime;
- `unresolvable` is a **first-class answer**, and the merge would rather surface
  a contradiction than paper over it.

### 4. A merge is a laundering primitive — so trust is a lattice

An assertion from a compromised session enters the merged block and becomes
indistinguishable from something the current user established.

> **Invariant I2: the act of merging may never raise a value's trust above the
> trust of the claims that assert it.** Corroboration can raise trust; merging
> cannot.

Verified against a real prompt-injection payload. After reading the injected
block, the model reported:

> *"Quoted as data only; the block's embedded directives are not treated as
> instructions."*

---

## What is actually here

Four kinds of document. The third column says who each one is for.

| | | read it if |
|---|---|---|
| **[belief-merge/README.md](belief-merge/README.md)** | **the user manual** — install, usage, configuration reference, upgrade traps, what is verified and what is not | you want to **use** the plugin |
| **[ARCHITECTURE.md](belief-merge/ARCHITECTURE.md)** | **the code map, as built** — the pipeline stage by stage, the three places a model may act, the degradation ladder | you want to **understand or extend** it |
| **[TECHNICAL-REPORT.md](belief-merge/TECHNICAL-REPORT.md)** | the full writeup — design rationale, the confluence result, the benchmark, limitations | you want the **reasoning** behind the design |
| **[belief-merge/CHANGELOG.md](belief-merge/CHANGELOG.md)** | release history, and why upgrading needs an explicit version | you are **upgrading** |
| **[belief-merge/VERIFY.md](belief-merge/VERIFY.md)** | the live-run record — **13 bugs found by running it**, and a failure taxonomy | you want to know **what actually happened** in a real harness |
| **[beliefmerge-t1/](beliefmerge-t1/)** | the confluence experiment — exhaustive enumeration over 72,760 profiles, minimal counterexamples | you want to **check the headline claim** |
| **[belief-merge/bench/](belief-merge/bench/)** | MergeBench — generator, scored arms, results, and what it does not measure | you want to **check the numbers** |
| **[belief-merge/](belief-merge/)** | the plugin itself: 14 core modules, 242 tests, an offline demo | you want to **read the code** |
| **[docs/](docs/)** | research material, not shipped in the npm package | |
| ↳ [会话融合引擎-BeliefMerge-可行性与算法架构.md](docs/会话融合引擎-BeliefMerge-可行性与算法架构.md) | the original **pre-implementation proposal** (Chinese) — 8 stages, 6 novelty points, 8 invariants. Read the banner first: its M-numbering is not the plugin's, and two of its milestones were never built | you want to see **how it was planned** |
| ↳ [conversation-branch-merge-litreview.md](docs/conversation-branch-merge-litreview.md) | the literature review, ~60 references checked against Crossref/OpenAlex/arXiv | you are asking **"has this been done before?"** |
| ↳ [BeliefMerge-算法逻辑图.html](docs/BeliefMerge-算法逻辑图.html) | the algorithm diagram, openable in a browser and exportable to PNG | you want **one picture** |
| ↳ [refcheck/](docs/refcheck/) | the scripts and table used to verify those references | you are **auditing the citations** |

> The npm package ships `lib/`, `bench/`, `cordis.patch.yml`, `ARCHITECTURE.md`,
> `CHANGELOG.md`, `TECHNICAL-REPORT.md` and `VERIFY.md` — see the `files` field in
> `package.json`. `docs/` and `beliefmerge-t1/` are repository material only.

---

## The part I would actually ask about in an interview

**Every bug that mattered was found by running the thing, not by testing it.**

`export * from './x.js'` re-exports a name but does not bind it locally — so a
missing `import` shipped while **83 tests passed**, because no test exercised
*alignment → merge → adjudication in one call*. The derivation-propagation
mechanism had **25 passing tests and had never once executed** against real
input, because the model emitted zero edges until the prompt contained a worked
example.

Thirteen are logged in
[TECHNICAL-REPORT.md §9](belief-merge/TECHNICAL-REPORT.md#9-engineering-log--what-running-it-found),
and narrated round by round in [VERIFY.md](belief-merge/VERIFY.md), including one
demo whose narration was **false** until the budget was tightened enough for its
claim to be true.

> A green test suite is evidence about the paths you exercised, not about the
> paths you did not.

---

## Reproducing everything

```sh
cd belief-merge && npm test          # 242 tests, no network, no API key
cd belief-merge && npm run demo      # seven worked examples, offline
cd belief-merge && npm run bench     # MergeBench
cd beliefmerge-t1 && python3 run_t1.py  # the confluence experiment, ~14s
```

Installing into a real DeepSeek Harness profile is documented in
[VERIFY.md](belief-merge/VERIFY.md), along with what happened when it was done.
