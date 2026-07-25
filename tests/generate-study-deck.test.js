/* ==========================================================================
   Integration tests for functions/api/generate-study-deck.js.
   Mocks global fetch (Turnstile siteverify + Gemini generateContent) and a
   minimal in-memory KV namespace — no live network or paid Gemini calls.
   ========================================================================== */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { onRequestPost } from '../functions/api/generate-study-deck.js';

function createDevKvNamespace() {
  const store = new Map();
  return {
    store,
    async get(key) {
      const entry = store.get(key);
      return entry ? entry.value : null;
    },
    async put(key, value) {
      store.set(key, { value });
    }
  };
}

function makeEnv(overrides = {}) {
  return {
    GUEST_MODE_ENABLED: 'true',
    GEMINI_API_KEY: 'test-gemini-key',
    GEMINI_GUEST_MODEL: 'test-guest-model',
    TURNSTILE_SECRET_KEY: 'test-turnstile-secret',
    RATE_LIMIT_SALT: 'test-salt',
    GUEST_DAILY_LIMIT: '5',
    GUEST_USAGE: createDevKvNamespace(),
    ...overrides
  };
}

function makeRequest(body) {
  return new Request('http://localhost/api/generate-study-deck', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

const VALID_SUMMARY_DECK = {
  title: 'Test Deck',
  subtitle: 'Test Subtitle',
  bullets: [{ label: 'Concept', content: 'Detail.' }],
  takeaway: 'The takeaway.'
};

function geminiCandidateResponse({ text, finishReason = 'STOP' }) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      candidates: [
        {
          finishReason,
          content: { parts: text === null ? [] : [{ text }] }
        }
      ]
    })
  };
}

function geminiHttpError(status, googleStatus, message) {
  return {
    ok: false,
    status,
    json: async () => ({ error: { status: googleStatus, message } })
  };
}

