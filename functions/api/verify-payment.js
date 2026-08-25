/* ==========================================================================
   POST /api/verify-payment
   Authenticates Razorpay's checkout callback, then asks Razorpay for the
   current payment state. A browser callback is never treated as proof that
   funds were captured.
   ========================================================================== */

import {
  PAYMENT_CURRENCY,
  fetchRazorpayJson,
  isAllowedPaymentOrigin,
  isRazorpayOrderId,
  isRazorpayPaymentId,
  logPaymentEvent,
  paymentErrorResponse,
  paymentJsonResponse,
  readJsonRequest,
  verifyHmacHex,
  verifyOrderContext
} from '../_lib/razorpay.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) {
      logPaymentEvent('error', { action: 'verify_payment', result: 'configuration_error' });
      return paymentErrorResponse('PAYMENT_CONFIGURATION_ERROR');
    }

    if (!isAllowedPaymentOrigin(request, env.PAYMENT_ALLOWED_ORIGINS || env.ALLOWED_ORIGINS)) {
      return paymentErrorResponse('ORIGIN_NOT_ALLOWED');
    }

    const parsed = await readJsonRequest(request);
    if (!parsed.ok) return parsed.response;

    const {
      razorpay_payment_id: paymentId,
      razorpay_order_id: callbackOrderId,
      razorpay_signature: signature,
      orderContext
    } = parsed.value;

    if (!isRazorpayPaymentId(paymentId) ||
        !isRazorpayOrderId(callbackOrderId) ||
        typeof signature !== 'string') {
      return paymentErrorResponse('INVALID_REQUEST');
    }

    const contextResult = await verifyOrderContext(orderContext, env.RAZORPAY_KEY_SECRET);
    if (!contextResult.valid || callbackOrderId !== contextResult.payload.orderId) {
      return paymentErrorResponse('ORDER_CONTEXT_INVALID');
    }

    const expectedMessage = `${contextResult.payload.orderId}|${paymentId}`;
    const signatureValid = await verifyHmacHex(expectedMessage, signature, env.RAZORPAY_KEY_SECRET);
    if (!signatureValid) {
      logPaymentEvent('error', {
        action: 'verify_payment',
        result: 'signature_invalid',
        orderId: contextResult.payload.orderId,
        paymentId
      });
      return paymentErrorResponse('PAYMENT_SIGNATURE_INVALID');
    }

    const provider = await fetchRazorpayJson(env, `/payments/${encodeURIComponent(paymentId)}`);
    if (!provider.ok || !provider.data) {
      logPaymentEvent('error', {
        action: 'verify_payment',
        result: 'provider_error',
        orderId: contextResult.payload.orderId,
        paymentId,
        providerStatus: provider.status || null
      });
      return paymentErrorResponse(provider.configurationError || provider.authenticationError
        ? 'PAYMENT_CONFIGURATION_ERROR'
        : 'PAYMENT_PROVIDER_ERROR');
    }

    const payment = provider.data;
    const detailsMatch = payment.id === paymentId &&
      payment.order_id === contextResult.payload.orderId &&
      payment.amount === contextResult.payload.amount &&
      payment.currency === PAYMENT_CURRENCY;

    if (!detailsMatch) {
      logPaymentEvent('error', {
        action: 'verify_payment',
        result: 'provider_details_mismatch',
        orderId: contextResult.payload.orderId,
        paymentId
      });
      return paymentErrorResponse('PAYMENT_SIGNATURE_INVALID');
    }

    if (payment.status === 'captured' && payment.captured === true) {
      logPaymentEvent('log', {
        action: 'payment_confirmed',
        orderId: contextResult.payload.orderId,
        paymentId,
        amount: contextResult.payload.amount,
        currency: PAYMENT_CURRENCY,
        status: 'captured'
      });
      return paymentJsonResponse({
        verified: true,
        confirmed: true,
        status: 'captured',
        orderId: contextResult.payload.orderId,
        paymentId,
        amount: contextResult.payload.amount,
        currency: PAYMENT_CURRENCY
      });
    }

    if (payment.status === 'authorized') {
      logPaymentEvent('log', {
        action: 'payment_pending_capture',
        orderId: contextResult.payload.orderId,
        paymentId,
        amount: contextResult.payload.amount,
        currency: PAYMENT_CURRENCY,
        status: 'authorized'
      });
      return paymentJsonResponse({
        verified: true,
        confirmed: false,
        status: 'authorized',
        orderId: contextResult.payload.orderId,
        paymentId,
        amount: contextResult.payload.amount,
        currency: PAYMENT_CURRENCY
      }, 202);
    }

    if (payment.status === 'failed') {
      return paymentErrorResponse('PAYMENT_FAILED');
    }

    return paymentErrorResponse('PAYMENT_NOT_CONFIRMED', {
      providerStatus: typeof payment.status === 'string' ? payment.status : 'unknown'
    });
  } catch (error) {
    logPaymentEvent('error', { action: 'verify_payment', result: 'unhandled_error' });
    return paymentErrorResponse('UNKNOWN_ERROR');
  }
}

export async function onRequestGet() {
  return paymentErrorResponse('METHOD_NOT_ALLOWED');
}
