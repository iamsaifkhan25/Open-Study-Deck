/* ==========================================================================
   POST /api/generate-study-deck
   Guest (no-API-key) study deck generation. The server uses its own Gemini
   credential (context.env.GEMINI_API_KEY) and a server-controlled model
   (context.env.GEMINI_GUEST_MODEL) — the browser cannot choose either, nor
   can it influence the output-token budget or retry behaviour.

   Flow: validate input -> verify Turnstile -> check daily quota -> call
   Gemini (with at most one internal compact retry for length-driven
   failures) -> charge quota only on final success -> return the deck.

   Call policy: at most 2 Gemini calls per request — one normal attempt, and
   one compact retry ONLY when the failure is specifically a length problem
   (MAX_TOKENS / truncated JSON / incomplete-structure-at-the-limit). Invalid
   keys, quota exhaustion, safety blocks, rate limits, and ordinary 4xx
   errors are never retried.

   Never logs request/response content or the Gemini credential.
   ========================================================================== */

import {
  isValidStudyMode,
  sanitizeSubjectContext,
  buildModeConfig,
  resolveGuestOutputTokenBudget,
  classifyGeneratedResponse,
  isRetryableForLength,
  RESPONSE_ISSUE,
  MAX_TEXT_INPUT_LENGTH,
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_GUEST_IMAGE_BYTES
} from '../../shared/study-config.js';
import { guestErrorResponse, SAFE_JSON_HEADERS } from '../_lib/errors.js';
import { verifyTurnstileToken } from '../_lib/turnstile.js';
import { getQuotaKey, readGuestUsage, incrementGuestUsage } from '../_lib/quota.js';

// Generous ceiling on the whole request body (JSON wrapper + base64 image
// overhead on top of the ~4MB raw-image cap). Guards against oversized
// payloads before we even attempt to parse them.
const MAX_BODY_BYTES = 6 * 1024 * 1024;

const GEMINI_ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

function isAllowedOrigin(request, allowedOriginsEnv) {
  const origin = request.headers.get('Origin');
  if (!origin) return true; // same-origin requests often omit Origin — other defenses (Turnstile, quota) still apply
  if (!allowedOriginsEnv) return true; // not configured — don't block
  const allowed = allowedOriginsEnv.split(',').map(s => s.trim()).filter(Boolean);
  if (allowed.length === 0) return true;
  return allowed.includes(origin);
}

function base64ByteLength(base64) {
  const clean = base64.replace(/=+$/, '');
  return Math.floor((clean.length * 3) / 4);
}

