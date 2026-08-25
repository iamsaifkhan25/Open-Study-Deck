/* ==========================================================================
   Database-free Razorpay workflow tests.

   All provider calls are mocked. These tests exercise the same Pages
   Function handlers deployed by Cloudflare and never create a live order.
   ========================================================================== */

import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { onRequestPost as createOrder } from '../functions/api/create-order.js';
import { onRequestPost as verifyPayment } from '../functions/api/verify-payment.js';
import {
  onRequestGet as webhookGet,
  onRequestPost as receiveWebhook
} from '../functions/api/webhook/razorpay.js';
import {
  ORDER_CONTEXT_TTL_SECONDS,
  createOrderContext,
  signHmacHex,
  verifyOrderContext
} from '../functions/_lib/razorpay.js';

const SITE_ORIGIN = 'https://openstudydeck.com';
const ORDER_ID = 'order_TestOrder123';
const PAYMENT_ID = 'pay_TestPayment123';

function makeEnv(overrides = {}) {
  return {
    RAZORPAY_KEY_ID: 'rzp_test_publicKey123',
    RAZORPAY_KEY_SECRET: 'test-api-secret',
    RAZORPAY_WEBHOOK_SECRET: 'test-webhook-secret',
    TURNSTILE_SECRET_KEY: 'test-turnstile-secret',
    ALLOWED_ORIGINS: `${SITE_ORIGIN},https://www.openstudydeck.com`,
    RAZORPAY_MAX_DONATION_CENTS: '100000',
    ...overrides
  };
}

