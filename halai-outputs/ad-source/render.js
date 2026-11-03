const { chromium } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const dir = __dirname, frames = path.join(dir, 'frames');
const only = process.argv[2] ? process.argv[2].split(',').map(Number) : null;
(async () => {
  fs.mkdirSync(frames, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 }, deviceScaleFactor: 1 });
  await page.goto('file://' + path.join(dir, 'ad.html'));
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  const list = only || Array.from({ length: 900 }, (_, i) => i);
  for (const i of list) {
    await page.evaluate((t) => setTime(t), i / 30);
    await page.screenshot({ path: path.join(only ? dir : frames, only ? `still-${i}.png` : `f${String(i).padStart(4, '0')}.jpg`), ...(only ? {} : { type: 'jpeg', quality: 92 }) });
  }
  await browser.close();
})();