describe('generate-study-deck onRequestPost', () => {
  let fetchCalls;
  let geminiResponseQueue;
  let originalFetch;

  beforeEach(() => {
    fetchCalls = [];
    geminiResponseQueue = [];
    originalFetch = global.fetch;
    global.fetch = async (url, init) => {
      const urlStr = String(url);
      if (urlStr.includes('siteverify')) {
        return { ok: true, status: 200, json: async () => ({ success: true }) };
      }
      if (urlStr.includes('generateContent')) {
        fetchCalls.push({ url: urlStr, body: JSON.parse(init.body) });
        const next = geminiResponseQueue.shift();
        if (!next) throw new Error('test setup error: no queued Gemini response');
        return next;
      }
      throw new Error(`Unexpected fetch call in test: ${urlStr}`);
    };
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  test('successful first attempt: one Gemini call, quota charged once, no retry', async () => {
    geminiResponseQueue.push(geminiCandidateResponse({ text: JSON.stringify(VALID_SUMMARY_DECK) }));

    const env = makeEnv();
    const res = await onRequestPost({
      request: makeRequest({
        mode: 'summary', inputType: 'text', text: 'Some study material.', turnstileToken: 'tok'
      }),
      env
    });

    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.deepEqual(payload.data, VALID_SUMMARY_DECK);
    assert.equal(fetchCalls.length, 1, 'only one Gemini call expected on success');
    assert.equal(payload.usage.remaining, 4); // limit 5, minus this one successful generation

    // Quota charged exactly once.
    assert.equal(env.GUEST_USAGE.store.size, 1);
    const [[, entry]] = env.GUEST_USAGE.store.entries();
    assert.equal(entry.value, '1');
  });

  test('MAX_TOKENS on first attempt triggers exactly one compact retry, which succeeds', async () => {
    geminiResponseQueue.push(geminiCandidateResponse({ text: '{"title": "T", "subtitle": "S", "bullets": [{"label": "A", "conte', finishReason: 'MAX_TOKENS' }));
    geminiResponseQueue.push(geminiCandidateResponse({ text: JSON.stringify(VALID_SUMMARY_DECK), finishReason: 'STOP' }));

    const env = makeEnv();
    const res = await onRequestPost({
      request: makeRequest({
        mode: 'summary', inputType: 'text', text: 'Some longer study material.', turnstileToken: 'tok'
      }),
      env
    });

    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.deepEqual(payload.data, VALID_SUMMARY_DECK);
    assert.equal(fetchCalls.length, 2, 'exactly one retry (2 total Gemini calls)');

    // The retry must use a compact prompt, distinct from the first attempt.
    const firstPrompt = fetchCalls[0].body.contents[0].parts[1].text;
    const secondPrompt = fetchCalls[1].body.contents[0].parts[1].text;
    assert.notEqual(firstPrompt, secondPrompt);
    assert.match(secondPrompt, /shorter than usual/);

    // Quota charged exactly once despite 2 Gemini calls.
    assert.equal(env.GUEST_USAGE.store.size, 1);
    const [[, entry]] = env.GUEST_USAGE.store.entries();
    assert.equal(entry.value, '1');
  });

  test('MAX_TOKENS on both attempts returns RESPONSE_TOO_LONG and never charges quota', async () => {
    geminiResponseQueue.push(geminiCandidateResponse({ text: null, finishReason: 'MAX_TOKENS' }));
    geminiResponseQueue.push(geminiCandidateResponse({ text: null, finishReason: 'MAX_TOKENS' }));

    const env = makeEnv();
    const res = await onRequestPost({
      request: makeRequest({
        mode: 'notes', inputType: 'text', text: 'Very long material.', turnstileToken: 'tok'
      }),
      env
    });

    assert.equal(res.status, 422);
    const payload = await res.json();
    assert.equal(payload.error.code, 'RESPONSE_TOO_LONG');
    assert.equal(fetchCalls.length, 2, 'capped at exactly 2 calls total, never more');
    assert.equal(env.GUEST_USAGE.store.size, 0, 'quota must not be charged on final failure');
  });

  test('safety block on first attempt does NOT trigger a retry', async () => {
    geminiResponseQueue.push(geminiCandidateResponse({ text: null, finishReason: 'SAFETY' }));

    const env = makeEnv();
    const res = await onRequestPost({
      request: makeRequest({
        mode: 'summary', inputType: 'text', text: 'Some material.', turnstileToken: 'tok'
      }),
      env
    });

    assert.equal(res.status, 422);
    const payload = await res.json();
    assert.equal(payload.error.code, 'GEMINI_SAFETY_BLOCK');
    assert.equal(fetchCalls.length, 1, 'safety block must not be retried');
    assert.equal(env.GUEST_USAGE.store.size, 0);
  });

  test('an HTTP-level Gemini error (invalid key / 400) does NOT trigger a retry', async () => {
    geminiResponseQueue.push(geminiHttpError(400, 'INVALID_ARGUMENT', 'API key not valid'));

    const env = makeEnv();
    const res = await onRequestPost({
      request: makeRequest({
        mode: 'summary', inputType: 'text', text: 'Some material.', turnstileToken: 'tok'
      }),
      env
    });

    const payload = await res.json();
    assert.equal(payload.error.code, 'SERVER_CONFIGURATION_ERROR');
    assert.equal(fetchCalls.length, 1, 'HTTP-level failures (invalid key, etc.) must not be retried');
    assert.equal(env.GUEST_USAGE.store.size, 0);
  });

  test('429 quota-exceeded does NOT trigger a retry', async () => {
    geminiResponseQueue.push(geminiHttpError(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded for this project'));

    const env = makeEnv();
    const res = await onRequestPost({
      request: makeRequest({
        mode: 'summary', inputType: 'text', text: 'Some material.', turnstileToken: 'tok'
      }),
      env
    });

    const payload = await res.json();
    assert.equal(payload.error.code, 'GEMINI_QUOTA_EXCEEDED');
    assert.equal(fetchCalls.length, 1);
  });

  test('valid JSON but wrong structure (STOP) maps to RESPONSE_INVALID_FORMAT without a retry', async () => {
    geminiResponseQueue.push(geminiCandidateResponse({ text: JSON.stringify({ unexpected: 'shape' }), finishReason: 'STOP' }));

    const env = makeEnv();
    const res = await onRequestPost({
      request: makeRequest({
        mode: 'summary', inputType: 'text', text: 'Some material.', turnstileToken: 'tok'
      }),
      env
    });

    const payload = await res.json();
    assert.equal(payload.error.code, 'RESPONSE_INVALID_FORMAT');
    assert.equal(fetchCalls.length, 1, 'a non-length structural problem is not retried');
  });

  test('empty text with a normal STOP reason maps to RESPONSE_EMPTY without a retry', async () => {
    geminiResponseQueue.push(geminiCandidateResponse({ text: null, finishReason: 'STOP' }));

    const env = makeEnv();
    const res = await onRequestPost({
      request: makeRequest({
        mode: 'summary', inputType: 'text', text: 'Some material.', turnstileToken: 'tok'
      }),
      env
    });

    const payload = await res.json();
    assert.equal(payload.error.code, 'RESPONSE_EMPTY');
    assert.equal(fetchCalls.length, 1);
  });

  test('daily quota already exhausted short-circuits before any Gemini call', async () => {
    const env = makeEnv({ GUEST_DAILY_LIMIT: '1' });
    // Pre-seed usage at the limit for whatever key this request will hash to.
    // Easiest reliable way: run one successful generation first, then try a second.
    geminiResponseQueue.push(geminiCandidateResponse({ text: JSON.stringify(VALID_SUMMARY_DECK) }));
    const first = await onRequestPost({
      request: makeRequest({ mode: 'summary', inputType: 'text', text: 'First.', turnstileToken: 'tok' }),
      env
    });
    assert.equal(first.status, 200);

    const second = await onRequestPost({
      request: makeRequest({ mode: 'summary', inputType: 'text', text: 'Second.', turnstileToken: 'tok' }),
      env
    });
    const secondPayload = await second.json();
    assert.equal(secondPayload.error.code, 'GUEST_DAILY_LIMIT_REACHED');
    assert.equal(fetchCalls.length, 1, 'no Gemini call should happen once quota is exhausted');
  });

  test('sends the mode-aware maxOutputTokens by default, and honors a valid env override', async () => {
    geminiResponseQueue.push(geminiCandidateResponse({ text: JSON.stringify(VALID_SUMMARY_DECK) }));
    const env = makeEnv();
    await onRequestPost({
      request: makeRequest({ mode: 'summary', inputType: 'text', text: 'Some material.', turnstileToken: 'tok' }),
      env
    });
    assert.equal(fetchCalls[0].body.generationConfig.maxOutputTokens, 4096);

    fetchCalls.length = 0;
    geminiResponseQueue.push(geminiCandidateResponse({ text: JSON.stringify(VALID_SUMMARY_DECK) }));
    const envWithOverride = makeEnv({ GEMINI_GUEST_MAX_OUTPUT_TOKENS: '2048' });
    await onRequestPost({
      request: makeRequest({ mode: 'summary', inputType: 'text', text: 'Some more material.', turnstileToken: 'tok' }),
      env: envWithOverride
    });
    assert.equal(fetchCalls[0].body.generationConfig.maxOutputTokens, 2048);

    fetchCalls.length = 0;
    geminiResponseQueue.push(geminiCandidateResponse({ text: JSON.stringify(VALID_SUMMARY_DECK) }));
    const envWithBadOverride = makeEnv({ GEMINI_GUEST_MAX_OUTPUT_TOKENS: '99999999' }); // out of range
    await onRequestPost({
      request: makeRequest({ mode: 'summary', inputType: 'text', text: 'Even more material.', turnstileToken: 'tok' }),
      env: envWithBadOverride
    });
    assert.equal(fetchCalls[0].body.generationConfig.maxOutputTokens, 4096, 'invalid override falls back to mode default');
  });

  test('guest mode disabled short-circuits before touching Gemini or Turnstile', async () => {
    const env = makeEnv({ GUEST_MODE_ENABLED: 'false' });
    const res = await onRequestPost({
      request: makeRequest({ mode: 'summary', inputType: 'text', text: 'Some material.', turnstileToken: 'tok' }),
      env
    });
    const payload = await res.json();
    assert.equal(payload.error.code, 'GUEST_MODE_DISABLED');
    assert.equal(fetchCalls.length, 0);
  });
});
