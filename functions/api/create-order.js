export async function onRequestPost(context) {
  try {
    const { amount, currency } = await context.request.json();
    
    if (!amount || isNaN(amount) || amount <= 0) {
      return new Response(JSON.stringify({ error: 'Invalid amount' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const keyId = context.env.RAZORPAY_KEY_ID;
    const keySecret = context.env.RAZORPAY_KEY_SECRET;

    if (!keyId || !keySecret) {
      return new Response(JSON.stringify({ error: 'Razorpay API keys are not configured in environment variables' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const authHeader = 'Basic ' + btoa(`${keyId}:${keySecret}`);

    const response = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader
      },
      body: JSON.stringify({
        amount: Math.round(amount), // in paise or cents (smallest currency unit)
        currency: currency || 'USD',
        receipt: 'receipt_order_' + Date.now()
      })
    });

    const data = await response.json();
    
    if (data && !data.error) {
      data.razorpayKeyId = keyId;
    }

    return new Response(JSON.stringify(data), {
      status: response.status,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json'
      }
    });
  }
}
