const { chromium } = require('playwright');

// Minimal Librus login + messages fetcher
// Designed to complete in under 100 seconds

const LOGIN_URL = 'https://synergia.librus.pl/loguj/portalRodzina';
const MESSAGES_URL = 'https://synergia.librus.pl/wiadomosci/1/5';

async function loginAndFetchMessages(login, password) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const ctx = await browser.newContext({
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 },
    locale: 'pl-PL',
  });
  const page = await ctx.newPage();

  // Step 1: Go directly to the synergia login page (not OAuth, not portal)
  // synergia.librus.pl is reachable from the VPS
  // The login form at /loguj/portalRodzina renders server-side
  console.log('[1] Navigating to synergia login page...');
  await page.goto('https://synergia.librus.pl/loguj/portalRodzina', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });
  await page.waitForTimeout(3000);
  console.log('[1] Current URL:', page.url());
  
  // Step 2: Accept cookie consent if present (may appear as popup/banner)
  console.log('[2] Checking for cookie consent...');
  for (let attempt = 0; attempt < 3; attempt++) {
    const cookieResult = await page.evaluate(() => {
      const buttons = document.querySelectorAll('button, a, [role="button"]');
      for (const btn of buttons) {
        const text = (btn.textContent || '').trim().toLowerCase();
        if (text.includes('akceptuję') || text.includes('akceptuje') ||
            text.includes('przechodzę') || text.includes('accept all') ||
            text.includes('włącz wszystkie')) {
          btn.click();
          return 'clicked: ' + btn.textContent.trim().substring(0, 60);
        }
      }
      return 'no banner';
    });
    console.log(`[2] Cookie attempt ${attempt}:`, cookieResult);
    if (cookieResult !== 'no banner') {
      await page.waitForTimeout(2000);
      break;
    }
    await page.waitForTimeout(2000);
  }

  // Step 3: Take screenshot and get page text
  const screenshot = await page.screenshot();
  const innerText = await page.evaluate(() => document.body?.innerText?.substring(0, 5000) || '');
  const allLinks = await page.evaluate(() => {
    return [...document.querySelectorAll('a, button')].map(el => ({
      tag: el.tagName,
      text: (el.textContent || '').trim().substring(0, 80),
      href: el.getAttribute('href') || '',
    }));
  });
  console.log('[3] Page text first 500 chars:', innerText.substring(0, 500));
  console.log('[3] Links/buttons:', JSON.stringify(allLinks.filter(l => l.text || l.href).slice(0, 20)));

  // Step 4: Click login/Zaloguj button
  console.log('[4] Looking for login button...');
  const loginClick = await page.evaluate(() => {
    const els = document.querySelectorAll('a, button, [role="button"], [role="link"]');
    for (const el of els) {
      const text = (el.textContent || '').trim().toLowerCase();
      const href = (el.getAttribute('href') || '').toLowerCase();
      if (text.includes('zaloguj') || text.includes('log in') || text.includes('sign in') ||
          href.includes('loguj') || href.includes('login') || href.includes('oauth') ||
          href.includes('authorization')) {
        el.click();
        return { text: el.textContent.trim().substring(0, 60), href: el.getAttribute('href') || '' };
      }
    }
    return null;
  });
  console.log('[4] Login click result:', loginClick);
  await page.waitForTimeout(3000);

  // Step 5: Check for login form
  console.log('[5] Checking URL:', page.url());
  const inputs = await page.evaluate(() => {
    const all = document.querySelectorAll('input');
    return {
      total: all.length,
      names: [...all].map(i => ({ name: i.name, type: i.type, id: i.id })),
    };
  });
  console.log('[5] Inputs:', JSON.stringify(inputs));

  // Step 6: If we have a login form, fill it
  if (inputs.names.some(i => i.type === 'password' || i.name === 'login' || i.id === 'login' || i.type === 'text' || i.type === 'email')) {
    console.log('[6] Filling login form...');
    
    // Find the username field
    const loginField = await page.$('input[name="login"], input[id="login"], input[type="email"], input[type="text"]');
    const passField = await page.$('input[type="password"]');
    
    if (loginField && passField) {
      await loginField.click();
      await loginField.fill(login);
      await passField.click();
      await passField.fill(password);
      
      console.log('[6] Submitting...');
      // Find and click submit button, or press Enter
      const submitBtn = await page.$('button[type="submit"], input[type="submit"]');
      if (submitBtn) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle', timeout: 60000 }).catch(() => {}),
          submitBtn.click(),
        ]);
      } else {
        await passField.press('Enter');
        await page.waitForTimeout(5000);
      }
      
      console.log('[6] After submit URL:', page.url());
      
      // Wait for dashboard
      try {
        await page.waitForURL(u => u.toString().includes('synergia.librus.pl') && !u.toString().includes('/loguj'), { timeout: 30000 });
      } catch (e) {
        console.log('[6] Dashboard wait timeout, current URL:', page.url());
      }
      
      // Navigate to messages
      console.log('[7] Fetching messages...');
      await page.goto(MESSAGES_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);
      
      const msgText = await page.evaluate(() => document.body?.innerText?.substring(0, 10000) || '');
      const msgScreenshot = await page.screenshot();
      
      await browser.close();
      return {
        success: true,
        url: page.url(),
        messagesText: msgText,
        screenshotB64: msgScreenshot.toString('base64'),
      };
    } else {
      console.log('[6] Login/pass fields not found');
    }
  }

  // No login form found — return debug info
  const debugScreenshot = await page.screenshot();
  const debugText = await page.evaluate(() => document.body?.innerText?.substring(0, 5000) || '');
  
  await browser.close();
  return {
    success: false,
    url: page.url(),
    pageText: innerText,
    links: allLinks,
    inputs: inputs,
    loginClick: loginClick,
    screenshotB64: debugScreenshot.toString('base64'),
    textAfterClick: debugText,
  };
}

// HTTP server
const express = require('express');
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'librus-login-bot', version: 7 });
});

app.post('/login-and-fetch', async (req, res) => {
  const { login, password } = req.body;
  if (!login || !password) return res.status(400).json({ error: 'Missing login/password' });
  
  try {
    const result = await loginAndFetchMessages(login, password);
    
    // Add screenshot as data URI
    if (result.screenshotB64) {
      result.screenshot = 'data:image/png;base64,' + result.screenshotB64;
      delete result.screenshotB64;
    }
    
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => console.log('Librus login bot v6 listening on :3000'));