function jsonRequest(path, body, headers = {}) {
  return new Request(`${SITE_ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: SITE_ORIGIN,
      ...headers
    },
    body: JSON.stringify(body)
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function makePaymentProof(env = makeEnv(), overrides = {}) {
  const order = {
    orderId: ORDER_ID,
    amount: 500,
    currency: 'USD',
    ...overrides
  };
  const orderContext = await createOrderContext(order, env.RAZORPAY_KEY_SECRET);
  const signature = await signHmacHex(`${order.orderId}|${PAYMENT_ID}`, env.RAZORPAY_KEY_SECRET);
  return {
    order,
    requestBody: {
      razorpay_payment_id: PAYMENT_ID,
      razorpay_order_id: order.orderId,
      razorpay_signature: signature,
      orderContext
    }
  };
}

describe('Razorpay donation workflow', () => {
  let originalFetch;
  let originalConsoleLog;
  let originalConsoleError;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    console.log = () => {};
    console.error = () => {};
  });

  afterEach(() => {
    global.fetch = originalFetch;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
  });

  test('creates a server-controlled USD order after a successful Turnstile check', async () => {
    const calls = [];
    global.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/siteverify')) {
        return jsonResponse({ success: true });
      }
      if (String(url).endsWith('/v1/orders')) {
        return jsonResponse({ id: ORDER_ID, amount: 500, currency: 'USD' });
      }
      throw new Error(`Unexpected request: ${url}`);
    };

    const response = await createOrder({
      env: makeEnv(),
      request: jsonRequest('/api/create-order', {
        amount: 500,
        currency: 'INR',
        turnstileToken: 'valid-turnstile-token'
      })
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const payload = await response.json();
    assert.deepEqual(Object.keys(payload).sort(), [
      'amount', 'currency', 'keyId', 'orderContext', 'orderId'
    ]);
    assert.equal(payload.orderId, ORDER_ID);
    assert.equal(payload.amount, 500);
    assert.equal(payload.currency, 'USD');
    assert.equal(payload.keyId, 'rzp_test_publicKey123');
    assert.ok(!JSON.stringify(payload).includes('test-api-secret'));

    assert.equal(calls.length, 2);
    const turnstileBody = new URLSearchParams(calls[0].init.body);
    assert.equal(turnstileBody.get('response'), 'valid-turnstile-token');
    const providerBody = JSON.parse(calls[1].init.body);
    assert.equal(providerBody.amount, 500);
    assert.equal(providerBody.currency, 'USD', 'browser-supplied currency must be ignored');
    assert.match(providerBody.receipt, /^don_[0-9a-f-]{36}$/);
    assert.ok(providerBody.receipt.length <= 40);
    assert.deepEqual(providerBody.notes, { source: 'openstudydeck_donation' });

    const context = await verifyOrderContext(payload.orderContext, 'test-api-secret');
    assert.equal(context.valid, true);
    assert.equal(context.payload.orderId, ORDER_ID);
    assert.equal(context.payload.amount, 500);
  });

  test('rejects disallowed origins and invalid amounts before external calls', async () => {
    let fetchCount = 0;
    global.fetch = async () => {
      fetchCount += 1;
      throw new Error('External fetch must not run');
    };

    const badOrigin = await createOrder({
      env: makeEnv(),
      request: jsonRequest('/api/create-order', {
        amount: 500,
        turnstileToken: 'token'
      }, { Origin: 'https://attacker.example' })
    });
    assert.equal(badOrigin.status, 403);
    assert.equal((await badOrigin.json()).error.code, 'ORIGIN_NOT_ALLOWED');

    const tooLarge = await createOrder({
      env: makeEnv(),
      request: jsonRequest('/api/create-order', {
        amount: 100001,
        turnstileToken: 'token'
      })
    });
    assert.equal(tooLarge.status, 400);
    const amountError = await tooLarge.json();
    assert.equal(amountError.error.code, 'INVALID_AMOUNT');
    assert.equal(amountError.error.maximum, 100000);
    assert.equal(fetchCount, 0);
  });

  test('fails closed when Turnstile rejects and does not contact Razorpay', async () => {
    const calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).includes('/siteverify')) {
        return jsonResponse({ success: false, 'error-codes': ['invalid-input-response'] });
      }
      throw new Error('Razorpay must not be called after failed Turnstile validation');
    };

    const response = await createOrder({
      env: makeEnv(),
      request: jsonRequest('/api/create-order', {
        amount: 500,
        turnstileToken: 'invalid-token'
      })
    });

    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, 'TURNSTILE_FAILED');
    assert.equal(calls.length, 1);
  });

  test('maps rejected Razorpay credentials to a controlled configuration error', async () => {
    global.fetch = async (url) => {
      if (String(url).includes('/siteverify')) {
        return jsonResponse({ success: true });
      }
      return jsonResponse({ error: { code: 'BAD_REQUEST_ERROR' } }, 401);
    };

    const response = await createOrder({
      env: makeEnv(),
      request: jsonRequest('/api/create-order', {
        amount: 500,
        turnstileToken: 'valid-token'
      })
    });

    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'PAYMENT_CONFIGURATION_ERROR');
  });

  test('confirms only a signature-authenticated, provider-captured payment', async () => {
    const env = makeEnv();
    const proof = await makePaymentProof(env);
    let providerRequest = null;
    global.fetch = async (url, init) => {
      providerRequest = { url: String(url), init };
      return jsonResponse({
        id: PAYMENT_ID,
        order_id: ORDER_ID,
        amount: 500,
        currency: 'USD',
        status: 'captured',
        captured: true
      });
    };

    const response = await verifyPayment({
      env,
      request: jsonRequest('/api/verify-payment', proof.requestBody)
    });

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload, {
      verified: true,
      confirmed: true,
      status: 'captured',
      orderId: ORDER_ID,
      paymentId: PAYMENT_ID,
      amount: 500,
      currency: 'USD'
    });
    assert.equal(providerRequest.url, `https://api.razorpay.com/v1/payments/${PAYMENT_ID}`);
    assert.match(providerRequest.init.headers.Authorization, /^Basic /);
  });

  test('rejects a forged checkout signature without querying Razorpay', async () => {
    const env = makeEnv();
    const proof = await makePaymentProof(env);
    proof.requestBody.razorpay_signature = '0'.repeat(64);
    let fetchCount = 0;
    global.fetch = async () => {
      fetchCount += 1;
      throw new Error('Provider fetch must not run for a forged callback');
    };

    const response = await verifyPayment({
      env,
      request: jsonRequest('/api/verify-payment', proof.requestBody)
    });

    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'PAYMENT_SIGNATURE_INVALID');
    assert.equal(fetchCount, 0);
  });

  test('reports authorized payments as pending and requires consistent captured state', async () => {
    const env = makeEnv();
    const proof = await makePaymentProof(env);
    const providerResponses = [
      {
        id: PAYMENT_ID,
        order_id: ORDER_ID,
        amount: 500,
        currency: 'USD',
        status: 'authorized',
        captured: false
      },
      {
        id: PAYMENT_ID,
        order_id: ORDER_ID,
        amount: 500,
        currency: 'USD',
        status: 'failed',
        captured: true
      }
    ];
    global.fetch = async () => jsonResponse(providerResponses.shift());

    const pending = await verifyPayment({
      env,
      request: jsonRequest('/api/verify-payment', proof.requestBody)
    });
    assert.equal(pending.status, 202);
    assert.deepEqual(await pending.json(), {
      verified: true,
      confirmed: false,
      status: 'authorized',
      orderId: ORDER_ID,
      paymentId: PAYMENT_ID,
      amount: 500,
      currency: 'USD'
    });

    const contradictory = await verifyPayment({
      env,
      request: jsonRequest('/api/verify-payment', proof.requestBody)
    });
    assert.equal(contradictory.status, 402);
    assert.equal((await contradictory.json()).error.code, 'PAYMENT_FAILED');
  });

  test('rejects provider details that do not match the signed order context', async () => {
    const env = makeEnv();
    const proof = await makePaymentProof(env);
    global.fetch = async () => jsonResponse({
      id: PAYMENT_ID,
      order_id: ORDER_ID,
      amount: 999,
      currency: 'USD',
      status: 'captured',
      captured: true
    });

    const response = await verifyPayment({
      env,
      request: jsonRequest('/api/verify-payment', proof.requestBody)
    });

    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'PAYMENT_SIGNATURE_INVALID');
  });

  test('signed order contexts reject tampering and expiry without storage', async () => {
    const nowMs = Date.UTC(2026, 7, 25, 12, 0, 0);
    const token = await createOrderContext({
      orderId: ORDER_ID,
      amount: 500,
      currency: 'USD'
    }, 'context-secret', nowMs);

    assert.equal((await verifyOrderContext(token, 'context-secret', nowMs)).valid, true);
    const tampered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
    assert.equal((await verifyOrderContext(tampered, 'context-secret', nowMs)).valid, false);
    const expiredAt = nowMs + (ORDER_CONTEXT_TTL_SECONDS + 1) * 1000;
    assert.equal((await verifyOrderContext(token, 'context-secret', expiredAt)).valid, false);
  });

  test('accepts the existing hyphenated webhook binding and is duplicate-safe', async () => {
    const rawBody = JSON.stringify({
      event: 'payment.captured',
      payload: {
        payment: {
          entity: {
            id: PAYMENT_ID,
            order_id: ORDER_ID,
            amount: 500,
            currency: 'USD',
            status: 'captured'
          }
        }
      }
    }, null, 2);
    const signature = await signHmacHex(rawBody, 'legacy-webhook-secret');
    const env = makeEnv({
      RAZORPAY_WEBHOOK_SECRET: undefined,
      'RAZORPAY-WEBHOOK': 'legacy-webhook-secret'
    });

    const send = () => receiveWebhook({
      env,
      request: new Request(`${SITE_ORIGIN}/api/webhook/razorpay`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Razorpay-Signature': signature,
          'X-Razorpay-Event-Id': 'evt_duplicate_test'
        },
        body: rawBody
      })
    });

    const first = await send();
    const duplicate = await send();
    assert.equal(first.status, 200);
    assert.equal(duplicate.status, 200);
    assert.deepEqual(await first.json(), { received: true, tracked: true });
    assert.deepEqual(await duplicate.json(), { received: true, tracked: true });
  });

  test('verifies a webhook before parsing and acknowledges unknown valid events', async () => {
    const invalidSignature = await receiveWebhook({
      env: makeEnv(),
      request: new Request(`${SITE_ORIGIN}/api/webhook/razorpay`, {
        method: 'POST',
        headers: { 'X-Razorpay-Signature': '0'.repeat(64) },
        body: '{not valid json'
      })
    });
    assert.equal(invalidSignature.status, 400);
    assert.equal((await invalidSignature.json()).error.code, 'PAYMENT_SIGNATURE_INVALID');

    const rawPrimitive = 'null';
    const primitiveSignature = await signHmacHex(rawPrimitive, 'test-webhook-secret');
    const primitive = await receiveWebhook({
      env: makeEnv(),
      request: new Request(`${SITE_ORIGIN}/api/webhook/razorpay`, {
        method: 'POST',
        headers: { 'X-Razorpay-Signature': primitiveSignature },
        body: rawPrimitive
      })
    });
    assert.equal(primitive.status, 400);
    assert.equal((await primitive.json()).error.code, 'INVALID_REQUEST');

    const rawUnknownEvent = JSON.stringify({ event: 'refund.processed', payload: {} });
    const signature = await signHmacHex(rawUnknownEvent, 'test-webhook-secret');
    const unknown = await receiveWebhook({
      env: makeEnv(),
      request: new Request(`${SITE_ORIGIN}/api/webhook/razorpay`, {
        method: 'POST',
        headers: { 'X-Razorpay-Signature': signature },
        body: rawUnknownEvent
      })
    });
    assert.equal(unknown.status, 200);
    assert.deepEqual(await unknown.json(), { received: true, tracked: false });
  });

  test('rejects oversized webhook bodies and exposes only POST', async () => {
    const oversized = 'x'.repeat(256 * 1024 + 1);
    const response = await receiveWebhook({
      env: makeEnv(),
      request: new Request(`${SITE_ORIGIN}/api/webhook/razorpay`, {
        method: 'POST',
        headers: { 'X-Razorpay-Signature': '0'.repeat(64) },
        body: oversized
      })
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, 'INVALID_REQUEST');

    const getResponse = await webhookGet();
    assert.equal(getResponse.status, 405);
    assert.equal(getResponse.headers.get('Allow'), 'POST');
  });
});
