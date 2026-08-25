import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'path';
import { onRequestPost as guestGeneratePost } from './functions/api/generate-study-deck.js';
import { onRequestGet as publicConfigGet } from './functions/api/public-config.js';
import { onRequestPost as createOrderPost } from './functions/api/create-order.js';
import { onRequestPost as verifyPaymentPost } from './functions/api/verify-payment.js';
import { onRequestPost as razorpayWebhookPost } from './functions/api/webhook/razorpay.js';

// Minimal in-memory stand-in for the GUEST_USAGE KV namespace, used only by
// the Vite dev server so `npm run dev` can exercise the real guest-generation
// handler without Cloudflare bindings. State resets whenever the dev server
// restarts and is NOT shared across processes — for production-parity KV
// testing, use `wrangler pages dev` instead (see docs/CLOUDFLARE_GUEST_AI_SETUP.md).
function createDevKvNamespace() {
  const store = new Map();
  return {
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt && Date.now() > entry.expiresAt) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async put(key, value, options = {}) {
      const expiresAt = options.expirationTtl ? Date.now() + options.expirationTtl * 1000 : null;
      store.set(key, { value, expiresAt });
    }
  };
}

// Converts a Node request (Connect-style middleware) into a Web-standard
// Request/Response pair so the exact same Cloudflare Pages Function handlers
// used in production can run unmodified during local Vite development.
async function invokePagesFunction(handler, req, res, env) {
  let bodyChunks = [];
  await new Promise((resolveBody) => {
    req.on('data', (chunk) => bodyChunks.push(chunk));
    req.on('end', resolveBody);
  });
  const bodyBuffer = Buffer.concat(bodyChunks);

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(key, value);
  }

  const request = new Request(`http://localhost${req.url}`, {
    method: req.method,
    headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : bodyBuffer
  });

  try {
    const response = await handler({ request, env });
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    const text = await response.text();
    res.end(text);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'UNKNOWN_ERROR', message: 'Local dev handler failed.' } }));
  }
}

export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '');

  // A local typo must not create live Razorpay orders. Test keys are expected
  // during `npm run dev`; the explicit override is reserved for intentional
  // live-mode troubleshooting and is never needed for normal development.
  if (command === 'serve' &&
      env.RAZORPAY_KEY_ID &&
      env.RAZORPAY_KEY_ID.startsWith('rzp_live_') &&
      env.ALLOW_LIVE_RAZORPAY_LOCAL !== 'true') {
    throw new Error('Refusing to use a live Razorpay key in local development. Use Test Mode keys.');
  }

  const devGuestUsageKv = createDevKvNamespace();
  const devEnv = {
    GUEST_MODE_ENABLED: env.GUEST_MODE_ENABLED,
    GEMINI_API_KEY: env.GEMINI_API_KEY,
    GEMINI_GUEST_MODEL: env.GEMINI_GUEST_MODEL,
    TURNSTILE_SECRET_KEY: env.TURNSTILE_SECRET_KEY,
    TURNSTILE_SITE_KEY: env.TURNSTILE_SITE_KEY,
    RATE_LIMIT_SALT: env.RATE_LIMIT_SALT,
    GUEST_DAILY_LIMIT: env.GUEST_DAILY_LIMIT,
    ALLOWED_ORIGINS: env.ALLOWED_ORIGINS,
    PAYMENT_ALLOWED_ORIGINS: env.PAYMENT_ALLOWED_ORIGINS,
    RAZORPAY_KEY_ID: env.RAZORPAY_KEY_ID,
    RAZORPAY_KEY_SECRET: env.RAZORPAY_KEY_SECRET,
    RAZORPAY_WEBHOOK_SECRET: env.RAZORPAY_WEBHOOK_SECRET,
    RAZORPAY_MAX_DONATION_CENTS: env.RAZORPAY_MAX_DONATION_CENTS,
    GUEST_USAGE: devGuestUsageKv
  };

  return {
    build: {
      rolldownOptions: {
        input: {
          main: resolve(import.meta.dirname, 'index.html'),
          about: resolve(import.meta.dirname, 'about.html'),
          projects: resolve(import.meta.dirname, 'projects.html'),
          privacy: resolve(import.meta.dirname, 'privacy.html'),
          terms: resolve(import.meta.dirname, 'terms.html'),
          contact: resolve(import.meta.dirname, 'contact.html'),
          404: resolve(import.meta.dirname, '404.html'),
          500: resolve(import.meta.dirname, '500.html'),
        },
      },
    },
    plugins: [
      {
        name: 'clean-urls',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            const url = new URL(req.url, 'http://localhost');
            const pathname = url.pathname;
            if (pathname !== '/' && !pathname.includes('.') && !pathname.startsWith('/api')) {
              req.url = pathname + '.html' + url.search;
            }
            next();
          });
        }
      },
      {
        name: 'pages-functions-local-runtime',
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            const url = new URL(req.url, 'http://localhost');
            if (url.pathname === '/api/generate-study-deck' && req.method === 'POST') {
              await invokePagesFunction(guestGeneratePost, req, res, devEnv);
              return;
            }
            if (url.pathname === '/api/public-config' && req.method === 'GET') {
              await invokePagesFunction(publicConfigGet, req, res, devEnv);
              return;
            }
            if (url.pathname === '/api/create-order' && req.method === 'POST') {
              await invokePagesFunction(createOrderPost, req, res, devEnv);
              return;
            }
            if (url.pathname === '/api/verify-payment' && req.method === 'POST') {
              await invokePagesFunction(verifyPaymentPost, req, res, devEnv);
              return;
            }
            if (url.pathname === '/api/webhook/razorpay' && req.method === 'POST') {
              await invokePagesFunction(razorpayWebhookPost, req, res, devEnv);
              return;
            }
            next();
          });
        }
      }
    ]
  };
});
