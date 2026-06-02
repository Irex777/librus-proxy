const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing ?url= parameter' });
  }

  try {
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'LibrusProxy/1.0',
        ...Object.fromEntries(
          Object.entries(req.headers).filter(([key]) =>
            ['authorization', 'cookie', 'content-type', 'accept'].includes(key.toLowerCase())
          )
        ),
      },
    });

    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.set('Access-Control-Allow-Headers', '*');

    const body = await response.text();
    res.status(response.status).set('Content-Type', response.headers.get('content-type') || 'application/json').send(body);
  } catch (err) {
    res.status(502).json({ error: 'Fetch failed', details: err.message });
  }
});

app.options('/proxy', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', '*');
  res.sendStatus(204);
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', usage: 'GET /proxy?url=<encoded_url>' });
});

app.listen(PORT, () => {
  console.log(`Librus proxy listening on port ${PORT}`);
});
