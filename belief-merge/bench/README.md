# MergeBench

```
node bench/run.js --seeds=5 --topics=10 --budget=400
```

A synthetic benchmark with known ground truth, built to answer one question:

> Does merging two branches let a reader answer questions that **neither branch
> could answer alone** — and does it earn the tokens it costs?

It is an instrument, not a result. The scenarios are generated, so the numbers
below are about the *pipeline*, not about real conversations.

---

## The design

**Bridge questions** are the whole point. Each needs facts that live in
*different* branches. **Local questions** need facts from *one* branch, and
exist so the single-branch baseline is not trivially zero — the first version of
this benchmark omitted them, which made every comparison vacuous.

Facts are distributed so no branch holds everything. Some keys are asserted
twice with different evidence, so the correct answer is decided by evidence
weight rather than by luck. Low-value chatter is mixed in, because that is what
a real token budget is actually spent on.

Every arm respects the same token budget. A baseline that ignores the limit
"wins" by spending tokens nobody offered it — the first version let
concatenation run unbounded.

| arm | what it is |
|---|---|
| `none` | no context — the floor |
| `single:branch-a` | one branch alone — a concrete single-branch arm |
| `concat` | every branch pasted together, truncated to budget |
| `beliefmerge-heuristic` | the deterministic core, **no model calls at all** |
| `beliefmerge-oracle` | full pipeline fed a **perfect extraction** |

`beliefmerge-oracle` measures the **pipeline ceiling**, not achievable accuracy.
Extraction quality on a real model is the one variable this benchmark cannot
control offline; the heuristic arm is the no-model floor.

---

## Results

### A realistic budget — 400 tokens, 5 scenarios, 50 bridge questions

```
arm                         local   bridge   best 1     GAIN  unambig   both   invent   tokens
----------------------------------------------------------------------------------------------
none                           0%       0%       0%      +0%       0%    0.0       0%        0
single:branch-a               50%       0%       0%      +0%      50%    0.0       0%      388
concat                        60%      18%       0%     +18%      50%    0.0       0%      399
beliefmerge-heuristic         95%      98%       0%     +98%      50%    0.8       0%      401
beliefmerge-oracle           100%     100%       0%    +100%     100%    0.0       0%      258
```

**Concatenation collapses.** It answers 60% of local questions but only **18%**
of bridge questions at the same cost as the merge, because chatter consumes the
budget before the facts do. The merge answers **98%**.

### A loose budget — 1200 tokens

```
arm                         local   bridge   best 1     GAIN  unambig   both   invent   tokens
----------------------------------------------------------------------------------------------
single:branch-a               50%       0%       0%      +0%      50%    0.0       0%      392
concat                       100%     100%       0%    +100%       0%    2.0       0%      786
beliefmerge-heuristic        100%     100%       0%    +100%       0%    2.0       0%      967
beliefmerge-oracle           100%     100%       0%    +100%     100%    0.0       0%      258
```

When everything fits, **concatenation is fine on coverage** — and cheaper than
the heuristic arm. What it does not do is resolve anything: on every key
asserted twice, **both values appear** (`both = 2.0`) and the reader is left to
work it out. The merge presents exactly one value, 100% of the time.

The oracle arm is also **3× cheaper than concatenation** (258 vs 786 tokens) at
identical coverage, because it carries the extracted facts rather than the
conversation that produced them.

---

## Reading the numbers honestly

**`unambig` must be read together with `bridge`.** An arm that truncates away
the losing half of a conflict *looks* decisive. `single:branch-a` scores 50%
unambiguous at a 400-token budget — not because it resolved anything, but
because it only ever had one side. High `unambig` with low `bridge` is data
loss, not resolution.

**`best 1` is 0% on bridge questions by construction.** A bridge question spans
branches, so no single branch can answer one. That is the definition, not a
flaw — the meaningful baseline comparison is the *local* column, where a single
branch sits at 50% and a merge at 95–100%.

**The heuristic arm costs more than concatenation at a loose budget** (967 vs
786 tokens). Its sentence-level extraction keeps chatter as "claims", so the
packer has more low-value items to consider and the dedup does not help. This is
a real limitation of the deterministic extractor, not a presentation choice.

**The heuristic arm cannot resolve conflicts** (`unambig` 50%, `both` 0.8). Its
keys are whole sentences, so `cache.ttl = sixty` and `cache.ttl = three_hundred`
never land in the same slot. Only the aligned (LLM) path can do better — and the
oracle arm shows that when alignment is correct, resolution is complete.

**Nothing here is fabricated.** `invent` is 0% across every arm: no block
contained a value from the topic vocabulary that no branch ever asserted.

---

## What this does not measure

- **Whether a model then uses the merged context well.** Scoring parses the
  rendered block; it does not run a downstream task. An end-to-end arm would be
  more realistic, non-deterministic and expensive — a deliberate omission, not
  an oversight.
- **Real conversations.** The scenarios are generated. Chatter is synthetic.
- **Extraction quality from a real model.** This is the largest uncontrolled
  variable, which is exactly why the oracle and heuristic arms bracket it.
- **Scale.** Two branches, ten topics, one workspace.
