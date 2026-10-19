/**
 * 图提取 ImageGrab · content script
 * 职责：只在目标电商商品详情页注入悬浮按钮，点击后扫描页面全部商品图，
 *       过滤噪声与过小图片，补全并去重 URL，最后把结果交给 background 打开预览页。
 * 说明：本文件运行在页面上下文（隔离环境），不依赖任何第三方库。
 */
(() => {
  'use strict';

  // 防止同一页面被重复注入（例如扩展热更新后）
  if (window.__imageGrabInjected) return;
  window.__imageGrabInjected = true;

  const MIN_SIZE = 100;          // 小于 100x100 的图视为图标/占位图
  const MAX_CANDIDATES = 240;    // 单次最多探测的候选图数量，避免页面卡顿
  const PROBE_TIMEOUT = 6000;    // 单张图片探测超时（懒加载图可能挂起）
  const PROBE_CONCURRENCY = 6;   // 并发探测数

  /* -------------------------------------------------------------------------- */
  /* 1. 页面识别                                                                 */
  /* -------------------------------------------------------------------------- */

  const PLATFORM_RULES = [
    {
      key: 'taobao',
      label: '淘宝 / 天猫',
      host: /(^|\.)(taobao|tmall)\.com$/i,
      detail: /\/item\.htm|\/item\/\d+|detail\.tmall\.com\/item/i,
    },
    {
      key: 'jd',
      label: '京东',
      host: /(^|\.)jd\.com$/i,
      // 京东详情页路径规律不同，单独在 detectPage() 中判断
      detail: null,
    },
    {
      key: 'pdd',
      label: '拼多多商家版',
      host: /(^|\.)(pinduoduo|yangkeduo)\.com$/i,
      detail: /goods\d*\.html|goods_id=/i,
    },
  ];

  /**
   * 判断当前页面是否为目标平台的商品详情页。
   * @returns {{key:string,label:string,isDetail:boolean}|null}
   */
  function detectPage() {
    const host = location.hostname;
    const pathAndQuery = location.pathname + location.search;

    // 本地演示页：仅在带 imagegrab-demo=1 时启用，便于开发调试与截图
    if (/^(localhost|127\.0\.0\.1)$/.test(host)) {
      if (/[?&]imagegrab-demo=1/.test(location.search)) {
        return { key: 'demo', label: '本地演示页', isDetail: true };
      }
      return null;
    }

    for (const rule of PLATFORM_RULES) {
      if (!rule.host.test(host)) continue;
      let isDetail;
      if (rule.key === 'jd') {
        // 京东 PC / 移动端详情页：item.jd.com/123.html、item.m.jd.com/product/123.html
        isDetail = /^item\.(m\.)?jd\.com$/i.test(host) && /\/\d+\.html|\/product\/\d+/i.test(pathAndQuery);
      } else {
        isDetail = rule.detail.test(pathAndQuery + host);
      }
      return { key: rule.key, label: rule.label, isDetail };
    }
    return null;
  }

  /* -------------------------------------------------------------------------- */
  /* 2. 图片 URL 收集与清洗                                                       */
  /* -------------------------------------------------------------------------- */

  const IMG_ATTRS = [
    'src',
    'data-src',
    'data-lazy-src',
    'data-original',
    'data-ks-lazyload',
    'data-lazyload',
    'data-echo',
    'data-url',
    'data-image',
    'data-src-large',
    'data-lazy',
  ];

  // 明显是图标 / 占位 / 装饰图的 URL 特征
  const NOISE_PATTERN =
    /(logo|icon|sprite|placeholder|placehold|loading|lazyload|blank|spacer|avatar|qrcode|erweima|1x1|pixel|transparent|grey\.gif|gray\.gif|default-img|watermark|badge|arrow|close|search)/i;

  /** 相对路径补全为绝对 URL，并统一协议 */
  function absolutize(raw) {
    if (!raw) return null;
    const value = String(raw).trim().replace(/^['"]|['"]$/g, '');
    if (!value || /^(data|blob|javascript|about|chrome-extension):/i.test(value)) return null;
    try {
      const url = new URL(value.startsWith('//') ? `https:${value}` : value, location.href);
      if (!/^https?:$/.test(url.protocol)) return null;
      // 仅当所在页面是 https 时把 http 图片升级为 https，避免混合内容拦截；
      // 页面本身是 http（如本地演示页）时保持原协议，否则会直接加载失败
      if (url.protocol === 'http:' && location.protocol === 'https:') url.protocol = 'https:';
      url.hash = '';
      return url.href;
    } catch {
      return null;
    }
  }

  /** 从 srcset 中挑选尺寸最大的那一张 */
  function pickFromSrcset(srcset) {
    if (!srcset) return null;
    const parts = String(srcset)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const [url, descriptor] = item.split(/\s+/);
        let weight = 0;
        if (descriptor) {
          const num = parseFloat(descriptor);
          if (descriptor.endsWith('w')) weight = num;
          else if (descriptor.endsWith('x')) weight = num * 1000;
        }
        return { url, weight: Number.isFinite(weight) ? weight : 0 };
      })
      .sort((a, b) => b.weight - a.weight);
    return parts.length ? parts[0].url : null;
  }

  /** 从 style / computedStyle 的 background-image 中提取 URL */
  function pickBackgroundUrl(styleValue) {
    if (!styleValue || styleValue === 'none') return null;
    const matches = styleValue.match(/url\((['"]?)([^'")]+)\1\)/gi) || [];
    for (const item of matches) {
      const url = item.replace(/^url\((['"]?)/i, '').replace(/['"]?\)$/, '');
      if (url && !/^(data|about|blob):/i.test(url)) return url;
    }
    return null;
  }

  /**
   * 把电商常见的缩略图地址还原为原图地址。
   * - 阿里 CDN：xxx.jpg_430x430q90.jpg → xxx.jpg
   * - 京东   ：.../s450x450_jfs/... → .../jfs/...
   */
  function upgradeToOriginal(url) {
    return url
      .replace(/(\.(?:jpg|jpeg|png|webp|gif))_\d+x\d+[^/]*$/i, '$1')
      .replace(/(\.(?:jpg|jpeg|png|webp|gif))_\.webp$/i, '$1')
      .replace(/\/s\d+x\d+_jfs\//i, '/jfs/')
      .replace(/\/n\d+\/jfs\//i, '/jfs/');
  }

  /**
   * 扫描 DOM，收集所有可能是商品图的候选 URL（尚未校验尺寸）。
   * @returns {{url:string, alt:string, order:number, from:string}[]}
   */
  function collectCandidates() {
    const seen = new Set();
    const result = [];
    let order = 0;

    const push = (rawUrl, el, from) => {
      const url = absolutize(rawUrl);
      if (!url) return;
      if (NOISE_PATTERN.test(url)) return;
      const original = absolutize(upgradeToOriginal(url));
      const finalUrl = original || url;
      if (seen.has(finalUrl)) return;
      seen.add(finalUrl);
      result.push({
        url: finalUrl,
        alt: (el && (el.alt || el.getAttribute('title') || el.getAttribute('data-title'))) || '',
        order: order++,
        from,
      });
    };

    // <img> 与常见懒加载属性
    const nodes = document.querySelectorAll(
      'img, picture source, [data-src], [data-lazy-src], [data-ks-lazyload], [data-original], [data-echo], [data-image], [data-url], [style*="background"]'
    );

    nodes.forEach((el) => {
      if (el.tagName === 'IMG') {
        push(el.currentSrc, el, 'img');
        push(el.getAttribute('src'), el, 'img');
        push(pickFromSrcset(el.getAttribute('srcset')), el, 'srcset');
        push(pickFromSrcset(el.getAttribute('data-srcset')), el, 'srcset');
      }
      IMG_ATTRS.forEach((attr) => push(el.getAttribute(attr), el, attr));
      push(pickBackgroundUrl(el.getAttribute('style')), el, 'background');
    });

    // 背景图：只对 class / 内联样式里像“图片容器”的元素做计算样式读取，控制开销
    const all = document.body ? document.body.querySelectorAll('*') : [];
    const limit = Math.min(all.length, 4000);
    for (let i = 0; i < limit; i += 1) {
      const el = all[i];
      const cls = typeof el.className === 'string' ? el.className : '';
      const styleAttr = el.getAttribute('style') || '';
      if (!/background/i.test(styleAttr) && !/(banner|swiper|slide|pic|photo|img|thumb|gallery|main-image)/i.test(cls)) {
        continue;
      }
      const bg = getComputedStyle(el).backgroundImage;
      push(pickBackgroundUrl(bg), el, 'computed-background');
      if (result.length >= MAX_CANDIDATES * 2) break;
    }

    return result.slice(0, MAX_CANDIDATES);
  }

  /* -------------------------------------------------------------------------- */
  /* 3. 尺寸校验（顺带把懒加载图真正加载出来）                                     */
  /* -------------------------------------------------------------------------- */

  /** 加载一张图片并返回其自然尺寸，失败返回 null */
  function probeImage(url) {
    return new Promise((resolve) => {
      const img = new Image();
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        img.onload = null;
        img.onerror = null;
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), PROBE_TIMEOUT);
      img.onload = () => {
        clearTimeout(timer);
        finish({ width: img.naturalWidth, height: img.naturalHeight });
      };
      img.onerror = () => {
        clearTimeout(timer);
        finish(null);
      };
      // 部分电商 CDN 会校验 referer，这里保持默认策略，跟随页面 referer
      img.decoding = 'async';
      img.src = url;
    });
  }

  /** 以固定并发数批量探测，保持候选顺序 */
  async function probeAll(candidates, onProgress) {
    const results = new Array(candidates.length).fill(null);
    let cursor = 0;
    let finished = 0;

    async function worker() {
      while (cursor < candidates.length) {
        const index = cursor++;
        const item = candidates[index];
        const size = await probeImage(item.url);
        results[index] = size ? { ...item, ...size } : null;
        finished += 1;
        if (onProgress) onProgress(finished, candidates.length);
      }
    }

    const workers = Array.from({ length: Math.min(PROBE_CONCURRENCY, candidates.length) }, worker);
    await Promise.all(workers);
    return results.filter(Boolean);
  }

  /* -------------------------------------------------------------------------- */
  /* 4. 悬浮按钮 UI                                                              */
  /* -------------------------------------------------------------------------- */

  const FAB_ID = 'imagegrab-fab';
  const TOAST_ID = 'imagegrab-toast';
  let fab = null;
  let toastTimer = null;
  let scanning = false;

  function createFab(label) {
    fab = document.createElement('button');
    fab.id = FAB_ID;
    fab.type = 'button';
    fab.title = `在${label}商品详情页提取全部图片`;
    fab.innerHTML = `
      <span class="ig-fab__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"
             stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="4"></rect>
          <circle cx="8.5" cy="9" r="1.6"></circle>
          <path d="M21 15l-4.5-4.5L7 20"></path>
        </svg>
      </span>
      <span class="ig-fab__text">获取图片</span>
      <span class="ig-fab__spinner" aria-hidden="true"></span>
      <span class="ig-fab__count" hidden>0</span>
    `;
    fab.addEventListener('click', onClickFab);
    document.documentElement.appendChild(fab);
  }

  function setFabState(state, count) {
    if (!fab) return;
    fab.classList.toggle('is-scanning', state === 'scanning');
    fab.classList.toggle('is-done', state === 'done');
    const text = fab.querySelector('.ig-fab__text');
    const badge = fab.querySelector('.ig-fab__count');
    if (state === 'scanning') text.textContent = '扫描中';
    else if (state === 'done') text.textContent = '重新获取';
    else text.textContent = '获取图片';

    if (typeof count === 'number' && count > 0) {
      badge.textContent = String(count);
      badge.hidden = false;
    } else {
      badge.hidden = true;
    }
  }

  function showToast(message, type = 'info', duration = 3200) {
    let toast = document.getElementById(TOAST_ID);
    if (!toast) {
      toast = document.createElement('div');
      toast.id = TOAST_ID;
      document.documentElement.appendChild(toast);
    }
    toast.textContent = message;
    toast.dataset.type = type;
    toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    if (duration > 0) {
      toastTimer = setTimeout(() => toast.classList.remove('is-visible'), duration);
    }
    return toast;
  }

  /* -------------------------------------------------------------------------- */
  /* 5. 主流程                                                                   */
  /* -------------------------------------------------------------------------- */

  async function onClickFab() {
    if (scanning) return;
    scanning = true;
    setFabState('scanning');

    try {
      const platform = detectPage();
      showToast('正在扫描页面图片…', 'info', 0);
      const candidates = collectCandidates();

      if (!candidates.length) {
        showToast('没有找到可下载的图片，试试先把页面滚动到底部再提取', 'warn', 4200);
        setFabState('idle');
        return;
      }

      const toast = showToast(`正在检查图片尺寸 0/${candidates.length}`, 'info', 0);
      const valid = await probeAll(candidates, (done, total) => {
        if (toast.isConnected) toast.textContent = `正在检查图片尺寸 ${done}/${total}`;
      });

      const images = valid
        .filter((item) => item.width >= MIN_SIZE && item.height >= MIN_SIZE)
        .sort((a, b) => b.width * b.height - a.width * a.height)
        .map((item) => ({
          url: item.url,
          width: item.width,
          height: item.height,
          alt: item.alt,
        }));

      if (!images.length) {
        showToast('提取到的图片都小于 100×100，已全部过滤', 'warn', 4200);
        setFabState('idle');
        return;
      }

      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage(
          {
            type: 'EXTRACT_DONE',
            payload: {
              pageUrl: location.href,
              pageTitle: document.title,
              platform: platform ? platform.label : '未知平台',
              images,
            },
          },
          (reply) => {
            // 读取 lastError 防止控制台报未处理错误
            const error = chrome.runtime.lastError;
            resolve({ ok: !error && reply && reply.ok, error: error && error.message });
          }
        );
      });

      if (response.ok) {
        setFabState('done', images.length);
        showToast(`已提取 ${images.length} 张图片，正在打开预览页…`, 'success');
      } else {
        showToast(`打开预览页失败：${response.error || '未知错误'}`, 'error', 4200);
        setFabState('idle');
      }
    } catch (err) {
      console.error('[ImageGrab] 提取失败', err);
      showToast(`提取失败：${err && err.message ? err.message : err}`, 'error', 4200);
      setFabState('idle');
    } finally {
      scanning = false;
    }
  }

  /* -------------------------------------------------------------------------- */
  /* 6. 启动                                                                     */
  /* -------------------------------------------------------------------------- */

  function boot() {
    const platform = detectPage();
    if (!platform || !platform.isDetail) return; // 非商品详情页不注入任何 UI
    if (document.getElementById(FAB_ID)) return;
    createFab(platform.label);

    // 需要时向 background 索取上次结果，用于恢复按钮上的数量角标
    chrome.runtime.sendMessage({ type: 'GET_LAST_META' }, (reply) => {
      if (chrome.runtime.lastError || !reply || !reply.meta) return;
      if (reply.meta.pageUrl !== location.href) return;
      setFabState('done', reply.meta.count);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
