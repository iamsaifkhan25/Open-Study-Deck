# Cloudflare Guest AI Setup

This document walks the repository owner through configuring **Guest Access**
(no-API-key study deck generation) on Cloudflare Pages. It only covers
infrastructure setup — the application code (`functions/api/generate-study-deck.js`,
`functions/api/public-config.js`, `shared/study-config.js`) is already in the
repository and needs no code changes to go live once these steps are done.

No real secret values are included anywhere in this document or the repo.
Every credential below is created and stored by you, outside of git.

---

## 1. Create a production Gemini API key

1. Go to [Google AI Studio](https://aistudio.google.com/).
2. Create (or choose) a Google Cloud project you're comfortable using for a
   shared, server-side credential — this is separate from any personal BYOK
   key a visitor might use.
3. Generate an API key for that project.
4. Set up billing and quota alerts on that project (see step 12) before
   enabling Guest Access in production — this key will serve every guest
   visitor, not just you.

## 2. Store the key as a Cloudflare Pages secret

1. Cloudflare dashboard → **Workers & Pages** → your Pages project →
   **Settings** → **Environment variables**.
2. Add a variable named `GEMINI_API_KEY`, set its value to the key from
   step 1, and mark it as **Secret** (encrypted, not visible after saving).
3. Do this separately for the **Production** and **Preview** environments
   (see step 10) — you may want a different, lower-quota key for Preview.

## 3. Configure the guest model

1. Add an environment variable named `GEMINI_GUEST_MODEL`.
2. Set it to a Gemini model your key has access to (e.g. a fast/cheap model
   suited to a free shared tier). This does **not** need to be marked secret.
3. The browser cannot override this value — `functions/api/generate-study-deck.js`
   always uses the server-configured model, and fails clearly with
   `SERVER_CONFIGURATION_ERROR` if this variable is missing, rather than
   silently falling back to a potentially expensive model.

## 4. Create a Cloudflare Turnstile widget

1. Cloudflare dashboard → **Turnstile** → **Add site**.
2. Add the hostnames that will serve the app:
   - `openstudydeck.com`
   - `www.openstudydeck.com` (if that hostname is actually used)
3. Choose a managed/non-interactive challenge mode (or your preferred
   Turnstile mode).
4. Cloudflare will generate a **Site Key** (public) and a **Secret Key**
   (private) for this widget.

## 5. Store the Turnstile keys

1. Add `TURNSTILE_SITE_KEY` as a normal (non-secret) environment variable —
   the frontend needs to read this value via `/api/public-config` to render
   the widget, so it must not be marked Secret.
2. Add `TURNSTILE_SECRET_KEY` as a **Secret** environment variable — this is
   only ever used server-side in `functions/_lib/turnstile.js` to verify
   tokens against Cloudflare's siteverify endpoint.

## 6. Create a KV namespace

1. Cloudflare dashboard → **Workers & Pages** → **KV**.
2. Create a new namespace (e.g. `openstudydeck-guest-usage`).

## 7. Bind the KV namespace to the Pages project

1. Pages project → **Settings** → **Functions** → **KV namespace bindings**.
2. Add a binding with variable name exactly `GUEST_USAGE`, pointing at the
   namespace created in step 6.
3. `functions/_lib/quota.js` reads/writes this binding directly — no code
   changes are needed once it's bound.

## 8. Create the rate-limit salt

1. Generate a long, random secret (e.g. `openssl rand -hex 32`).
2. Add it as `RATE_LIMIT_SALT`, marked **Secret**.
3. This salt is mixed into the SHA-256 hash of (visitor IP + UTC date) used
   as the KV key for guest quota tracking — it ensures the hash can't be
   brute-forced back to an IP address by a third party who doesn't know the
   salt. Rotating this value effectively resets everyone's daily quota
   bucket (a new hash space), so avoid rotating it casually.

## 9. Configure the remaining guest variables

Add these as normal (non-secret) environment variables:

| Variable | Example | Purpose |
|---|---|---|
| `GUEST_MODE_ENABLED` | `true` | Master on/off switch for Guest Access. |
| `GUEST_DAILY_LIMIT` | `5` | Successful guest generations allowed per visitor per UTC day. |
| `ALLOWED_ORIGINS` | `https://openstudydeck.com,https://www.openstudydeck.com` | Comma-separated allowlist checked against the request's `Origin` header as a defense-in-depth measure (Turnstile + KV quota are the primary abuse controls). Include local dev origins (e.g. `http://localhost:5173`) only in non-production environments. |
| `GEMINI_GUEST_MAX_OUTPUT_TOKENS` | *(unset)* | Optional. Not secret. Overrides the mode-aware output-token budget (`shared/study-config.js` `OUTPUT_TOKEN_BUDGETS` — summary 4096, eli5 4096, flashcards 6144, notes 12288) for every guest generation, regardless of mode. Must be a safe integer between 256 and 16384; any missing or out-of-range value is ignored and the mode-aware default is used instead. The browser can never override this — it is only ever read from the server environment. |

## 10. Configure Production and Preview environments separately

Cloudflare Pages lets you set different values per environment. Recommended
approach:

- **Production:** real `GEMINI_API_KEY`, real `TURNSTILE_SITE_KEY` /
  `TURNSTILE_SECRET_KEY` for your live domains, `ALLOWED_ORIGINS` limited to
  your real domains only.
- **Preview:** either a separate low-quota Gemini key, or set
  `GUEST_MODE_ENABLED=false` for Preview deployments if you don't want guest
  traffic hitting preview URLs at all.

## 11. Redeploy after creating bindings

Environment variable and KV binding changes take effect on the **next**
deployment — trigger a redeploy (push a commit, or use "Retry deployment")
after completing steps 2–10.

## 12. Configure Google API quotas and billing alerts

Before enabling Guest Access for real traffic:

1. In Google Cloud Console, set a budget alert on the project tied to
   `GEMINI_API_KEY`.
2. Review Gemini API quota limits for the project and confirm they're
   appropriate for `GUEST_DAILY_LIMIT` × your expected visitor count.
3. Remember `GUEST_DAILY_LIMIT` is a best-effort, per-visitor limiter (see
   the limitations note in `functions/_lib/quota.js`) — it reduces abuse but
   is not a hard billing guarantee on its own.

## 13. Disable guest access instantly

Set `GUEST_MODE_ENABLED=false` (any value other than the exact string
`true`) and redeploy, or update the variable and it will apply on the next
deployment. `functions/api/generate-study-deck.js` returns a controlled
`GUEST_MODE_DISABLED` error immediately, before touching Gemini, Turnstile,
or KV. BYOK continues working normally — disabling guest access never
affects BYOK.

## 14. Local development

Two supported local setups:

**A. Plain `npm run dev` (fastest, no Wrangler required)**

- Copy `.env.example` to `.env` and fill in the guest-related variables you
  want to test (`GEMINI_API_KEY`, `GEMINI_GUEST_MODEL`, Turnstile keys,
  `RATE_LIMIT_SALT`, `GUEST_MODE_ENABLED`, `GUEST_DAILY_LIMIT`).
- `vite.config.js` mocks `/api/generate-study-deck` and `/api/public-config`
  by directly invoking the real handler functions from `functions/api/`,
  with an in-memory stand-in for the `GUEST_USAGE` KV namespace (state resets
  when the dev server restarts).
- For Turnstile, use Cloudflare's official testing keys so the widget works
  without needing a real registered site:
  - Always passes: site key `1x00000000000000000000AA`,
    secret key `1x0000000000000000000000000000AA`
  - Always blocks: site key `2x00000000000000000000AB`,
    secret key `2x0000000000000000000000000000AA`
  - Forces an interactive challenge: site key `3x00000000000000000000FF`
  - These still require internet access — the Turnstile widget script and
    verification call both talk to Cloudflare over the network even with
    test keys.

**B. `wrangler pages dev` (production-parity, real bindings)**

- Copy `.dev.vars.example` to `.dev.vars` (already gitignored — never
  commit it) and fill in the same variables.
- Run `npx wrangler pages dev -- npm run dev` to proxy Wrangler's Pages
  runtime (real KV bindings, real Functions routing) in front of the Vite
  dev server.
- This is the closest local approximation of production behavior, useful
  for verifying KV persistence and binding configuration before deploying.

## 15. Verify no server secret appears in the built frontend

After running `npm run build`:

- Search `dist/` for the literal values of `GEMINI_API_KEY`,
  `TURNSTILE_SECRET_KEY`, and `RATE_LIMIT_SALT` — they must not appear
  anywhere (Vite's client bundle never has access to these; they only exist
  as Cloudflare Pages environment variables read inside `functions/`, which
  run server-side and are never bundled into `dist/assets/*.js`).
- Only `TURNSTILE_SITE_KEY` and `GUEST_DAILY_LIMIT` are intentionally
  visible to the browser, and only via the runtime `/api/public-config`
  response — never hardcoded into the built JS/HTML.
- If you ever add a new environment variable, remember: anything prefixed
  for Vite's client build (`VITE_*` in `import.meta.env`) would be publicly
  bundled — none of the guest/Turnstile/analytics secrets should ever be
  given that prefix or referenced from `app.js`.
