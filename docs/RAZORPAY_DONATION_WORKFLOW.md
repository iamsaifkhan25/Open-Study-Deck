# Razorpay Donation Workflow

This is the operator guide for Open Study Deck's database-free Razorpay
integration. Razorpay is the durable payment ledger. Open Study Deck creates
and verifies orders with Cloudflare Pages Functions, while structured
Cloudflare logs provide short-term workflow diagnostics.

No D1, Postgres, or payment-specific KV namespace is required for the current
flow.

## Architecture

```text
Browser
  |-- Turnstile token + integer USD cents --> POST /api/create-order
  |                                             |
  |                                             +--> Razorpay Orders API
  |<-- order ID + public key + signed context --|
  |
  +-- Razorpay Checkout
         |
         +-- callback IDs + signature --> POST /api/verify-payment
         |                                  |-- verify HMAC
         |                                  +-- GET Razorpay payment
         |<-- captured / pending / failed --|
         |
Razorpay +-- signed event --> POST /api/webhook/razorpay
                               |-- verify exact raw bytes first
                               +-- emit structured, non-PII log
```

The signed order context is an expiring HMAC token containing the server-created
order ID, amount, currency, issue time, and expiry. It lets the verification
Function recover trusted order data without storing a local record.

## Implemented endpoints

| Endpoint | Purpose | Important guarantees |
| --- | --- | --- |
| `POST /api/create-order` | Validate Turnstile and create a Razorpay order | Allowed-origin check, bounded JSON body, integer amount limits, server-owned `USD`, unique receipt, provider response validation |
| `POST /api/verify-payment` | Authenticate Checkout and confirm provider state | Signed context validation, Razorpay callback HMAC validation, provider lookup, exact order/amount/currency match, success only when `status=captured` and `captured=true` |
| `POST /api/webhook/razorpay` | Receive asynchronous lifecycle events | Bounded streaming read, byte-exact HMAC before JSON parsing, safe handling of duplicate/out-of-order events, structured logs only |
| `GET /api/public-config` | Supply the public Turnstile site key | Returns no secrets and uses `Cache-Control: no-store` |

All other methods on payment endpoints return `405` where explicitly handled.

## Environment variables

Store production secrets as encrypted Cloudflare Pages secrets. Never put real
values in Git, client JavaScript, `.env.example`, documentation, tickets, or
chat messages.

| Name | Required | Secret | Notes |
| --- | --- | --- | --- |
| `RAZORPAY_KEY_ID` | Yes | Treat as configuration | Use the key ID from the same Razorpay mode/account as the secret |
| `RAZORPAY_KEY_SECRET` | Yes | Yes | Used only by Pages Functions and never returned to the browser |
| `RAZORPAY_WEBHOOK_SECRET` | Yes | Yes | A separate webhook signing secret; it is not the API key secret |
| `TURNSTILE_SITE_KEY` | Yes | No | Returned by `/api/public-config` so the browser can render Turnstile |
| `TURNSTILE_SECRET_KEY` | Yes | Yes | Validates each order-creation challenge server-side |
| `ALLOWED_ORIGINS` | Yes | No | Existing comma-separated site allowlist |
| `PAYMENT_ALLOWED_ORIGINS` | Optional | No | Payment-only override; otherwise `ALLOWED_ORIGINS` is used |
| `RAZORPAY_MAX_DONATION_CENTS` | Optional | No | Safe-integer ceiling; defaults to `100000` ($1,000 USD) |

For local Vite development use `.env`; for `wrangler pages dev` use
`.dev.vars`. Both real files are ignored by Git. Use Razorpay Test Mode locally.
Vite refuses an `rzp_live_` key unless the owner deliberately sets
`ALLOW_LIVE_RAZORPAY_LOCAL=true`.

## Cloudflare configuration audit (2026-08-25)

The production Pages project was inspected read-only. No secret values were
displayed or downloaded.

- `openstudydeck.com` and `openstudydeck.pages.dev` are attached to the same
  Pages project, with `master` as the production branch.
