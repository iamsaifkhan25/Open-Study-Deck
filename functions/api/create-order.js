/* ==========================================================================
   POST /api/create-order
   Creates a server-controlled USD donation order after Turnstile validation.
   The signed orderContext binds the order ID, amount, currency, and expiry so
   /api/verify-payment never has to trust those values from browser state.
   ========================================================================== */

import { verifyTurnstileToken } from '../_lib/turnstile.js';
import {
  PAYMENT_CURRENCY,
  createOrderContext,
  fetchRazorpayJson,
  getMaxDonationCents,
  isAllowedPaymentOrigin,
  isRazorpayOrderId,
  isValidDonationAmount,
  logPaymentEvent,
  paymentErrorResponse,
  paymentJsonResponse,
  readJsonRequest
} from '../_lib/razorpay.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET || !env.TURNSTILE_SECRET_KEY) {
      logPaymentEvent('error', { action: 'create_order', result: 'configuration_error' });
      return paymentErrorResponse('PAYMENT_CONFIGURATION_ERROR');
    }

    if (!isAllowedPaymentOrigin(request, env.PAYMENT_ALLOWED_ORIGINS || env.ALLOWED_ORIGINS)) {
      return paymentErrorResponse('ORIGIN_NOT_ALLOWED');
    }

    const parsed = await readJsonRequest(request);
    if (!parsed.ok) return parsed.response;

    const { amount, turnstileToken } = parsed.value;
    const maxAmount = getMaxDonationCents(env);
    if (!isValidDonationAmount(amount, maxAmount)) {
      return paymentErrorResponse('INVALID_AMOUNT', {
        minimum: 100,
        maximum: maxAmount,
        currency: PAYMENT_CURRENCY
      });
    }

    if (!turnstileToken || typeof turnstileToken !== 'string') {
      return paymentErrorResponse('TURNSTILE_REQUIRED');
    }

    const remoteIp = request.headers.get('CF-Connecting-IP') || undefined;
    const turnstileResult = await verifyTurnstileToken(turnstileToken, env.TURNSTILE_SECRET_KEY, remoteIp);
    if (!turnstileResult.success) {
      return paymentErrorResponse('TURNSTILE_FAILED');
    }

    const receipt = `don_${crypto.randomUUID()}`;
    const provider = await fetchRazorpayJson(env, '/orders', {
      method: 'POST',
      body: {
        amount,
        currency: PAYMENT_CURRENCY,
        receipt,
        notes: { source: 'openstudydeck_donation' }
      }
    });

    if (!provider.ok || !provider.data) {
      logPaymentEvent('error', {
        action: 'create_order',
        result: 'provider_error',
        providerStatus: provider.status || null
      });
      return paymentErrorResponse(provider.configurationError || provider.authenticationError
        ? 'PAYMENT_CONFIGURATION_ERROR'
        : 'PAYMENT_PROVIDER_ERROR');
    }

    const order = provider.data;
    if (!isRazorpayOrderId(order.id) || order.amount !== amount || order.currency !== PAYMENT_CURRENCY) {
      logPaymentEvent('error', {
        action: 'create_order',
        result: 'invalid_provider_response',
        providerStatus: provider.status
      });
      return paymentErrorResponse('PAYMENT_PROVIDER_ERROR');
    }

    const orderContext = await createOrderContext({
      orderId: order.id,
      amount,
      currency: PAYMENT_CURRENCY
    }, env.RAZORPAY_KEY_SECRET);

    logPaymentEvent('log', {
      action: 'order_created',
      orderId: order.id,
      amount,
      currency: PAYMENT_CURRENCY
    });

    return paymentJsonResponse({
      orderId: order.id,
      amount,
      currency: PAYMENT_CURRENCY,
      keyId: env.RAZORPAY_KEY_ID,
      orderContext
    });
  } catch (error) {
    logPaymentEvent('error', { action: 'create_order', result: 'unhandled_error' });
    return paymentErrorResponse('UNKNOWN_ERROR');
  }
}

export async function onRequestGet() {
  return paymentErrorResponse('METHOD_NOT_ALLOWED');
}
