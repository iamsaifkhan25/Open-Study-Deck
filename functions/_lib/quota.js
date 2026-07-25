/* ==========================================================================
   GUEST DAILY QUOTA (Cloudflare KV)
   Tracks a per-visitor daily generation count without ever storing the raw
   IP address. The visitor identifier is a salted SHA-256 hash of
   (IP + UTC date), so the KV record cannot be reversed back to an IP and
   automatically rotates to a new key every day.

   This is a best-effort abuse deterrent, not a billing-grade limiter — KV is
   eventually consistent, so a burst of near-simultaneous requests from the
   same visitor could occasionally slip a request or two past the limit.
   ========================================================================== */

function currentUtcDateString(now = new Date()) {
  return now.toISOString().slice(0, 10); // YYYY-MM-DD
}

function nextUtcMidnight(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
}

async function hashVisitor(ip, dateStr, salt) {
  const encoder = new TextEncoder();
  const data = encoder.encode(`${ip}:${dateStr}:${salt}`);
  const digestBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digestBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// Derives the day-scoped, hashed KV key for the connecting visitor.
// Never pass the raw IP to a caller that might persist or log it.
export async function getQuotaKey(request, salt) {
  const ip =
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('x-real-ip') ||
    '0.0.0.0';
  const dateStr = currentUtcDateString();
  const hash = await hashVisitor(ip, dateStr, salt || '');
  return `guest:${dateStr}:${hash}`;
}

export async function readGuestUsage(kv, key, limit) {
  let raw = null;
  try {
    raw = await kv.get(key);
  } catch (err) {
    // If KV is temporarily unreachable, treat the visitor as having full
    // quota rather than hard-failing guest access for everyone.
    raw = null;
  }
  const count = raw ? (parseInt(raw, 10) || 0) : 0;
  const resetsAt = nextUtcMidnight().toISOString();
  return {
    count,
    remaining: Math.max(0, limit - count),
    resetsAt
  };
}

export async function incrementGuestUsage(kv, key, currentCount) {
  const nextCount = currentCount + 1;
  const ttlSeconds = Math.ceil((nextUtcMidnight().getTime() - Date.now()) / 1000) + 3600; // +1hr buffer
  try {
    await kv.put(key, String(nextCount), { expirationTtl: Math.max(60, ttlSeconds) });
  } catch (err) {
    // Best-effort only — a failed write just means this increment won't
    // persist; it must never block the response to the visitor.
  }
  return nextCount;
}
