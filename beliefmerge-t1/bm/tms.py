"""Experiment 2 -- does the P1 failure compound through derivation structure?

Slot-level confluence is only half the story.  In BeliefMerge a claim is
*derived* from premises (the `derived-from` edges that JTMS walks).  So a
single slot decision that flips under incremental merging can cascade:
a premise goes OUT, therefore everything downstream goes OUT too.

Claims form a DAG via ``premises``.  A claim is IN iff

    (merged decision for that claim == resolved(ASSERT))
    and every premise is IN

computed as a least fixpoint (this is Doyle-style label propagation
restricted to conjunctions).

We then compare:

    n-ary        merge all branches, then propagate
    incremental  fold branches pairwise with a representation, then propagate

Any divergence in the resulting IN set is a *compounded* associativity
failure -- much worse than a cosmetic slot-level disagreement, because it
silently deletes (or resurrects) whole chains of reasoning.
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import permutations, product
from typing import Dict, FrozenSet, List, Optional, Sequence, Set, Tuple

from .model import SlotState
from .operators import Decision, Representation, ScoreFn, merge_incremental, merge_nary, select

ASSERT = "assert"
REFUTE = "refute"


@dataclass(frozen=True)
class ClaimSpec:
    """One claim and the premises that must all hold for it to be IN."""

    cid: int
    premises: FrozenSet[int] = frozenset()

    def __str__(self) -> str:
        if not self.premises:
            return f"c{self.cid}(axiom)"
        return f"c{self.cid}<-{{{','.join('c'+str(p) for p in sorted(self.premises))}}}"


@dataclass(frozen=True)
class Branch:
    """A branch's opinions: for each claim, at most one (value, evidence)."""

    sid: str
    opinions: FrozenSet[Tuple[int, str, int]] = frozenset()

    def slot(self, cid: int) -> SlotState:
        return SlotState(
            frozenset((v, self.sid, e) for (c, v, e) in self.opinions if c == cid)
        )


def propagate(specs: Sequence[ClaimSpec], decisions: Dict[int, Decision]) -> Set[int]:
    """Least fixpoint: a claim is IN iff asserted and all premises are IN."""
    inn: Set[int] = set()
    changed = True
    while changed:
        changed = False
        for spec in specs:
            if spec.cid in inn:
                continue
            decision = decisions.get(spec.cid)
            if decision is None or decision.outcome != "resolved" or decision.winner != ASSERT:
                continue
            if all(p in inn for p in spec.premises):
                inn.add(spec.cid)
                changed = True
    return inn


def evaluate_nary(
    specs: Sequence[ClaimSpec],
    branches: Sequence[Branch],
    score: ScoreFn,
) -> Set[int]:
    states = {spec.cid: SlotState() for spec in specs}
    for branch in branches:
        for spec in specs:
            states[spec.cid] = states[spec.cid].union(branch.slot(spec.cid))
    decisions = {cid: select(state, score) for cid, state in states.items()}
    return propagate(specs, decisions)


def evaluate_incremental(
    specs: Sequence[ClaimSpec],
    branches: Sequence[Branch],
    score: ScoreFn,
    representation: Representation,
    order: Optional[Sequence[int]] = None,
) -> Set[int]:
    order = list(range(len(branches))) if order is None else list(order)
    states = {spec.cid: branches[order[0]].slot(spec.cid) for spec in specs}
    for index in order[1:]:
        branch = branches[index]
        for spec in specs:
            states[spec.cid] = representation(states[spec.cid].union(branch.slot(spec.cid)), score)
    decisions = {cid: select(state, score) for cid, state in states.items()}
    return propagate(specs, decisions)


# ---------------------------------------------------------------------
# Exhaustive search for a compounded failure
# ---------------------------------------------------------------------

def _branch_options(evidences: Sequence[int]) -> List[Optional[Tuple[str, int]]]:
    options: List[Optional[Tuple[str, int]]] = [None]
    options += [(ASSERT, e) for e in evidences]
    options += [(REFUTE, e) for e in evidences]
    return options


def _all_branches(specs: Sequence[ClaimSpec], evidences: Sequence[int]) -> List[Branch]:
    options = _branch_options(evidences)
    templates = list(product(options, repeat=len(specs)))
    return [
        Branch(
            sid="tmp",
            opinions=frozenset(
                (spec.cid, value, evidence)
                for spec, opinion in zip(specs, combo)
                if opinion is not None
                for value, evidence in [opinion]
            ),
        )
        for combo in templates
    ]


def find_compounded_failures(
    specs: Sequence[ClaimSpec],
    evidences: Sequence[int] = (1, 2),
    n_branches: int = 3,
    score: Optional[ScoreFn] = None,
    representation: Optional[Representation] = None,
    limit: int = 3,
) -> List[Tuple[int, List[Branch], Set[int], Set[int]]]:
    """Return (cost, branches, n_ary_IN, incremental_IN) sorted by cost.

    NOTE: n_branches must be >= 3.  With only two branches the incremental
    fold performs a single union and then optionally re-represents it, which
    cannot change the Decision -- so two branches can *never* exhibit a
    confluence failure.  Any claim about incremental merging therefore
    requires at least three sources.
    """
    from .operators import egalitarian_score, repr_max

    if n_branches < 3:
        raise ValueError("n_branches must be >= 3 for a meaningful confluence test")

    score = score or egalitarian_score
    representation = representation or repr_max

    templates = _all_branches(specs, evidences)
    found: List[Tuple[int, List[Branch], Set[int], Set[int]]] = []

    for combo in product(templates, repeat=n_branches):
        branches = [
            Branch(sid=f"b{i}", opinions=t.opinions) for i, t in enumerate(combo)
        ]
        reference = evaluate_nary(specs, branches, score)
        for order in permutations(range(n_branches)):
            got = evaluate_incremental(specs, branches, score, representation, order)
            if got != reference:
                cost = sum(len(b.opinions) for b in branches)
                found.append((cost, branches, reference, got))
                break

    found.sort(key=lambda row: row[0])
    return found[:limit]


def find_compounded_failures_random(
    specs: Sequence[ClaimSpec],
    evidences: Sequence[int] = (1, 2),
    n_branches: int = 3,
    score: Optional[ScoreFn] = None,
    representation: Optional[Representation] = None,
    samples: int = 200_000,
    seed: int = 20260917,
    limit: int = 2,
) -> List[Tuple[int, List[Branch], Set[int], Set[int]]]:
    """Unbiased random search -- for chains too large to enumerate."""
    import random

    from .operators import egalitarian_score, repr_max

    if n_branches < 3:
        raise ValueError("n_branches must be >= 3")

    score = score or egalitarian_score
    representation = representation or repr_max
    rng = random.Random(seed)
    options = _branch_options(evidences)

    found: List[Tuple[int, List[Branch], Set[int], Set[int]]] = []
    for _ in range(samples):
        branches = [
            Branch(
                sid=f"b{i}",
                opinions=frozenset(
                    (spec.cid, value, evidence)
                    for spec, opinion in zip(specs, rng.choices(options, k=len(specs)))
                    if opinion is not None
                    for value, evidence in [opinion]
                ),
            )
            for i in range(n_branches)
        ]
        reference = evaluate_nary(specs, branches, score)
        for order in permutations(range(n_branches)):
            got = evaluate_incremental(specs, branches, score, representation, order)
            if got != reference:
                cost = sum(len(b.opinions) for b in branches)
                found.append((cost, branches, reference, got))
                break
        if len(found) >= 64:
            break

    found.sort(key=lambda row: row[0])
    return found[:limit]
