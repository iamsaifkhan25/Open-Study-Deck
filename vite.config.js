import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'path';
import { onRequestPost as guestGeneratePost } from './functions/api/generate-study-deck.js';
import { onRequestGet as publicConfigGet } from './functions/api/public-config.js';

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

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
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
    GUEST_USAGE: devGuestUsageKv
  };

  return {
    build: {
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'index.html'),
          about: resolve(__dirname, 'about.html'),
          projects: resolve(__dirname, 'projects.html'),
          privacy: resolve(__dirname, 'privacy.html'),
          terms: resolve(__dirname, 'terms.html'),
          contact: resolve(__dirname, 'contact.html'),
          404: resolve(__dirname, '404.html'),
          500: resolve(__dirname, '500.html'),
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
        name: 'guest-generation-api-mock',
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
            next();
          });
        }
      },
      {
        name: 'razorpay-api-mock',
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            if (req.url === '/api/create-order' && req.method === 'POST') {
              let body = '';
              req.on('data', chunk => {
                body += chunk;
              });
              req.on('end', async () => {
                try {
                  const { amount, currency } = JSON.parse(body);
                  const keyId = env.RAZORPAY_KEY_ID;
                  const keySecret = env.RAZORPAY_KEY_SECRET;

                  if (!keyId || !keySecret) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Razorpay API keys (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET) are not configured in local environment variables' }));
                    return;
                  }

                  const authHeader = 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');

                  const response = await fetch('https://api.razorpay.com/v1/orders', {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/json',
                      'Authorization': authHeader
                    },
                    body: JSON.stringify({
                      amount: Math.round(amount),
                      currency: currency || 'USD',
                      receipt: 'receipt_order_' + Date.now()
                    })
                  });

                  const data = await response.json();
                  if (data && !data.error) {
                    data.razorpayKeyId = keyId;
                  }
                  res.writeHead(response.status, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify(data));
                } catch (err) {
                  res.writeHead(500, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ error: err.message }));
                }
              });
            } else {
              next();
            }
          });
        }
      }
    ]
  };
});
