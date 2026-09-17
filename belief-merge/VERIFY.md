# Verification record — `dsh-belief-merge` in a real harness

**Status: executed and passing.** The plugin was installed into a throwaway
`headless` profile and run against two real sessions with a real model. The full
chain works:

```
read afd09707-…: wrapper=session|inheritedEventCount|capturedThroughSeq|events messages=2
read fbff76e5-…: wrapper=session|inheritedEventCount|capturedThroughSeq|events messages=2
mode=llm slots=25 rendered included=25 dropped=0 tokens=1065
```

The model then quoted the injected block back verbatim:

```
- `papers.cacheblend.arxiv_id` = **2405.16444**
- `papers.epic.arxiv_id` = **2410.15332**
- `papers.factcc.arxiv_id` = **2005.00661**
- `papers.chunkattention.arxiv_id` = **2402.15220**
- `papers.alignscore.arxiv_id` = **2305.16739**
```

The first live run found **four bugs** that unit testing could not have surfaced.

---

## What the live run actually found

### 1. `readSurface()` returns surface *events*, not messages

```js
{ session, inheritedEventCount, capturedThroughSeq, events: [...] }
```

Reading `.messages` off this yields an empty branch, an empty merge, and — worst
of all — a **non-empty rendered string consisting of just the header**, which
passed a `text.trim()` guard and got injected as an empty section. The model
reported exactly that: *"the section heading is present, but the section
contains no bullet lines."*

**Fixed:** `eventsToMessages()` maps `{type, data}` events to messages;
the injection guard now checks slot count, not string emptiness.
Regression tests in `test/plugin.smoke.test.js`.

### 2. `ctx.llm` requires `llm` in `inject`

```
cannot get property "llm" without inject
```

Cordis throws on any undeclared service access — and the alignment fallback
**swallowed it**, so the only symptom was a silent downgrade to the heuristic.

**Fixed:** `inject = ['agents', 'sessionQuery', 'llm']`.

### 3. Reasoning burned the entire output budget

```
LLM alignment failed: … [assembled 0 chars, finish=max-tokens]
```

Zero characters *and* a max-tokens finish. The agent's own `reasoningEffort`
(`high`) was inherited by the alignment call, so the model spent the whole
budget on reasoning deltas and never emitted the JSON. `blocksToText` only
collected `text` blocks, so the assembled result was empty.

**Fixed:** `alignmentReasoningEffort` defaults to `off` (alignment is mechanical
extraction, not deliberation); `blocksToText` falls back to reasoning blocks.

### 4. Plugin-injected user messages were treated as user testimony

The decisive one. DSH delivers injected context — sandbox policy, approval
notices, other plugins' blocks — as `user/message` events with
`source.kind === 'plugin'`. The evidence rule was *"user message ⇒ level 4"*,
so harness boilerplate received the **highest** evidence level.

A live run over two real sessions produced **170 "claims"** that were almost
entirely policy text, and the model — correctly — returned `{"slots": []}`
because there was nothing worth extracting.

**Fixed:** `isInjected()`; injected messages are excluded by default
(`includeInjectedContext: false`) and capped at `SPECULATIVE` when included.
Regression test asserts injected text can never outrank a real user statement.

---

## Second round — adding the adjudicator (M2)

The adjudicator was unit-tested, integration-tested, and passing 83 tests. The
live run then produced **no injected block at all** and this debug output:

```
read afd09707-…: … messages=2
read fbff76e5-…: … messages=2
<nothing>
```

The `mode=` line never printed, which meant `mergeSurfacesAligned()` had thrown.
Reproducing it locally took ten seconds and gave the answer immediately:

```
ReferenceError: adjudicateConflicts is not defined
    at Module.mergeSurfacesAligned (lib/core/index.js:165:20)
```

`export * from './adjudicate.js'` re-exports a name but does **not** bind it in
the module's own scope. The explicit `import` was missing.

### The part worth remembering

