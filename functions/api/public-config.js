/* ==========================================================================
   GET /api/public-config
   Returns only non-secret values the frontend needs to decide whether guest
   mode is available and to render the Turnstile widget. Never include
   GEMINI_API_KEY, TURNSTILE_SECRET_KEY, RATE_LIMIT_SALT, or any other secret.
   ========================================================================== */

export async function onRequestGet(context) {
  const { env } = context;

  const body = {
    guestModeEnabled: env.GUEST_MODE_ENABLED === 'true',
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || null,
    guestDailyLimit: Number(env.GUEST_DAILY_LIMIT) > 0 ? Number(env.GUEST_DAILY_LIMIT) : 5
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}
