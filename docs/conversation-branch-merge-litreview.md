# Literature Review — Merging / Fusing Multiple LLM Conversation Branches into One Conflict-Resolved Context

Scope: algorithms for fusing N divergent conversation branches (context, memory, knowledge, reasoning traces) into a single coherent context a new session can continue from.

Verification policy: every entry below was checked by fetching the arXiv abstract page and reading its `citation_title` metadata, or (for pre-arXiv classics) is a standard, widely indexed reference. Metadata was collected **2026-09-17**. Items I could not verify are quarantined in §8 rather than mixed into the body.

---

## 1. Context compression & distillation

**Verified:**
- **Learning to Compress Prompts with Gist Tokens** (Mu, Li, Goodman — NeurIPS 2023) — arXiv:2304.08467 — https://arxiv.org/abs/2304.08467 — train the LM to map a prompt to a few "gist" soft tokens by instruction tuning, so the prompt is replaced by K cached activations.
- **Adapting Language Models to Compress Contexts** (AutoCompressor; Chevalier, Wettig, Ajith et al. — EMNLP 2023) — arXiv:2305.14788 — https://arxiv.org/abs/2305.14788 — recursively summarize arbitrary-length context into ~50 summary vectors that condition generation.
- **In-context Autoencoder for Context Compression in a Large Language Model** (ICAE; Ge, Hu, Wang et al. — ICLR 2024) — arXiv:2307.06945 — https://arxiv.org/abs/2307.06945 — a learned encoder compresses context to memory slots; the frozen LLM is LoRA-tuned to consume them.
- **LLMLingua: Compressing Prompts for Accelerated Inference of LLMs** (Jiang, Wu, Lin et al. — EMNLP 2023) — arXiv:2310.05736 — https://arxiv.org/abs/2310.05736 — coarse-to-fine budget-controlled token dropping using a small LM's perplexity.
- **LongLLMLingua: Accelerating and Enhancing LLMs in Long Context Scenarios via Prompt Compression** (Jiang, Wu, Luo et al. — ACL 2024) — arXiv:2310.06839 — https://arxiv.org/abs/2310.06839 — question-aware, position-aware compression for long contexts.
- **LLMLingua-2: Data Distillation for Efficient and Faithful Task-Agnostic Prompt Compression** (Pan, Wu, Jiang et al. — ACL Findings 2024) — arXiv:2403.12968 — https://arxiv.org/abs/2403.12968 — reframes compression as token classification trained by distillation from GPT-4, improving faithfulness.
- **xRAG: Extreme Context Compression for Retrieval-augmented Generation with One Token** (Cheng, Wang, Zhang et al. — NeurIPS 2024) — arXiv:2405.13792 — https://arxiv.org/abs/2405.13792 — project a document's dense embedding into the LM's token-embedding space so retrieval and compression become one token.

**Lossy vs. faithful.** Hard token-dropping families (LLMLingua/LongLLMLingua/LLMLingua-2) are *extractive and lossy*: they preserve the surface form of surviving spans, which is why they retain some reasoning structure, but information-theoretically discard tokens. Soft-prompt families (Gist, AutoCompressor, ICAE, xRAG) are *abstractive and lossy in an uninterpretable way*: the compressed state is a dense vector, not human-readable, cannot be audited, and degrades badly under multi-hop/arithmetic reasoning because intermediate steps need many exact tokens. xRAG is the most extreme (one token) and correspondingly the least faithful. **No compression paper I found claims to preserve a *reasoning trace* as opposed to facts/answers**; the faithfulness evaluations are QA/accuracy-based. This is a real gap.

**Verified-adjacent (found via search, ID not individually confirmed):** RECOMP, TCRA-LLM, 500xCompressor, Activation Beacon, AutoCompressor follow-ups, and one or more 2025 prompt-compression surveys. Treat as unverified for citation.

**Unsolved:** (a) auditable compression that preserves *derivational* content (which premise supported which conclusion); (b) compression that is *mergeable* — all these methods compress one context linearly, none defines how two compressed states combine; (c) a faithfulness metric for reasoning chains, not answers.

---

## 2. LLM agent memory & consolidation

