import { chromium } from 'playwright-core';
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-proxy-server'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 1500 } });
await page.goto('http://localhost:5173/rte-demo.html', { waitUntil: 'networkidle' });
await page.waitForSelector('.rte-content');
const chat = page.locator('.rte').nth(2);
const chatContent = chat.locator('.rte-content');
await chatContent.click();
await page.keyboard.type('带图消息');
const before = await chatContent.evaluate(el => el.innerHTML);
console.log('BEFORE paste innerHTML:', JSON.stringify(before));
await page.evaluate(() => {
  const bytes = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), c => c.charCodeAt(0));
  const file = new File([bytes], 'pixel.png', { type: 'image/png' });
  const dt = new DataTransfer(); dt.items.add(file);
  const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
  document.querySelectorAll('.rte-content')[2].dispatchEvent(ev);
});
await page.waitForFunction(() => document.querySelectorAll('.rte')[2].querySelector('img'), null, { timeout: 8000 });
const after = await chatContent.evaluate(el => el.innerHTML);
console.log('AFTER paste innerHTML:', JSON.stringify(after));
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
const bubbleCount = await page.locator('.chat-bubble').count();
console.log('bubble count:', bubbleCount);
for (let i = 0; i < bubbleCount; i++) {
  const t = await page.locator('.chat-bubble').nth(i).textContent();
  const h = await page.locator('.chat-bubble').nth(i).innerHTML();
  console.log(`bubble[${i}] text:`, JSON.stringify(t), '| html:', h.slice(0, 120));
}
await browser.close();
