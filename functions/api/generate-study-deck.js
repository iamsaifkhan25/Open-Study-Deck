/* ==========================================================================
   POST /api/generate-study-deck
   Guest (no-API-key) study deck generation. The server uses its own Gemini
   credential (context.env.GEMINI_API_KEY) and a server-controlled model
   (context.env.GEMINI_GUEST_MODEL) — the browser cannot choose either.

   Flow: validate input -> verify Turnstile -> check daily quota -> call
   Gemini -> charge quota only on success -> return the deck.

   Never logs request/response content or the Gemini credential.
   ========================================================================== */

import {
  isValidStudyMode,
  sanitizeSubjectContext,
  buildModeConfig,
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

    // --- Build the prompt/schema from the validated mode only ---
    let modeConfig;
    try {
      modeConfig = buildModeConfig(mode, safeSubjectContext);
    } catch (err) {
      return guestErrorResponse('INVALID_INPUT');
    }

    const geminiResult = await callGemini({
      apiKey: env.GEMINI_API_KEY,
      model: env.GEMINI_GUEST_MODEL,
      contentPart,
      modeConfig
    });

    if (!geminiResult.ok) {
      return guestErrorResponse(geminiResult.code);
    }

    // Only charge quota for a successful generation.
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

async function callGemini({ apiKey, model, contentPart, modeConfig }) {
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
      temperature: 0.2
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
    return { ok: false, code: 'GEMINI_SERVICE_UNAVAILABLE' };
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
    return { ok: false, code };
  }

  let payload;
  try {
    payload = await response.json();
  } catch (err) {
    return { ok: false, code: 'UNKNOWN_ERROR' };
  }

  const candidate = payload && Array.isArray(payload.candidates) && payload.candidates[0];
  if (!candidate) {
    return { ok: false, code: 'UNKNOWN_ERROR' };
  }
  if (candidate.finishReason === 'SAFETY' || candidate.finishReason === 'PROHIBITED_CONTENT') {
    return { ok: false, code: 'GEMINI_SAFETY_BLOCK' };
  }

  const parts = candidate.content && candidate.content.parts;
  const textPart = Array.isArray(parts) && parts[0] && parts[0].text;
  if (!textPart) {
    return { ok: false, code: 'UNKNOWN_ERROR' };
  }

  let parsed;
  try {
    parsed = JSON.parse(textPart);
  } catch (err) {
    return { ok: false, code: 'UNKNOWN_ERROR' };
  }

  return { ok: true, data: parsed };
}
