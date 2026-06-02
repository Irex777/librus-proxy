const { chromium } = require('playwright');

const express = require('express');
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'librus-login-bot', version: 8 });
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
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 },
      locale: 'pl-PL',
    });
    const page = await ctx.newPage();

    // STEP 1: Navigate to OAuth endpoint directly
    // Playwright's Chromium has real TLS fingerprint, should bypass IP block
    console.log('[1] Navigating to OAuth...');
    const navResp = await page.goto('https://api.librus.pl/OAuth/Authorization?client_id=46', {
      waitUntil: 'networkidle',
      timeout: 60000,
    }).catch(e => ({ _error: e.message }));
    
    const afterNavUrl = page.url();
    const afterNavHtml = await page.evaluate(() => document.documentElement.outerHTML.substring(0, 5000));
    const afterNavText = await page.evaluate(() => document.body?.innerText?.substring(0, 3000) || '');
    const inputsAfterNav = await page.evaluate(() => {
      return [...document.querySelectorAll('input')].map(i => ({
        name: i.name, type: i.type, id: i.id, placeholder: i.placeholder
      }));
    });
    
    console.log('[1] After OAuth nav:');
    console.log('    URL:', afterNavUrl);
    console.log('    Nav error:', navResp?._error || 'none');
    console.log('    Text (first 500):', afterNavText.substring(0, 500));
    console.log('    Inputs:', JSON.stringify(inputsAfterNav));
    
    // STEP 2: If we have a login form, fill it
    let loginSuccess = false;
    if (inputsAfterNav.some(i => i.type === 'password' || i.name === 'login')) {
      console.log('[2] Found login form! Filling...');
      const loginInput = await page.$('input[name="login"], input[id="login"], input[type="email"], input[type="text"]:first-of-type');
      const passInput = await page.$('input[type="password"]');
      
      if (loginInput && passInput) {
        await loginInput.fill(login);
        await passInput.fill(password);
        
        console.log('[2] Submitting...');
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle', timeout: 60000 }).catch(() => {}),
          passInput.press('Enter'),
        ]);
        
        console.log('[2] After submit URL:', page.url());
        await page.waitForTimeout(5000);
        
        // Check if we're logged in
        const postLoginUrl = page.url();
        if (postLoginUrl.includes('synergia.librus.pl') && !postLoginUrl.includes('/loguj')) {
          loginSuccess = true;
          console.log('[2] Login successful! Dashboard URL:', postLoginUrl);
        }
      }
    }
    
    // STEP 3: If no login form on OAuth, try the portal route
    if (!loginSuccess && afterNavUrl.includes('portal.librus.pl')) {
      console.log('[3] Redirected to portal, clicking Zaloguj...');
      
      // Accept cookies first
      await page.evaluate(() => {
        const buttons = document.querySelectorAll('button, a, [role="button"]');
        for (const btn of buttons) {
          const text = (btn.textContent || '').trim().toLowerCase();
          if (text.includes('akceptuję') || text.includes('włącz wszystkie')) {
            btn.click();
            break;
          }
        }
      });
      await page.waitForTimeout(2000);
      
      // Click Zaloguj
      const zalogujClick = await page.evaluate(() => {
        const els = document.querySelectorAll('a, button');
        for (const el of els) {
          const text = (el.textContent || '').trim().toLowerCase();
          const href = (el.getAttribute('href') || '').toLowerCase();
          if ((text.includes('zaloguj') && !text.includes('mam konto')) || 
              href.includes('oauth') || href.includes('loguj/portalRodzina')) {
            el.click();
            return { text: el.textContent.trim().substring(0, 60), href: el.getAttribute('href') || '' };
          }
        }
        return null;
      });
      console.log('[3] Zaloguj click:', zalogujClick);
      await page.waitForTimeout(5000);
      
      // Check for login form now
      const newInputs = await page.evaluate(() => {
        return [...document.querySelectorAll('input')].map(i => ({
          name: i.name, type: i.type, id: i.id
        }));
      });
      console.log('[3] New inputs:', JSON.stringify(newInputs));
      
      if (newInputs.some(i => i.type === 'password' || i.name === 'login')) {
        const loginInput = await page.$('input[name="login"], input[id="login"], input[type="email"], input[type="text"]:first-of-type');
        const passInput = await page.$('input[type="password"]');
        
        if (loginInput && passInput) {
          await loginInput.fill(login);
          await passInput.fill(password);
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle', timeout: 60000 }).catch(() => {}),
            passInput.press('Enter'),
          ]);
          console.log('[3] After submit URL:', page.url());
          await page.waitForTimeout(5000);
          
          const postUrl = page.url();
          if (postUrl.includes('synergia.librus.pl') && !postUrl.includes('/loguj')) {
            loginSuccess = true;
          }
        }
      }
    }
    
    // STEP 4: Fetch messages if logged in
    if (loginSuccess) {
      console.log('[4] Fetching messages...');
      await page.goto('https://synergia.librus.pl/wiadomosci/1/5', { waitUntil: 'domcontentloaded', timeout: 30000 });
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
    
    // STEP 5: Return debug info
    const debugScreenshot = await page.screenshot();
    const finalText = await page.evaluate(() => document.body?.innerText?.substring(0, 5000) || '');
    const finalInputs = await page.evaluate(() => {
      return [...document.querySelectorAll('input')].map(i => ({
        name: i.name, type: i.type, id: i.id
      }));
    });
    
    await browser.close();
    res.json({
      success: false,
      afterNavUrl,
      afterNavText: afterNavText.substring(0, 2000),
      inputsAfterNav,
      finalUrl: page.url(),
      finalText: finalText.substring(0, 2000),
      finalInputs,
      loginSuccess,
      screenshot: 'data:image/png;base64,' + debugScreenshot.toString('base64'),
    });
  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    console.error('Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(3000, () => console.log('Librus login bot v8 listening on :3000 - build 8'));