**Verified:**
- **MemGPT: Towards LLMs as Operating Systems** (Packer, Wooders, Lin et al. — 2023) — arXiv:2310.08560 — https://arxiv.org/abs/2310.08560 — OS-style paging between main context and external memory, with self-directed edits (the Letta lineage).
- **Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory** (Chhikara, Khant, Aryan et al. — 2025) — arXiv:2504.19413 — https://arxiv.org/abs/2504.19413 — LLM-extracted facts ADD/UPDATE/DELETE against an existing store; graph variant Mem0^g.
- **A-MEM: Agentic Memory for LLM Agents** (Xu, Liang, Mei et al. — 2025) — arXiv:2502.12110 — https://arxiv.org/abs/2502.12110 — Zettelkasten-style atomic notes with LLM-generated links, evolving on new evidence.
- **Zep: A Temporal Knowledge Graph Architecture for Agent Memory** (Rasmussen, Paliychuk, Beauvais et al. — 2025) — arXiv:2501.13956 — https://arxiv.org/abs/2501.13956 — bi-temporal Graphiti graph; invalidates superseded facts by edge validity intervals rather than deleting (the closest thing to principled conflict handling in agent memory).
- **HippoRAG: Neurobiologically Inspired Long-Term Memory for Large Language Models** (Gutiérrez, Shu, Gu et al. — NeurIPS 2024) — arXiv:2405.14831 — https://arxiv.org/abs/2405.14831 — personalized-PageRank traversal over an LLM-built KG for multi-hop recall.
- **Generative Agents: Interactive Simulacra of Human Behavior** (Park, O'Brien, Cai et al. — UIST 2023) — arXiv:2304.03442 — https://arxiv.org/abs/2304.03442 — memory stream + periodic *reflection* (synthesizing higher-level beliefs) + retrieval scored by recency × importance × relevance.
- **LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory** (Wu, Wang, Yu et al. — ICLR 2025) — arXiv:2410.10813 — https://arxiv.org/abs/2410.10813 — 500 questions over long histories; tests information extraction, multi-session reasoning, temporal reasoning, knowledge updates, abstention.
- **Evaluating Very Long-Term Conversational Memory of LLM Agents** (LoCoMo; Maharana, Lee, Tulyakov et al. — ACL 2024) — arXiv:2402.17753 — https://arxiv.org/abs/2402.17753 — very long multi-session dialogues with event graphs and a memory-consistency metric.
- **MemOS: An Operating System for Memory-Augmented Generation (MAG) in Large Language Models** (Li, Song, Wang et al. — 2025) — arXiv:2505.22101 — https://arxiv.org/abs/2505.22101 — memories as first-class schedulable "MemCubes" with lifecycle and governance.
- **MIRIX: Multi-Agent Memory System for LLM-Based Agents** (Wang, Chen — 2025) — arXiv:2507.07957 — https://arxiv.org/abs/2507.07957 — six typed memory components coordinated by multiple agents.
- **Collaborative Memory: Multi-User Memory Sharing in LLM Agents with Dynamic Access Control** (Rezazadeh, Li, Lou et al. — 2025) — arXiv:2505.18279 — https://arxiv.org/abs/2505.18279 — **shared memory across users/agents with asymmetric read/write permission, provenance-aware retrieval, and explicit conflict handling.** This is the closest existing prior art to "merging memories from separate actors."

**Sleep-time compute / consolidation.** "Sleep-time compute" (Snell et al. 2025) is real but I could not confirm its arXiv ID before hitting API rate limits → §8. The cognitive-science basis (McClelland, McNaughton & O'Reilly 1995, *Psychological Review*; Kumaran, Hassabis & McClelland 2016, *Trends in Cognitive Sciences*) is standard and explains *why* offline consolidation should help, but no paper I found applies it to merging two branches.

**Unsolved:** all of these construct *one* memory stream. None defines an algebraic merge of two independently grown stores; update semantics are destructive (Mem0's UPDATE/DELETE) or interval-based (Zep) within one timeline, with no notion of two timelines that disagree.

---

## 3. Merging multiple sources / answers

**Verified / standard:**
- **LLM-Blender: Ensembling Large Language Models with Pairwise Ranking and Generative Fusion** (Jiang, Ren, Lin — ACL 2023) — arXiv:2306.02561 — https://arxiv.org/abs/2306.02561 — PairRanker does pairwise comparison across candidate outputs; GenFuser conditions on the top-k candidates to generate a fused answer.
- **Mixture-of-Agents Enhances Large Language Model Capabilities** (Wang, Wang, Athiwaratkun et al. — 2024) — arXiv:2406.04692 — https://arxiv.org/abs/2406.04692 — layered proposer/aggregator: each layer's LLM sees all previous-layer outputs and synthesizes.
- **RAG-Fusion: a New Take on Retrieval-Augmented Generation** (Rackauckas — 2024) — arXiv:2402.03367 — https://arxiv.org/abs/2402.03367 — query rewriting + reciprocal rank fusion over retrieved doc lists. (Unrefereed preprint.)
- Self-consistency (Wang et al. 2022, arXiv:2203.11171), LLM-as-a-judge / MT-Bench (Zheng et al. 2023, arXiv:2306.05685), multi-agent debate (Du et al. 2023, arXiv:2305.14325), Self-Refine (Madaan et al. 2023, arXiv:2303.17651) — standard, listed in §8 pending per-ID confirmation.

**CONFIRMED (the claim in the brief holds).** The entire answer-merging literature merges **multiple candidate responses to a single query/prompt with a shared history**. The merged objects are *outputs*; the input context is common. There is no notion of two divergent histories, no reconciliation of contradictory *premises*, and no requirement that the merged artifact be a valid *context* a future turn can continue from. GenFuser emits a final answer, not a resumable state. Reciprocal rank fusion merges *rankings of documents*, not beliefs. Self-consistency marginalizes over sampled answers. **So: these techniques are reusable as the "conflict adjudication" subroutine, but they do not solve conversation merge.**

---

## 4. Classical foundations that could be repurposed (most important section)

All entries below were verified against Crossref, OpenAlex, HAL/INRIA, proceedings pages, or arXiv `citation_*` metadata (see `refcheck/verified-references.md` for the raw fact-check). DOIs are given where they exist; the pre-arXiv classics have no arXiv ID.

**4.1 Belief revision & iterated revision**
- **On the Logic of Theory Change: Partial Meet Contraction and Revision Functions** (Alchourrón, Gärdenfors, Makinson — *Journal of Symbolic Logic* 50(2):510–530, 1985) — DOI:10.2307/2274239 — https://doi.org/10.2307/2274239 — the AGM postulates; revision = contraction + expansion, with Levi identity and the epistemic-entrenchment/partial-meet constructions. The canonical correctness criteria any "merge operator" should be measured against.
- **Propositional Knowledge Base Revision and Minimal Change** (Katsuno & Mendelzon — *Artificial Intelligence* 52(3):263–294, 1991) — DOI:10.1016/0004-3702(91)90069-V — https://doi.org/10.1016/0004-3702(91)90069-V — KM postulates; revision as minimal model change via preorders over interpretations.
- **On the Logic of Iterated Belief Revision** (Darwiche & Pearl — *Artificial Intelligence* 89(1–2):1–29, 1997) — DOI:10.1016/S0004-3702(96)00038-0 — https://doi.org/10.1016/S0004-3702(96)00038-0 — shows AGM's postulates are too weak for *sequences* of revisions; introduces the "principle of irrelevance" (postulates C1–C4). **This is the key warning for conversation merge: a merge that is correct once may be unstable under repeated merging of further branches.**
- **Iterated Belief Change Based on Epistemic Entrenchment** (Nayak — *Erkenntnis* 41, 1994) — DOI:10.1007/BF01130759 — iterated revision driven by entrenchment orderings.
- **Dynamic Belief Revision Operators** (Nayak, Pagnucco, Peppas — *Artificial Intelligence* 146(2):193–228, 2003) — DOI:10.1016/S0004-3702(03)00017-1.
- **Iterated Belief Revision, Revised** (Jin & Thielscher — *Artificial Intelligence* 171(1):1–18, 2007) — DOI:10.1016/j.artint.2006.11.002 — replaces the DP postulates with a semantically justified set (lexicographic revision).
- **Admissible and Restrained Revision** (Booth & Meyer — *JAIR* 26:127–151, 2006) — DOI:10.1613/jair.1874 — restrained revision satisfies DP while staying admissible.
- **Investigations into a Theory of Knowledge Base Revision: Preliminary Report** (Dalal — AAAI 1988, pp. 475–479) — https://openalex.org/W2160579271 — Dalal distance = number of differing atoms between models; minimal-distance revision.
- **Nonmonotonic Reasoning by Minimal Belief Revision** (Satoh — FGCS 1988) — https://openalex.org/W68974267 — nonmonotonic consequence as set-inclusion-minimal belief change.
- **Merging Information Under Constraints: A Logical Framework** (Konieczny & Pino Pérez — *Journal of Logic and Computation* 12(5):773–808, 2002) — DOI:10.1093/logcom/12.5.773 — https://doi.org/10.1093/logcom/12.5.773 — belief *merging* operators for a *set* of possibly conflicting belief bases, with integrity-constraint postulates and a family of operators (majority, arbitration, egalitarian). **Directly the right formal target for N branches.**
- **On the Logic of Merging** (Konieczny & Pino Pérez — KR 1998, pp. 488–498) — https://openalex.org/W163597783 — the conference origin of the above; first logical characterization of merging via syncretic/arbitration assignments.
- Recent: **Collective Belief Revision** (Aravanis — *JAIR* 78:1221–1247, 2023) — DOI:10.1613/jair.1.15745 — AGM-style revision for *groups* of agents; relevant if a branch is itself a set of actors.

**4.2 Truth maintenance systems (TMS/ATMS)**
- **A Truth Maintenance System** (Doyle — *Artificial Intelligence* 12(3):231–272, 1979) — DOI:10.1016/0004-3702(79)90008-0 — justification-based TMS: every belief carries a justification (antecedents + label), enabling retraction-with-propagation.
- **Truth Maintenance Systems for Problem Solving** (Doyle — MIT AI Lab TR-419, 1977) — https://openalex.org/W1488207627 — precursor report introducing dependency-directed belief maintenance.
- **An Assumption-Based TMS** (de Kleer — *Artificial Intelligence* 28(2):127–162, 1986) — DOI:10.1016/0004-3702(86)90080-9 — and **Extending the ATMS** (de Kleer — *Artificial Intelligence* 28(2):163–196, 1986) — DOI:10.1016/0004-3702(86)90081-0 — maintain *all* consistent assumption environments (labels and nogoods), so context-dependent truth is a first-class object. **This is the natural data structure for provenance-typed reasoning: each branch becomes an assumption set, each claim an environment-labeled node.**
- **Foundations of Assumption-Based TMS: Preliminary Report** (Reiter & de Kleer — AAAI 1987) — https://openalex.org/W145128706 — logical foundations for the ATMS.
- **An Outlook on Truth Maintenance** (McAllester — MIT AI Memo 551, 1980) — http://hdl.handle.net/1721.1/6327 — truth maintenance as dependency-directed reasoning.
- **Building Problem Solvers** (Forbus & de Kleer — MIT Press, 1993, ISBN 9780262528153) — https://mitpress.mit.edu/9780262528153/building-problem-solvers/ — the consolidated TMS/ATMS engineering reference. *(Existence confirmed via MIT Press ISBN and library catalogue records; the publisher landing page was not fetchable from the verification sandbox.)*

**4.3 Non-monotonic & defeasible reasoning**
- **A Logic for Default Reasoning** (Reiter — *Artificial Intelligence* 13(1–2):81–132, 1980) — DOI:10.1016/0004-3702(80)90014-4 — default rules with consistency constraints; canonical formalization of "normally true unless defeated."
- **Circumscription — A Form of Non-Monotonic Reasoning** (McCarthy — *Artificial Intelligence* 13(1–2):27–39, 1980) — DOI:10.1016/0004-3702(80)90011-9 — minimize abnormal/unknown predicate extensions.
- **Defeasible Logic** (Nute — *Handbook of Logic in AI and Logic Programming*, Vol. 3, OUP, pp. 353–395, 1994) — DOI:10.1093/oso/9780198537472.003.0007 — strict + defeasible rules with a superiority relation.
- **Defeasible Reasoning** (Pollock — *Cognitive Science* 11(4):481–518, 1987) — DOI:10.1207/s15516709cog1104_4 — defeasible reasons plus rebutting and *undercutting* defeaters (OSCAR).
- **Nonmonotonic Reasoning: An Overview** (Brewka, Dix, Konolige — CSLI Lecture Notes 73, **1997**) — https://openalex.org/W1569596742 — survey text. *(Note: 1997, not 2008.)*
- **On the Acceptability of Arguments and its Fundamental Role in Nonmonotonic Reasoning, Logic Programming and n-Person Games** (Dung — *Artificial Intelligence* 77(2):321–357, 1995) — DOI:10.1016/0004-3702(94)00041-X — abstract argumentation frameworks: conflicts resolved by admissible/grounded/stable extensions. **Clean substrate for "two branches disagree → which claims survive."**
- Recent: **On the Acceptability of Arguments … : 25 Years Later** (Baroni, Toni, Verheij — *Argument & Computation* 11(1–2):1–14, 2020) — DOI:10.3233/AAC-200901 — retrospective on Dung-style argumentation.

**4.4 Paraconsistent logic**
- **A Useful Four-Valued Logic** (Belnap — in *Modern Uses of Multiple-Valued Logic*, pp. 5–37, 1977) — DOI:10.1007/978-94-010-1161-7_2 — truth values {T, F, Both, Neither} on a bilattice; contradiction is representable without explosion. **The right semantics if the merged context must tolerate (rather than resolve) a residual contradiction.**
- **The Logic of Paradox** (Priest — *Journal of Philosophical Logic* 8(1):219–241, 1979) — DOI:10.1007/BF00258428 — LP with truth-value gluts.
- **On the Theory of Inconsistent Formal Systems** (da Costa — *Notre Dame Journal of Formal Logic* 15(4):497–510, 1974) — DOI:10.1305/ndjfl/1093891487 — the paraconsistent hierarchy C_n.
- **The Paraconsistent Logics PJ** (da Costa, Subrahmanian, Vago — *Mathematical Logic Quarterly* 37(9–12):139–148, 1991) — DOI:10.1002/malq.19910370903 — annotated paraconsistent logic for inconsistent KBs.
- **Introduction to Annotated Logics** (Abe, Akama, Nakamatsu — Springer, 2015) — DOI:10.1007/978-3-319-17912-4 — book on annotated logics.
- **A Survey of Inconsistency-Adaptive Logics** (Batens — in *Frontiers of Paraconsistent Logic*, pp. 49–73, 2000) — https://users.ugent.be/~dbatens/publ/A2000D_surv-ial.pdf — adaptive logics treating inconsistency as an abnormality to be localized.

**4.5 CRDTs and operational transformation**
- **Conflict-Free Replicated Data Types** (Shapiro, Preguiça, Baquero, Zawirski — SSS 2011, LNCS 6976:386–400) — DOI:10.1007/978-3-642-24550-3_29 — CvRDT/op-based CRDTs converging without coordination. Tech-report version: INRIA RR-7687, https://inria.hal.science/inria-00609399v2
- **A Comprehensive Study of Convergent and Commutative Replicated Data Types** (same authors — INRIA **RR-7506**, 2011) — https://inria.hal.science/inria-00555588v1 — the catalogue of CRDTs with convergence proofs. *(Note: RR-7506, not RR-7687 — that is the identically-titled SSS paper's tech report.)*
- **Concurrency Control in Groupware Systems** (Ellis & Gibbs — SIGMOD 1989, pp. 399–407) — DOI:10.1145/67544.66963 — introduces operational transformation (dOPT).
- **Operational Transformation in Real-Time Group Editors: Issues, Algorithms, and Achievements** (Sun & Ellis — CSCW 1998, pp. 59–68) — DOI:10.1145/289444.289469 — the OT correctness conditions TP1/TP2 and their failure modes; directly analogous to "merge function must be confluent."
- **A Conflict-Free Replicated JSON Datatype** (Kleppmann & Beresford — *IEEE TPDS* 28(10):2733–2746, 2017) — DOI:10.1109/TPDS.2017.2697382 — CRDT semantics for nested, ordered, unstructured text — the closest CRDT analogue to a conversation transcript (this is the datatype behind Automerge).
- **OpSets: Sequential Specifications for Replicated Datatypes (Extended Version)** (Kleppmann, Gomes, Mulligan, Beresford — 2018) — arXiv:1805.04263 — https://arxiv.org/abs/1805.04263 — declarative specification language for CRDT semantics, with machine-checked proofs.
- **Mergeable Replicated Data Types** (Kaki, Priya, Sivaramakrishnan, Jagannathan — OOPSLA 2019, PACMPL 3:154) — DOI:10.1145/3360580 — user-supplied **three-way merge** functions under typed commutativity conditions — a *state-merge* rather than op-merge framing, exactly the "two branches" shape.
- **Delta State Replicated Data Types** (Almeida, Shoker, Baquero — *JPDC* 111:162–173, 2018) — DOI:10.1016/j.jpdc.2017.08.003 — δ-CRDTs: merge small deltas instead of full state.
- Recent: **Certified Mergeable Replicated Data Types** (Soundarapandian et al. — PLDI 2022, pp. 332–347) — DOI:10.1145/3519939.3523735 — machine-checked merge laws.
- Recent: **A Highly-Available Move Operation for Replicated Trees** (Kleppmann et al. — *IEEE TPDS* 33(7):1711–1724, 2022) — DOI:10.1109/TPDS.2021.3118603 — correct *move* in tree CRDTs; relevant because branch merge entails tree restructuring.

**4.6 Version control / program-analysis merge**
- **A Formal Investigation of Diff3** (Khanna, Kunal, Pierce — FSTTCS 2007, LNCS 4855:485–496) — DOI:10.1007/978-3-540-77050-3_40 — first rigorous semantics of three-way merge; shows diff3 is ill-defined and non-optimal and can silently produce wrong output.
- **Integrating Noninterfering Versions of Programs** (Horwitz, Prins, Reps — *ACM TOPLAS* 11(3):345–387, 1989) — DOI:10.1145/65979.65980 — semantic (not textual) merge via program dependence graphs; the origin of "semantic merge" (POPL'88 precursor: DOI:10.1145/73560.73572).
- **Semistructured Merge: Rethinking Merge in Revision Control Systems** (Apel, Liebig, Brandl, Lengauer, Kästner — ESEC/FSE 2011, pp. 190–200) — DOI:10.1145/2025113.2025141 — merge at the AST/declaration level to cut spurious conflicts.
- **Structured Merge with Auto-Tuning** (Apel, Leßenich, Lengauer — ASE 2012, pp. 120–129) — DOI:10.1145/2351676.2351694 — JDime switches between structured and unstructured merge; journal version: **Balancing Precision and Performance in Structured Merge** (Leßenich, Apel, Lengauer — *Automated Software Engineering* 22(3):367–397, 2015) — DOI:10.1007/s10515-014-0151-5.
- **Understanding Semi-Structured Merge Conflict Characteristics in Open-Source Java Projects** (Accioly, Borba, Cavalcanti — *EMSE* 23:2251–2285, 2018) — DOI:10.1007/s10664-017-9586-1 — empirical taxonomy of semi-structured conflicts.
- **Evaluating and Improving Semistructured Merge** (Cavalcanti, Borba, Accioly — OOPSLA 2017, PACMPL 1:59) — DOI:10.1145/3133883 — precision/recall measurement of merge tools.
- **On the Nature of Merge Conflicts: A Study of 2,731 Open Source Java Projects Hosted by GitHub** (Ghiotto, Murta, Barros, van der Hoek — *IEEE TSE* 46(8):892–915, 2020) — DOI:10.1109/TSE.2018.2871083 — the large-scale empirical conflict taxonomy; useful as an analogy for conversation-conflict classes.
- **A State-of-the-Art Survey on Software Merging** (Mens — *IEEE TSE* 28(5):449–462, 2002) — DOI:10.1109/TSE.2002.1000449 — the canonical merge survey (use this, not any "survey of software merge techniques").
- Adjacent/recent: **Verified Three-Way Program Merge** (Sousa, Dillig, Lahiri — OOPSLA 2018, PACMPL 2:161) — DOI:10.1145/3276535; **IntelliMerge: A Refactoring-Aware Software Merging Technique** (Shen et al. — OOPSLA 2019, PACMPL 3:132) — DOI:10.1145/3360596; **A Characterization Study of Merge Conflicts in Java Projects** (Shen, Gulzar, He, Meng — *ACM TOSEM* 32(3), 2022) — DOI:10.1145/3546944.

**4.7 Knowledge-graph / ontology merging, entity resolution**
- **Ontology Matching** (Euzenat & Shvaiko — Springer, 1st ed. 2007, 2nd ed. 2013) — 2nd ed. DOI:10.1007/978-3-642-38721-0 — the reference work on alignment, similarity measures, and matcher evaluation.
- **PROMPT: Algorithm and Tool for Automated Ontology Merging and Alignment** (Noy & Musen — AAAI 2000) — https://openalex.org/W1600475986 — semi-automatic merge with conflict suggestions.
- **Falcon-AO: A Practical Ontology Matching System** (Hu & Qu — *Journal of Web Semantics* 6(3):237–239, 2008) — DOI:10.1016/j.websem.2008.02.006 — linguistic + structural matchers.
- **Representing and Reasoning about Mappings between Domain Models** (Madhavan, Bernstein, Doan, Halevy — AAAI 2002) — https://aaai.org/papers/00080-aaai02-013-representing-and-reasoning-about-mappings-between-domain-models/ — formal mapping semantics (sound/complete/maximal/faithful). *(Note: the often-cited "Flouris, Fundulaki, Michou — …between domain **ontologies**" could not be verified; this is the correct paper.)*
- **A Theory for Record Linkage** (Fellegi & Sunter — *JASA* 64(328):1183–1210, 1969) — DOI:10.1080/01621459.1969.10501049 — probabilistic record-linkage decision rule.
- **Collective Entity Resolution in Relational Data** (Bhattacharya & Getoor — *ACM TKDD* 1(1):5, 2007) — DOI:10.1145/1217299.1217304 — resolution as a joint inference problem over a graph; **the machinery needed to decide when a name/entity mentioned in branch A is the same as one in branch B.**
- **Blocking and Filtering Techniques for Entity Resolution** (Papadakis, Skoutas, Thanos, Palpanas — *ACM Computing Surveys* 53(3):56, 2020) — DOI:10.1145/3377455 — arXiv:1905.06167 — candidate-generation survey (the scalability half of entity resolution).
- **Deep Learning for Entity Matching: A Design Space Exploration** (Mudgal et al. — SIGMOD 2018, pp. 19–34) — DOI:10.1145/3183713.3196926 — DeepMatcher design study.
- Recent: **Deep Entity Matching with Pre-Trained Language Models** (Li, Li, Suhara, Doan, Tan — *PVLDB* 14(1):50–60, 2020) — DOI:10.14778/3421424.3421431 — Ditto.
- Recent: **Entity Matching using Large Language Models** (Peeters, Steiner, Bizer — 2023) — arXiv:2310.11244 — https://arxiv.org/abs/2310.11244 — LLM prompting for entity matching; the practical route for cross-branch coreference.
- Graph-embedding alignment: **MTransE** (Chen, Tian, Yang, Zaniolo — IJCAI 2017) — DOI:10.24963/ijcai.2017/209 — arXiv:1611.03954; **BootEA** (Sun, Hu, Zhang, Qu — IJCAI 2018) — DOI:10.24963/ijcai.2018/611 — iterative embed-align-relabel bootstrapping.

**4.8 Provenance / lineage**
- **Why and Where: A Characterization of Data Provenance** (Buneman, Khanna, Tan — ICDT 2001, LNCS 1973:316–330) — DOI:10.1007/3-540-44503-X_20 — why-provenance (which input tuples caused the output) vs. where-provenance (which input *locations* the output was copied from). **Directly relevant: "which branch utterance justifies this claim" is why-provenance; "which span was copied" is where-provenance.**
- **Provenance Semirings** (Green, Karvounarakis, Tannen — PODS 2007, pp. 31–40) — DOI:10.1145/1265530.1265535 — annotate tuples with elements of a commutative semiring; different semirings instantiate why-, how-, and trust-provenance, and the same evaluation machinery propagates them. **This is the strongest candidate formalism for a typed provenance algebra over merged conversation claims.**
- **Provenance in Databases: Why, How, and Where** (Cheney, Chiticariu, Tan — *Foundations and Trends in Databases* 1(4):379–474, 2009) — DOI:10.1561/1900000006 — the survey.
- **Data Provenance: A Categorization of Existing Approaches** (Glavic & Dittrich — BTW 2007, LNI 103:227–241) — http://www.btw2007.de/paper/p227.pdf — provenance taxonomy.
- Recent: **Capturing End-to-End Provenance for Machine Learning Pipelines** (Schlegel & Sattler — *Information Systems*, 2024) — DOI:10.1016/j.is.2024.102495 — lineage across ML pipelines.
- Recent: **An LLM-Guided Platform for Multi-Granular Collection and Management of Data Provenance** (Gregori, Lazzaro, Lazzaro, Missier, Torlone — *Journal of Big Data* 12, 2025) — DOI:10.1186/s40537-025-01209-3 — LLM-assisted provenance capture and querying.

**4.9 Incremental view maintenance**
- **Efficiently Updating Materialized Views** (Blakeley, Larson, Tompa — SIGMOD 1986, pp. 61–71) — DOI:10.1145/16894.16861 — the origin of IVM; delta propagation into materialized views.
- **Maintaining Views Incrementally** (Gupta, Mumick, Subrahmanian — SIGMOD 1993, pp. 157–166) — DOI:10.1145/170035.170066 — contains the **DRed** algorithm for recursive views, plus counting. *(Note: "DRed" is not a separate paper.)*
- **Incremental Maintenance of Views with Duplicates** (Griffin & Libkin — SIGMOD 1995, pp. 328–339) — DOI:10.1145/223784.223849 — the counting algorithm under bag semantics.
- **Differential Dataflow** (McSherry, Murray, Isaacs, Isard — CIDR 2013) — http://www.cidrdb.org/cidr2013/Papers/CIDR13_Paper111.pdf — arrangements + partially ordered timestamps for incremental and iterative dataflow; **the practical engine if the merged context is a derived view that must be re-derived cheaply as branches arrive.** Formalized in **Foundations of Differential Dataflow** (Abadi, McSherry, Plotkin — ICALP 2015, LNCS 9134:71–83) — DOI:10.1007/978-3-662-46678-0_5.
- **DBToaster: Higher-Order Delta Processing for Dynamic, Frequently Fresh Views** (Koch, Ahmad, Kennedy, Nikolić, Nötzli, Lupei, Shaikhha — *VLDB Journal* 23(2):253–278, 2014) — DOI:10.1007/s00778-013-0348-4 — higher-order delta queries (2012 PVLDB version: Ahmad, Kennedy, Koch, Nikolić, PVLDB 5(10):968–979, DOI:10.14778/2336664.2336670; arXiv:1207.0137).
- Recent: **DBSP: Automatic Incremental View Maintenance for Rich Query Languages** (Budiu, Chajed, McSherry, Ryzhyk, Tannen — *PVLDB* 16(7):1601–1614, 2023) — DOI:10.14778/3587136.3587137 — arXiv:2203.16684 — a z-set stream algebra that makes *any* query incrementally computable by construction. **The most directly reusable modern result for "re-derive the merged context when a new branch lands."**

**Synthesis for this section.** These four traditions are complementary and, as far as I can tell, have never been combined for conversation merge: **AGM/Konieczny–Pino Pérez** give the *postulates and operators* (what a correct merge is); **ATMS/defeasible/argumentation** give the *representation* (assumption-labeled, retractable, extension-based); **semiring provenance** gives the *typing and propagation* (where each claim came from and how it was derived); **CRDT/3-way-semantic-merge** gives the *concurrency and confluence guarantees* (order- and duplicate-independence); **IVM/differential dataflow** gives the *incremental recomputation*.

---

## 5. KV-cache / system-level reuse

**Verified:**
- **Efficient Memory Management for Large Language Model Serving with PagedAttention** (Kwon, Li, Zhuang et al. — SOSP 2023) — arXiv:2309.06180 — https://arxiv.org/abs/2309.06180 — paged KV storage; the basis of vLLM prefix caching.
- **SGLang: Efficient Execution of Structured Language Model Programs** (Zheng, Yin, Xie et al. — NeurIPS 2024) — arXiv:2312.07104 — https://arxiv.org/abs/2312.07104 — RadixAttention: a radix tree over token sequences to reuse KV across shared prefixes.
- **Prompt Cache: Modular Attention Reuse for Low-Latency Inference** (Gim, Chen, Lee et al. — MLSys 2024) — arXiv:2311.04934 — https://arxiv.org/abs/2311.04934 — precompute per-module attention states with explicit position IDs and recombine them; **the earliest clean statement that independently computed prompt states can be stitched if positions are tracked.**
- **CacheBlend: Fast Large Language Model Serving for RAG with Cached Knowledge Fusion** (Yao, Li, Liu et al. — EuroSys 2025) — arXiv:2405.16444 — https://arxiv.org/abs/2405.16444 — **"fuses" KV caches of *multiple retrieved chunks* into one cache, then selectively recomputes the KV of a small fraction (high-attention) of tokens to recover cross-chunk attention.** This is the single most relevant system to the brief.
- **EPIC: Efficient Position-Independent Caching for Serving Large Language Models** (Hu, Huang, Wang et al. — ICML 2025) — arXiv:2410.15332 — https://arxiv.org/abs/2410.15332 — position-independent caching that makes chunks reusable regardless of where they land.
- **KV Cache Compression for Inference Efficiency in LLMs: A Review** (Liu, Fu, Liu et al. — 2025) — arXiv:2508.06297 — https://arxiv.org/abs/2508.06297 — survey of eviction/quantization/merging.

**Is there work on merging two *independently computed* KV caches? Partially yes, with caveats.** CacheBlend + EPIC + Prompt Cache + related 2025–2026 systems (A3 "Attention-Aware Accurate KV Cache Fusion", QCFuse "Query-Aware Cache Fusion via Compressed View", Cache-Craft, RAGCache, CacheGen/ChunkAttention — see §8) fuse caches of *chunks of one document set answering one query*. They are not merging two conversation *histories*.

**Known failure modes (important for the brief):**
1. **RoPE positional dependence.** Attention logits depend on *relative* positions. A cache computed at positions [0..n) carries absolute-position-encoded keys; concatenating a second cache computed at [0..m) makes every token in the second chunk "think" it is near the start. This is exactly why Prompt Cache needs explicit position IDs and why EPIC exists. Fixes are approximate.
2. **Attention-sink / outlier tokens.** The first few tokens absorb disproportionate attention; a chunk-local sink is a fake sink after fusion, and the true global sink is missing. CacheBlend's answer is partial recomputation, which is a speed/accuracy knob, not a correct merge.
3. **Missing cross-chunk attention.** Each chunk's KV was computed *without* the other chunks, so any token whose meaning depends on a counterpart in another chunk is mis-encoded. CacheBlend quantifies this and repairs the top-k% — the residual error is silently retained.
4. **Order/duplication.** Prefix reuse assumes a shared prefix; two *branches* have a common prefix then diverge, so you get a tree, not a list — the merged cache would have to represent *both* continuations of the same prefix, which RadixAttention-style trees represent structurally but which no system resolves semantically.
5. **No conflict semantics at all.** KV fusion is a *numerical* operation with no notion that chunk A says X and chunk B says ¬X. It faithfully encodes both and lets attention sort it out.

**Unsolved:** a KV-level merge that is *semantically aware* (detects and resolves contradiction rather than blending it), that handles divergent-tree (not shared-prefix) structure, and that has error bounds rather than an empirical accuracy delta.

---

## 6. Evaluation

**Verified:**
- **LongBench: A Bilingual, Multitask Benchmark for Long Context Understanding** (Bai, Lv, Zhang et al. — ACL 2024) — arXiv:2308.14508 — https://arxiv.org/abs/2308.14508 — 21 datasets, bilingual, long-input tasks.
- **RULER: What's the Real Context Size of Your Long-Context Language Models?** (Hsieh, Sun, Kriman et al. — COLM 2024) — arXiv:2404.06654 — https://arxiv.org/abs/2404.06654 — synthetic, configurable length/needle-count tasks that expose effective vs. claimed context.
- **LongMemEval** (arXiv:2410.10813) and **LoCoMo** (arXiv:2402.17753) — as in §2; the best available multi-session memory benchmarks, and the natural starting point for a merge benchmark.
- **Knowledge Conflicts for LLMs: A Survey** (Xu, Qi, Guo et al. — EMNLP 2024) — arXiv:2403.08319 — https://arxiv.org/abs/2403.08319 — taxonomy of context-memory and inter-context conflict; **the closest thing to a "conflict" evaluation framing.**
- **LongBench/RULER-tier long-context**, plus standard needle-in-a-haystack (Kamradt's repo — not peer-reviewed, cite as a repo).

**Standard, pending per-ID confirmation (§8):** SummaC (Laban et al., TACL 2022), FactCC ("Evaluating the Factual Consistency of Abstractive Text Summarization", Kryscinski et al., EMNLP 2020), QAFactEval, AlignScore, BERTScore, TRUE, DocNLI, "Lost in the Middle" (Liu et al., TACL 2024), ∞Bench, ZeroSCROLLS, HELMET, BABILong, LV-Eval, ConflictBank, SelfCheckGPT, MSC / "Beyond Goldfish Memory", MT-Bench, self-consistency, multi-agent debate.

**How one would benchmark "conversation merge quality" (my synthesis — no such benchmark exists that I could find):**
1. **Continuation validity** — can a fresh session, seeded only with the merged context, answer questions that are only answerable using *both* branches? (extends LongMemEval's multi-session reasoning).
2. **Conflict resolution accuracy** — inject known contradictions (temporal supersession, factual disagreement, preference reversal); measure whether the merged context adopts the right one and *records* the discarded one.
3. **Non-interference / minimal change** — measure whether merge destroyed claims present in only one branch (the AGM "inclusion" postulate, operationalized).
4. **Idempotence/commutativity/confluence** — merge(A,B,C) vs. merge(C,B,A); merge(merge(A,B),C) vs. merge(A,merge(B,C)); merge(A,A)=A. *No existing benchmark tests these, and they are exactly the CRDT/OT correctness properties.*
5. **Reasoning-trace faithfulness** — SummaC/FactCC-style entailment between the merged trace and each source trace (does the merged derivation still entail the branch derivations?).
6. **Budget compliance** — quality under a hard token budget, with a Pareto curve of budget vs. conflict-resolution accuracy.

---

## 7. NOVELTY GAP

**What is clearly already taken:**
- Compressing one context (all of §1); building one agent memory store (§2).
- Merging many *answers to one query* (§3) — LLM-Blender, MoA, RRF, self-consistency, debate.
- Fusing KV caches of *chunks of one retrieval set* (§5) — CacheBlend, Prompt Cache, EPIC, A3, QCFuse.
- Formal belief merging itself (§4.1) — Konieczny & Pino Pérez solved the abstract problem in 1998–2002.
- **Trace-level synthesis across agents:** *Beyond Consensus: Trace-Level Synthesis in Mixture of Agents* (Fadnavis, Kanakaraj, Wyss — arXiv:2605.29116, 2026-05-27) — synthesizes *reasoning traces*, not just answers, across MoA agents. This is the nearest published neighbour to the "reasoning trace merge" idea, but it is still **branch = proposer response to the same prompt**, with no provenance typing, no AGM postulates, no resumable-context requirement.
- **Typed provenance over agent memory:** *Mitigating Provenance-Role Collapse in Long-Term Agents via Typed Memory Representation* (Jin, Wang, Li — arXiv:2605.25869, 2026-05-25) — explicitly types memory by provenance role. Very close on the *representation* half; does not do a merge operator.
- **Multi-actor memory sharing with provenance + conflict handling:** *Collaborative Memory* (arXiv:2505.18279) — nearest on the *systems* half.
- **Branching conversation structures:** "Conversation Tree Architecture" (Hemanth & Saha — metadata unconfirmed, §8) proposes multi-branch conversation trees; no merge semantics found.

**What appears genuinely open (my honest assessment):**

No paper I could find proposes the full combination: **treat N conversation branches as replicas, compute a provenance-typed (semiring-annotated, ATMS-style assumption-labeled) representation of their claims *and derivation steps*, apply a belief-merging operator with explicit majority/arbitration semantics satisfying stated postulates, adjudicate residual conflicts with a verifier loop, and pack the result into a token/context budget that a fresh session can continue from.**

Specifically open, in decreasing order of confidence:
1. **Merge of derivation structure, not conclusions.** Every merging system I found merges text/answers/KV. Merging *justification graphs* (which premise licensed which inference) with conflict detection *inside* a derivation is unaddressed. ATMS and semiring provenance provide the machinery; nobody has applied it to LLM reasoning traces.
2. **Postulate-level guarantees for LLM context merge.** Nobody states, let alone proves or tests, AGM/Konieczny–Pino-Pérez-style postulates (IC0–IC8, inclusion, idempotence, commutativity) for an LLM-produced merged context. The CRDT/OT correctness conditions (confluence, order-independence) are likewise untested.
3. **Iterated merge.** Darwiche–Pearl showed single-shot correctness does not survive iteration. Tree-shaped branch topologies *require* iterated merge, and no work addresses stability under repeated merging.
4. **Provenance-typed conflict *typing*.** Distinguishing conflict classes — temporal supersession vs. factual disagreement vs. preference/instruction conflict vs. divergent-assumption (both true under different premises, i.e. Belnap "Both") — and choosing a different operator per class, is not done. Zep does temporal supersession only; knowledge-conflict surveys *taxonomize* but do not *operate*.
5. **Mergeable compression.** Compression methods (§1) are not mergeable; merge methods (§3) are not compressive. A representation that is *both* provenance-annotated *and* budget-packable is missing.
6. **Verifier loop over a merged context**, with a measurable guarantee that the merge did not hallucinate a consensus (the "false consensus" failure: averaging contradictory claims into a third, wrong claim, exactly what GenFuser and KV blending can do).
7. **A benchmark** with the properties listed in §6 — in particular commutativity/idempotence and non-interference, which no existing benchmark measures.

**Risk assessment.** The *ingredients* are all published, so novelty must be claimed at the **level of the operator and its guarantees**, not at the level of "we combine ideas X and Y." The strongest defensible claims are: (a) a provenance-typed representation of reasoning traces (not just claims) that is closed under merge; (b) a class-conditional belief-merging operator with stated postulates + a proof or empirical demonstration of confluence/idempotence/iteration-stability; (c) a verifier-in-the-loop adjudicator with false-consensus detection; (d) a budget-constrained packing step with a quality/budget Pareto characterization. Anything weaker than this will read as an application of Konieczny–Pino Pérez to a new domain, which is a workshop paper, not a contribution. **The most likely reviewer objection:** "This is belief merging (1998) plus provenance semirings (2007) plus CacheBlend (2024) applied to conversations — what is the new theorem?" The answer must be a theorem or a sharp empirical impossibility/possibility result, not an architecture diagram.

---

## 8. UNVERIFIED / metadata not confirmed (do not cite without checking)

These were surfaced by search but I could not confirm the exact arXiv ID/venue before the arXiv and search APIs rate-limited me (HTTP 429, 2026-09-17). Titles are likely real; **IDs must be re-verified before use.**

- SummaC (Laban et al., TACL 2022) — my candidate ID 2106.01263 resolved to a *different* paper ("Uni-Encoder"), so SummaC's ID is **unverified**.
- FactCC / "Evaluating the Factual Consistency of Abstractive Text Summarization" (Kryscinski et al., EMNLP 2020).
- "Beyond Goldfish Memory: Long-Term Open-Domain Conversation" (MSC; Xu et al. 2021).
- Self-consistency (Wang et al. 2022); LLM-as-a-judge / MT-Bench (Zheng et al. 2023); multi-agent debate (Du et al. 2023); Self-Refine (Madaan et al. 2023).
- "Lost in the Middle" (Liu et al. 2023); ∞Bench; ZeroSCROLLS; HELMET; BABILong; LV-Eval; ConflictBank; SelfCheckGPT; QAFactEval; AlignScore; TRUE; BERTScore; DocNLI.
- Sleep-time compute (Snell et al. 2025); MemoryBank (Zhong et al., AAAI 2024); "A Survey on the Memory Mechanism of LLM-based Agents"; Agent Workflow Memory; SeCom; MemInsight; Memory-R1; LightMem; MemoryOS; Mem1.
- GraphRAG (Microsoft); LightRAG; RAPTOR; Unlimiformer; Recurrent Memory Transformer; Memorizing Transformers.
- KV systems: CacheGen; Cache-Craft; RAGCache; ChunkAttention; A3 (Attention-Aware KV Cache Fusion); QCFuse (Query-Aware Cache Fusion); H2O; StreamingLLM; SnapKV; KIVI; Quest; Scissorhands; PyramidKV.
- "Conversation Tree Architecture: A Structured Framework for Context-Aware Multi-Branch LLM Conversations" (Hemanth & Saha) — found only via Semantic Scholar, no arXiv ID located.
- MemoryBank's arXiv ID (my candidate 2304.11158 resolved to an unrelated paper).
- ~~Classical items in §4~~ — **resolved.** All of §4 has since been verified against Crossref / OpenAlex / HAL-INRIA / proceedings pages, with DOIs and exact page ranges; see `refcheck/verified-references.md` for the raw fact-check and the list of corrections applied.
- Items that were requested but **could not be verified and were therefore dropped rather than cited**: "Accioly/Borba — Comparing conflict detection techniques"; "A formal framework for structural merging"; "A survey of software merge techniques" (the canonical survey is Mens 2002, now cited); "RDF merge is not enough"; "Flouris, Fundulaki, Michou — Representing and reasoning about mappings between domain ontologies" (the real paper is Madhavan et al., AAAI 2002, now cited); "Annotated logics" as a standalone da Costa paper (cite the 1991 PJ paper or the Abe et al. 2015 book instead).
- Some page ranges that could not be independently confirmed (Satoh 1988; Noy & Musen 2000; Reiter & de Kleer 1987) are omitted rather than asserted.

**Method note for reproducibility:** verification was done in two passes. (1) Body sections 1–3, 5–7 by `curl`ing `https://arxiv.org/abs/<id>` and reading the `citation_title`/`citation_author`/`citation_date` meta tags; `https://export.arxiv.org/api/query` worked for exact-ID lookups but returned HTTP 429 under batch load. (2) Section 4 by a dedicated fact-check pass against the **Crossref API**, **OpenAlex API**, **HAL/INRIA API**, and publisher/proceedings pages (dblp.org was network-unreachable; `mitpress.mit.edu`/ACM DL returned 403 to that sandbox). Multiple IDs were found to be wrong guesses and were corrected (xRAG, A-MEM, Zep, HippoRAG, the LLMLingua family, ICAE, AutoCompressor, Gist), and several section-4 attributions were corrected (Brewka et al. is 1997 not 2008; CRDT "comprehensive study" is INRIA RR-7506 not RR-7687; Ghiotto et al. is TSE 2020; DBToaster's first author is Koch/Ahmad not Nikolić; "DRed" is not a standalone paper). Raw fact-check artifact: `refcheck/verified-references.md`.
