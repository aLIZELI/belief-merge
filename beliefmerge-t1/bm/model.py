"""Core data types for the BeliefMerge T1 experiment.

A *slot* is one semantic key -- an aligned equivalence class of claims
(Stage 2 of the architecture collapses many surface claims into one slot).

A slot's state is a set of assertions ``(value, source, evidence)``.

Keeping ``source`` inside the state is the whole point: it is what makes
the annotation a join-semilattice.  ``union`` is then associative,
commutative and idempotent *by construction*, which is exactly the
property Proposition P1 is about.

Drop ``source`` and you can no longer tell "three branches independently
said X" from "one branch said X" -- and that is where associativity dies.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, FrozenSet, Iterable, Set, Tuple

# (source_id, evidence_level)
Support = Tuple[str, int]
# (value, source_id, evidence_level)
Item = Tuple[str, str, int]

# Source id used by lossy representations that synthesise a merged opinion.
SYNTHETIC_SOURCE = "*merged*"


@dataclass(frozen=True)
class SlotState:
    """Provenance-retaining annotation for a single semantic key."""

    items: FrozenSet[Item] = frozenset()

    # -- constructors --------------------------------------------------
    @staticmethod
    def of(*items: Item) -> "SlotState":
        return SlotState(frozenset(items))

    @staticmethod
    def singleton(value: str, source: str, evidence: int) -> "SlotState":
        return SlotState(frozenset({(value, source, evidence)}))

    # -- algebra -------------------------------------------------------
    def union(self, other: "SlotState") -> "SlotState":
        """Join of two annotations. Associative, commutative, idempotent."""
        return SlotState(self.items | other.items)

    # -- reads ---------------------------------------------------------
    def per_value(self) -> Dict[str, Set[Support]]:
        out: Dict[str, Set[Support]] = {}
        for value, source, evidence in self.items:
            out.setdefault(value, set()).add((source, evidence))
        return out

    def values(self) -> Set[str]:
        return {value for value, _, _ in self.items}

    def assertion_count(self) -> int:
        return len(self.items)

    def __bool__(self) -> bool:
        return bool(self.items)

    def __str__(self) -> str:
        if not self.items:
            return "<empty>"
        parts = sorted(f"{v}@{e}({s})" for v, s, e in self.items)
        return "{" + ", ".join(parts) + "}"
