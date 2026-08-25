/* ==========================================================================
   RAZORPAY DONATION CHECKOUT — SHARED BROWSER CONTROLLER

   Used by both the main support modal and projects page. Checkout success is
   provisional until /api/verify-payment authenticates the signature and
   confirms Razorpay's captured state.
   ========================================================================== */

const RAZORPAY_SCRIPT_URL = 'https://checkout.razorpay.com/v1/checkout.js';
const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
const CREATE_ORDER_URL = '/api/create-order';
const VERIFY_PAYMENT_URL = '/api/verify-payment';
const PUBLIC_CONFIG_URL = '/api/public-config';
const REQUEST_TIMEOUT_MS = 12000;
const SCRIPT_TIMEOUT_MS = 15000;
const TURNSTILE_TIMEOUT_MS = 30000;
const VERIFY_RETRY_DELAYS_MS = [0, 1500, 3000];
const MIN_DONATION_CENTS = 100;
const MAX_MESSAGE_LENGTH = 2000;
const SUPPORT_EMAIL = 'harukiwaves@zohomail.in';

let razorpayScriptPromise = null;
let turnstileScriptPromise = null;
let publicConfigPromise = null;

class PaymentFlowError extends Error {
  constructor(message, code = 'UNKNOWN_ERROR', details = null) {
    super(message);
    this.name = 'PaymentFlowError';
    this.code = code;
    this.details = details;
  }
}

function loadScriptOnce(src, globalName) {
  if (window[globalName]) return Promise.resolve(true);

  return new Promise((resolve) => {
    let script = Array.from(document.scripts).find(item => item.src === src);
    if (!script) {
      script = document.createElement('script');
      script.src = src;
      script.async = true;
      document.body.appendChild(script);
    }

    let settled = false;
    let timeoutId = null;
    const finish = success => {
      if (settled) return;
      settled = true;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      const loaded = success && Boolean(window[globalName]);
      if (!loaded && script.isConnected) script.remove();
      resolve(loaded);
    };
    script.addEventListener('load', () => finish(true), { once: true });
    script.addEventListener('error', () => finish(false), { once: true });
    timeoutId = window.setTimeout(() => finish(false), SCRIPT_TIMEOUT_MS);

    // A previously loaded script will not emit another load event.
    if (window[globalName]) finish(true);
  });
}

function loadRazorpayCheckout() {
  if (!razorpayScriptPromise) {
    razorpayScriptPromise = loadScriptOnce(RAZORPAY_SCRIPT_URL, 'Razorpay').then(loaded => {
      if (!loaded) razorpayScriptPromise = null;
      return loaded;
    });
  }
  return razorpayScriptPromise;
}

function loadTurnstile() {
  if (!turnstileScriptPromise) {
    turnstileScriptPromise = loadScriptOnce(TURNSTILE_SCRIPT_URL, 'turnstile').then(loaded => {
      if (!loaded) turnstileScriptPromise = null;
      return loaded;
    });
  }
  return turnstileScriptPromise;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    window.clearTimeout(timeoutId);
  }
}

async function readJsonResponse(response) {
  try {
    return await response.json();
  } catch (error) {
    throw new PaymentFlowError('The payment service returned an invalid response.', 'INVALID_RESPONSE');
  }
}

async function postJson(url, body) {
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const payload = await readJsonResponse(response);

  if (!response.ok) {
    const code = payload && payload.error && payload.error.code
      ? payload.error.code
      : 'PAYMENT_REQUEST_FAILED';
    const message = payload && payload.error && payload.error.message
      ? payload.error.message
      : 'The payment request failed.';
    throw new PaymentFlowError(message, code, payload && payload.error ? payload.error : null);
  }

  return { status: response.status, payload };
}

