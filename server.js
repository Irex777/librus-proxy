const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.raw({ type: '*/*', limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Cookie jar for proxied requests
const cookieJars = new Map();

function getCookieJar(jarId) {
  if (!cookieJars.has(jarId)) cookieJars.set(jarId, {});
  return cookieJars.get(jarId);
}

function applyCookies(jar, url) {
  const headers = {};
  const cookies = [];
  for (const [domain, cookies_] of Object.entries(jar)) {
    if (url.includes(domain)) {
      cookies.push(...cookies_);
    }
  }
  // Also add cookies that match any domain
  for (const [domain, cookies_] of Object.entries(jar)) {
    if (domain === '*' || url.includes(domain.replace(/^\./, ''))) {
      cookies.push(...cookies_);
    }
  }
  if (cookies.length > 0) headers['Cookie'] = cookies.join('; ');
  return headers;
}

function storeCookies(jar, setCookieHeaders, url) {
  if (!setCookieHeaders) return;
  const headers = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  for (const h of headers) {
    const match = h.match(/^([^=]+)=([^;]*)(.*)/);
    if (!match) continue;
    const name = match[1].trim();
    const value = match[2].trim();
    // Extract domain from rest
    const domainMatch = h.match(/Domain=([^;]+)/i);
    const domain = domainMatch ? domainMatch[1].replace(/^\./, '') : new URL(url).hostname;
    if (!jar[domain]) jar[domain] = [];
    // Remove existing cookie with same name for this domain
    jar[domain] = jar[domain].filter(c => !c.startsWith(name + '='));
    jar[domain].push(`${name}=${value}`);
  }
}

// Generic proxy with cookie jar support
app.all('/proxy', async (req, res) => {
  const targetUrl = req.query.url;
  const jarId = req.query.jar || 'default';
  if (!targetUrl) return res.status(400).json({ error: 'Missing ?url= parameter' });

  try {
    const jar = getCookieJar(jarId);
    const fetchOptions = {
      method: req.method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
        ...applyCookies(jar, targetUrl),
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    };

    // Forward client headers
    for (const h of ['authorization', 'content-type', 'referer']) {
      if (req.headers[h]) fetchOptions.headers[h] = req.headers[h];
    }

    // Forward body
    if (!['GET', 'HEAD'].includes(req.method) && req.body && req.body.length > 0) {
      fetchOptions.body = req.body;
    }

    const response = await fetch(targetUrl, fetchOptions);

    // Store cookies from response
    const setCookieHeaders = response.headers.getSetCookie?.() || [];
    storeCookies(jar, setCookieHeaders, targetUrl);

    // Build response
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', '*');
    res.set('Access-Control-Allow-Headers', '*');
    res.set('Access-Control-Expose-Headers', '*');

    // Forward Set-Cookie without Domain (so browser/requests accepts them)
    for (const sc of setCookieHeaders) {
      const cleaned = sc.replace(/;\s*Domain=[^;]*/gi, '');
      res.append('Set-Cookie', cleaned);
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const body = await response.arrayBuffer();
    res.status(response.status).set('Content-Type', contentType).send(Buffer.from(body));
  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(502).json({ error: 'Fetch failed', details: err.message });
  }
});

// Dedicated Librus auth + message fetch endpoint
app.post('/librus-auth', async (req, res) => {
  const { login, password, jar: jarId } = req.body;
  if (!login || !password) return res.status(400).json({ error: 'Missing login/password' });

  const jar = getCookieJar(jarId || 'librus');
  const results = [];

  async function step(name, method, url, body) {
    try {
      const opts = {
        method,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
          'Referer': 'https://portal.librus.pl/rodzina/synergia/loguj',
          ...applyCookies(jar, url),
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(30000),
      };
      if (body) {
        opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        opts.body = new URLSearchParams(body).toString();
      }
      const resp = await fetch(url, opts);
      storeCookies(jar, resp.headers.getSetCookie?.() || [], url);
      const text = await resp.text();
      const entry = { step: name, status: resp.status, bodyLen: text.length, body: text.substring(0, 2000) };
      results.push(entry);
      console.log(`[${name}] ${resp.status} (${text.length} chars)`);
      return { status: resp.status, text, resp };
    } catch (err) {
      results.push({ step: name, error: err.message });
      return { status: 0, text: '', error: err };
    }
  }

  const BASE = 'https://api.librus.pl';
  const SYN = 'https://synergia.librus.pl';

  // Step 1: GET api.librus.pl — sets initial DZIENNIKSID
  await step('1_init', 'GET', BASE + '/');

  // Step 2: GET synergia.librus.pl/loguj/portalRodzina — sets DZIENNIKSID
  await step('2_portal', 'GET', SYN + '/loguj/portalRodzina');

  // Step 3: POST OAuth Authorization
  await step('3_auth', 'POST', BASE + '/OAuth/Authorization?client_id=46', {
    action: 'login', login, pass: password
  });

  // Step 4: GET 2FA endpoint — sets oauth_token
  await step('4_2fa', 'GET', BASE + '/OAuth/Authorization/2FA?client_id=46');

  // Step 5: GET refreshToken as fallback
  await step('5_refresh', 'GET', SYN + '/refreshToken');

  // Debug: dump all cookies
  results.push({ step: 'cookies_debug', jar: JSON.stringify(jar) });

  res.json({ results, jar });
});

// Fetch messages page
app.get('/librus-messages', async (req, res) => {
  const jar = getCookieJar(req.query.jar || 'librus');
  const page = req.query.page || '1';
  const url = `https://synergia.librus.pl/wiadomosci/1/5/${page === '1' ? '' : page}`;

  try {
    const opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
        ...applyCookies(jar, url),
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    };
    const resp = await fetch(url, opts);
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
    const opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        ...applyCookies(jar, url),
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(30000),
    };
    const resp = await fetch(url, opts);
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
  res.json({
    status: 'ok', service: 'librus-proxy',
    endpoints: {
      'POST /librus-auth': 'Authenticate (body: {login, password})',
      'GET /librus-messages?page=N': 'Fetch inbox messages list',
      'GET /librus-message/:id': 'Fetch individual message HTML',
      'ANY /proxy?url=X&jar=Y': 'Generic proxy with cookie jar',
    }
  });
});

app.listen(PORT, () => console.log(`Librus proxy listening on port ${PORT}`));
