/**
 * MergeBench -- scenario generation (M6).
 *
 * WHAT THIS IS
 * ------------
 * A synthetic benchmark with known ground truth. It is NOT real user data;
 * it is a controlled instrument for one question:
 *
 *     Does merging two branches let a reader answer questions that neither
 *     branch could answer alone?
 *
 * The instrument is built around **bridge questions**: each question needs
 * facts that live in DIFFERENT branches. That is what makes the measurement
 * meaningful -- if a question were answerable from one branch, a merge would
 * have nothing to prove.
 *
 * Facts are distributed so that no branch holds everything, some keys are
 * asserted twice with DIFFERENT evidence (so the correct answer is determined
 * by evidence, not by chance), and irrelevant chatter is mixed in.
 *
 * Determinism: a seeded PRNG, so a scenario is reproducible from its seed.
 */

/** Small deterministic PRNG (mulberry32). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Topics with two plausible competing values each. */
const TOPICS = [
  { key: 'database.engine', values: ['postgresql', 'mysql'], say: (v) => `The database engine is ${v}.` },
  { key: 'cache.ttl_seconds', values: ['sixty', 'three_hundred'], say: (v) => `The cache TTL is ${v} seconds.` },
  { key: 'pool.max_connections', values: ['twenty', 'fifty'], say: (v) => `The connection pool cap is ${v}.` },
  { key: 'retry.max_attempts', values: ['three', 'five'], say: (v) => `Retries are capped at ${v}.` },
  { key: 'auth.provider', values: ['oauth', 'saml'], say: (v) => `Authentication uses ${v}.` },
  { key: 'deploy.target', values: ['kubernetes', 'lambda'], say: (v) => `We deploy to ${v}.` },
  { key: 'queue.broker', values: ['kafka', 'rabbitmq'], say: (v) => `The queue broker is ${v}.` },
  { key: 'storage.format', values: ['jsonl', 'parquet'], say: (v) => `Records are stored as ${v}.` },
  { key: 'cache.backend', values: ['redis', 'memcached'], say: (v) => `The cache backend is ${v}.` },
  { key: 'logging.sink', values: ['stdout', 'file'], say: (v) => `Logs go to ${v}.` },
  { key: 'search.index', values: ['elasticsearch', 'sqlite_fts'], say: (v) => `Search is backed by ${v}.` },
  { key: 'region.primary', values: ['us_east', 'eu_west'], say: (v) => `The primary region is ${v}.` },
  { key: 'metrics.exporter', values: ['prometheus', 'statsd'], say: (v) => `Metrics go to ${v}.` },
  { key: 'ci.runner', values: ['github_actions', 'jenkins'], say: (v) => `CI runs on ${v}.` },
  { key: 'secrets.store', values: ['vault', 'aws_secrets_manager'], say: (v) => `Secrets live in ${v}.` },
  { key: 'cdn.provider', values: ['cloudflare', 'fastly'], say: (v) => `The CDN is ${v}.` },
];

const CHATTER = [
  'Sure, let me look into that and get back to you with what I find.',
  'That sounds reasonable to me, though I would want to check the details first.',
  'I will check the configuration next and report anything that looks off.',
  'Thanks, that clarifies things quite a bit for the direction we are taking.',
  'Let me know if you want me to dig deeper into any particular part of this.',
  'Okay, moving on to the next item on the list we agreed earlier today.',
  'I think there are a couple of trade-offs worth writing down before we commit.',
  'That matches what I remembered from the earlier discussion on this topic.',
  'Before we change anything I would like to see how it behaves under load.',
  'Good point, I had not considered that angle when we first looked at it.',
  'Let me summarise where we are so far so nothing gets lost in the thread.',
  'I would rather keep the current setup until we have a concrete reason to move.',
];

/** Evidence-level meaning, matching lib/core/slot.js. */
const USER_STATED = 4;
const INFERRED = 2;

function pick(rng, list) {
  return list[Math.floor(rng() * list.length)];
}

function shuffle(rng, list) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Build one scenario.
 *
 * @param {{seed?: number, branchCount?: number, topicCount?: number,
 *          conflictCount?: number, chatterPerBranch?: number}} opts
 * @returns {{seed, facts, branches, questions}}
 */
