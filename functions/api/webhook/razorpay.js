/* ==========================================================================
   POST /api/webhook/razorpay
   Database-free Razorpay workflow tracking. The raw request body is verified
   before JSON parsing. Accepted events produce structured, non-PII Cloudflare
   logs; they do not trigger fulfilment, email, or another repeatable side
   effect, so duplicate and out-of-order deliveries are safe.
   ========================================================================== */

import {
  MAX_WEBHOOK_BYTES,
  logPaymentEvent,
  paymentErrorResponse,
  paymentJsonResponse,
  readRequestBytes,
  verifyHmacHex
} from '../../_lib/razorpay.js';

const TRACKED_EVENTS = new Set([
  'payment.authorized',
  'payment.captured',
  'payment.failed',
  'order.paid'
]);

function getEntity(payload, name) {
  const entity = payload && payload[name] && payload[name].entity;
  return entity && typeof entity === 'object' ? entity : null;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    // The underscore name is canonical. Keep the previous hyphenated alias
    // temporarily so an older deployment/configuration rollback fails safely.
    const webhookSecret = env.RAZORPAY_WEBHOOK_SECRET || env['RAZORPAY-WEBHOOK'];
    if (!webhookSecret) {
      logPaymentEvent('error', { action: 'webhook', result: 'configuration_error' });
      return paymentErrorResponse('PAYMENT_CONFIGURATION_ERROR');
    }

    const bodyResult = await readRequestBytes(request, MAX_WEBHOOK_BYTES);
    if (!bodyResult.ok) {
      return paymentErrorResponse('INVALID_REQUEST');
    }

    const signature = request.headers.get('X-Razorpay-Signature');
    const signatureValid = await verifyHmacHex(bodyResult.bytes, signature, webhookSecret);
    if (!signatureValid) {
      logPaymentEvent('error', { action: 'webhook', result: 'signature_invalid' });
      return paymentErrorResponse('PAYMENT_SIGNATURE_INVALID');
    }

    let event;
    try {
      event = JSON.parse(new TextDecoder().decode(bodyResult.bytes));
    } catch (error) {
      return paymentErrorResponse('INVALID_REQUEST');
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      return paymentErrorResponse('INVALID_REQUEST');
    }

    const eventType = typeof event.event === 'string' ? event.event : 'unknown';
    const eventId = request.headers.get('X-Razorpay-Event-Id') || null;
    const payment = getEntity(event.payload, 'payment');
    const order = getEntity(event.payload, 'order');

    if (!TRACKED_EVENTS.has(eventType)) {
      logPaymentEvent('log', {
        action: 'webhook_ignored',
        eventId,
        eventType
      });
      return paymentJsonResponse({ received: true, tracked: false });
    }

    logPaymentEvent(eventType === 'payment.failed' ? 'error' : 'log', {
      action: 'webhook_received',
      eventId,
      eventType,
      paymentId: payment && typeof payment.id === 'string' ? payment.id : null,
      orderId: payment && typeof payment.order_id === 'string'
        ? payment.order_id
        : (order && typeof order.id === 'string' ? order.id : null),
      amount: payment && Number.isSafeInteger(payment.amount)
        ? payment.amount
        : (order && Number.isSafeInteger(order.amount) ? order.amount : null),
      currency: payment && typeof payment.currency === 'string'
        ? payment.currency
        : (order && typeof order.currency === 'string' ? order.currency : null),
      status: payment && typeof payment.status === 'string'
        ? payment.status
        : (order && typeof order.status === 'string' ? order.status : null)
    });

    return paymentJsonResponse({ received: true, tracked: true });
  } catch (error) {
    logPaymentEvent('error', { action: 'webhook', result: 'unhandled_error' });
    return paymentErrorResponse('UNKNOWN_ERROR');
  }
}

export async function onRequestGet() {
  return paymentErrorResponse('METHOD_NOT_ALLOWED');
}
