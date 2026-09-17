"""Law checks for merge operators: confluence, order-independence, idempotence.

The central law is **confluent associativity**:

    for every permutation p of the branches,
        fold(branches[p], representation) == merge_nary(branches)

If this holds, incremental merging is safe: it does not matter in which
order branches arrive.  If it fails, the merged context depends on the
accident of arrival order -- which is exactly the failure Darwiche & Pearl
(1997) warned about for *iterated* belief revision.
"""

from __future__ import annotations

from itertools import permutations
from typing import List, Optional, Sequence, Tuple

from .model import SlotState
from .operators import Decision, Representation, ScoreFn, merge_incremental, merge_nary


def confluence_violation(
    branches: Sequence[SlotState],
    score: ScoreFn,
    representation: Representation,
) -> Optional[Tuple[Decision, Tuple[int, ...], Decision]]:
    """Return (n_ary_decision, offending_order, got) or None if confluent."""
    _, reference = merge_nary(branches, score)
    for order in permutations(range(len(branches))):
        _, got = merge_incremental([branches[i] for i in order], score, representation)
        if got.key() != reference.key():
            return reference, order, got
    return None


def is_confluent(branches, score, representation) -> bool:
    return confluence_violation(branches, score, representation) is None


def order_dependence(
    branches: Sequence[SlotState],
    score: ScoreFn,
    representation: Representation,
) -> Optional[Tuple[Tuple[int, ...], Decision, Tuple[int, ...], Decision]]:
    """Find two incremental orders that disagree with each other.

    A weaker failure than non-confluence: the orders may all disagree with
    the n-ary merge yet still agree among themselves.
    """
    first: Optional[Tuple[Tuple[int, ...], Decision]] = None
    for order in permutations(range(len(branches))):
        _, got = merge_incremental([branches[i] for i in order], score, representation)
        if first is None:
            first = (order, got)
        elif got.key() != first[1].key():
            return first[0], first[1], order, got
    return None


def is_idempotent(branch: SlotState, score: ScoreFn, representation: Representation) -> bool:
    """merge(A, A) must agree with A alone."""
    _, once = merge_nary([branch], score)
    _, twice = merge_incremental([branch, branch], score, representation)
    return once.key() == twice.key()


def state_is_idempotent(branch: SlotState, representation: Representation, score: ScoreFn) -> bool:
    """Stronger, state-level idempotence: merge(A, A) == A as an annotation."""
    merged = representation(branch.union(branch), score)
    return merged.items == branch.items