- The production secret list contains `RAZORPAY_KEY_ID`,
  `RAZORPAY_KEY_SECRET`, and the canonical `RAZORPAY_WEBHOOK_SECRET`; the old
  `RAZORPAY-WEBHOOK` binding is no longer present.
- The existing allowed-origin configuration covers the apex and `www` site
  origins. Payment endpoints inherit it unless `PAYMENT_ALLOWED_ORIGINS` is
  later added.
- The configured Turnstile widget covers both production hostnames. Reusing
  its site/secret key pair for a second widget on the donation form is
  supported and does not conflict with the Guest Access widget.
- There is no D1 binding and no payment-specific KV binding. The sole
  `GUEST_USAGE` KV namespace remains isolated to the Guest Access quota.
- Preview does not currently have the payment/Turnstile secret set required
  for checkout, so preview payment attempts fail closed. Use test-only preview
  bindings if preview QA is later required.
- Recent history contained both Git-triggered and manual/ad-hoc production
  deployments. Git deployment is now documented as canonical and the local
  command is named `deploy:manual` to reduce duplicate releases.

This audit proves binding names and topology, not that two encrypted secret
values match. Only a successful signed Razorpay test webhook can prove the
Dashboard secret and Cloudflare secret are identical. It also does not mean
the local source changes in this document are live until a deployment occurs.

## Razorpay Dashboard setup

Configure one webhook in the Razorpay Dashboard:

- URL: `https://openstudydeck.com/api/webhook/razorpay`
- Active events:
  - `payment.authorized`
  - `payment.captured`
  - `payment.failed`
  - `order.paid`
- Secret: exactly the same value stored in Cloudflare as
  `RAZORPAY_WEBHOOK_SECRET`

Use a randomly generated webhook secret that is unrelated to
`RAZORPAY_KEY_SECRET`. Enable automatic capture in Razorpay if donations should
be confirmed immediately. With manual capture, the site correctly reports an
authenticated payment as pending until Razorpay changes it to `captured`.

