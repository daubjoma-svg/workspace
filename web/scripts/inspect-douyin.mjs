import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const outputDir = path.resolve('../docs/report-assets/video-reference');
mkdirSync(outputDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: chrome,
  headless: true,
  args: ['--no-proxy-server', '--autoplay-policy=no-user-gesture-required', '--disable-gpu'],
});
const context = await browser.newContext({
  viewport: { width: 430, height: 932 },
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
});
const page = await context.newPage();
const responses = [];

page.on('response', async (response) => {
  const url = response.url();
  if (!/aweme|iteminfo|video|play|douyin/.test(url)) return;
  responses.push({ status: response.status(), contentType: response.headers()['content-type'] || '', url });
  if (/json/.test(response.headers()['content-type'] || '')) {
    try {
      const body = await response.text();
      if (body.length > 20 && body.length < 5_000_000) {
        writeFileSync(path.join(outputDir, `response-${responses.length}.json`), body);
      }
    } catch {
      // 跨域或流式响应无法读取时，仅保留请求地址。
    }
  }
});

await page.goto('http://v.douyin.com/Ia9xB1HTjxA/', { waitUntil: 'domcontentloaded', timeout: 60_000 });
await page.waitForTimeout(12_000);
writeFileSync(path.join(outputDir, 'page.html'), await page.content());
writeFileSync(path.join(outputDir, 'responses.json'), JSON.stringify(responses, null, 2));
writeFileSync(path.join(outputDir, 'visible-text.txt'), (await page.locator('body').innerText()).slice(0, 30_000));
await page.screenshot({ path: path.join(outputDir, 'page.png'), fullPage: true });

const video = page.locator('video').first();
if (await video.count()) {
  const info = await video.evaluate((element) => ({
    currentSrc: element.currentSrc,
    src: element.src,
    duration: element.duration,
    currentTime: element.currentTime,
    readyState: element.readyState,
  }));
  writeFileSync(path.join(outputDir, 'video-info.json'), JSON.stringify(info, null, 2));
  for (const [name, second] of [['start', 1], ['middle', Math.max(1, Math.floor((info.duration || 6) / 2))], ['end', Math.max(1, Math.floor((info.duration || 6) - 1))]]) {
    await video.evaluate((element, time) => { element.currentTime = time; }, second);
    await page.waitForTimeout(1_000);
    await video.screenshot({ path: path.join(outputDir, `${name}.png`) });
  }
}

console.log(JSON.stringify({ url: page.url(), title: await page.title(), responses: responses.length }, null, 2));
await browser.close();