function extractBase64Payload(rawData) {
  if (typeof rawData !== 'string') return null;
  const payload = rawData.includes(',') ? rawData.split(',').pop() : rawData;
  if (!payload || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) return null;
  return payload;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    if (env.GUEST_MODE_ENABLED !== 'true') {
      return guestErrorResponse('GUEST_MODE_DISABLED');
    }

    if (!env.GEMINI_API_KEY || !env.GEMINI_GUEST_MODEL) {
      // Fail clearly rather than silently choosing a fallback model.
      console.error('generate-study-deck: SERVER_CONFIGURATION_ERROR — missing GEMINI_API_KEY or GEMINI_GUEST_MODEL');
      return guestErrorResponse('SERVER_CONFIGURATION_ERROR');
    }

    if (!isAllowedOrigin(request, env.ALLOWED_ORIGINS)) {
      return guestErrorResponse('INVALID_INPUT');
    }

    const contentLength = Number(request.headers.get('Content-Length') || 0);
    if (contentLength && contentLength > MAX_BODY_BYTES) {
      return guestErrorResponse('INPUT_TOO_LARGE');
    }

    const rawBody = await request.text();
    if (rawBody.length > MAX_BODY_BYTES) {
      return guestErrorResponse('INPUT_TOO_LARGE');
    }

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch (err) {
      return guestErrorResponse('INVALID_INPUT');
    }

    if (!body || typeof body !== 'object') {
      return guestErrorResponse('INVALID_INPUT');
    }

    const { mode, inputType, text, image, subjectContext, turnstileToken } = body;

    if (!isValidStudyMode(mode)) {
      return guestErrorResponse('INVALID_INPUT');
    }
    if (inputType !== 'image' && inputType !== 'text') {
      return guestErrorResponse('INVALID_INPUT');
    }

    let contentPart = null;

    if (inputType === 'text') {
      if (typeof text !== 'string' || !text.trim()) {
        return guestErrorResponse('INVALID_INPUT');
      }
      if (text.length > MAX_TEXT_INPUT_LENGTH) {
        return guestErrorResponse('INPUT_TOO_LARGE');
      }
      contentPart = { text: text.trim() };
    } else {
      if (!image || typeof image !== 'object' || typeof image.mimeType !== 'string') {
        return guestErrorResponse('INVALID_INPUT');
      }
      if (!ALLOWED_IMAGE_MIME_TYPES.includes(image.mimeType)) {
        return guestErrorResponse('UNSUPPORTED_FILE_TYPE');
      }
      const base64Data = extractBase64Payload(image.data);
      if (!base64Data) {
        return guestErrorResponse('INVALID_INPUT');
      }
      if (base64ByteLength(base64Data) > MAX_GUEST_IMAGE_BYTES) {
        return guestErrorResponse('INPUT_TOO_LARGE');
      }
      contentPart = { inlineData: { data: base64Data, mimeType: image.mimeType } };
    }

    const safeSubjectContext = sanitizeSubjectContext(subjectContext);

    // --- Turnstile: never treat client-side widget completion as validation ---
    if (!turnstileToken || typeof turnstileToken !== 'string') {
      return guestErrorResponse('TURNSTILE_REQUIRED');
    }
    if (!env.TURNSTILE_SECRET_KEY) {
      console.error('generate-study-deck: SERVER_CONFIGURATION_ERROR — missing TURNSTILE_SECRET_KEY');
      return guestErrorResponse('SERVER_CONFIGURATION_ERROR');
    }
    const remoteIp = request.headers.get('CF-Connecting-IP') || undefined;
    const turnstileResult = await verifyTurnstileToken(turnstileToken, env.TURNSTILE_SECRET_KEY, remoteIp);
    if (!turnstileResult.success) {
      return guestErrorResponse('TURNSTILE_FAILED');
    }

    // --- Daily quota (checked before spending a Gemini call) ---
    if (!env.GUEST_USAGE) {
      console.error('generate-study-deck: SERVER_CONFIGURATION_ERROR — missing GUEST_USAGE KV binding');
      return guestErrorResponse('SERVER_CONFIGURATION_ERROR');
    }
    const dailyLimit = Number(env.GUEST_DAILY_LIMIT) > 0 ? Number(env.GUEST_DAILY_LIMIT) : 5;
    const quotaKey = await getQuotaKey(request, env.RATE_LIMIT_SALT || '');
    const usage = await readGuestUsage(env.GUEST_USAGE, quotaKey, dailyLimit);
    if (usage.remaining <= 0) {
      return guestErrorResponse('GUEST_DAILY_LIMIT_REACHED', {
        resetsAt: usage.resetsAt,
        usage: { remaining: 0, limit: dailyLimit, resetsAt: usage.resetsAt }
      });
    }

    const sourceLength = inputType === 'text' ? contentPart.text.length : 0;
    const maxOutputTokens = resolveGuestOutputTokenBudget(mode, env.GEMINI_GUEST_MAX_OUTPUT_TOKENS);

    const geminiResult = await generateGuestDeck({
      apiKey: env.GEMINI_API_KEY,
      model: env.GEMINI_GUEST_MODEL,
      contentPart,
      mode,
      safeSubjectContext,
      sourceLength,
      maxOutputTokens
    });

    // Safe diagnostic metadata only — never prompt/source/generated content.
    console.log(`generate-study-deck: mode=${mode} ok=${geminiResult.ok} completion=${geminiResult.completion || 'n/a'} retried=${geminiResult.retried}`);

    if (!geminiResult.ok) {
      return guestErrorResponse(geminiResult.code);
    }

    // Only charge quota for a successful generation — the internal compact
    // retry (if any) never consumes a second daily allowance.
    const newCount = await incrementGuestUsage(env.GUEST_USAGE, quotaKey, usage.count);

    return new Response(JSON.stringify({
      data: geminiResult.data,
      usage: {
        remaining: Math.max(0, dailyLimit - newCount),
        limit: dailyLimit,
        resetsAt: usage.resetsAt
      }
    }), { status: 200, headers: SAFE_JSON_HEADERS });

  } catch (err) {
    // Deliberately generic — never log request/response content or secrets.
    console.error('generate-study-deck: unhandled request error');
    return guestErrorResponse('UNKNOWN_ERROR');
  }
}

