"""BeliefMerge T1 experiment package.

Proposition P1
--------------
Let Delta be an n-ary merge operator on a slot annotation, defined as
"union the provenance, then pick the winner by an evidence score".
Claim: whether Delta is *confluent* (incremental pairwise merging agrees
with n-ary merging, for every arrival order) depends on the
*representation* chosen for the merged result -- not on the score.

Environment: Python 3.11+, standard library only.
"""

from .model import SYNTHETIC_SOURCE, SlotState, Support  # noqa: F401
from .operators import (  # noqa: F401
    REPRESENTATIONS,
    SCORES,
    Decision,
    egalitarian_score,
    elitist_score,
    merge_incremental,
    merge_nary,
    repr_count,
    repr_join,
    repr_max,
    select,
)
from .laws import (  # noqa: F401
    confluence_violation,
    is_confluent,
    is_idempotent,
    order_dependence,
    state_is_idempotent,
)
from .search import (  # noqa: F401
    confluence_failure_rate,
    enumerate_profiles,
    find_minimal_counterexamples,
    total_size,
)

__all__ = [
    "SlotState",
    "Support",
    "SYNTHETIC_SOURCE",
    "Decision",
    "select",
    "merge_nary",
    "merge_incremental",
    "repr_join",
    "repr_count",
    "repr_max",
    "REPRESENTATIONS",
    "SCORES",
    "egalitarian_score",
    "elitist_score",
    "confluence_violation",
    "is_confluent",
    "order_dependence",
    "is_idempotent",
    "state_is_idempotent",
    "find_minimal_counterexamples",
    "confluence_failure_rate",
    "enumerate_profiles",
    "total_size",
]
