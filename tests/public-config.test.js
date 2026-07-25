import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { onRequestGet } from '../functions/api/public-config.js';

describe('public-config onRequestGet', () => {
  test('explicitly enabled: reports guestModeEnabled true with site key', async () => {
    const res = await onRequestGet({
      env: { GUEST_MODE_ENABLED: 'true', TURNSTILE_SITE_KEY: 'site-key-123', GUEST_DAILY_LIMIT: '7' }
    });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.guestModeEnabled, true);
    assert.equal(body.turnstileSiteKey, 'site-key-123');
    assert.equal(body.guestDailyLimit, 7);
  });

  test('explicitly disabled: reports guestModeEnabled false (any non-"true" value)', async () => {
    const res = await onRequestGet({ env: { GUEST_MODE_ENABLED: 'false' } });
    const body = await res.json();
    assert.equal(body.guestModeEnabled, false);
    assert.equal(body.turnstileSiteKey, null);
  });

  test('missing GUEST_MODE_ENABLED env entirely also reports disabled, not a crash', async () => {
    const res = await onRequestGet({ env: {} });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.guestModeEnabled, false);
    assert.equal(body.guestDailyLimit, 5); // safe default
  });

  test('never includes secret env values in the response body', async () => {
    const res = await onRequestGet({
      env: {
        GUEST_MODE_ENABLED: 'true',
        TURNSTILE_SITE_KEY: 'site-key',
        GEMINI_API_KEY: 'super-secret-gemini-key',
        TURNSTILE_SECRET_KEY: 'super-secret-turnstile-key',
        RATE_LIMIT_SALT: 'super-secret-salt'
      }
    });
    const raw = await res.text();
    assert.ok(!raw.includes('super-secret'));
  });

  test('response has no-store cache headers', async () => {
    const res = await onRequestGet({ env: { GUEST_MODE_ENABLED: 'true' } });
    assert.equal(res.headers.get('Cache-Control'), 'no-store');
  });
});
