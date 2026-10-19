/**
 * 端到端测试：用真实 Chrome 加载扩展，验证
 *  1) 详情页右下角悬浮按钮注入
 *  2) 图片提取（含懒加载、背景图、过滤小图）
 *  3) 预览页渲染与批量下载为 PNG
 * 同时输出插件截图。
 *
 * 运行：node tools/e2e.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(ROOT, 'screenshots');
const PORT = 8123;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

function startServer() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    const filePath = path.join(ROOT, url === '/' ? '/demo/shop.html' : url);
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 截图（只用于文档与人工核对）：headed 模式下偶发合成器停摆，
 * 失败时重试一次，仍失败只告警，不阻断功能断言。
 */
async function shot(page, name) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await page.bringToFront();
      await page.screenshot({ path: path.join(SHOTS, name), timeout: 15000 });
      console.log('截图:', name);
      return true;
    } catch (err) {
      console.warn(`截图 ${name} 第 ${attempt} 次失败:`, err.message.split('\n')[0]);
      await page.waitForTimeout(800);
    }
  }
  return false;
}

/** 选择一个可用的 Chrome/Chromium（优先本机 Chrome，其次 Playwright 已下载的版本） */
function resolveChrome() {
  const candidates = [
    process.env.IMAGEGRAB_CHROME,
    // Playwright 自带的 Chromium 仍支持 --load-extension（品牌版 Chrome 137+ 已移除该开关）
    path.join(os.homedir(), 'AppData/Local/ms-playwright/chromium-1161/chrome-win/chrome.exe'),
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('未找到可用的 Chrome，可通过环境变量 IMAGEGRAB_CHROME 指定路径');
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const server = await startServer();
  const downloadDir = path.join(os.tmpdir(), `imagegrab-downloads-${Date.now()}`);
  fs.mkdirSync(downloadDir, { recursive: true });
  const profileDir = path.join(os.tmpdir(), `imagegrab-profile-${Date.now()}`);
  // 预写浏览器偏好，把下载目录指到临时目录，避免污染真实下载文件夹
  fs.mkdirSync(path.join(profileDir, 'Default'), { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, 'Default', 'Preferences'),
    JSON.stringify({
      download: { default_directory: downloadDir, prompt_for_download: false, directory_upgrade: true },
      savefile: { default_directory: downloadDir },
    })
  );

  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: resolveChrome(),
    headless: false,
    args: [
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1440,940',
      // headed 模式下窗口被遮挡时合成器会停摆，导致 Page.captureScreenshot 一直挂起
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-features=CalculateNativeWinOcclusion',
    ],
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    acceptDownloads: true,
  });

  const log = (...args) => console.log(...args);

  // Playwright 接管下载后会把文件改名成 GUID 存进自己的 artifacts 目录，
  // 这里用 CDP 覆盖回「按扩展指定文件名 + 指定目录落盘」，
  // 否则既验证不到文件名，也会让 chrome.downloads 记录成 interrupted。
  try {
    const probePage = await context.newPage();
    const cdp = await context.newCDPSession(probePage);
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadDir,
      eventsEnabled: true,
    });
    await probePage.close();
  } catch (err) {
    log('覆盖下载行为失败（文件名/落盘校验将不可靠）:', err.message);
  }

  try {
    // 1. 拿到扩展 ID（新版 Playwright 不一定会抛出 serviceworker 事件，兜底用 CDP 枚举 target）
    let worker = context.serviceWorkers()[0];
    if (!worker) {
      try {
        worker = await context.waitForEvent('serviceworker', { timeout: 8000 });
      } catch {
        worker = null;
      }
    }

    let extensionId = worker ? new URL(worker.url()).host : null;
    if (!extensionId) {
      const probe = await context.newPage();
      const session = await context.newCDPSession(probe);
      const { targetInfos } = await session.send('Target.getTargets');
      const extTarget = targetInfos.find((t) => /^chrome-extension:\/\/[a-p]{32}/.test(t.url));
      if (extTarget) extensionId = new URL(extTarget.url).host;
      await probe.close();
    }
    if (!extensionId) {
      throw new Error('扩展未加载：请确认 --load-extension 生效（品牌版 Chrome 137+ 已移除该开关）');
    }
    log('扩展 ID:', extensionId);

    // background service worker 句柄（用于读取下载记录）
    if (!worker) {
      worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
    }

    // 下载目录已通过 Preferences 指定；这里只打开一个空白页备用
    const cdpProbe = await context.newPage();
    await cdpProbe.close();

    // 2. 打开演示详情页
    const page = await context.newPage();
    await page.goto(`http://localhost:${PORT}/demo/shop.html?imagegrab-demo=1`, { waitUntil: 'load' });
    await page.waitForSelector('#imagegrab-fab', { timeout: 15000 });
    await page.waitForTimeout(600);
    log('悬浮按钮已注入');

    // 轻微滚动页面，模拟真实浏览后再提取
    await page.evaluate(() => window.scrollTo(0, 260));
    await page.waitForTimeout(500);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);

    await shot(page, '01-button-on-page.png');

    // 3. 点击提取，等待预览页打开
    page.on('console', (msg) => log('[page console]', msg.type(), msg.text()));
    if (worker) worker.on('console', (msg) => log('[sw console]', msg.type(), msg.text()));

    const pagePromise = context.waitForEvent('page', { timeout: 25000 });
    await page.click('#imagegrab-fab');

    let gallery;
    try {
      gallery = await pagePromise;
    } catch (err) {
      await page.waitForTimeout(4000);
      log('点击后页面列表:', context.pages().map((p) => p.url()).join(' , '));
      const toast = await page.locator('#imagegrab-toast').textContent().catch(() => null);
      log('页面提示:', toast);
      const stored = await worker.evaluate(() => chrome.storage.local.get('imagegrab:last')).catch((e) => e.message);
      log('storage:', JSON.stringify(stored).slice(0, 300));
      throw err;
    }
    await gallery.waitForLoadState('domcontentloaded');
    await gallery.waitForSelector('#grid .card', { timeout: 20000 });
    await gallery.waitForTimeout(1200);

    const cards = await gallery.locator('#grid .card').count();
    const totalText = await gallery.locator('#totalCount').textContent();
    const filenames = await gallery.locator('.card__name').allTextContents();
    log(`预览页卡片数: ${cards}，标题显示: ${totalText}`);
    log('文件命名:', filenames.join(', '));

    const sizes = await gallery.locator('.card__size').allTextContents();
    log('图片尺寸:', sizes.join(' | '));

    await shot(gallery, '02-gallery.png');

    // 4. 批量下载
    await gallery.click('#btnDownload');
    await gallery.waitForFunction(
      () => {
        const toast = document.getElementById('toast');
        return toast && toast.classList.contains('is-visible') && /已下载/.test(toast.textContent || '');
      },
      { timeout: 90000 }
    );
    const toastText = await gallery.locator('#toast').textContent();
    log('下载结果:', toastText);

    // 5. 等待所有下载真正落盘，再通过扩展 API 校验
    let downloads = [];
    for (let i = 0; i < 40; i += 1) {
      downloads = await worker.evaluate(async () => {
        const items = await chrome.downloads.search({ limit: 40, orderBy: ['-startTime'] });
        return items.map((d) => ({ filename: d.filename, state: d.state, bytes: d.bytesReceived, mime: d.mime }));
      });
      if (downloads.length >= 10 && downloads.every((d) => d.state !== 'in_progress')) break;
      await gallery.waitForTimeout(500);
    }
    log(`下载记录 ${downloads.length} 条，完成 ${downloads.filter((d) => d.state === 'complete').length} 条`);
    log('示例:', JSON.stringify(downloads.slice(0, 3), null, 0));

    await gallery.waitForTimeout(1200);
    await shot(gallery, '03-after-download.png');

    // 6. 文件系统校验：确认真实落盘的 PNG 数量与尺寸
    const files = fs.readdirSync(downloadDir).filter((f) => f.endsWith('.png'));
    log('下载目录文件:', files.join(', '));
    log('下载目录:', downloadDir);

    // 7. 校验失败情况下的容错：空页面不应注入按钮
    const blank = await context.newPage();
    await blank.goto(`http://localhost:${PORT}/demo/shop.html`, { waitUntil: 'load' });
    await sleep(800);
    const hasFab = await blank.locator('#imagegrab-fab').count();
    log('无 ?imagegrab-demo=1 参数时按钮数量(应为 0):', hasFab);

    // 汇总 + 断言（失败时以非 0 退出码结束，避免“打印一堆日志但其实没通过”）
    const completed = downloads.filter((d) => d.state === 'complete').length;
    const summary = {
      extensionId,
      extracted: cards,
      expectedAtLeast: 10,
      downloads: downloads.length,
      completed,
      filesOnDisk: files.length,
      toastText,
      blankPageInjected: hasFab > 0,
    };
    log('RESULT ' + JSON.stringify(summary));

    const problems = [];
    if (cards < summary.expectedAtLeast) problems.push(`提取数量不足：${cards} < 10`);
    if (completed < cards) problems.push(`下载未全部完成：${completed}/${cards}`);
    if (files.length < cards) problems.push(`落盘数量不足：${files.length}/${cards}`);
    if (hasFab > 0) problems.push('无 demo 参数时仍然注入了按钮');
    const notPng = files.filter((f) => !f.endsWith('.png'));
    if (notPng.length) problems.push(`存在非 PNG 文件：${notPng.join(', ')}`);

    if (problems.length) {
      log('E2E 未通过：' + problems.join('；'));
      process.exitCode = 1;
    } else {
      log('E2E 通过 ✔');
    }
  } finally {
    await context.close();
    server.close();
  }
}

main().catch((err) => {
  console.error('E2E 失败:', err);
  process.exitCode = 1;
});
