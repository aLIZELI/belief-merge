# BeliefMerge T1 — Is incremental context merging safe?

> **Proposition P1, settled empirically.**
> Streaming (pairwise, incremental) merging of conversation branches is **not**
> confluent — it depends on branch arrival order — and the failure **compounds
> through derivation structure**, silently deleting or resurrecting whole chains
> of reasoning. The failure is caused by the *representation* of a merged slot,
> not by the scoring function. Retaining full per-source provenance restores
> confluence, commutativity and idempotence exactly.

```
python3 run_t1.py        # ~14s, standard library only, Python 3.11+
```

---

## 1. The question

BeliefMerge (Stage 3) merges N conversation branches slot by slot. In practice
branches arrive **one at a time**, so you merge pairwise:

```
M  = merge(B1, B2)          # incremental
M' = merge(M, B3)
```

But the architecture also promises **IC2 (symmetry)**: *the merged context must
not depend on which branch you consider "primary"*. That promise is only true if

```
fold(B[p], repr)  ==  merge_nary(B)      for every permutation p
```

Darwiche & Pearl (*On the Logic of Iterated Belief Revision*, AI 1997) proved
that AGM postulates are **insufficient for iterated revision**. We are merging,
not revising, but the same hazard applies. So: **is it safe?**

The answer hinges on one design decision — **how you represent a merged slot
when you re-merge it**:

| Representation | What is kept |
|---|---|
| `JOIN` | the full annotation: every `(value, source, evidence)` |
| `COUNT` | the winner + the multiset of evidence that supported it |
| `MAX` | the winner + a single max evidence level |

Two evidence-aggregation scores are crossed with these:

- `egalitarian` — weighted majority (the Dalai-distance minimiser on one slot)
- `elitist` — lexicographic on the sorted evidence vector (Konieczny–Pino Pérez)

## 2. Method

Fully enumerable search spaces, so a negative result is meaningful evidence and
a positive result comes with a minimal, reproducible witness.

- **Space A** — 3 values, evidence {1,2}, 3 branches → 19,683 profiles
- **Space B** — 2 values, evidence {1,2,3,4}, 3 branches → 15,625 profiles
- **well-formed** variant — each branch holds **at most one opinion per slot**
  (a real conversation branch does not assert `located_in=NYC` *and*
  `located_in=SF` at the same semantic key)

> ⚠️ **Three branches are required.** With two branches the incremental fold is a
> single union; it can never disagree with the n-ary merge. An earlier version of
> this experiment used two branches and produced a spurious null result. Any claim
> about incremental merging needs ≥ 3 sources.

## 3. Results

### 3.1 Confluence failure rates

| space | score | repr | well-formed | failures | total | rate |
|---|---|---|---:|---:|---:|---:|
| A | egalitarian | **JOIN** | no | **0** | 19,683 | **0.0%** |
| A | egalitarian | COUNT | no | 7,740 | 19,683 | 39.3% |
| A | egalitarian | MAX | no | 8,034 | 19,683 | 40.8% |
| A | elitist | **JOIN** | no | **0** | 19,683 | **0.0%** |
| A | elitist | COUNT | no | 7,794 | 19,683 | 39.6% |
| A | elitist | MAX | no | 7,620 | 19,683 | 38.7% |
| A | egalitarian | **JOIN** | yes | **0** | 343 | **0.0%** |
| A | egalitarian | COUNT | yes | 54 | 343 | 15.7% |
| A | egalitarian | MAX | yes | 90 | 343 | 26.2% |
| A | elitist | **JOIN** | yes | **0** | 343 | **0.0%** |
| A | elitist | COUNT | yes | 36 | 343 | 10.5% |
| A | elitist | MAX | yes | 72 | 343 | 21.0% |
| B | egalitarian | **JOIN** | no | **0** | 15,625 | **0.0%** |
| B | egalitarian | COUNT | no | 4,488 | 15,625 | 28.7% |
| B | egalitarian | MAX | no | 3,594 | 15,625 | 23.0% |
| B | elitist | **JOIN** | no | **0** | 15,625 | **0.0%** |
| B | elitist | COUNT | no | 3,276 | 15,625 | 21.0% |
| B | elitist | MAX | no | 3,240 | 15,625 | 20.7% |
| B | egalitarian | **JOIN** | yes | **0** | 729 | **0.0%** |
| B | egalitarian | COUNT | yes | 90 | 729 | 12.3% |
| B | egalitarian | MAX | yes | 114 | 729 | 15.6% |
| B | elitist | **JOIN** | yes | **0** | 729 | **0.0%** |
| B | elitist | COUNT | yes | 72 | 729 | 9.9% |
| B | elitist | MAX | yes | 96 | 729 | 13.2% |