export function generateScenario(opts = {}) {
  const {
    seed = 1,
    branchCount = 2,
    topicCount = 8,
    conflictCount = 2,
    chatterPerBranch = 18,
  } = opts;

  if (branchCount < 2) throw new Error('a merge benchmark needs at least two branches');

  const rng = mulberry32(seed);
  const topics = shuffle(rng, TOPICS).slice(0, Math.min(topicCount, TOPICS.length));
  const branchIds = Array.from({ length: branchCount }, (_, i) => `branch-${String.fromCharCode(97 + i)}`);

  /** @type {Array<{key: string, value: string, branch: string, evidence: number, correct: boolean}>} */
  const facts = [];

  // Primary assertions: every topic belongs to exactly one branch, so no
  // single branch can answer a question that spans two topics.
  const owner = new Map();
  topics.forEach((topic, index) => {
    const branch = branchIds[index % branchCount];
    const value = topic.values[0];
    owner.set(topic.key, branch);
    facts.push({ key: topic.key, value, branch, evidence: USER_STATED, correct: true });
  });

  // Conflicts: another branch asserts a DIFFERENT value with LOWER evidence,
  // so the correct answer is decided by evidence weight, not by luck.
  const conflicted = shuffle(rng, topics).slice(0, Math.min(conflictCount, topics.length));
  for (const topic of conflicted) {
    const challenger = branchIds.find((b) => b !== owner.get(topic.key));
    facts.push({
      key: topic.key,
      value: topic.values[1],
      branch: challenger,
      evidence: INFERRED,
      correct: false,
    });
  }

  // Materialise one surface per branch.
  const branches = branchIds.map((id) => {
    const mine = facts.filter((f) => f.branch === id);
    const messages = [];
    for (const fact of mine) {
      const topic = topics.find((t) => t.key === fact.key);
      const role = fact.evidence === USER_STATED ? 'user' : 'assistant';
      messages.push({
        role,
        content: [{ type: 'text', text: topic.say(fact.value) }],
        source: { kind: 'user' },
      });
      if (fact.evidence !== USER_STATED) {
        // The weaker claim is the model's own inference, recorded in reasoning.
        messages.push({
          role: 'assistant',
          content: [{ type: 'reasoning', text: `${topic.say(fact.value)} I think.` }],
          source: { kind: 'model' },
        });
      }
    }
    // A conflicting opinion should read as asserted, in the branch's own voice.
    for (const fact of mine.filter((f) => !f.correct)) {
      const topic = topics.find((t) => t.key === fact.key);
      messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: topic.say(fact.value) }],
        source: { kind: 'model' },
      });
    }
    for (let i = 0; i < chatterPerBranch; i += 1) {
      messages.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: [{ type: 'text', text: pick(rng, CHATTER) }],
        source: { kind: i % 2 === 0 ? 'user' : 'model' },
      });
    }
    return { id, messages };
  });

  // Questions come in two kinds, and the distinction is the whole point:
  //
  //   local   both facts live in ONE branch -> a single branch can answer it
  //   bridge  the facts live in DIFFERENT branches -> only a merge can
  //
  // Without local questions the "best single branch" baseline is trivially
  // zero and the comparison says nothing. An earlier version of this
  // generator made that mistake.
  const correctFacts = facts.filter((f) => f.correct);
  const byBranch = new Map();
  for (const fact of correctFacts) {
    if (!byBranch.has(fact.branch)) byBranch.set(fact.branch, []);
    byBranch.get(fact.branch).push(fact);
  }

  const questions = [];
  const used = new Set();

  for (const [branch, mine] of byBranch) {
    for (let i = 0; i + 1 < mine.length; i += 2) {
      const a = mine[i];
      const b = mine[i + 1];
      questions.push({
        id: `local-${branch}-${a.key}`,
        kind: 'local',
        question: `What is the ${a.key} and what is the ${b.key}?`,
        requires: [a.key, b.key],
        expect: { [a.key]: a.value, [b.key]: b.value },
        spansBranches: [branch],
      });
      used.add(a.key);
      used.add(b.key);
    }
  }

  for (const topic of topics) {
    const primary = correctFacts.find((f) => f.key === topic.key);
    if (!primary) continue;
    const partner = correctFacts.find((f) => f.key !== topic.key && f.branch !== primary.branch);
    if (!partner) continue;
    questions.push({
      id: `bridge-${topic.key}`,
      kind: 'bridge',
      question: `What is the ${topic.key} and what is the ${partner.key}?`,
      requires: [topic.key, partner.key],
      expect: { [topic.key]: primary.value, [partner.key]: partner.value },
      spansBranches: [primary.branch, partner.branch].sort(),
    });
  }

  const bridge = questions.filter((q) => q.kind === 'bridge');
  const local = questions.filter((q) => q.kind === 'local');

  const vocabulary = [...new Set(TOPICS.flatMap((t) => t.values))];

  return { seed, facts, branches, questions, bridge, local, topics, vocabulary };
}

/** Split a scenario's branches so each arm gets a fresh, unmutated copy. */
export function cloneBranches(branches) {
  return branches.map((b) => ({ id: b.id, messages: b.messages.map((m) => ({ ...m })) }));
}
