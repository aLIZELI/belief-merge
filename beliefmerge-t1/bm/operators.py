"""Merge operators and (crucially) *representations* of a merged slot.

Proposition P1 asks whether incremental pairwise merging agrees with a
single n-ary merge.  The answer depends entirely on how the merged result
is *represented*, because the representation is what gets re-merged:

  JOIN   retain the full provenance annotation
         -> a join-semilattice: associative, commutative, idempotent
  COUNT  retain the winner plus the multiset of its supporters' evidence
         -> loses the losers, keeps multiplicity
  MAX    retain the winner plus one max evidence level
         -> most lossy: loses multiplicity AND the losers

Two evidence-aggregation scores are contrasted:

  egalitarian  weighted majority (the Dalal-distance minimiser restricted
               to a single slot)
  elitist      lexicographic on the sorted evidence vector
               (Konieczny-Pino Perez's lexicographic merging)
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Dict, Iterable, List, Optional, Sequence, Tuple

from .model import SYNTHETIC_SOURCE, SlotState, Support

WEIGHTS: Dict[int, int] = {1: 1, 2: 2, 3: 4, 4: 8}


def egalitarian_score(supports: Iterable[Support]) -> int:
    """Sum of evidence weights -- weighted majority / Dalal minimiser."""
    return sum(WEIGHTS[e] for _, e in supports)


def elitist_score(supports: Iterable[Support]) -> Tuple[int, ...]:
    """Sorted-descending evidence vector, compared lexicographically."""
    return tuple(sorted((e for _, e in supports), reverse=True))


ScoreFn = Callable[[Iterable[Support]], object]


@dataclass(frozen=True)
class Decision:
    """The observable outcome for one slot."""

    outcome: str  # 'empty' | 'resolved' | 'disputed'
    winner: Optional[str] = None
    tied: Tuple[str, ...] = ()

    def key(self) -> Tuple:
        return (self.outcome, self.winner, self.tied)

    def __str__(self) -> str:
        if self.outcome == "empty":
            return "<empty>"
        if self.outcome == "resolved":
            return str(self.winner)
        return "disputed{" + ",".join(self.tied) + "}"


def select(state: SlotState, score: ScoreFn) -> Decision:
    """Pick the winning value; a genuine tie is DISPUTED, never guessed."""
    per_value = state.per_value()
    if not per_value:
        return Decision("empty")
    scored = {value: score(supports) for value, supports in per_value.items()}
    best = max(scored.values())
    winners = sorted(value for value, s in scored.items() if s == best)
    if len(winners) == 1:
        return Decision("resolved", winners[0])
    return Decision("disputed", None, tuple(winners))


# ---------------------------------------------------------------------
# Representations: what a merged slot looks like when you re-merge it
# ---------------------------------------------------------------------

def repr_join(state: SlotState, score: ScoreFn) -> SlotState:
    """Keep everything -- the information-preserving choice."""
    return state


def repr_count(state: SlotState, score: ScoreFn) -> SlotState:
    """Keep the winner and the multiset of evidence that supported it."""
    decision = select(state, score)
    if decision.outcome == "empty":
        return SlotState()
    per_value = state.per_value()
    keep = (decision.winner,) if decision.outcome == "resolved" else decision.tied
    items = set()
    for value in keep:
        ordered = sorted(per_value[value], key=lambda s: -s[1])
        for index, (_, evidence) in enumerate(ordered):
            items.add((value, f"{SYNTHETIC_SOURCE}:{index}", evidence))
    return SlotState(frozenset(items))


def repr_max(state: SlotState, score: ScoreFn) -> SlotState:
    """Keep the winner and a single max evidence level -- most lossy."""
    decision = select(state, score)
    if decision.outcome == "empty":
        return SlotState()
    per_value = state.per_value()
    keep = (decision.winner,) if decision.outcome == "resolved" else decision.tied
    items = {
        (value, SYNTHETIC_SOURCE, max(e for _, e in per_value[value]))
        for value in keep
    }
    return SlotState(frozenset(items))


Representation = Callable[[SlotState, ScoreFn], SlotState]

REPRESENTATIONS: Dict[str, Representation] = {
    "JOIN": repr_join,
    "COUNT": repr_count,
    "MAX": repr_max,
}

SCORES: Dict[str, ScoreFn] = {
    "egalitarian": egalitarian_score,
    "elitist": elitist_score,
}


# ---------------------------------------------------------------------
# The two merge shapes under test
# ---------------------------------------------------------------------

def merge_nary(branches: Sequence[SlotState], score: ScoreFn) -> Tuple[SlotState, Decision]:
    """Merge every branch at once -- the reference semantics."""
    acc = SlotState()
    for branch in branches:
        acc = acc.union(branch)
    return acc, select(acc, score)


def merge_incremental(
    branches: Sequence[SlotState],
    score: ScoreFn,
    representation: Representation,
) -> Tuple[SlotState, Decision]:
    """Fold branches pairwise, re-representing the accumulator each step."""
    seq: List[SlotState] = list(branches)
    if not seq:
        return SlotState(), Decision("empty")
    acc = seq[0]
    for branch in seq[1:]:
        acc = representation(acc.union(branch), score)
    return acc, select(acc, score)
