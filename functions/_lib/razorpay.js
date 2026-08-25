/* ==========================================================================
   RAZORPAY DONATIONS — SHARED SERVER UTILITIES

   Open Study Deck does not keep a local payment database. Razorpay remains
   the durable ledger, while an expiring HMAC-signed order context lets the
   verification endpoint recover the exact server-created order details
   without trusting mutable browser state.

   Never log secrets, signatures, Turnstile tokens, or Razorpay payloads that
   may contain payer data. Structured transaction-state logs are deliberately
   limited to provider IDs, amount, currency, status, and event ID.
   ========================================================================== */

export const PAYMENT_CURRENCY = 'USD';
export const MIN_DONATION_CENTS = 100;
export const DEFAULT_MAX_DONATION_CENTS = 100000;
export const MAX_PAYMENT_JSON_BYTES = 8 * 1024;
export const MAX_WEBHOOK_BYTES = 256 * 1024;
export const ORDER_CONTEXT_TTL_SECONDS = 2 * 60 * 60;

const RAZORPAY_API_BASE = 'https://api.razorpay.com/v1';
const RAZORPAY_TIMEOUT_MS = 10000;
const ORDER_CONTEXT_DOMAIN = 'openstudydeck:razorpay-order-context:v1';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const PAYMENT_JSON_HEADERS = {
  'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer'
};

const PAYMENT_ERROR_DEFS = {
  INVALID_REQUEST: { status: 400, message: 'The payment request is invalid.' },
  INVALID_AMOUNT: { status: 400, message: 'Enter a donation amount within the allowed range.' },
  ORIGIN_NOT_ALLOWED: { status: 403, message: 'This payment request is not allowed.' },
  TURNSTILE_REQUIRED: { status: 400, message: 'Please complete the verification challenge and try again.' },
  TURNSTILE_FAILED: { status: 403, message: 'Verification failed. Please retry the challenge.' },
  ORDER_CONTEXT_INVALID: { status: 400, message: 'The payment session is invalid or has expired. Please start again.' },
  PAYMENT_SIGNATURE_INVALID: { status: 400, message: 'The payment could not be authenticated.' },
  PAYMENT_NOT_CONFIRMED: { status: 409, message: 'The payment has not been confirmed yet.' },
  PAYMENT_FAILED: { status: 402, message: 'Razorpay reported that the payment failed.' },
  PAYMENT_CONFIGURATION_ERROR: { status: 503, message: 'Payments are temporarily unavailable.' },
  PAYMENT_PROVIDER_ERROR: { status: 502, message: 'Razorpay could not be reached. Please try again.' },
  METHOD_NOT_ALLOWED: { status: 405, message: 'Method not allowed.' },
  UNKNOWN_ERROR: { status: 500, message: 'Payment processing failed. Please try again.' }
};

export function paymentJsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...PAYMENT_JSON_HEADERS, ...extraHeaders }
  });
}

export function paymentErrorResponse(code, extra = {}) {
  const known = Object.prototype.hasOwnProperty.call(PAYMENT_ERROR_DEFS, code);
  const safeCode = known ? code : 'UNKNOWN_ERROR';
  const def = PAYMENT_ERROR_DEFS[safeCode];
  return paymentJsonResponse({
    error: {
      code: safeCode,
      message: def.message,
      ...extra
    }
  }, def.status, safeCode === 'METHOD_NOT_ALLOWED' ? { Allow: 'POST' } : {});
}

export function logPaymentEvent(level, details) {
  const safeLevel = level === 'error' ? 'error' : 'log';
  console[safeLevel](JSON.stringify({
    scope: 'razorpay-donations',
    ...details
  }));
}

export function getMaxDonationCents(env) {
  const configured = Number(env.RAZORPAY_MAX_DONATION_CENTS);
  return Number.isSafeInteger(configured) && configured >= MIN_DONATION_CENTS
    ? configured
    : DEFAULT_MAX_DONATION_CENTS;
}

export function isValidDonationAmount(amount, maxAmount) {
  return Number.isSafeInteger(amount) &&
    amount >= MIN_DONATION_CENTS &&
    amount <= maxAmount;
}

export function isAllowedPaymentOrigin(request, allowedOriginsEnv) {
  const origin = request.headers.get('Origin');
  if (!origin) return false;

  const configured = String(allowedOriginsEnv || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);

  if (configured.length > 0) return configured.includes(origin);

  try {
    return new URL(request.url).origin === origin;
  } catch (error) {
    return false;
  }
}

export async function readRequestBytes(request, maxBytes) {
  const contentLengthHeader = request.headers.get('Content-Length');
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0 || contentLength > maxBytes) {
      return { ok: false };
    }
  }

  if (!request.body) return { ok: true, bytes: new Uint8Array() };

  const reader = request.body.getReader();
  const chunks = [];
  let byteLength = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        await reader.cancel();
        return { ok: false };
      }
      chunks.push(value);
    }
  } catch (error) {
    return { ok: false };
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}