**JOIN aggregate: 0 failures / 72,760 profiles, across both scores.**

### 3.2 Minimal counterexample — and it is well-formed

```
B0 = {a@1}      B1 = {a@1}      B2 = {b@2}

n-ary       : disputed{a,b}          <-- correct: weights are 1+1 = 2 vs 2
incremental : b                      <-- WRONG
   (order B0,B1,B2: a wins 2-1, collapses to a@1 [weight 1],
    then b@2 [weight 2] beats it 2-1)
```

**Mechanism — collapsing destroys corroboration multiplicity.** Two weak
agreeing branches are worth more than one of them alone; a winner-take-all
representation throws that away, and a single strong dissenter then wins.

This is *not* an artefact of self-contradictory branches. It survives on
well-formed input, at a 9.9%–26.2% rate.

### 3.3 The failure compounds through derivation structure

A claim is `IN` iff it is merged-`ASSERT`ed **and** all its premises are `IN`
(JTMS-style label propagation). Divergence in one slot decision cascades.

**Deletion** — corroboration lost, a clear win becomes a tie:

```
b0: c0:assert@1     b1: c0:assert@1     b2: c0:refute@1
n-ary       IN = [c0]        <-- assert wins 2-1
incremental IN = []          <-- collapses to a@1, ties 1-1, c0 goes OUT
```

**Resurrection** — a claim that should be `disputed` comes back to life:

```
b0: c0:assert@2, c1:assert@2
b1:             c1:refute@1, c2:refute@1
b2: c0:refute@1, c1:refute@1
n-ary       IN = [c0]        <-- c1 ties 2-2, stays disputed, is OUT
incremental IN = [c0, c1]    <-- c1 resurrects, and if asserted would cascade
```

**Whole-chain loss** — with a 3-claim chain, incremental merging erased the
entire derivation (`n-ary IN = [c0]`, `incremental IN = []`).

### 3.4 Idempotence

| score | repr | decision-level | state-level |
|---|---|---|---|
| either | **JOIN** | PASS | **PASS** |
| either | COUNT | PASS | **FAIL** |
| either | MAX | PASS | **FAIL** |

Only `JOIN` is idempotent at the *state* level: union of supports is idempotent,
while collapsing duplicates support. Decision-level idempotence holds for all
representations, so the damage is confined to the iteration path.

## 4. Conclusion

**Theorem (necessity of provenance retention), informally.**
Let a merge operator union each branch's *provenance-typed* assertion set and
select a winner by any evidence score. Then:

1. **If the merged slot retains the full annotation**, the merge is a join over a
   join-semilattice: associative, commutative, idempotent — hence confluent.
   *Proven by construction; zero counterexamples in 72,760 enumerated profiles.*
2. **If the merged slot is collapsed to a bounded-size summary** (winner +
   evidence), confluence fails — on **well-formed** input, at 9.9%–26.2% in our
   spaces — and the failure compounds through the derivation DAG, deleting or
   resurrecting entire reasoning chains.
   *Demonstrated by exhaustive minimal counterexamples.*

**Consequences for the design:**

- **Incremental merging is only safe if full per-source provenance is carried
  forward.** "Summarize as you merge" is unsound, no matter how good the
  summarizer or the scoring function.
- **The scoring function is not the problem.** Egalitarian and elitist fail at
  comparable rates under lossy representations and both are perfect under JOIN.
  The representation is the variable that matters.
- **Engineering fallback:** log the merge order in `merge/*` events and keep the
  ability to recompute n-ary from the sources. Without that, an incremental
  deployment is silently order-dependent.
- **When storage forces a collapse**, do it only at the *last* step (serialization
  for injection), never between merges.

## 5. Files

```
bm/model.py       SlotState — provenance-typed annotation, union
bm/operators.py   scores, select(), the three representations, both merge shapes
bm/laws.py        confluence / order-dependence / idempotence checks
bm/search.py      exhaustive enumeration over small spaces
bm/tms.py         claims, JTMS propagation, compounded-failure search
run_t1.py         driver -> console report + t1_results.json
```

## 6. Honest scope

- The spaces are deliberately small (≤ 4 evidence levels, ≤ 3 values, 3 branches).
  They are **fully enumerated**, which is stronger than sampling, but they are not
  a proof over all profiles.
- `JOIN` confluence *is* proven structurally (union is a join-semilattice); the
  enumeration is corroboration, not the proof.
- Lossy non-confluence is **witnessed**, not characterised. The exact boundary —
  for which profile shapes a bounded representation happens to suffice — is open.
- The JTMS fragment here is conjunction-only (no disjunctive justifications, no
  out-lists). The full architecture needs the general assumption-based TMS.
