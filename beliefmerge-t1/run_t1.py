#!/usr/bin/env python3
"""BeliefMerge T1 -- does incremental merging agree with n-ary merging?

Runs four experiments and prints a report:

  1. Confluence under the information-preserving representation (JOIN)
  2. Confluence under lossy representations (COUNT, MAX)
  3. Idempotence
  4. Whether slot-level failures compound through derivation structure (JTMS)

Run:  python3 run_t1.py
"""

from __future__ import annotations

import json
import time
from itertools import permutations
from pathlib import Path
from typing import Dict, List, Sequence, Tuple

from bm.laws import confluence_violation, is_idempotent, state_is_idempotent
from bm.model import SlotState
from bm.operators import (
    REPRESENTATIONS,
    SCORES,
    Decision,
    merge_incremental,
    merge_nary,
    select,
)
from bm.search import confluence_failure_rate, find_minimal_counterexamples
from bm.tms import (
    ClaimSpec,
    find_compounded_failures,
    find_compounded_failures_random,
)

LINE = "=" * 78
SUB = "-" * 78

# Two fully-enumerable search spaces.
SPACE_A = dict(values=("a", "b", "c"), evidences=(1, 2), n_branches=3)
SPACE_B = dict(values=("a", "b"), evidences=(1, 2, 3, 4), n_branches=3)


def space_size(space) -> int:
    per_branch = (len(space["evidences"]) + 1) ** len(space["values"])
    return per_branch ** space["n_branches"]


def describe(decision: Decision) -> str:
    return str(decision)


def show_profile(branches: Sequence[SlotState]) -> str:
    return "  |  ".join(f"B{i}={b}" for i, b in enumerate(branches))


def experiment_1(report: Dict) -> None:
    print(LINE)
    print("EXPERIMENT 1 -- confluence: incremental merging vs n-ary merging")
    print(LINE)
    print("  Law: for every permutation p of branches,")
    print("         fold(branches[p], representation) == merge_nary(branches)")
    print()

    for space_name, space in (("A", SPACE_A), ("B", SPACE_B)):
        n = space_size(space)
        print(f"  Space {space_name}: values={list(space['values'])} "
              f"evidences={list(space['evidences'])} branches={space['n_branches']} "
              f"({n:,} profiles)")

    print()
    print("  'well-formed' = each branch holds at most ONE opinion per slot")
    print("  (the realistic case: a single conversation branch does not assert")
    print("   located_in=NYC and located_in=SF at the same semantic key)")
    print()
    header = (f"  {'space':<7}{'score':<13}{'repr':<8}{'wellformed':<12}"
              f"{'failures':>10}{'total':>10}{'rate':>10}")
    print(header)
    print("  " + SUB[2:])
    for space_name, space in (("A", SPACE_A), ("B", SPACE_B)):
        for well_formed in (False, True):
            for score_name, score in SCORES.items():
                for rep_name, rep in REPRESENTATIONS.items():
                    fails, total = confluence_failure_rate(
                        space["values"], space["evidences"], space["n_branches"],
                        score, rep, well_formed=well_formed,
                    )
                    rate = fails / total if total else 0.0
                    print(f"  {space_name:<7}{score_name:<13}{rep_name:<8}"
                          f"{('yes' if well_formed else 'no'):<12}"
                          f"{fails:>10,}{total:>10,}{rate:>9.1%}")
                    report["confluence"].append(
                        dict(space=space_name, score=score_name, representation=rep_name,
                             well_formed=well_formed, failures=fails, total=total, rate=rate)
                    )
    print()


def experiment_1b(report: Dict) -> None:
    print(LINE)
    print("EXPERIMENT 1b -- minimal counterexamples")
    print(LINE)
    print("  Question: is the failure an artefact of self-contradictory branches,")
    print("  or does it survive on well-formed (realistic) branches?")
    print()
    for well_formed in (False, True):
        tag = "well-formed" if well_formed else "general"
        print(f"  --- {tag} branches ---")
        for score_name, score in SCORES.items():
            for rep_name, rep in REPRESENTATIONS.items():
                if rep_name == "JOIN":
                    continue
                examples = find_minimal_counterexamples(
                    SPACE_A["values"], SPACE_A["evidences"], SPACE_A["n_branches"],
                    score, rep, limit=1, well_formed=well_formed,
                )
                if not examples:
                    print(f"    [{score_name} / {rep_name}] no counterexample found")
                    continue
                size, branches, (ref, order, got) = examples[0]
                print(f"    [{score_name} / {rep_name}] minimal witness ({size} assertions)")
                print(f"        profile : {show_profile(branches)}")
                print(f"        n-ary   : {describe(ref)}")
                print(f"        order {order}: {describe(got)}   <-- DIFFERS")
                report["minimal_witness"].append(
                    dict(well_formed=well_formed, score=score_name,
                         representation=rep_name, size=size,
                         profile=[str(b) for b in branches],
                         n_ary=str(ref), order=list(order), incremental=str(got))
                )
        print()