export async function readJsonRequest(request, maxBytes = MAX_PAYMENT_JSON_BYTES) {
  const contentType = request.headers.get('Content-Type') || '';
  if (!contentType.toLowerCase().startsWith('application/json')) {
    return { ok: false, response: paymentErrorResponse('INVALID_REQUEST') };
  }

  const bodyResult = await readRequestBytes(request, maxBytes);
  if (!bodyResult.ok) {
    return { ok: false, response: paymentErrorResponse('INVALID_REQUEST') };
  }

  try {
    const value = JSON.parse(decoder.decode(bodyResult.bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, response: paymentErrorResponse('INVALID_REQUEST') };
    }
    return { ok: true, value };
  } catch (error) {
    return { ok: false, response: paymentErrorResponse('INVALID_REQUEST') };
  }
}

function bytesToHex(bytes) {
  return Array.from(bytes)
    .map(value => value.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2) {
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  }
  return bytes;
}

async function importHmacKey(secret, usage) {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage]
  );
}

function asMessageBytes(message) {
  if (typeof message === 'string') return encoder.encode(message);
  if (message instanceof Uint8Array) return message;
  if (message instanceof ArrayBuffer) return new Uint8Array(message);
  if (ArrayBuffer.isView(message)) {
    return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  }
  throw new TypeError('HMAC input must be a string or BufferSource.');
}

export async function signHmacHex(message, secret) {
  const key = await importHmacKey(secret, 'sign');
  const signature = await crypto.subtle.sign('HMAC', key, asMessageBytes(message));
  return bytesToHex(new Uint8Array(signature));
}

export async function verifyHmacHex(message, providedSignature, secret) {
  const signatureBytes = hexToBytes(providedSignature);
  if (!signatureBytes || !secret) return false;

  try {
    const key = await importHmacKey(secret, 'verify');
    return crypto.subtle.verify('HMAC', key, signatureBytes, asMessageBytes(message));
  } catch (error) {
    return false;
  }
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4);
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch (error) {
    return null;
  }
}

export function isRazorpayOrderId(value) {
  return typeof value === 'string' && /^order_[A-Za-z0-9]+$/.test(value);
}

export function isRazorpayPaymentId(value) {
  return typeof value === 'string' && /^pay_[A-Za-z0-9]+$/.test(value);
}

export async function createOrderContext(order, secret, nowMs = Date.now()) {
  const issuedAt = Math.floor(nowMs / 1000);
  const payload = {
    v: 1,
    orderId: order.orderId,
    amount: order.amount,
    currency: order.currency,
    iat: issuedAt,
    exp: issuedAt + ORDER_CONTEXT_TTL_SECONDS
  };
  const encodedPayload = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await signHmacHex(`${ORDER_CONTEXT_DOMAIN}.${encodedPayload}`, secret);
  return `${encodedPayload}.${signature}`;
}

export async function verifyOrderContext(token, secret, nowMs = Date.now()) {
  if (typeof token !== 'string' || token.length > 2048) return { valid: false };
  const parts = token.split('.');
  if (parts.length !== 2) return { valid: false };
  const [encodedPayload, signature] = parts;

  const authentic = await verifyHmacHex(`${ORDER_CONTEXT_DOMAIN}.${encodedPayload}`, signature, secret);
  if (!authentic) return { valid: false };

  const payloadBytes = base64UrlToBytes(encodedPayload);
  if (!payloadBytes) return { valid: false };

  try {
    const payload = JSON.parse(decoder.decode(payloadBytes));
    const now = Math.floor(nowMs / 1000);
    const valid = payload &&
      payload.v === 1 &&
      isRazorpayOrderId(payload.orderId) &&
      Number.isSafeInteger(payload.amount) &&
      payload.amount >= MIN_DONATION_CENTS &&
      payload.currency === PAYMENT_CURRENCY &&
      Number.isSafeInteger(payload.iat) &&
      Number.isSafeInteger(payload.exp) &&
      payload.iat <= now + 300 &&
      payload.exp >= now;

    return valid ? { valid: true, payload } : { valid: false };
  } catch (error) {
    return { valid: false };
  }
}

function createBasicAuth(keyId, keySecret) {
  return `Basic ${btoa(`${keyId}:${keySecret}`)}`;
}

export async function fetchRazorpayJson(env, path, options = {}) {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
    return { ok: false, configurationError: true, status: 0, data: null };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), RAZORPAY_TIMEOUT_MS);

  try {
    const response = await fetch(`${RAZORPAY_API_BASE}${path}`, {
      method: options.method || 'GET',
      headers: {
        Authorization: createBasicAuth(env.RAZORPAY_KEY_ID, env.RAZORPAY_KEY_SECRET),
        ...(options.body ? { 'Content-Type': 'application/json' } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });

    let data = null;
    try {
      data = await response.json();
    } catch (error) {
      data = null;
    }

    return {
      ok: response.ok,
      status: response.status,
      data,
      authenticationError: response.status === 401 || response.status === 403
    };
  } catch (error) {
    return { ok: false, status: 0, data: null, networkError: true };
  } finally {
    clearTimeout(timeoutId);
  }
}
