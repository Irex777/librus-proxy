const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// Parse raw body for POST forwarding
app.use(express.raw({ type: '*/*', limit: '5mb' }));

app.all('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing ?url= parameter' });
  }

  try {
    const fetchOptions = {
      method: req.method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    };

    // Forward specific headers from client
    const forwardHeaders = ['authorization', 'content-type', 'cookie', 'referer'];
    for (const h of forwardHeaders) {
      if (req.headers[h]) fetchOptions.headers[h] = req.headers[h];
    }

    // Forward body for POST/PUT
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body && req.body.length > 0) {
      fetchOptions.body = req.body;
    }

    const response = await fetch(targetUrl, fetchOptions);

    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', '*');
    res.set('Access-Control-Allow-Headers', '*');
    res.set('Access-Control-Expose-Headers', '*');

    // Forward key response headers
    const exposeHeaders = ['set-cookie', 'content-type', 'location', 'x-csrf-token'];
    for (const h of exposeHeaders) {
      const val = response.headers.get(h);
      if (val) res.set(h, val);
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const body = await response.arrayBuffer();

    res.status(response.status).set('Content-Type', contentType).send(Buffer.from(body));
  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(502).json({ error: 'Fetch failed', details: err.message, url: targetUrl });
  }
});

app.options('/proxy', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', '*');
  res.set('Access-Control-Allow-Headers', '*');
  res.sendStatus(204);
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'librus-proxy', usage: 'ANY /proxy?url=<encoded_url>' });
});

app.listen(PORT, () => {
  console.log(`Librus proxy listening on port ${PORT}`);
});