// Any non-POST method to this route (GET, PUT, etc.) gets a controlled error
// instead of Cloudflare's default 405 page.
export async function onRequestGet() {
  return guestErrorResponse('INVALID_INPUT');
}

// Maps an internal response-classification issue to a guest-facing
// controlled error code. `completion` disambiguates issues that can arise
// both from a hard MAX_TOKENS cutoff and from other causes.
function mapResponseIssueToErrorCode(issue, completion) {
  switch (issue) {
    case RESPONSE_ISSUE.SAFETY_BLOCK:
      return 'GEMINI_SAFETY_BLOCK';
    case RESPONSE_ISSUE.EMPTY:
      return 'RESPONSE_EMPTY';
    case RESPONSE_ISSUE.MAX_TOKENS_NO_TEXT:
      return 'RESPONSE_TOO_LONG';
    case RESPONSE_ISSUE.TRUNCATED_JSON:
      return completion === 'max_tokens' ? 'RESPONSE_TOO_LONG' : 'RESPONSE_INCOMPLETE';
    case RESPONSE_ISSUE.INVALID_STRUCTURE:
    case RESPONSE_ISSUE.MALFORMED_JSON:
      return 'RESPONSE_INVALID_FORMAT';
    default:
      return 'UNKNOWN_ERROR';
  }
}

// Orchestrates the full guest generation attempt, including the single
// controlled compact retry. Returns { ok, data?, code?, retried, completion }.
async function generateGuestDeck({ apiKey, model, contentPart, mode, safeSubjectContext, sourceLength, maxOutputTokens }) {
  let primaryConfig;
  try {
    primaryConfig = buildModeConfig(mode, safeSubjectContext, sourceLength);
  } catch (err) {
    return { ok: false, code: 'INVALID_INPUT', retried: false };
  }

  const firstAttempt = await fetchGeminiOnce({ apiKey, model, contentPart, modeConfig: primaryConfig, maxOutputTokens });
  if (!firstAttempt.httpOk) {
    return { ok: false, code: firstAttempt.code, retried: false };
  }

  const firstClassification = classifyGeneratedResponse({
    mode,
    text: firstAttempt.text,
    finishReason: firstAttempt.finishReason
  });

  if (firstClassification.issue === RESPONSE_ISSUE.OK) {
    return { ok: true, data: firstClassification.data, retried: false, completion: firstClassification.completion };
  }

  if (!isRetryableForLength(firstClassification.issue)) {
    return {
      ok: false,
      code: mapResponseIssueToErrorCode(firstClassification.issue, firstClassification.completion),
      retried: false,
      completion: firstClassification.completion
    };
  }

  // --- One controlled compact retry, server-constructed instruction only ---
  let compactConfig;
  try {
    compactConfig = buildModeConfig(mode, safeSubjectContext, sourceLength, { compact: true });
  } catch (err) {
    return { ok: false, code: 'INVALID_INPUT', retried: false };
  }

  const retryAttempt = await fetchGeminiOnce({ apiKey, model, contentPart, modeConfig: compactConfig, maxOutputTokens });
  if (!retryAttempt.httpOk) {
    return { ok: false, code: retryAttempt.code, retried: true };
  }

  const retryClassification = classifyGeneratedResponse({
    mode,
    text: retryAttempt.text,
    finishReason: retryAttempt.finishReason
  });

  if (retryClassification.issue === RESPONSE_ISSUE.OK) {
    return { ok: true, data: retryClassification.data, retried: true, completion: retryClassification.completion };
  }

  return {
    ok: false,
    code: mapResponseIssueToErrorCode(retryClassification.issue, retryClassification.completion),
    retried: true,
    completion: retryClassification.completion
  };
}

