/* ==========================================================================
   BYOK API KEY FORMAT VALIDATION
   Local, format-only validation for a user-supplied Gemini API key. Google
   remains the sole authority on whether a key is authentic, active,
   correctly restricted, or has available quota — this only rejects input
   that clearly cannot be a raw key value (empty, wrapped in quotes/env-var
   syntax, containing whitespace or control characters, an unreasonable
   length, or characters outside the safe set). It deliberately does not
   require any specific prefix: Google has issued multiple valid Gemini key
   formats (legacy "AIza..." keys and newer "AQ...." authorization keys) and
   may issue more in the future.
   ========================================================================== */

const MIN_KEY_LENGTH = 20;
const MAX_KEY_LENGTH = 200;

// Conservative safe-character set: letters, digits, and the punctuation
// Google's own key formats are known to use (hyphen, underscore, period).
const SAFE_KEY_CHARS = /^[A-Za-z0-9._-]+$/;

// Never throws — always returns { valid: false, reason } or { valid: true, value }.
export function validateApiKeyFormat(rawValue) {
  const asString = rawValue === null || rawValue === undefined ? '' : String(rawValue);
  const value = asString.trim();

  if (!value) {
    return { valid: false, reason: 'Please enter your Gemini API key.' };
  }

  if (/\s/.test(value)) {
    return {
      valid: false,
      reason: 'The API key contains spaces or line breaks. Copy only the key value from Google AI Studio.'
    };
  }

  if (value.length < MIN_KEY_LENGTH) {
    return { valid: false, reason: 'That value looks too short to be a Gemini API key.' };
  }

  if (value.length > MAX_KEY_LENGTH) {
    return {
      valid: false,
      reason: 'That value is too long to be a Gemini API key. Paste only the key itself, not an entire file or document.'
    };
  }

  // Catches control characters and any other unsupported character in one
  // pass — anything that isn't a letter, digit, hyphen, underscore, or
  // period (including surrounding quotes or an "ENV_VAR=" prefix) fails here.
  if (!SAFE_KEY_CHARS.test(value)) {
    return {
      valid: false,
      reason: 'The API key contains unsupported characters. Copy only the key itself, without quotes or an environment-variable name.'
    };
  }

  return { valid: true, value };
}