async function getPublicConfig() {
  if (!publicConfigPromise) {
    publicConfigPromise = (async () => {
      const response = await fetchWithTimeout(PUBLIC_CONFIG_URL, {
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) {
        throw new PaymentFlowError('Payment verification is temporarily unavailable.', 'PAYMENT_CONFIGURATION_ERROR');
      }
      return readJsonResponse(response);
    })().catch(error => {
      publicConfigPromise = null;
      throw error;
    });
  }
  return publicConfigPromise;
}

function createTurnstileController(container) {
  let widgetId = null;
  let token = null;
  let pending = null;

  function settlePending(error, nextToken = null) {
    if (!pending) return;
    const current = pending;
    pending = null;
    window.clearTimeout(current.timeoutId);
    if (error) current.reject(error);
    else current.resolve(nextToken);
  }

  async function getToken() {
    if (token) return token;
    if (pending) return pending.promise;

    const config = await getPublicConfig();
    if (!config || typeof config.turnstileSiteKey !== 'string' || !config.turnstileSiteKey) {
      throw new PaymentFlowError('Payment verification is not configured.', 'PAYMENT_CONFIGURATION_ERROR');
    }

    const loaded = await loadTurnstile();
    if (!loaded || !window.turnstile) {
      throw new PaymentFlowError('The security challenge could not load.', 'TURNSTILE_LOAD_FAILED');
    }

    let resolvePending;
    let rejectPending;
    const promise = new Promise((resolve, reject) => {
      resolvePending = resolve;
      rejectPending = reject;
    });
    pending = {
      promise,
      resolve: resolvePending,
      reject: rejectPending,
      timeoutId: window.setTimeout(() => {
        token = null;
        settlePending(new PaymentFlowError('The security challenge timed out.', 'TURNSTILE_TIMEOUT'));
      }, TURNSTILE_TIMEOUT_MS)
    };

    const options = {
      sitekey: config.turnstileSiteKey,
      theme: 'auto',
      size: 'flexible',
      appearance: 'interaction-only',
      callback: nextToken => {
        token = nextToken;
        settlePending(null, nextToken);
      },
      'expired-callback': () => {
        token = null;
      },
      'error-callback': () => {
        token = null;
        settlePending(new PaymentFlowError('The security challenge failed.', 'TURNSTILE_FAILED'));
      }
    };

    try {
      if (widgetId === null) {
        widgetId = window.turnstile.render(container, options);
      } else {
        window.turnstile.reset(widgetId);
      }
    } catch (error) {
      token = null;
      settlePending(new PaymentFlowError('The security challenge failed to start.', 'TURNSTILE_FAILED'));
    }

    return promise;
  }

  function reset() {
    token = null;
    settlePending(new PaymentFlowError('The security challenge was reset.', 'TURNSTILE_RESET'));
    if (window.turnstile && widgetId !== null) {
      try {
        window.turnstile.reset(widgetId);
      } catch (error) {
        // The next submission will recreate/retry the challenge as needed.
      }
    }
  }

  return { getToken, reset };
}

function parseDonationCents(customRadio, customInput) {
  const selected = document.querySelector('input[name="support-tier"]:checked');
  if (!selected) {
    throw new PaymentFlowError('Choose a support amount.', 'INVALID_AMOUNT');
  }

  const rawValue = customRadio.checked ? customInput.value.trim() : selected.value;
  if (!/^\d+(?:\.\d{1,2})?$/.test(rawValue)) {
    throw new PaymentFlowError('Enter an amount with no more than two decimal places.', 'INVALID_AMOUNT');
  }

  const amount = Number(rawValue);
  const cents = Math.round(amount * 100);
  if (!Number.isSafeInteger(cents) || cents < MIN_DONATION_CENTS) {
    throw new PaymentFlowError('The minimum donation is $1.00 USD.', 'INVALID_AMOUNT');
  }
  return cents;
}

function formatUsd(cents) {
  return (cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function userMessageForError(error) {
  const code = error && error.code;
  switch (code) {
    case 'INVALID_AMOUNT':
      if (error.details && Number.isSafeInteger(error.details.maximum)) {
        return `Enter an amount between $1.00 and $${formatUsd(error.details.maximum)} USD.`;
      }
      return error.message;
    case 'TURNSTILE_REQUIRED':
    case 'TURNSTILE_FAILED':
    case 'TURNSTILE_TIMEOUT':
    case 'TURNSTILE_LOAD_FAILED':
      return 'Security verification failed. Please retry the challenge.';
    case 'PAYMENT_CONFIGURATION_ERROR':
      return 'Payments are temporarily unavailable. Please try again later.';
    case 'PAYMENT_PROVIDER_ERROR':
      return 'Razorpay is temporarily unavailable. Please try again shortly.';
    case 'ORDER_CONTEXT_INVALID':
      return 'This payment session expired. Please start a new donation.';
    case 'PAYMENT_SIGNATURE_INVALID':
      return 'The payment could not be authenticated. Please check Razorpay before trying again.';
    case 'PAYMENT_FAILED':
      return 'Razorpay reported that the payment failed. No confirmation was recorded.';
    default:
      return 'Payment processing could not be completed. Please try again.';
  }
}

async function verifyWithRetry(callbackResponse, orderContext) {
  let lastResult = null;
  for (const delayMs of VERIFY_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await new Promise(resolve => window.setTimeout(resolve, delayMs));
    }
    const result = await postJson(VERIFY_PAYMENT_URL, {
      razorpay_payment_id: callbackResponse.razorpay_payment_id,
      razorpay_order_id: callbackResponse.razorpay_order_id,
      razorpay_signature: callbackResponse.razorpay_signature,
      orderContext
    });
    lastResult = result.payload;
    if (lastResult.confirmed === true) return lastResult;
    if (result.status !== 202 || lastResult.status !== 'authorized') return lastResult;
  }
  return lastResult;
}

function prepareSupportEmail(amountCents, message, paymentId) {
  const amount = formatUsd(amountCents);
  const subject = `Support Message for Open Study Deck ($${amount})`;
  const body = `Hi! I have made a confirmed $${amount} USD contribution via Razorpay to support Open Study Deck.\n\nMessage:\n${message}\n\nPayment ID: ${paymentId}`;
  const mailtoUrl = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  window.setTimeout(() => {
    window.location.href = mailtoUrl;
  }, 750);
}

export function initRazorpayDonationFlow(options = {}) {
  const customRadio = document.getElementById('opt-custom');
  const customInput = document.getElementById('custom-support-amount');
  const allRadios = document.querySelectorAll('input[name="support-tier"]');
  const submitBtn = document.getElementById('submit-support-btn');
  const messageArea = document.getElementById('support-message');
  const customAmountGroup = document.getElementById('custom-amount-group');
  const turnstileContainer = document.getElementById('support-turnstile-container');
  const supportModal = document.getElementById('support-modal');

  if (!customRadio || !customInput || !submitBtn || !messageArea ||
      !customAmountGroup || !turnstileContainer || allRadios.length === 0) {
    return false;
  }

  const notify = typeof options.notify === 'function'
    ? options.notify
    : (message => window.alert(message));
  const turnstile = createTurnstileController(turnstileContainer);
  const originalButtonHtml = submitBtn.innerHTML;
  let busy = false;
  let verificationInProgress = false;

  function setButtonLabel(label) {
    const labelNode = submitBtn.querySelector('span');
    if (labelNode) labelNode.textContent = label;
    else submitBtn.textContent = label;
  }

  function restoreButton() {
    submitBtn.disabled = false;
    submitBtn.innerHTML = originalButtonHtml;
    busy = false;
  }

  function resetForm() {
    messageArea.value = '';
    customInput.value = '';
    customAmountGroup.style.display = 'none';
    const defaultTier = document.getElementById('opt-coffee');
    if (defaultTier) defaultTier.checked = true;
    if (supportModal) supportModal.style.display = 'none';
  }

  allRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      if (customRadio.checked) {
        customAmountGroup.style.display = 'block';
        if (!customInput.value) customInput.value = '20';
        customInput.focus();
        customInput.select();
      } else {
        customAmountGroup.style.display = 'none';
        customInput.value = '';
      }
    });
  });

  submitBtn.addEventListener('click', async () => {
    if (busy) return;

    let amountCents;
    try {
      amountCents = parseDonationCents(customRadio, customInput);
    } catch (error) {
      notify(userMessageForError(error), 'warning');
      if (customRadio.checked) customInput.focus();
      return;
    }

    const message = messageArea.value.trim();
    if (message.length > MAX_MESSAGE_LENGTH) {
      notify(`Please keep the optional message under ${MAX_MESSAGE_LENGTH} characters.`, 'warning');
      messageArea.focus();
      return;
    }

    busy = true;
    submitBtn.disabled = true;
    setButtonLabel('Security check...');

    try {
      const [checkoutLoaded, turnstileToken] = await Promise.all([
        loadRazorpayCheckout(),
        turnstile.getToken()
      ]);
      if (!checkoutLoaded) {
        throw new PaymentFlowError('Razorpay Checkout could not load.', 'RAZORPAY_LOAD_FAILED');
      }

      setButtonLabel('Initializing...');
      const orderResult = await postJson(CREATE_ORDER_URL, {
        amount: amountCents,
        turnstileToken
      });
      turnstile.reset();

      const order = orderResult.payload;
      if (!order || typeof order.orderId !== 'string' ||
          typeof order.orderContext !== 'string' ||
          typeof order.keyId !== 'string' ||
          order.amount !== amountCents || order.currency !== 'USD') {
        throw new PaymentFlowError('The order response was invalid.', 'INVALID_RESPONSE');
      }

      const checkout = new window.Razorpay({
        key: order.keyId,
        amount: order.amount,
        currency: order.currency,
        name: 'Open Study Deck',
        description: 'Support the Creator',
        order_id: order.orderId,
        handler: response => {
          verificationInProgress = true;
          setButtonLabel('Confirming payment...');

          void (async () => {
            try {
              const verified = await verifyWithRetry(response, order.orderContext);
              if (verified && verified.confirmed === true) {
                notify(`Thank you! Your $${formatUsd(amountCents)} USD payment is confirmed.`, 'success', 5000);
                resetForm();
                if (message) prepareSupportEmail(amountCents, message, verified.paymentId);
              } else {
                notify('Your payment was authenticated and is awaiting capture. Please do not pay again; Razorpay will finalize its status.', 'warning', 8000);
                resetForm();
              }
            } catch (error) {
              console.error('Razorpay payment verification failed.');
              notify('Razorpay returned a payment result, but this site could not confirm it. Please do not retry immediately; check your Razorpay receipt or contact the developer.', 'error', 10000);
              resetForm();
            } finally {
              verificationInProgress = false;
              restoreButton();
            }
          })();
        },
        prefill: { name: '', email: '', contact: '' },
        theme: { color: '#18181b' },
        modal: {
          ondismiss: () => {
            if (!verificationInProgress) restoreButton();
          }
        }
      });

      checkout.on('payment.failed', response => {
        const reason = response && response.error && response.error.reason
          ? response.error.reason
          : 'unknown';
        console.error(`Razorpay checkout failed: ${reason}`);
        notify('The payment was not completed. You can review the details in Razorpay and try again.', 'error', 7000);
        restoreButton();
      });

      checkout.open();
      setButtonLabel('Complete in Razorpay...');
    } catch (error) {
      console.error('Razorpay checkout initialization failed.');
      turnstile.reset();
      notify(userMessageForError(error), 'error', 7000);
      restoreButton();
    }
  });

  return true;
}