// A single Gemini REST call. Returns either { httpOk: false, code } for
// transport/HTTP/envelope-level failures, or { httpOk: true, text,
// finishReason } for anything that got a normal candidate response — content
// classification (empty/truncated/malformed/valid) happens one level up.
async function fetchGeminiOnce({ apiKey, model, contentPart, modeConfig, maxOutputTokens }) {
  const { schema, systemInstruction, userPrompt } = modeConfig;

  const requestBody = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: 'user', parts: [contentPart, { text: userPrompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      // Match the BYOK client (app.js), which uses the SDK's
      // `responseJsonSchema` field — the full-JSON-Schema field, not the
      // older/stricter OpenAPI-subset `responseSchema` field. Using the
      // wrong one here caused Gemini to reject these schemas with
      // INVALID_ARGUMENT.
      responseJsonSchema: schema,
      temperature: 0.2,
      maxOutputTokens
    }
  };

  let response;
  try {
    response = await fetch(
      `${GEMINI_ENDPOINT_BASE}/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // Header (not query string) so the credential never appears in a URL.
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify(requestBody)
      }
    );
  } catch (err) {
    console.error('generate-study-deck: network error calling Gemini');
    return { httpOk: false, code: 'GEMINI_SERVICE_UNAVAILABLE' };
  }

  if (!response.ok) {
    let errBody = null;
    try { errBody = await response.json(); } catch (err) { /* non-JSON error body */ }
    const message = ((errBody && errBody.error && errBody.error.message) || '').toLowerCase();
    // Safe to log: HTTP status and Google's short reason code. Never the
    // full message (could echo request specifics) or the API key.
    const googleStatus = (errBody && errBody.error && errBody.error.status) || 'unknown';
    // Google's 4xx validation messages describe OUR request's structure
    // (e.g. "Unknown name X at 'generationConfig'") — they do not echo
    // guest-submitted content, so this is safe to log. Capped defensively.
    const rawMessage = ((errBody && errBody.error && errBody.error.message) || '').slice(0, 300);
    console.error(`generate-study-deck: Gemini call failed — http=${response.status} googleStatus=${googleStatus} message=${rawMessage}`);

    let code = 'UNKNOWN_ERROR';
    if (response.status === 429) {
      code = message.includes('quota') ? 'GEMINI_QUOTA_EXCEEDED' : 'GEMINI_RATE_LIMIT';
    } else if (response.status === 404) {
      code = 'MODEL_UNAVAILABLE';
    } else if (response.status >= 500) {
      code = 'GEMINI_SERVICE_UNAVAILABLE';
    } else if (response.status === 400 || response.status === 403) {
      // Our own server-side key/config is the likely cause, not the guest's input.
      code = 'SERVER_CONFIGURATION_ERROR';
    }
    return { httpOk: false, code };
  }

  let payload;
  try {
    payload = await response.json();
  } catch (err) {
    return { httpOk: false, code: 'UNKNOWN_ERROR' };
  }

  // A prompt-level block (before any candidate is generated) surfaces here
  // rather than on a candidate's finishReason.
  if (payload && payload.promptFeedback && payload.promptFeedback.blockReason) {
    return { httpOk: true, text: null, finishReason: 'SAFETY' };
  }

  const candidate = payload && Array.isArray(payload.candidates) && payload.candidates[0];
  const finishReason = candidate && candidate.finishReason;
  const parts = candidate && candidate.content && candidate.content.parts;
  const textPart = Array.isArray(parts) ? parts.find(p => typeof p.text === 'string') : null;
  const text = textPart ? textPart.text : null;

  return { httpOk: true, text, finishReason };
}
