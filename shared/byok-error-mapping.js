/* ==========================================================================
   BYOK PROVIDER ERROR MAPPING
   Maps an error thrown by `ai.models.generateContent()` (the @google/genai
   SDK, called directly from the browser with the user's own key) to a
   low-cardinality internal failure category plus an actionable, safe
   user-facing message.

   The SDK's ApiError shape is: `err.status` (HTTP status number) and
   `err.message` (a JSON string of Google's response body, e.g.
   `{"error":{"code":401,"status":"UNAUTHENTICATED","message":"..."}}`).
   Some environments/older SDK versions only surface a plain string message
   (not valid JSON) — detection here works either way, and never depends on
   matching one exact message string.

   Never logs, returns, or embeds the caller's API key, the full raw Google
   error body, request content, or generated content. Only a short category
   slug and a hand-written sentence are ever returned.
   ========================================================================== */

// Every category this module can return — kept low-cardinality and stable
// so it's safe to send as an Analytics dimension.
export const BYOK_FAILURE_CATEGORIES = Object.freeze([
  'auth_key_unsupported',
  'invalid_key',
  'key_disabled',
  'quota',
  'rate_limit',
  'model_unavailable',
  'network',
  'unknown'
]);

function safeParseJson(str) {
  if (typeof str !== 'string') return null;
  try {
    const parsed = JSON.parse(str);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    return null;
  }
}

// Pulls out whatever Google gave us, regardless of whether the SDK error's
// `.message` was valid JSON, a plain string, or absent entirely.
function extractErrorInfo(err) {
  const httpStatus = err && typeof err.status === 'number' ? err.status : null;
  const rawMessage = err && typeof err.message === 'string' ? err.message : '';
  const parsed = safeParseJson(rawMessage);
  const googleError = parsed && parsed.error && typeof parsed.error === 'object' ? parsed.error : null;

  const code = httpStatus !== null
    ? httpStatus
    : (googleError && typeof googleError.code === 'number' ? googleError.code : null);
  const status = (googleError && typeof googleError.status === 'string') ? googleError.status : null;
  const details = (googleError && Array.isArray(googleError.details)) ? googleError.details : [];
  const reason = details.map(d => d && typeof d.reason === 'string' && d.reason).find(Boolean) || null;

  // Fallback textual haystack for the "equivalent structured/stringified
  // representation" case — covers a plain-string message that still
  // contains the tokens we care about even though it didn't parse as JSON.
  const haystack = rawMessage.toUpperCase();

  return { code, status, reason, haystack, rawMessage };
}

const NETWORK_PATTERN = /FAILED TO FETCH|NETWORKERROR|LOAD FAILED|ERR_INTERNET_DISCONNECTED|ERR_NETWORK|ERR_CONNECTION/;

export function mapByokErrorToFailure(err) {
  const info = extractErrorInfo(err);

  const isUnauthenticated = info.code === 401 || info.status === 'UNAUTHENTICATED' || info.haystack.includes('UNAUTHENTICATED');
  const isAccessTokenUnsupported =
    info.reason === 'ACCESS_TOKEN_TYPE_UNSUPPORTED' ||
    info.haystack.includes('ACCESS_TOKEN_TYPE_UNSUPPORTED') ||
    info.haystack.includes('EXPECTED OAUTH 2 ACCESS TOKEN');

  if (isUnauthenticated && isAccessTokenUnsupported) {
    return {
      failureCategory: 'auth_key_unsupported',
      message: 'Google rejected this authorization key before generation began. Some newly issued Gemini auth keys may not be fully provisioned for API requests yet. Check the key and linked project in Google AI Studio, or create a new key in another project. Do not paste an OAuth access token. Guest Access remains available while you resolve the key.'
    };
  }

  const isDisabledOrRevoked =
    info.reason === 'SERVICE_DISABLED' ||
    info.haystack.includes('SERVICE_DISABLED') ||
    info.haystack.includes('HAS BEEN DISABLED') ||
    info.haystack.includes('KEY HAS BEEN REVOKED') ||
    info.haystack.includes('API KEY EXPIRED') ||
    info.haystack.includes('API_KEY_EXPIRED');

  if (isDisabledOrRevoked) {
    return {
      failureCategory: 'key_disabled',
      message: 'This Gemini API key or its project access appears to be disabled, revoked, or expired. Check the key status and API enablement in Google AI Studio or Google Cloud Console.'
    };
  }

  const isInvalidKey =
    info.code === 400 ||
    info.code === 403 ||
    isUnauthenticated ||
    info.reason === 'API_KEY_INVALID' ||
    info.haystack.includes('API_KEY_INVALID') ||
    info.haystack.includes('API KEY NOT VALID');

  if (isInvalidKey) {
    return {
      failureCategory: 'invalid_key',
      message: 'Invalid API Key. Please verify it in settings.'
    };
  }

  if (info.code === 429) {
    if (info.haystack.includes('QUOTA')) {
      return {
        failureCategory: 'quota',
        message: 'Request limit exceeded. Please wait a minute before retrying.'
      };
    }
    return {
      failureCategory: 'rate_limit',
      message: 'Too many requests right now. Please wait a moment and try again.'
    };
  }

  if (info.code === 404 || (info.haystack.includes('MODEL') && info.haystack.includes('NOT FOUND'))) {
    return {
      failureCategory: 'model_unavailable',
      message: 'The selected Gemini model is unavailable right now. Try a different model or try again shortly.'
    };
  }

  if (info.code === null && (!info.rawMessage || NETWORK_PATTERN.test(info.haystack))) {
    return {
      failureCategory: 'network',
      message: 'Network failure while contacting Google. Check your connection and try again.'
    };
  }

  return {
    failureCategory: 'unknown',
    message: 'Something went wrong while contacting Google. Please try again.'
  };
}
