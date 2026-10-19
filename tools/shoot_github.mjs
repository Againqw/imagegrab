/**
 * 交付物截图：GitHub 项目页 + GitHub Pages 官网
 * 运行：node tools/shoot_github.mjs <repoUrl> <pagesUrl> <outDir>
 */
import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const repoUrl = process.argv[2] || 'https://github.com/Againqw/imagegrab';
const pagesUrl = process.argv[3] || 'https://againqw.github.io/imagegrab/';
const outDir = process.argv[4] || path.resolve('screenshots');
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1161/chrome-win/chrome.exe'),
  headless: true,
});

/**
 * 截图。要点：
 *  1) 关掉平滑滚动，否则 scrollTo(0,0) 还没结束就截图，会截到半路
 *  2) 整页截图前先逐屏滚一遍，把 loading="lazy" 的图片真正加载出来
 *  3) 强制触发 reveal 动画，避免整页截图里元素还是透明
 */
async function capture(name, url, viewport, fullPage, waitFor, scrollSelector) {
  const page = await browser.newPage({ viewport, deviceScaleFactor: 2 });
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 60000 });
    if (waitFor) await page.waitForSelector(waitFor, { timeout: 40000 }).catch(() => {});
    await page.addStyleTag({ content: 'html{scroll-behavior:auto !important}' });

    await page.evaluate(async () => {
      document.querySelectorAll('[data-reveal]').forEach((el) => el.classList.add('is-visible'));
      const step = Math.round(window.innerHeight * 0.8);
      for (let y = 0; y < document.body.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 130));
      }
      window.scrollTo(0, 0);
      await new Promise((r) => setTimeout(r, 500));
    });

    // 需要定位到某个区块时（如 GitHub 的 README），再精确滚动一次
    if (scrollSelector) {
      await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 90);
      }, scrollSelector);
      await page.waitForTimeout(900);
    }

    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(outDir, name), fullPage, animations: 'disabled' });
    console.log('saved', name, `${viewport.width}x${viewport.height}${fullPage ? ' full' : ''}`);
  } catch (err) {
    console.warn('截图失败', name, err.message.split('\n')[0]);
    throw err;
  } finally {
    await page.close();
  }
}

// GitHub 项目页
await capture('github-repo.png', repoUrl, { width: 1440, height: 960 }, false, 'article.markdown-body');
await capture('github-readme.png', repoUrl, { width: 1440, height: 960 }, false, 'article.markdown-body', 'article.markdown-body img');
await capture('github-repo-full.png', repoUrl, { width: 1440, height: 960 }, true, 'article.markdown-body');

// Pages 线上官网
await capture('pages-hero.png', pagesUrl, { width: 1440, height: 900 }, false, '.hero__title');
await capture('pages-full.png', pagesUrl, { width: 1440, height: 900 }, true, '.hero__title');

await browser.close();
console.log('done');
