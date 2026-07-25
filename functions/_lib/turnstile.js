/* ==========================================================================
   CLOUDFLARE TURNSTILE — SERVER-SIDE VERIFICATION
   Client-side widget completion is never trusted on its own. Every guest
   generation must pass this siteverify check before Gemini is called.
   ========================================================================== */

const SITEVERIFY_ENDPOINT = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export async function verifyTurnstileToken(token, secretKey, remoteIp) {
  if (!token || typeof token !== 'string') {
    return { success: false, reason: 'missing-token' };
  }
  if (!secretKey) {
    return { success: false, reason: 'missing-secret' };
  }

  try {
    const form = new URLSearchParams();
    form.append('secret', secretKey);
    form.append('response', token);
    if (remoteIp) form.append('remoteip', remoteIp);

    const res = await fetch(SITEVERIFY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    });

    if (!res.ok) {
      return { success: false, reason: 'siteverify-http-error' };
    }

    const data = await res.json();
    return {
      success: data && data.success === true,
      errorCodes: (data && data['error-codes']) || []
    };
  } catch (err) {
    // Network failure talking to Cloudflare — fail closed, never throw.
    return { success: false, reason: 'network' };
  }
}
