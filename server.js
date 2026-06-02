const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing ?url= parameter' });
  }

  try {
    const fetchOptions = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    };

    // Forward auth header if provided
    const authHeader = req.headers['authorization'];
    if (authHeader) {
      fetchOptions.headers['Authorization'] = authHeader;
    }

    const response = await fetch(targetUrl, fetchOptions);

    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', '*');

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
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', '*');
  res.sendStatus(204);
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'librus-proxy', usage: 'GET /proxy?url=<encoded_url>' });
});

// Self-test endpoint
app.get('/test', async (req, res) => {
  try {
    const r = await fetch('https://api.librus.pl/', { signal: AbortSignal.timeout(10000) });
    const text = await r.text();
    res.json({ status: r.status, headers: Object.fromEntries(r.headers), body: text.substring(0, 500) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Librus proxy listening on port ${PORT}`);
});
