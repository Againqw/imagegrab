/**
 * 图提取 ImageGrab · background service worker (MV3)
 * 职责：
 *   1. 接收 content script 提取的图片列表，落盘到 chrome.storage，并打开预览页；
 *   2. 负责单张图片的 PNG 转换与下载（fetch + createImageBitmap + OffscreenCanvas，
 *      借助扩展的 host_permissions 绕过页面跨域限制）；
 *   3. 维护工具栏角标与预览页数据读写。
 */

const STORAGE_KEY = 'imagegrab:last';
// 注意：MV3 的 service worker 里没有 URL.createObjectURL()（SW 规范已移除），
// 所以下载一律走 data URL；实测 20MB 的 PNG（base64 约 26MB）也能正常下载完成。

/* -------------------------------------------------------------------------- */
/* 工具函数                                                                    */
/* -------------------------------------------------------------------------- */

/** 读取上次提取结果 */
async function readLast() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  return stored[STORAGE_KEY] || null;
}

/** 打开（或聚焦）预览页 */
async function openGallery() {
  const galleryUrl = chrome.runtime.getURL('gallery.html');
  try {
    // getContexts 不需要 tabs 权限，可拿到扩展自身已打开的标签页
    if (chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
      const existing = contexts.find((ctx) => ctx.documentUrl && ctx.documentUrl.startsWith(galleryUrl));
      if (existing && existing.tabId >= 0) {
        await chrome.tabs.update(existing.tabId, { active: true });
        if (existing.windowId >= 0) await chrome.windows.update(existing.windowId, { focused: true });
        return;
      }
    }
  } catch (err) {
    console.warn('[ImageGrab] 复用预览页失败，将新建标签页', err);
  }
  await chrome.tabs.create({ url: galleryUrl });
}

/** 更新工具栏角标 */
async function updateBadge(count) {
  const text = count > 0 ? (count > 99 ? '99+' : String(count)) : '';
  await chrome.action.setBadgeText({ text });
  if (text) {
    await chrome.action.setBadgeBackgroundColor({ color: '#4f46e5' });
    await chrome.action.setBadgeTextColor?.({ color: '#ffffff' });
  }
}

/** ArrayBuffer → base64（分块处理，避免超长字符串导致调用栈溢出） */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

/* -------------------------------------------------------------------------- */
/* 图片转 PNG                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 下载并转换为 PNG。
 * @param {string} url 原图地址
 * @returns {Promise<{blob:Blob,width:number,height:number,converted:boolean}>}
 */
async function fetchAsPng(url) {
  const response = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
  if (!response.ok) throw new Error(`图片请求失败（HTTP ${response.status}）`);

  const sourceBlob = await response.blob();
  if (!sourceBlob.size) throw new Error('图片内容为空');

  // 本身是 PNG 就直接用，省一次解码/编码
  if (sourceBlob.type === 'image/png') {
    const bitmap = await createImageBitmap(sourceBlob).catch(() => null);
    const result = {
      blob: sourceBlob,
      width: bitmap ? bitmap.width : 0,
      height: bitmap ? bitmap.height : 0,
      converted: false,
    };
    if (bitmap) bitmap.close?.();
    return result;
  }

  const bitmap = await createImageBitmap(sourceBlob);
  const { width, height } = bitmap;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  // JPEG / WebP 没有透明通道，铺白底后再转换，避免出现黑色背景
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();

  const pngBlob = await canvas.convertToBlob({ type: 'image/png' });
  return { blob: pngBlob, width, height, converted: true };
}

/**
 * 下载单张图片（统一转为 PNG）。
 * @param {{url:string, filename:string}} options
 */
async function downloadOne({ url, filename }) {
  if (!url) return { ok: false, error: '缺少图片地址' };

  try {
    const { blob, width, height, converted } = await fetchAsPng(url);

    const buffer = await blob.arrayBuffer();
    const downloadUrl = `data:image/png;base64,${arrayBufferToBase64(buffer)}`;

    const downloadId = await chrome.downloads.download({
      url: downloadUrl,
      filename,
      conflictAction: 'uniquify',
      saveAs: false,
    });

    return { ok: true, downloadId, filename, bytes: blob.size, width, height, converted };
  } catch (err) {
    console.warn('[ImageGrab] PNG 转换/下载失败，尝试回退原图', url, err);
    // 回退方案：转换失败时直接下载原图，保证用户不会一无所获
    try {
      const fallbackName = filename.replace(/\.png$/i, '') + guessExt(url);
      const downloadId = await chrome.downloads.download({
        url,
        filename: fallbackName,
        conflictAction: 'uniquify',
        saveAs: false,
      });
      return {
        ok: true,
        fallback: true,
        downloadId,
        filename: fallbackName,
        error: err && err.message ? err.message : String(err),
      };
    } catch (fallbackErr) {
      return { ok: false, error: fallbackErr && fallbackErr.message ? fallbackErr.message : String(fallbackErr) };
    }
  }
}

/** 根据 URL 推断扩展名（回退下载时用） */
function guessExt(url) {
  const match = /\.(jpg|jpeg|png|webp|gif|avif)(?:[?#]|$)/i.exec(url);
  if (!match) return '.jpg';
  const ext = match[1].toLowerCase();
  return ext === 'jpeg' ? '.jpg' : `.${ext}`;
}

/* -------------------------------------------------------------------------- */
/* 消息路由                                                                    */
/* -------------------------------------------------------------------------- */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message && message.type;

  if (type === 'EXTRACT_DONE') {
    (async () => {
      const payload = message.payload || {};
      const images = Array.isArray(payload.images) ? payload.images : [];
      const record = {
        pageUrl: payload.pageUrl || '',
        pageTitle: payload.pageTitle || '',
        platform: payload.platform || '',
        images,
        extractedAt: Date.now(),
      };
      await chrome.storage.local.set({ [STORAGE_KEY]: record });
      await updateBadge(images.length);
      await openGallery();
      sendResponse({ ok: true, count: images.length });
    })();
    return true; // 异步响应
  }

  if (type === 'GET_LAST_META') {
    (async () => {
      const record = await readLast();
      sendResponse({
        meta: record ? { pageUrl: record.pageUrl, count: record.images.length, extractedAt: record.extractedAt } : null,
      });
    })();
    return true;
  }

  if (type === 'GET_LAST') {
    (async () => sendResponse({ data: await readLast() }))();
    return true;
  }

  if (type === 'CLEAR') {
    (async () => {
      await chrome.storage.local.remove(STORAGE_KEY);
      await updateBadge(0);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (type === 'DOWNLOAD_ONE') {
    downloadOne(message.payload || {}).then(sendResponse);
    return true;
  }

  return false;
});

/** 点击工具栏图标：直接打开预览页（没有数据时展示使用引导） */
chrome.action.onClicked.addListener(() => {
  openGallery();
});

/** 安装时写一条默认状态，方便首次打开预览页 */
chrome.runtime.onInstalled.addListener(async () => {
  const record = await readLast();
  await updateBadge(record ? record.images.length : 0);
});
