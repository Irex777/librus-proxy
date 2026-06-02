const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

// IMPORTANT: JSON must come BEFORE raw to prevent raw from eating JSON bodies
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: '5mb' }));
// Also handle any other content types as raw (but NOT json or urlencoded)
app.use((req, res, next) => {
  if (!req.body || Buffer.isBuffer(req.body)) {
    let data = [];
    req.on('data', chunk => data.push(chunk));
    req.on('end', () => {
      req.rawBody = Buffer.concat(data);
      next();
    });
  } else {
    next();
  }
});

// Cookie jar management
const cookieJars = new Map();

function getCookieJar(jarId) {
  if (!cookieJars.has(jarId)) cookieJars.set(jarId, {});
  return cookieJars.get(jarId);
}

function applyCookies(jar, url) {
  const cookies = [];
  const urlLower = url.toLowerCase();
  for (const [domain, domainCookies] of Object.entries(jar)) {
    if (urlLower.includes(domain.toLowerCase()) || domain === '*') {
      cookies.push(...domainCookies);
    }
  }
  return cookies.length > 0 ? { 'Cookie': cookies.join('; ') } : {};
}

function storeCookies(jar, setCookieHeaders, url) {
  if (!setCookieHeaders) return;
  const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  for (const h of headers) {
    const match = h.match(/^([^=]+)=([^;]*)/);
    if (!match) continue;
    const name = match[1].trim();
    const value = match[2].trim();
    const domainMatch = h.match(/Domain=([^;]+)/i);
    const urlObj = new URL(url);
    const domain = domainMatch ? domainMatch[1].replace(/^\./, '') : urlObj.hostname;
    if (!jar[domain]) jar[domain] = [];
    jar[domain] = jar[domain].filter(c => !c.startsWith(name + '='));
    jar[domain].push(`${name}=${value}`);
  }
}

function extractRawBody(req) {
  if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return null; // parsed body
  return req.body || req.rawBody;
}

// Generic proxy with cookie jar
app.all('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  const jarId = req.query.jar || 'default';
  if (!targetUrl) return res.status(400).json({ error: 'Missing ?url=' });

  try {
    const jar = getCookieJar(jarId);
    const fetchHeaders = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
      ...applyCookies(jar, targetUrl),
    };
    for (const h of ['authorization', 'content-type', 'referer']) {
      if (req.headers[h]) fetchHeaders[h] = req.headers[h];
    }

    const rawBody = extractRawBody(req);
    const fetchOpts = {
      method: req.method,
      headers: fetchHeaders,
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    };
    if (!['GET', 'HEAD'].includes(req.method) && rawBody && rawBody.length > 0) {
      fetchOpts.body = rawBody;
    }

    const response = await fetch(targetUrl, fetchOpts);
    const setCookieHeaders = response.headers.getSetCookie?.() || [];
    storeCookies(jar, setCookieHeaders, targetUrl);

    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', '*');
    res.set('Access-Control-Allow-Headers', '*');
    res.set('Access-Control-Expose-Headers', '*');
    for (const sc of setCookieHeaders) {
      res.append('Set-Cookie', sc.replace(/;\s*Domain=[^;]*/gi, ''));
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const body = await response.arrayBuffer();
    res.status(response.status).set('Content-Type', contentType).send(Buffer.from(body));
  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(502).json({ error: 'Fetch failed', details: err.message });
  }
});

// Librus auth endpoint
app.post('/librus-auth', async (req, res) => {
  const { login, password, jar: jarId } = req.body;
  if (!login || !password) return res.status(400).json({ error: 'Missing login/password' });

  const jar = getCookieJar(jarId || 'librus');
  const results = [];

  async function step(name, method, url, bodyData) {
    try {
      const headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': 'https://portal.librus.pl/rodzina/synergia/loguj',
        ...applyCookies(jar, url),
      };
      const opts = { method, headers, redirect: 'follow', signal: AbortSignal.timeout(30000) };
      if (bodyData) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        opts.body = new URLSearchParams(bodyData).toString();
      }
      const resp = await fetch(url, opts);
      storeCookies(jar, resp.headers.getSetCookie?.() || [], url);
      const text = await resp.text();
      const entry = { step: name, status: resp.status, bodyLen: text.length, body: text.substring(0, 2000) };
      results.push(entry);
      console.log(`[${name}] ${resp.status} (${text.length} chars)`);
      return { status: resp.status, text };
    } catch (err) {
      results.push({ step: name, error: err.message });
      return { status: 0, text: '', error: err.message };
    }
  }

  await step('1_init', 'GET', 'https://api.librus.pl/');
  await step('2_portal', 'GET', 'https://synergia.librus.pl/loguj/portalRodzina');
  await step('3_auth', 'POST', 'https://api.librus.pl/OAuth/Authorization?client_id=46', { action: 'login', login, pass: password });
  await step('4_2fa', 'GET', 'https://api.librus.pl/OAuth/Authorization/2FA?client_id=46');
  await step('5_refresh', 'GET', 'https://synergia.librus.pl/refreshToken');

  const sizes = {};
  for (const [k, v] of Object.entries(jar)) sizes[k] = v.length;
  results.push({ step: 'cookies_debug', jar_keys: Object.keys(jar), jar_sizes: sizes });

  res.json({ results, jar });
});

// Fetch messages page
app.get('/librus-messages', async (req, res) => {
  const jar = getCookieJar(req.query.jar || 'librus');
  const page = req.query.page || '';
  const url = `https://synergia.librus.pl/wiadomosci/1/5/${page}`.replace(/\/$/,'');

  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      ...applyCookies(jar, url),
    };
    const resp = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(30000) });
    storeCookies(jar, resp.headers.getSetCookie?.() || [], url);
    const text = await resp.text();
    res.status(resp.status).type('text/html').send(text);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Fetch individual message
app.get('/librus-message/:id', async (req, res) => {
  const jar = getCookieJar(req.query.jar || 'librus');
  const url = `https://synergia.librus.pl/wiadomosci/1/5/${req.params.id}/f0`;

  try {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      ...applyCookies(jar, url),
    };
    const resp = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(30000) });
    const text = await resp.text();
    res.status(resp.status).type('text/html').send(text);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.options('*', (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', '*');
  res.set('Access-Control-Allow-Headers', '*');
  res.sendStatus(204);
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'librus-proxy-v2', version: 3 });
});

app.listen(PORT, () => console.log(`Librus proxy v3 listening on port ${PORT}`));