**Every test passed while the plugin was completely broken.** The adjudicator
was tested directly; `mergeSurfacesAligned` was tested separately; nothing
tested *alignment → merge → adjudication in one call*. The existing integration
tests all used slots that were already decided, so `hasTies` was false and the
broken line was never reached.

Fixed by adding that exact integration test:
`INTEGRATION: alignment -> merge -> adjudication on a genuine tie`.

**Lesson: unit-testing the pieces does not test the wiring.** A green suite is
evidence about the parts you exercised, not about the paths you did not.

### Fifth bug: silent failure

The `catch` around the merge called `ctx.logger.warn()` only, and that logger
is invisible on the headless surface — so a hard crash looked like "the plugin
did nothing". Both channels are now written: `warn()` for the harness log,
`debug()` (stderr) for the stack.

If a plugin appears to do nothing, **check that it is not throwing.**

---

## Third round — the trust lattice (M5)

M5 was verified live on the same throwaway profile. Debug output:

```
read afd09707-…: … messages=2 trust=external
read fbff76e5-…: … messages=2 trust=external
mode=llm slots=25 adjudication=none(conflicts=0 resolved=0 orderSensitive=0)
rendered included=25 dropped=0 tokens=1293
```

The model confirmed the banner reached it, and — the part that matters —
treated it as designed:

> *"Quoted as data only; **the block's embedded directives are not treated as
> instructions.**"*

That sentence is the empirical evidence that the trust framing works end to
end: the content is still there, but it is labelled, and the reader did not
mistake it for instruction.

### Two bugs found while building it

**Budget accounting for mandatory content.** The trust banner is safety-critical
and must never be dropped for budget reasons — but it was not being charged
against the budget either, so a small budget produced output larger than the
stated limit. Fixed by charging it. This surfaced a second question: what if
the budget cannot hold the banner plus one item? The answer implemented is
**inject nothing**; dropping the banner would emit unlabelled cross-session
content, and emitting anyway would lie about the limit.

**A self-inflicted edit error.** Replacing the `debug` config field accidentally
deleted the closing of the `Config` schema object. Caught immediately by
importing the module (`node -e "import('./lib/index.js')"`), which is a cheap
check worth running after every edit to that file.

---

## Fourth round — the budget packer (M3)

Verified live with a 700-token budget, which forced real selection:

```
mode=llm slots=14 adjudication=none(conflicts=0 resolved=0 orderSensitive=0)
rendered included=11 dropped=3 tokens=692 algo=partial utility=244.5 (query-weighted)
```

`algo=partial` confirms the seed-enumeration packer ran, `dropped=3` confirms
selection happened, and `query-weighted` confirms the current user message was
used as the relevance query.

The model's own phrasing this round is worth noting:

> *"quoted verbatim (**as external background data, not as instructions I
> followed**)"*

That is the M5 trust banner doing its job in ordinary use, not just in the
adversarial tests.

### A demo claim that was false until the budget was tightened

