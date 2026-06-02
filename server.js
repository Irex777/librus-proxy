const { chromium } = require('playwright');
const express = require('express');
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'librus-login-bot', version: 10 });
});

app.post('/login-and-fetch', async (req, res) => {
  const { login, password } = req.body;
  if (!login || !password) return res.status(400).json({ error: 'Missing login/password' });

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 },
      locale: 'pl-PL',
    });
    const page = await ctx.newPage();

    // Step 1: Go to portal.librus.pl/rodzina
    console.log('[1] Going to portal...');
    await page.goto('https://portal.librus.pl/rodzina', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(3000);
    console.log('[1] URL:', page.url());

    // Step 2: Accept cookies
    console.log('[2] Accepting cookies...');
    const cookieRes = await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button')];
      for (const btn of buttons) {
        const t = (btn.textContent || '').toLowerCase();
        if (t.includes('akceptuję') || t.includes('włącz wszystkie')) {
          btn.click();
          return 'clicked';
        }
      }
      return 'not found';
    });
    console.log('[2] Cookie:', cookieRes);
    await page.waitForTimeout(2000);

    // Step 3: Click "Zaloguj" (NOT "Zaloguj (mam Konto LIBRUS)" which is different)
    console.log('[3] Clicking Zaloguj...');
    const loginRes = await page.evaluate(() => {
      const links = [...document.querySelectorAll('a')];
      for (const link of links) {
        const text = (link.textContent || '').trim();
        const href = link.getAttribute('href') || '';
        // Look for plain "Zaloguj" that goes to /rodzina/synergia/loguj
        if (text === 'Zaloguj' && href.includes('/rodzina/synergia/loguj')) {
          link.click();
          return { clicked: text, href };
        }
      }
      // Fallback: any Zaloguj that isn't "(mam Konto LIBRUS)"
      for (const link of links) {
        const text = (link.textContent || '').trim();
        const href = link.getAttribute('href') || '';
        if (text.includes('Zaloguj') && !text.includes('mam Konto') && !text.includes('Konto LIBRUS')) {
          link.click();
          return { clicked: text, href };
        }
      }
      return null;
    });
    console.log('[3] Login click:', loginRes);

    // Step 4: Wait for SPA to render the login component
    // The portal is a React SPA - after clicking Zaloguj it renders a login component
    console.log('[4] Waiting for login form...');
    
    // Wait up to 15 seconds for a password field to appear
    try {
      await page.waitForSelector('input[type="password"], input[name="login"], #login', {
        timeout: 15000,
      });
      console.log('[4] Found login form!');
    } catch (e) {
      console.log('[4] No login form found, checking what we have...');
      // Check for iframes
      const frames = page.frames();
      console.log('[4] Frames:', frames.length);
      for (const frame of frames) {
        console.log('    Frame:', frame.url());
        const frameInputs = await frame.evaluate(() => {
          return [...document.querySelectorAll('input')].map(i => ({
            name: i.name, type: i.type, id: i.id
          }));
        }).catch(() => []);
        console.log('    Frame inputs:', JSON.stringify(frameInputs));
      }
    }

    // Step 5: Check current state
    const currentUrl = page.url();
    const currentText = await page.evaluate(() => document.body?.innerText?.substring(0, 3000) || '');
    const currentInputs = await page.evaluate(() => {
      return [...document.querySelectorAll('input')].map(i => ({
        name: i.name, type: i.type, id: i.id
      }));
    });
    console.log('[5] URL:', currentUrl);
    console.log('[5] Inputs:', JSON.stringify(currentInputs));
    console.log('[5] Text (first 500):', currentText.substring(0, 500));

    // Step 6: Try to fill login form if we have one
    let loggedIn = false;
    if (currentInputs.some(i => i.type === 'password')) {
      console.log('[6] Filling form...');
      await page.fill('input[type="password"]', password);
      
      // Find login field
      const loginField = await page.$('input[name="login"], input[id="login"], input[type="text"], input[type="email"]');
      if (loginField) {
        await loginField.fill(login);
      }
      
      await page.waitForTimeout(500);
      
      // Submit
      await page.press('input[type="password"]', 'Enter');
      console.log('[6] Submitted, waiting for dashboard...');
      
      try {
        await page.waitForURL(u => !u.toString().includes('/loguj'), { timeout: 30000 });
        loggedIn = true;
      } catch (e) {
        console.log('[6] Still on login page:', page.url());
      }
    }

    // Step 7: Also try navigating to the OAuth URL in a new tab to test if Playwright can reach it
    if (!loggedIn) {
      console.log('[7] Testing if Playwright can reach api.librus.pl...');
      const page2 = await ctx.newPage();
      try {
        const resp = await page2.goto('https://api.librus.pl/OAuth/Authorization?client_id=46', {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });
        const oauthUrl = page2.url();
        const oauthText = await page2.evaluate(() => document.body?.innerText?.substring(0, 500) || '');
        const oauthInputs = await page2.evaluate(() => {
          return [...document.querySelectorAll('input')].map(i => ({ name: i.name, type: i.type, id: i.id }));
        });
        console.log('[7] OAuth URL:', oauthUrl);
        console.log('[7] OAuth text:', oauthText.substring(0, 300));
        console.log('[7] OAuth inputs:', JSON.stringify(oauthInputs));
        
        // If we got a login form here, use it
        if (oauthInputs.some(i => i.type === 'password' || i.name === 'login')) {
          console.log('[7] Login form found on OAuth page! Filling...');
          const lf = await page2.$('input[name="login"], input[id="login"], input[type="text"], input[type="email"]');
          const pf = await page2.$('input[type="password"]');
          if (lf && pf) {
            await lf.fill(login);
            await pf.fill(password);
            await Promise.all([
              page2.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}),
              pf.press('Enter'),
            ]);
            console.log('[7] After OAuth submit URL:', page2.url());
            
            // Transfer cookies to main page
            await page.goto(page2.url(), { waitUntil: 'domcontentloaded', timeout: 30000 });
            loggedIn = !page.url().includes('/loguj') && page.url().includes('synergia');
          }
        }
      } catch (e) {
        console.log('[7] OAuth error:', e.message);
      }
      await page2.close().catch(() => {});
    }

    // Step 8: Fetch messages if logged in
    if (loggedIn) {
      console.log('[8] Fetching messages...');
      await page.goto('https://synergia.librus.pl/wiadomosci/1/5', {
        waitUntil: 'domcontentloaded', timeout: 30000,
      });
      await page.waitForTimeout(3000);
      const msgText = await page.evaluate(() => document.body?.innerText?.substring(0, 10000) || '');
      const msgScreenshot = await page.screenshot();
      await browser.close();
      return res.json({
        success: true,
        url: page.url(),
        messagesText: msgText,
        screenshot: 'data:image/png;base64,' + msgScreenshot.toString('base64'),
      });
    }

    // Debug output
    const screenshot = await page.screenshot();
    await browser.close();
    res.json({
      success: false,
      url: currentUrl,
      text: currentText.substring(0, 3000),
      inputs: currentInputs,
      loginClick: loginRes,
      cookieResult: cookieRes,
      loggedIn,
      screenshot: 'data:image/png;base64,' + screenshot.toString('base64'),
    });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => console.log('Librus login bot v9 listening on :3000'));
