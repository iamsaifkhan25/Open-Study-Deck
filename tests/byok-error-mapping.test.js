import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { mapByokErrorToFailure, BYOK_FAILURE_CATEGORIES } from '../shared/byok-error-mapping.js';

// All errors below are fabricated for test purposes only — they mimic the
// shapes the @google/genai SDK's ApiError can take, never a real response.
// A fake key-like string is embedded in a couple of messages specifically to
// verify it never leaks into the mapped output.
const FAKE_KEY_LOOKALIKE = 'AQ.FAKEFAKEFAKEFAKEFAKE1234567890';

function structuredApiError({ status, code, googleStatus, message, details }) {
  return {
    name: 'ApiError',
    status,
    message: JSON.stringify({
      error: {
        code: code !== undefined ? code : status,
        status: googleStatus,
        message,
        ...(details ? { details } : {})
      }
    })
  };
}

describe('mapByokErrorToFailure', () => {
  test('structured ACCESS_TOKEN_TYPE_UNSUPPORTED response maps to auth_key_unsupported', () => {
    const err = structuredApiError({
      status: 401,
      googleStatus: 'UNAUTHENTICATED',
      message: `Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential for key ${FAKE_KEY_LOOKALIKE}.`,
      details: [
        { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCESS_TOKEN_TYPE_UNSUPPORTED', domain: 'googleapis.com' }
      ]
    });

    const result = mapByokErrorToFailure(err);
    assert.equal(result.failureCategory, 'auth_key_unsupported');
    assert.match(result.message, /authorization key/i);
    assert.match(result.message, /guest access/i);
  });

  test('JSON-stringified equivalent (no structured .status, plain-text message) maps correctly', () => {
    // Simulates an environment where only a stringified/plain-text
    // representation survives — no numeric .status, no parsed .reason.
    const err = {
      message: 'got status: 401 Unauthorized. {"error":{"code":401,"status":"UNAUTHENTICATED","message":"Expected OAuth 2 access token, login cookie or other valid authentication credential. reason: ACCESS_TOKEN_TYPE_UNSUPPORTED"}}'
    };

    const result = mapByokErrorToFailure(err);
    assert.equal(result.failureCategory, 'auth_key_unsupported');
  });

  test('ordinary invalid-key response remains invalid_key', () => {
    const err = structuredApiError({
      status: 400,
      googleStatus: 'INVALID_ARGUMENT',
      message: `API key not valid. Please pass a valid API key. (${FAKE_KEY_LOOKALIKE})`
    });

    const result = mapByokErrorToFailure(err);
    assert.equal(result.failureCategory, 'invalid_key');
    assert.match(result.message, /invalid api key/i);
  });

  test('disabled/revoked key is distinguished from ordinary invalid key', () => {
    const err = structuredApiError({
      status: 403,
      googleStatus: 'PERMISSION_DENIED',
      message: 'Generative Language API has not been used in project 12345 or it has been disabled.',
      details: [
        { '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED', domain: 'googleapis.com' }
      ]
    });

    const result = mapByokErrorToFailure(err);
    assert.equal(result.failureCategory, 'key_disabled');
  });

  test('quota remains quota', () => {
    const err = structuredApiError({
      status: 429,
      googleStatus: 'RESOURCE_EXHAUSTED',
      message: 'Quota exceeded for quota metric "Generate Content API requests per minute".'
    });

    const result = mapByokErrorToFailure(err);
    assert.equal(result.failureCategory, 'quota');
  });

  test('rate limit (429 without quota wording) is distinguished from quota', () => {
    const err = structuredApiError({
      status: 429,
      googleStatus: 'RESOURCE_EXHAUSTED',
      message: 'Too many requests, please retry after a short delay.'
    });

    const result = mapByokErrorToFailure(err);
    assert.equal(result.failureCategory, 'rate_limit');
  });

  test('model unavailable (404) is distinguished from invalid key', () => {
    const err = structuredApiError({
      status: 404,
      googleStatus: 'NOT_FOUND',
      message: 'models/gemini-nonexistent-model is not found for API version v1beta.'
    });

    const result = mapByokErrorToFailure(err);
    assert.equal(result.failureCategory, 'model_unavailable');
  });

  test('network failure (no status, browser fetch-style error) maps to network', () => {
    const err = { name: 'TypeError', message: 'Failed to fetch' };

    const result = mapByokErrorToFailure(err);
    assert.equal(result.failureCategory, 'network');
  });

  test('a completely empty error falls back to network without throwing', () => {
    const result = mapByokErrorToFailure({});
    assert.equal(result.failureCategory, 'network');

    const resultUndefined = mapByokErrorToFailure(undefined);
    assert.equal(resultUndefined.failureCategory, 'network');
  });

  test('an unrecognized but non-empty, non-network error message falls back to unknown', () => {
    const result = mapByokErrorToFailure({ message: 'Something unexpected happened deep in the SDK.' });
    assert.equal(result.failureCategory, 'unknown');
  });

  test('no raw error body is exposed in the user-facing message', () => {
    const err = structuredApiError({
      status: 401,
      googleStatus: 'UNAUTHENTICATED',
      message: `Expected OAuth 2 access token for ${FAKE_KEY_LOOKALIKE}`,
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCESS_TOKEN_TYPE_UNSUPPORTED' }]
    });

    const result = mapByokErrorToFailure(err);
    assert.equal(result.message.includes(FAKE_KEY_LOOKALIKE), false);
    assert.equal(result.message.includes('{"error"'), false);
    assert.equal(result.message.includes('googleapis.com/google.rpc.ErrorInfo'), false);
  });

  test('failureCategory is always one of the documented low-cardinality values (safe for Analytics)', () => {
    const sampleErrors = [
      structuredApiError({ status: 401, googleStatus: 'UNAUTHENTICATED', message: 'Expected OAuth 2 access token', details: [{ reason: 'ACCESS_TOKEN_TYPE_UNSUPPORTED' }] }),
      structuredApiError({ status: 400, googleStatus: 'INVALID_ARGUMENT', message: `API key not valid ${FAKE_KEY_LOOKALIKE}` }),
      structuredApiError({ status: 429, googleStatus: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded' }),
      { message: 'Failed to fetch' },
      {}
    ];

    for (const err of sampleErrors) {
      const { failureCategory, message } = mapByokErrorToFailure(err);
      assert.ok(BYOK_FAILURE_CATEGORIES.includes(failureCategory));
      // No API-key-like value should ever ride along in what would become
      // an Analytics parameter alongside this category.
      assert.equal(message.includes(FAKE_KEY_LOOKALIKE), false);
      assert.equal(typeof failureCategory, 'string');
      assert.ok(failureCategory.length < 40);
    }
  });
});
