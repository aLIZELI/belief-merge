# Changelog

Notable changes to `dsh-belief-merge`, newest first. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> ### Upgrading from `0.2.0` or older needs an explicit version
>
> While the major version is `0`, a caret range does **not** cross a minor
> version: `^0.2.0` will never resolve to `0.3.x`, and neither would `^0.0.1`
> have reached `0.1.0`. Name the version:
>
> ```sh
> dsh plugin --profile web add dsh-belief-merge@0.3.1
> ```
>
> **Patches are the exception.** `^0.3.0` *does* resolve `0.3.1`, because the
> minor version is unchanged. So this is a one-time step: get onto `0.3.x`
> explicitly, and later patch releases follow on their own.
>
> `0.3.0` is the first release with the tool and the command, so a profile still
> on `^0.2.0` has the merge but no way to configure it from a conversation.
> `0.0.1` additionally predates the `dsh.bundle` manifest and was installed as a
> plain dependency rather than a profile layer.
>
> After installing `0.3.0` or later, restart once. That activates
> `patchReload: live` in the profile, after which source changes no longer need a
> restart.

---

## [0.3.1] — 2026-09-17

Documentation only — **no code changed**, so upgrading from `0.3.0` changes no
behaviour.

### Added

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — the map of the code as built: the
  pipeline stage by stage with its real entry points, the two merge
  representations and which one production uses, the three places a model is
  allowed to act, the degradation ladder, and what is deliberately absent.
- **[CHANGELOG.md](CHANGELOG.md)** — this file.
- **CI** (`.github/workflows/test.yml`) — the suite, the demo and the tight
  benchmark on Node 20 and 22, plus a job that re-runs the 72,760-profile
  confluence enumeration so the headline number is checked rather than trusted.

### Fixed

- `lib/index.js` still declared in its header that the adapter had "NOT been
  exercised inside a live DSH process", long after it had been.
- The README described the injected block as *prepended to the context*. It is
  **appended**: `dsh-session-reference` documents the order as "direct messages
  followed by their session-reference context", and `{ prepend: true }` on
  `ctx.on` is *listener* order, not message position.
- The README's dev-dependency count said two; there are four.

### Changed

- The hand-maintained "tests-242 passing" badge is replaced by the real CI
  badge.
- The original design proposal now carries a banner explaining that its
  M0–M8 numbering is not the plugin's, and that two of its milestones
  (Shapley attribution, a learned merge policy) were never built.

## [0.3.0] — 2026-09-17

Configuring sources no longer requires editing YAML.

### Added

- **`merge_sessions` model tool** (`lib/tools.js`) — actions `list`, `status`,
  `set`, `add`, `remove`, `clear`; parameters `action`, `sessions`, `query`. The
  model can find candidate sessions and turn merging on from a conversation.
- **`/merge` command** — the same operations from the command surface, with
  `find <text>` to filter candidates and selection by exact id, **unique id
  prefix**, or 1-based index. A command result never enters model history.
- **Runtime source-selection layer** (`lib/core/state.js`), persisted at
  `<dsh home>/storages/belief-merge/sources.json` and read per turn. It overrides
  the config default, so a change takes effect on the **next turn** — no YAML
  edit, no restart. `set([])` and `clear()` stay distinct: "merge nothing" versus
  "fall back to the configured default".
- **Candidate discovery** (`lib/core/sessions.js`) — ranking, unique-prefix
  resolution, age and size labels, and titles read through
  `readTitleSnapshots` (`snap.value.title.title`, two levels down).
- **`test/controls.test.js`** — 29 tests covering state precedence, discovery,
  and both control surfaces, including that they cannot disagree.

### Changed

- The control surface is registered **unconditionally**, even with no sources
  configured. A user with nothing configured is exactly the user who needs the
  tool; returning early here was why the plugin could previously only be enabled
  by editing YAML.

### Notes

- The tool and the command share one `run()`, so they write the same state.
- Resolution runs against **all** sessions, not the 20-item page the tool
  displays.

## [0.2.0] — 2026-09-17

### Added

- **Credential redaction** (`lib/core/redact.js`), applied inside
  `flattenSurface` — upstream of both extraction paths and of any prompt.
- A withheld-credential notice at the end of the rendered block, so the fact
  that a secret lives in a source session is surfaced rather than swallowed.
- `test/redact.test.js`, with fixtures assembled at runtime so no credential
  shape is ever committed.

### Security

- **Merging two real sessions produced a claim whose value was a live API key.**
  A context-merge plugin is a credential-distribution mechanism: anything in a
  source conversation gets extracted and injected into every later turn. Worse,
  the alignment stage sends session text to a model API, so the key had already
  left the machine. Redaction now runs before either path sees the text.

### Notes

- Deliberately conservative: provider prefixes (`sk-`, `ghp_`, `AIza`, `AKIA`,
  `hf_`, `npm_`), JWTs, PEM blocks, and an explicit label followed by a value. A
  generic "long random string" rule was **rejected** — it would rewrite commit
  hashes, arXiv ids and file paths, which in a system built on fidelity is a
  correctness bug, not a safety win.

## [0.1.0] — 2026-09-17

### Added

- **`dsh.bundle` manifest + `cordis.patch.yml`**, so the package installs as a
  profile **layer** rather than a plain dependency. Without this,
  `dsh plugin add` reports that the package "declares no dsh.bundle".
- Inert default config (`sources: []`): mounted but injecting nothing. Reading
  other conversations is opt-in.

## [0.0.1] — 2026-09-17

First publication.

### Added

- Provenance-retaining merge core (`lib/core/`): `SlotState` with the full
  per-source claim set, `reprJoin` / `reprCollapse`, evidence-weighted scoring,
  `mergeStreaming`.
- Conflict handling: `DISPUTED` as a first-class outcome, plus the constrained
  adjudicator with the order-reversal symmetry check.
- Trust lattice and invariant I2 (merging may never raise a claim's trust).
- `propagateDerivation` — JTMS label propagation with a trust ceiling.
- Submodular knapsack packing with a cache-aware layout.
- LLM joint alignment with a graceful fallback to the offline heuristic.
- DSH adapter: `sessionQuery` read, `agent/pre-step` injection.
- MergeBench (`bench/`) and an offline demo (`demo.js`).
