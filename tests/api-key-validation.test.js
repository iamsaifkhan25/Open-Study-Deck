import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { validateApiKeyFormat } from '../shared/api-key-validation.js';

// All keys below are fabricated placeholders for format testing only — never
// real credentials.
const FAKE_LEGACY_KEY = 'AIzaSyFAKEFAKEFAKE1234567890';
const FAKE_NEW_KEY = 'AQ.FAKEFAKEFAKEFAKEFAKE1234567890';

describe('validateApiKeyFormat', () => {
  test('accepts a legacy-style AIza key', () => {
    const result = validateApiKeyFormat(FAKE_LEGACY_KEY);
    assert.equal(result.valid, true);
    assert.equal(result.value, FAKE_LEGACY_KEY);
  });

  test('accepts a new-style AQ. authorization key', () => {
    const result = validateApiKeyFormat(FAKE_NEW_KEY);
    assert.equal(result.valid, true);
    assert.equal(result.value, FAKE_NEW_KEY);
  });

  test('accepts periods, hyphens, and underscores', () => {
    const result = validateApiKeyFormat('test-key_with.mixed-chars_1234567890');
    assert.equal(result.valid, true);
  });

  test('trims leading and trailing whitespace', () => {
    const result = validateApiKeyFormat(`  ${FAKE_LEGACY_KEY}  `);
    assert.equal(result.valid, true);
    assert.equal(result.value, FAKE_LEGACY_KEY);
  });

  test('rejects an internal space', () => {
    const result = validateApiKeyFormat('AIzaSyFAKE FAKEFAKE1234567890');
    assert.equal(result.valid, false);
    assert.match(result.reason, /spaces or line breaks/i);
  });

  test('rejects a newline in the middle', () => {
    const result = validateApiKeyFormat('AIzaSyFAKE\nFAKEFAKE1234567890');
    assert.equal(result.valid, false);
    assert.match(result.reason, /spaces or line breaks/i);
  });

  test('rejects a surrounding-quotes paste', () => {
    const result = validateApiKeyFormat(`"${FAKE_LEGACY_KEY}"`);
    assert.equal(result.valid, false);
    assert.match(result.reason, /unsupported characters/i);
  });

  test('rejects a GEMINI_API_KEY= wrapper instead of silently stripping it', () => {
    const result = validateApiKeyFormat(`GEMINI_API_KEY=${FAKE_LEGACY_KEY}`);
    assert.equal(result.valid, false);
    assert.match(result.reason, /unsupported characters/i);
  });

  test('rejects an empty value', () => {
    const result = validateApiKeyFormat('');
    assert.equal(result.valid, false);
    assert.match(result.reason, /enter your gemini api key/i);
  });

  test('rejects a whitespace-only value as empty', () => {
    const result = validateApiKeyFormat('   ');
    assert.equal(result.valid, false);
    assert.match(result.reason, /enter your gemini api key/i);
  });

  test('rejects a clearly too-short value', () => {
    const result = validateApiKeyFormat('AIzaShort');
    assert.equal(result.valid, false);
    assert.match(result.reason, /too short/i);
  });

  test('rejects embedded control characters', () => {
    const result = validateApiKeyFormat('AIzaSyFAKEFAKEFAKE12345\x0790');
    assert.equal(result.valid, false);
    assert.match(result.reason, /unsupported characters/i);
  });

  test('rejects extremely long pasted content', () => {
    const result = validateApiKeyFormat('A'.repeat(300));
    assert.equal(result.valid, false);
    assert.match(result.reason, /too long/i);
  });

  test('does not require an AIza or AQ. prefix', () => {
    const result = validateApiKeyFormat('SomeFutureGeminiKeyFormat1234567890');
    assert.equal(result.valid, true);
  });

  test('safely stringifies non-string input without throwing', () => {
    assert.equal(validateApiKeyFormat(null).valid, false);
    assert.equal(validateApiKeyFormat(undefined).valid, false);
  });
});