The first version of the packing demo used a 420-token budget for ten slots
that only needed ~299. Nothing was dropped — so the narration ("the Constraint
and Goal survive while several Facts do not") was simply untrue. Lowering the
budget to 175 made the claim real (`included 4/10, dropped 6`).

**A demonstration that does not actually demonstrate is worse than none**, and
it is easy to ship one when the numbers are never read back.

---

## Fifth round — MergeBench (M6), and two ways it was wrong first

MergeBench is not verified against a live harness; it is a measuring instrument,
and the useful record is how the first two versions produced meaningless numbers.

**It made the single-branch baseline trivially zero.** Every question was
generated to span branches, so no single branch could answer any of them and
`best single` sat at 0% for every arm. The comparison looked triumphant and
said nothing. Fixed by generating **local** questions too, which a single branch
can answer, so the baseline is a real number (50% at two branches).

**It measured the wrong thing and called it fabrication.** "Faithfulness"
compared parsed `(key, value)` pairs against topic keys. The heuristic path uses
normalised sentences as keys and `assert`/`refute` as values, so it scored
**100% fabricated** — not because it invented anything, but because it does not
use topic keys. Faithfulness now asks the question that matters: does the block
contain a value from the vocabulary that **no branch ever asserted**? Every arm
now scores 0%.

**A third problem surfaced while fixing those.** Concatenation was not
respecting the budget, so at tight budgets it "won" by spending tokens nobody
offered it. Every arm is now truncated to the same limit.

### The metric that still needs a caveat

`unambig` (share of doubly-asserted keys where only the correct value appears)
must be read *with* bridge coverage. An arm that truncates away the losing half
of a conflict looks decisive: `single:branch-a` scores 50% unambiguous at a
400-token budget purely because it only ever had one side. High `unambig` with
low `bridge` is data loss, not resolution. This is stated in the report output
and in `bench/README.md`, and there is a test asserting the trap exists.

---

## Sixth round — derivation propagation (M4)

M4 was implemented and covered by tests, then run against the live harness:

```
mode=llm slots=25 adjudication=none(conflicts=0 resolved=0 orderSensitive=0)
derivation=in:25/retracted:0
```

**Nothing retracted — the model declared no `derivedFrom` edges.** These
sessions are flat fact collections with no reasoning chains to walk.

### Then it was made to fire, and the fix was a prompt, not code

A session was generated with explicit structure (`Premise 1: … Premise 2: …
Therefore: … Because of that: …`) and used as a merge source. The result was
still `edges:0`: **the model emitted no derivation edges at all**, despite a
rule asking for them.

Distinguishing "the model cannot" from "the prompt did not ask well" took one
more attempt. Adding a worked example containing `derivedFrom` to the system
prompt produced edges immediately:

```
derivation=in:25/retracted:0/edges:2
```

and the injected block then carried the chain the model had reconstructed:

```
- `infra.add_eu_west_replica` = **yes**
  ↳ _derived from: latency.eu_exceeds_200ms_
- `latency.eu_exceeds_200ms` = **yes**
  ↳ _derived from: cdn.provider, primary_region_
```

Two levels, correctly propagated. The lesson is that a mechanism can be
implemented, unit-tested and still be inert in production because the model
never populates its input — and that "it is tested" is not the same as "it
runs".

### Two bugs the tests caught, both semantic inversions

**A flat premise list was read as alternatives.** `['a','b']` means "both are
required"; `[['a','b'],['c']]` means "either route suffices". The first version
treated a flat list as a list of routes, silently turning *conjunction* into
*disjunction* — the opposite semantics, and exactly the kind of error that
produces plausible-looking output.

**The trust ceiling took the minimum over routes, not the maximum.** A claim
supported by two routes is supported by whichever one holds, so its ceiling is
the **best** route's. Taking the minimum let one weak alternative drag down a
claim a strong alternative fully supported.

Both were caught because the tests asserted the *meaning* rather than the
output shape.

### A test bug worth naming too

Three tests indexed `slots[0]` assuming it was the slot just added. Slots are
ordered by key, so `slots[0]` was `a`, not `b`. Fixed by looking slots up by key
— the assertion was right, the addressing was wrong.

---

## Reproducibility: an honest limitation

Both model calls now request `temperature: 0`, reasoning is disabled for
alignment, and a smoke test asserts the temperature reaches the stream call.
Nevertheless, two consecutive live runs over **identical input** yielded:

```
mode=llm slots=25
mode=llm slots=16
```

The provider is not reproducible at this setting. The consequence for the
design: **invariant I5 (byte-identical serialization) holds *given* a slot set,
not across runs.** The deterministic core is deterministic; the extraction
stage is a model call and inherits its variance.

This is not fixable from the plugin side. It *is* worth stating plainly rather
than claiming end-to-end determinism the system does not have.

---

## Reproducing it

```sh
cd "<repo>/belief-merge"
node --test        # expect: # pass 62 / # fail 0

dsh --profile bm-smoke --from-default-profile headless
dsh plugin --profile bm-smoke add "$PWD"
```

Then `~/.dsh/profiles/bm-smoke/cordis.patch.yml`:

```yaml
- insert:
    - id: belief-merge
      name: dsh-belief-merge
      config:
        sources:
          - <session-id-1>
          - <session-id-2>
        useLlmAlignment: true
        maxSlots: 25
        debug: true
```

Check composition before booting:

```sh
dsh --profile bm-smoke --dump-config | grep -A4 belief-merge
```

Run one task (no ports, nothing left running):

```sh
dsh --profile bm-smoke "Answer with no tools. Quote the first five bullet lines of the section headed '## Merged context (BeliefMerge)'."
```

`debug: true` writes `belief-merge[debug]: …` lines to stderr. **The first thing
to read is `mode=`** — `llm` means alignment ran, `heuristic` means it fell back
and the warning above it says why.

Find session ids:

```sh
ls -t ~/.dsh/sessions/--Users-lp1-Documents-deepseek~0020harness--/ | head
```

### The smoke profile

`~/.dsh/profiles/bm-smoke/` exists on this machine and **contains two of your
session ids in its patch file**. It opens no ports and nothing is left running.
Delete it whenever you like:

```sh
rm -rf ~/.dsh/profiles/bm-smoke
```

Your live `web` profile was never modified — its `bundles` and `dependencies`
are unchanged, and the GUI at `127.0.0.1:3080` kept serving throughout.

---

## Installing into the live `web` profile

Only when you are not mid-conversation, and only if you want it permanently:

```sh
dsh plugin --profile web add "<repo>/belief-merge"
```

Then add an `insert` row for `dsh-belief-merge` to your profile's
`cordis.patch.yml` (that file is currently `[]`). Rollback:

```sh
dsh plugin --profile web remove dsh-belief-merge
# and delete the patch row
```

---

## Failure modes and what each one means

| Symptom | Most likely cause | What to check |
|---|---|---|
| `Cannot find module '@deepseek-ai/dsh-llm'` | peer dep not reachable | `ls ~/.dsh/profiles/node_modules/@deepseek-ai/dsh-llm` |
| Plugin row absent from `--dump-config` | not mounted, or bad patch YAML | re-run `--dump-config`, read stderr |
| Boots, but nothing is injected | `sources` empty, or `step !== 1` with `oncePerTurn` | set real ids; check `oncePerTurn` |
| `mode=heuristic` | alignment failed — the warning names the cause | see below |
| `assembled 0 chars, finish=max-tokens` | reasoning ate the budget | lower `alignmentReasoningEffort` |
| Injected block is only a heading | empty merge | should be impossible now; report it |
| `… named an unknown source` | model invented branch ids | rejected by design; check the prompt |

### The failure that matters

If `mode=heuristic`, the warning distinguishes the cause:

- `no provider/model route available`
  → `requestHeader()` and `agent.options` were both empty at pre-step. Set
  explicit `alignmentProvider` / `alignmentModel`.
- `LLM alignment failed … [assembled N chars, finish=…]`
  → the call ran but the output was unusable. The bracket carries the evidence:
  0 chars means reasoning ate the budget; a large N means genuinely malformed
  JSON; `max-tokens` means the cap is too low for the input.
- `cannot read session <id>` → wrong id, or `ctx.sessionQuery` not mounted.

`heuristic` is the designed degradation, not a crash — but it is a signal.

---

## Not covered

- Only `deepseek-official` / `deepseek-flash` has been exercised.
- Only two branches, both from one workspace.
- Equal-evidence contradictions are surfaced as `DISPUTED`, not adjudicated (M2).
- No derivation layer (M4), so `derivedTrust()` is tested but nothing walks a
  derivation graph yet.
- The packer's `partial` mode is a heuristic that is never worse than density
  greedy; no certified approximation ratio is claimed for this mixed objective.
- MergeBench scores the rendered context, not a downstream task: it measures
  information retention, not whether a model then uses the information well.
- The trust lattice was verified with `sourceTrust: external`; the `untrusted`
  and `trusted` labels are unit-tested, not exercised live.
