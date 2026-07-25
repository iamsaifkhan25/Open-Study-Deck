/* ==========================================================================
   GUEST GENERATION — CONTROLLED ERROR CODES
   Every error returned by the guest endpoint uses one of these codes so the
   frontend can show a specific, safe, student-facing message. Never expose
   stack traces, secret values, or raw upstream response bodies here.
   ========================================================================== */

export const SAFE_JSON_HEADERS = {
  'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer'
};

const GUEST_ERROR_DEFS = {
  GUEST_MODE_DISABLED: { status: 503, message: 'Guest access is currently unavailable. Please use your own Gemini API key.' },
  TURNSTILE_REQUIRED: { status: 400, message: 'Please complete the verification challenge and try again.' },
  TURNSTILE_FAILED: { status: 403, message: 'Verification failed. Please retry the challenge.' },
  GUEST_DAILY_LIMIT_REACHED: { status: 429, message: "Guest access has reached today's allowance." },
  INVALID_INPUT: { status: 400, message: 'Your request could not be processed. Please check your input and try again.' },
  INPUT_TOO_LARGE: { status: 413, message: 'Your submission is too large for guest access.' },
  UNSUPPORTED_FILE_TYPE: { status: 415, message: 'That image type is not supported.' },
  MODEL_UNAVAILABLE: { status: 502, message: 'The guest AI model is temporarily unavailable.' },
  GEMINI_RATE_LIMIT: { status: 429, message: 'Too many requests right now. Please wait a moment and try again.' },
  GEMINI_QUOTA_EXCEEDED: { status: 429, message: 'The guest service has reached its usage quota. Please try again later.' },
  GEMINI_SAFETY_BLOCK: { status: 422, message: 'The AI declined to process this content.' },
  GEMINI_SERVICE_UNAVAILABLE: { status: 502, message: "Google's AI service is temporarily unavailable." },
  SERVER_CONFIGURATION_ERROR: { status: 500, message: 'Guest access is temporarily misconfigured. Please use your own Gemini API key.' },
  RESPONSE_TOO_LONG: { status: 422, message: 'The generated study deck was too large to complete reliably. Try a shorter source, choose Summary mode, or split the material into smaller sections.' },
  RESPONSE_INCOMPLETE: { status: 422, message: 'The AI returned an incomplete study deck. Please try again. If the source is very long, use a shorter section.' },
  RESPONSE_INVALID_FORMAT: { status: 502, message: 'The AI returned an incomplete study deck. Please try again. If the source is very long, use a shorter section.' },
  RESPONSE_EMPTY: { status: 502, message: "Google's AI service did not return usable study content. Please retry with clearer source material." },
  UNKNOWN_ERROR: { status: 500, message: 'Something went wrong. Please try again.' }
};

export function guestErrorResponse(code, extra = {}) {
  const known = Object.prototype.hasOwnProperty.call(GUEST_ERROR_DEFS, code);
  const def = known ? GUEST_ERROR_DEFS[code] : GUEST_ERROR_DEFS.UNKNOWN_ERROR;
  const body = {
    error: {
      code: known ? code : 'UNKNOWN_ERROR',
      message: def.message,
      ...extra
    }
  };
  return new Response(JSON.stringify(body), {
    status: def.status,
    headers: SAFE_JSON_HEADERS
  });
}