Razorpay requires webhook validation against the unmodified request body and
recommends using `x-razorpay-event-id` to recognize duplicate deliveries. The
handler follows both rules. See Razorpay's official
[webhook validation guide](https://razorpay.com/docs/webhooks/validate-test/)
and [Standard Checkout integration guide](https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/integration-steps/).

## Workflow tracking without a database

Use the Razorpay Dashboard as the authoritative transaction record. Search
Cloudflare Pages Function logs for JSON records whose `scope` is
`razorpay-donations`. The implemented actions are:

- `order_created`
- `payment_pending_capture`
- `payment_confirmed`
- `webhook_received`
- `webhook_ignored`
- controlled error results such as `signature_invalid` or `provider_error`

Logs contain only workflow fields such as Razorpay order/payment/event IDs,
amount, currency, state, and provider HTTP status. They intentionally exclude
API secrets, webhook signatures, Turnstile tokens, full Razorpay payloads,
names, email addresses, phone numbers, card/bank details, and the optional
support message.

The same valid webhook can be delivered more than once. That is safe today
because the handler only records a log and returns an acknowledgement; it does
not send mail, grant access, issue a refund, or perform any other repeatable
side effect.

## Limitations and their fixes

| Current limitation | Present behavior | Fix if requirements grow |
| --- | --- | --- |
| No Open Study Deck payment history | Razorpay remains the durable ledger; Cloudflare logs are diagnostic and retention depends on the Cloudflare plan | Add a payment table or durable event store only if an in-app ledger/reconciliation view becomes necessary |
| No durable webhook deduplication | Safe because the webhook has no side effects | Before adding email, entitlements, accounting exports, or refunds, store `x-razorpay-event-id` and enforce idempotency with D1/KV/Durable Objects or another durable store |
| Optional message uses `mailto:` | The browser prepares an email only after capture; the site does not store or guarantee delivery of the message | Add a transactional email service only with authenticated server execution, abuse controls, and durable idempotency |
| Capture may be delayed | Client verifies up to three times and then tells the donor not to pay again; webhook logs the later state | Enable Razorpay automatic capture or add a status page backed by durable storage |
| Donations are server-locked to USD | Razorpay rejects order creation if the account is not enabled for the required international/currency capability | Confirm USD/international payments are enabled in the Razorpay account, or make a deliberate end-to-end currency change in the server, UI, tests, and policy copy |
| No refund automation | Refunds and disputes are handled from the Razorpay Dashboard | Add a separately authenticated owner-only workflow if automated refunds are ever required |
| Shared Turnstile widget analytics | Guest generation and donations use separate widgets in the page but the same configured site key, so challenge analytics are combined | Create a second Turnstile widget and a payment-specific public/secret key pair only if separated analytics or policy is needed |
| Preview environment has no payment secrets | Preview checkout fails closed with a controlled configuration error | Add Razorpay Test Mode and Turnstile test bindings to Cloudflare Preview if preview payment QA is desired |
| No site-wide Content Security Policy yet | Global anti-sniffing, anti-framing, referrer, and browser-permission headers are set, but existing inline scripts and several trusted CDNs make a safe CSP migration non-trivial | Inventory every required Razorpay, Turnstile, Gemini, analytics, font, and CDN origin; deploy `Content-Security-Policy-Report-Only`; resolve reports; then enforce the tested policy |

The current design deliberately avoids a database. A database or durable KV
becomes necessary only when a webhook starts causing a business side effect or
when Open Study Deck itself must retain a transaction history.

## Security and secret rotation

If any production secret is pasted outside Razorpay/Cloudflare secret stores,
commit it accidentally, or otherwise becomes visible, rotate it. For the
webhook secret:

1. Generate a fresh high-entropy value in a password manager or trusted local
   cryptographic tool.
2. Replace the secret in the Razorpay webhook configuration and the encrypted
   Cloudflare `RAZORPAY_WEBHOOK_SECRET` binding during the same maintenance
   window.
3. Deploy no source-code change; the handler reads the binding at runtime.
4. Send a Razorpay test webhook and confirm HTTP `200` plus a matching
   `webhook_received` log.
5. Remove the old value from any local notes or password-manager history where
   appropriate.

Do not print secret values to verify them. Cloudflare can confirm that a secret
binding exists, but its encrypted value cannot be read back. Matching is proven
with a successfully signed Razorpay test delivery.

## Deployment and conflict prevention

The Cloudflare Pages project is Git-connected to the `master` production
branch. Treat that integration as the normal deployment path. The repository's
CLI command is intentionally named `npm run deploy:manual`; use it only for an
explicit recovery/manual release. Running both Git deployment and manual Pages
deployment for the same commit creates duplicate production deployments.

The Pages runtime does not require `nodejs_compat`; payment code uses standard
Web APIs (`Request`, `Response`, `crypto.subtle`, streams, and
`AbortController`). The existing `GUEST_USAGE` KV namespace belongs to Guest
Access and is not used for payments.

The repository pins Node `22.16.0` in `.node-version`. This satisfies Vite 8's
runtime requirement and prevents an older Cloudflare Pages build image from
silently selecting Node 18.

## Verification checklist

Local automated checks:

```bash
npm test
npm run build
npm audit
npm run build:functions
```

Before the first live donation:

1. Confirm all production binding names exist; never display their values.
2. Confirm Razorpay and Cloudflare are both using Live Mode credentials.
3. Confirm the exact webhook URL and four event subscriptions above.
4. Confirm automatic capture is enabled if immediate confirmation is expected.
5. Deploy through the Git-connected `master` workflow.
6. Send a Razorpay Dashboard test webhook and verify HTTP `200`.
7. Make the smallest permitted real donation, confirm the browser thanks the
   donor only after capture, and reconcile its order/payment IDs in Razorpay.
8. Test Checkout dismissal and a failed payment; neither may show success.

Do not use an automated test to make a live charge. The repository test suite
mocks Turnstile and Razorpay completely.
