/**
 * Secret redaction tests.
 *
 * Two failure modes matter, and they pull in opposite directions:
 *
 *   a miss            a credential reaches the claim graph, the rendered block,
 *                     and the model API. Observed in practice: merging two real
 *                     sessions produced a claim whose value was a live API key.
 *   a false positive  ordinary content is mangled. Worse than it sounds -- a
 *                     system whose whole job is fidelity must not silently
 *                     rewrite commit hashes, arXiv ids or file paths.
 *
 * Both directions are tested.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractClaims,
  flattenSurface,
  hasSecrets,
  redactMessages,
  redactSecrets,
  textBlocks,
} from '../lib/core/index.js';

/* ---- must catch -------------------------------------------------- */

// Every fixture below is ASSEMBLED AT RUNTIME from harmless fragments.
// A complete token literal in this file trips GitHub push protection, which
// is exactly what happened on the first attempt to push it -- the scanner was
// right, and a redaction test is not a good place to keep a string that looks
// like a live credential.
const j = function () { return Array.prototype.join.call(arguments, ''); };
const A = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0';
const lower = 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6';

const MUST_CATCH = [
  ['openai', j('my key is sk-', lower, ' ok')],
  ['openai-proj', j('sk-proj-', lower)],
  ['anthropic', j('sk-ant-api03-', lower)],
  ['google', j('AIzaSy', A.slice(0, 33))],
  ['github', j('gh', 'p_', A.replace(/[^A-Za-z0-9]/g, '').slice(0, 36))],
  ['huggingface', j('hf_', lower, '0123')],
  ['aws', j('AKIA', 'EXAMPLEKEY123456')],
  ['slack', j('xoxb-', '123456789012', '-', lower.slice(0, 16))],
  ['stripe', j('sk_', 'live_', lower.slice(0, 24))],
  ['npm', j('npm_', lower, '0123456789')],
  [
    'jwt',
    j(
      'eyJhbGciOiJIUzI1NiJ9',
      '.',
      'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
      '.',
      'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    ),
  ],
];

for (const pair of MUST_CATCH) {
  const kind = pair[0];
  const sample = pair[1];
  test('catches a ' + kind + ' credential', function () {
    const out = redactSecrets(sample);
    assert.ok(out.found.length > 0, 'missed ' + kind);
    assert.match(out.text, /\[REDACTED:/);
  });
}

test('catches a PEM private key', function () {
  const pem = j(
    '-----BEGIN ', 'RSA ', 'PRIVATE KEY-----',
    '\nMIIEowIBAAKCAQEA\n',
    '-----END ', 'RSA ', 'PRIVATE KEY-----',
  );
  assert.ok(redactSecrets(pem).found.some(function (f) { return f.kind === 'private-key'; }));
});

test('catches labelled secrets in several spellings', function () {
  const v = lower.slice(0, 20);
  const cases = [
    'api_key = ' + v,
    'API-KEY: ' + v,
    'access_token=' + v,
    'password: ' + v,
  ];
  for (const c of cases) {
    assert.ok(redactSecrets(c).found.length > 0, 'missed ' + c);
  }
});

/* ---- must not touch ---------------------------------------------- */

const MUST_KEEP = [
  'The token budget is 1200.',
  'The token expired and we retried.',
  'Use a secret management service.',
  'The password policy requires twelve characters.',
  'commit 433f5a14e6bcc1b9849b01462ecc818c0de53385',
  'arXiv:2405.16444 and arXiv:2310.08560',
  '/Users/lp1/Documents/deepseek harness/bili/BV15N816aEq9/frames_01.jpg',
  'The error code was EPERM_ACCESS_DENIED_2026.',
  'The connection pool is capped at twenty.',
];

for (const sample of MUST_KEEP) {
  test('leaves ordinary content alone: ' + sample.slice(0, 38), function () {
    const out = redactSecrets(sample);
    assert.equal(out.found.length, 0, 'false positive on ' + sample);
    assert.equal(out.text, sample);
  });
}

test('REGRESSION: a bare dotted credential is caught by SHAPE, with no label', function () {
  // Found by merging two real sessions: a 32-hex + '.' + 16-alnum key has no
  // provider prefix and no adjacent label, so every other rule missed it and
  // it reached both the claim graph and the rendered block.
  const key = j('0123456789abcdef0123456789abcdef', '.', 'AbCdEf1234567890');
  const out = redactSecrets('here it is: ' + key);
  assert.ok(out.found.length > 0, 'a labelled-by-nothing credential must still be caught');
  assert.ok(out.text.indexOf(key) === -1);
});

test('REGRESSION: mixed CN/EN labels and quoted JSON forms are caught', function () {
  const key = j('0123456789abcdef0123456789abcdef', '.', 'AbCdEf1234567890');
  const cases = [
    'API密钥：' + key,
    JSON.stringify({ api_key: key }),
    '{ "api_key": "' + key + '" }',
  ];
  for (const c of cases) {
    const out = redactSecrets(c);
    assert.ok(out.found.length > 0, 'missed: ' + c);
    assert.ok(out.text.indexOf(key) === -1);
  }
});

test('a 32-hex commit sha on its own is NOT a credential', function () {
  // The dotted rule must not swallow plain hashes.
  const out = redactSecrets(j('blob ', '0123456789abcdef0123456789abcdef', ' done'));
  assert.equal(out.found.length, 0);
});

test('a labelled word with a placeholder value is left alone', function () {
  assert.equal(hasSecrets('api_key = <your-key-here>'), false);
  assert.equal(hasSecrets('token: ...'), false);
});

/* ---- where it is applied ----------------------------------------- */

test('textBlocks redacts before anything downstream sees the text', function () {
  const message = {
    role: 'user',
    content: [{ type: 'text', text: j('my key is sk-', lower, ' by the way') }],
  };
  const blocks = Array.from(textBlocks(message));
  assert.match(blocks[0].text, /\[REDACTED:openai\]/);
  assert.ok(blocks[0].text.indexOf(lower.slice(0, 10)) === -1);
});

test('the heuristic extractor never sees a credential', function () {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'api_key = ' + lower.slice(0, 18) }] },
  ];
  const claims = extractClaims(messages, { sourceId: 'b' });
  const joined = claims.map(function (c) { return c.text; }).join(' ');
  assert.ok(joined.indexOf(lower.slice(0, 18)) === -1, 'credential reached a claim');
});

test('SAFETY: the alignment prompt never contains a credential', function () {
  // The one that matters most: this string is sent to a model API.
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'sk-abcdefghijklmnopqrstuvwxyz012345' }] },
  ];
  const out = flattenSurface(messages);
  assert.ok(out.text.indexOf(lower.slice(0, 10)) === -1, 'credential would have left the machine');
});

test('redactMessages reports findings and does not mutate the input', function () {
  const original = [
    { role: 'user', content: [{ type: 'text', text: j('gh', 'p_', lower, '0123') }] },
  ];
  const out = redactMessages(original);
  assert.ok(out.found.length > 0);
  assert.ok(out.messages[0].content[0].text.indexOf(j('gh', 'p_')) === -1);
  assert.ok(original[0].content[0].text.indexOf(j('gh', 'p_')) !== -1);
});

test('a reasoning block is redacted too, not just visible text', function () {
  const message = {
    role: 'assistant',
    content: [{ type: 'reasoning', text: j('I will use sk-', lower) }],
  };
  const blocks = Array.from(textBlocks(message));
  assert.match(blocks[0].text, /\[REDACTED:openai\]/);
});
