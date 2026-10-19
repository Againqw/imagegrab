/**
 * 官网截图：桌面（1440）+ 手机（390）全页，用于交付物与视觉自查
 * 运行：node tools/shoot_site.mjs <url> <outDir>
 */
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const url = process.argv[2] || 'http://127.0.0.1:8130/';
const outDir = process.argv[3] || path.resolve('screenshots');
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1161/chrome-win/chrome.exe'),
  headless: true,
});

const shot = async (name, viewport, fullPage, prepare) => {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
  await page.goto(url, { waitUntil: 'networkidle' });
  if (prepare) await prepare(page);
  // 触发全部 reveal 动画，避免整页截图里元素还是隐藏状态
  await page.evaluate(async () => {
    const items = [...document.querySelectorAll('[data-reveal]')];
    items.forEach((el) => el.classList.add('is-visible'));
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise((r) => setTimeout(r, 400));
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 300));
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(outDir, name), fullPage });
  console.log('saved', name, viewport.width + 'x' + viewport.height);
  await page.close();
};

await shot('site-desktop.png', { width: 1440, height: 900 }, true);
await shot('site-hero.png', { width: 1440, height: 900 }, false);
await shot('site-mobile.png', { width: 390, height: 844 }, true);
await shot('site-mobile-hero.png', { width: 390, height: 844 }, false);

await browser.close();