def experiment_2(report: Dict) -> None:
    print(LINE)
    print("EXPERIMENT 2 -- idempotence: merge(A, A) == A")
    print(LINE)
    samples = [
        SlotState.of(("a", "b0", 2), ("b", "b0", 1)),
        SlotState.of(("a", "b0", 1), ("b", "b0", 1)),
        SlotState.of(("a", "b0", 4), ("a", "b0", 1)),
        SlotState.of(("a", "b0", 1), ("a", "b0", 2), ("b", "b0", 2)),
    ]
    for score_name, score in SCORES.items():
        for rep_name, rep in REPRESENTATIONS.items():
            decision_ok = all(is_idempotent(s, score, rep) for s in samples)
            state_ok = all(state_is_idempotent(s, rep, score) for s in samples)
            print(f"  {score_name:<14}{rep_name:<8}"
                  f"decision-level={'PASS' if decision_ok else 'FAIL':<6}"
                  f"state-level={'PASS' if state_ok else 'FAIL'}")
            report["idempotence"].append(
                dict(score=score_name, representation=rep_name,
                     decision_level=decision_ok, state_level=state_ok)
            )
    print()
    print("  Note: only JOIN is state-level idempotent -- union of supports is")
    print("  idempotent, while summing/collapsing duplicates support.")
    print()


def _print_compounded(failures, report, key: str) -> None:
    if not failures:
        print("    no compounded failure found")
        print()
        return
    for cost, branches, reference, got in failures:
        print(f"    witness (cost={cost}):")
        for b in branches:
            ops = ", ".join(f"c{cid}:{val}@{e}" for cid, val, e in sorted(b.opinions))
            print(f"        {b.sid}: {ops if ops else '<no opinion>'}")
        print(f"        n-ary        IN = {sorted(reference)}")
        print(f"        incremental  IN = {sorted(got)}   <-- DIFFERS")
        report[key].append(
            dict(cost=cost,
                 branches=[sorted((c, v, e) for c, v, e in b.opinions) for b in branches],
                 n_ary_IN=sorted(reference), incremental_IN=sorted(got))
        )
    print()


def experiment_3(report: Dict) -> None:
    print(LINE)
    print("EXPERIMENT 3 -- do slot-level failures compound through derivations?")
    print(LINE)
    print("  A claim is IN iff it is merged-ASSERTed and all premises are IN.")
    print("  NOTE: 3 branches are required -- with only 2, the incremental fold")
    print("  is a single union and can never disagree with the n-ary merge.")
    print()

    score = SCORES["egalitarian"]
    rep = REPRESENTATIONS["MAX"]

    print("  [3a] Claims: c0 (axiom), c1 <- {c0}   -- 3 branches, exhaustive")
    specs2 = [ClaimSpec(cid=0), ClaimSpec(cid=1, premises=frozenset({0}))]
    _print_compounded(
        find_compounded_failures(specs2, evidences=(1, 2), n_branches=3,
                                 score=score, representation=rep, limit=2),
        report, "compounded",
    )

    print("  [3b] Claims: c0 (axiom), c1 <- {c0}, c2 <- {c1}   -- 3 branches, random")
    specs3 = [ClaimSpec(cid=0),
              ClaimSpec(cid=1, premises=frozenset({0})),
              ClaimSpec(cid=2, premises=frozenset({1}))]
    _print_compounded(
        find_compounded_failures_random(specs3, evidences=(1, 2), n_branches=3,
                                        score=score, representation=rep,
                                        samples=100_000, limit=2),
        report, "compounded_chain3",
    )


def experiment_4(report: Dict) -> None:
    """Prove the positive direction on the JOIN representation by construction."""
    print(LINE)
    print("EXPERIMENT 4 -- why JOIN is safe (structural argument, checked exhaustively)")
    print(LINE)
    print("  With JOIN the accumulator after any fold is exactly the union of all")
    print("  branches seen so far.  Union is associative, commutative and")
    print("  idempotent, so every arrival order yields the same annotation, hence")
    print("  the same Decision.  The exhaustive runs above confirm zero failures.")
    print()
    # A deliberately adversarial random-ish sample to demonstrate.
    tricky = [
        [SlotState.of(("a", "b0", 2)), SlotState.of(("b", "b1", 1)), SlotState.of(("b", "b2", 1))],
        [SlotState.of(("a", "b0", 2)), SlotState.of(("b", "b1", 2)), SlotState.of(("b", "b2", 1))],
        [SlotState.of(("a", "b0", 1)), SlotState.of(("b", "b1", 1)), SlotState.of(("c", "b2", 1))],
    ]
    for branches in tricky:
        _, ref = merge_nary(branches, SCORES["egalitarian"])
        results = {
            order: merge_incremental([branches[i] for i in order],
                                     SCORES["egalitarian"], REPRESENTATIONS["JOIN"])[1]
            for order in permutations(range(len(branches)))
        }
        agree = all(d.key() == ref.key() for d in results.values())
        print(f"  {show_profile(branches)}")
        print(f"      n-ary={ref}  all {len(results)} orders agree: {agree}")
    print()


def main() -> None:
    started = time.time()
    report: Dict = {"confluence": [], "minimal_witness": [], "idempotence": [],
                    "compounded": [], "compounded_chain3": []}

    print()
    print(LINE)
    print("BeliefMerge T1 -- associativity / confluence of incremental context merging")
    print(LINE)
    print()

    experiment_1(report)
    experiment_1b(report)
    experiment_2(report)
    experiment_3(report)
    experiment_4(report)

    elapsed = time.time() - started
    print(LINE)
    print(f"done in {elapsed:.1f}s")
    print(LINE)

    out = Path(__file__).with_name("t1_results.json")
    out.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"machine-readable results -> {out.name}")


if __name__ == "__main__":
    main()
