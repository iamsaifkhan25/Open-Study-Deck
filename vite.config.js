import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
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
                const keyId = 'rzp_live_T0Nw1fEYYo8OtR';
                const keySecret = '50xAouMgBbV92KqiR5KaG57R';
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
});

