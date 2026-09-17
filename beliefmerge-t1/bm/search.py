"""Exhaustive search for the smallest counterexamples to confluence.

The search space is deliberately tiny and fully enumerable:

  * a slot has a small alphabet of values
  * each branch may assert at most one evidence level per value
    (a branch holding two levels for the same value is meaningless)
  * n_branches branches, all permutations checked

Because the space is exhaustive, a *negative* result (no counterexample
under representation R) is meaningful evidence, and a *positive* result
comes with a concrete, minimal, reproducible witness.
"""

from __future__ import annotations

from itertools import product
from typing import Dict, Iterator, List, Optional, Sequence, Tuple

from .laws import confluence_violation
from .model import SlotState
from .operators import Representation, ScoreFn


def branch_templates(
    values: Sequence[str],
    evidences: Sequence[int],
    well_formed: bool = False,
) -> Iterator[Dict[str, int]]:
    """Every way a single branch can opine on a single slot.

    well_formed=False  a branch may assert *several different values* for the
                       same slot (a self-contradictory branch)
    well_formed=True   a branch holds at most ONE opinion for the slot --
                       the realistic case, since a single conversation
                       branch does not assert ``located_in=NYC`` and
                       ``located_in=SF`` at the same semantic key
    """
    if well_formed:
        yield {}
        for value in values:
            for evidence in evidences:
                yield {value: evidence}
        return
    options: List[Optional[int]] = [None] + list(evidences)
    for combo in product(options, repeat=len(values)):
        yield {v: e for v, e in zip(values, combo) if e is not None}


def instantiate(template: Dict[str, int], source: str) -> SlotState:
    return SlotState(frozenset((v, source, e) for v, e in template.items()))


def enumerate_profiles(
    values: Sequence[str],
    evidences: Sequence[int],
    n_branches: int,
    well_formed: bool = False,
) -> Iterator[List[SlotState]]:
    templates = list(branch_templates(values, evidences, well_formed))
    for combo in product(templates, repeat=n_branches):
        yield [instantiate(t, f"b{i}") for i, t in enumerate(combo)]


def total_size(branches: Sequence[SlotState]) -> int:
    return sum(b.assertion_count() for b in branches)


def find_minimal_counterexamples(
    values: Sequence[str],
    evidences: Sequence[int],
    n_branches: int,
    score: ScoreFn,
    representation: Representation,
    limit: int = 3,
    max_size: Optional[int] = None,
    well_formed: bool = False,
) -> List[Tuple[int, List[SlotState], tuple]]:
    """All counterexamples, sorted by total number of assertions."""
    found: List[Tuple[int, List[SlotState], tuple]] = []
    for branches in enumerate_profiles(values, evidences, n_branches, well_formed):
        size = total_size(branches)
        if max_size is not None and size > max_size:
            continue
        violation = confluence_violation(branches, score, representation)
        if violation is not None:
            found.append((size, branches, violation))
    found.sort(key=lambda row: row[0])
    return found[:limit]


def confluence_failure_rate(
    values: Sequence[str],
    evidences: Sequence[int],
    n_branches: int,
    score: ScoreFn,
    representation: Representation,
    cap: Optional[int] = None,
    well_formed: bool = False,
) -> Tuple[int, int]:
    """(failures, total) over the enumerated space."""
    failures = 0
    total = 0
    for branches in enumerate_profiles(values, evidences, n_branches, well_formed):
        total += 1
        if confluence_violation(branches, score, representation) is not None:
            failures += 1
        if cap is not None and total >= cap:
            break
    return failures, total
