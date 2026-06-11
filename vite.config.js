import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

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
