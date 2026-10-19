/**
 * 图提取 ImageGrab · 预览页逻辑
 * 数据来源：background 写入 chrome.storage.local 的最近一次提取结果
 * 交互：全选 / 反选 / 单张勾选 / 批量下载（PNG）
 */

(() => {
  'use strict';

  const STORAGE_KEY = 'imagegrab:last';
  const $ = (id) => document.getElementById(id);

  const els = {
    hero: $('hero'),
    toolbar: $('toolbar'),
    grid: $('grid'),
    empty: $('empty'),
    total: $('totalCount'),
    selected: $('selectedCount'),
    checkAll: $('checkAll'),
    btnInvert: $('btnInvert'),
    btnDownload: $('btnDownload'),
    btnDownloadText: $('btnDownloadText'),
    btnClear: $('btnClear'),
    progress: $('progress'),
    progressLabel: $('progressLabel'),
    progressCount: $('progressCount'),
    progressBar: $('progressBar'),
    toast: $('toast'),
    source: $('source'),
    sourcePlatform: $('sourcePlatform'),
    sourceTitle: $('sourceTitle'),
  };

  const state = {
    items: [], // { url, width, height, filename, checked, status, el }
    downloading: false,
  };

  let toastTimer = null;

  /* ---------------------------------------------------------------- 工具 */

  function showToast(message, type = 'success', duration = 3600) {
    els.toast.textContent = message;
    els.toast.dataset.type = type;
    els.toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('is-visible'), duration);
  }

  function pad(num, len = 3) {
    return String(num).padStart(len, '0');
  }

  function formatBytes(bytes) {
    if (!bytes && bytes !== 0) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (reply) => {
        const error = chrome.runtime.lastError;
        if (error) resolve({ ok: false, error: error.message });
        else resolve(reply || { ok: false, error: '没有收到响应' });
      });
    });
  }

  /* ---------------------------------------------------------------- 渲染 */

  function renderSource(data) {
    if (!data || !data.pageUrl) {
      els.source.hidden = true;
      return;
    }
    els.source.hidden = false;
    els.sourcePlatform.textContent = data.platform || '商品详情页';
    els.sourceTitle.textContent = data.pageTitle || data.pageUrl;
    els.sourceTitle.href = data.pageUrl;
    els.sourceTitle.title = data.pageTitle || data.pageUrl;
  }

  function createCard(image, index) {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.index = String(index);

    const filename = `商品图_${pad(index + 1)}.png`;

    card.innerHTML = `
      <div class="card__thumb">
        <input type="checkbox" class="card__check" aria-label="选择第 ${index + 1} 张图片" />
        <span class="card__index">${pad(index + 1, 2)}</span>
        <img alt="" loading="lazy" />
        <span class="card__status" data-state="pending"></span>
      </div>
      <div class="card__meta">
        <span class="card__size">${image.width}×${image.height}</span>
        <span class="card__name">${filename}</span>
      </div>
    `;

    const img = card.querySelector('img');
    img.src = image.url;
    img.alt = image.alt || `商品图 ${index + 1}`;
    img.addEventListener('load', () => card.classList.add('is-loaded'));
    img.addEventListener('error', () => {
      card.classList.add('is-loaded');
      img.replaceWith(Object.assign(document.createElement('div'), {
        className: 'card__failed-thumb',
        textContent: '缩略图加载失败',
      }));
    });

    const checkbox = card.querySelector('.card__check');
    checkbox.checked = true;
    checkbox.addEventListener('change', () => {
      item.checked = checkbox.checked;
      syncCardSelection(item);
      updateToolbar();
    });

    const item = {
      url: image.url,
      width: image.width,
      height: image.height,
      filename,
      checked: true,
      status: 'idle',
      el: card,
      checkbox,
    };

    // 点击卡片空白处也能切换选中状态
    card.addEventListener('click', (event) => {
      if (event.target === checkbox) return;
      checkbox.checked = !checkbox.checked;
      checkbox.dispatchEvent(new Event('change'));
    });

    return { card, item };
  }

  function syncCardSelection(item) {
    item.el.classList.toggle('is-selected', item.checked);
  }

  function setCardStatus(item, status, text) {
    item.status = status;
    const badge = item.el.querySelector('.card__status');
    if (!badge) return;
    if (!status || status === 'idle') {
      badge.classList.remove('is-visible');
      item.el.classList.remove('is-failed');
      return;
    }
    badge.dataset.state = status;
    badge.textContent = text || '';
    badge.classList.add('is-visible');
    item.el.classList.toggle('is-failed', status === 'failed');
  }

  function render(data) {
    state.items = [];
    els.grid.innerHTML = '';

    const images = (data && Array.isArray(data.images) ? data.images : []).filter((img) => img && img.url);
    if (!images.length) {
      els.hero.hidden = true;
      els.toolbar.hidden = true;
      els.empty.hidden = false;
      return;
    }

    els.empty.hidden = true;
    els.hero.hidden = false;
    els.toolbar.hidden = false;
    els.total.textContent = String(images.length);

    const fragment = document.createDocumentFragment();
    images.forEach((image, index) => {
      const { card, item } = createCard(image, index);
      state.items.push(item);
      syncCardSelection(item);
      fragment.appendChild(card);
    });
    els.grid.appendChild(fragment);
    updateToolbar();
  }

  function updateToolbar() {
    const total = state.items.length;
    const selected = state.items.filter((item) => item.checked).length;
    els.selected.textContent = String(selected);
    els.checkAll.checked = selected > 0 && selected === total;
    els.checkAll.indeterminate = selected > 0 && selected < total;
    els.btnDownload.disabled = selected === 0 || state.downloading;
    els.btnDownloadText.textContent = selected > 0 ? `下载选中（${selected}）` : '下载选中';
  }

  /* ---------------------------------------------------------------- 下载 */

  function showProgress(done, total, label) {
    els.progress.hidden = false;
    els.progressCount.textContent = `${done}/${total}`;
    els.progressLabel.textContent = label;
    els.progressBar.style.width = `${total ? (done / total) * 100 : 0}%`;
  }

  function hideProgress(delay = 900) {
    setTimeout(() => {
      els.progress.hidden = true;
      els.progressBar.style.width = '0%';
    }, delay);
  }

  async function downloadSelected() {
    if (state.downloading) return;
    const picks = state.items.filter((item) => item.checked);
    if (!picks.length) {
      showToast('请先勾选要下载的图片', 'warn');
      return;
    }

    state.downloading = true;
    updateToolbar();
    els.btnInvert.disabled = true;
    els.checkAll.disabled = true;

    const startedAt = Date.now();
    let success = 0;
    let failed = 0;
    let fallback = 0;
    let firstError = '';

    for (let i = 0; i < picks.length; i += 1) {
      const item = picks[i];
      setCardStatus(item, 'working', '转换中');
      showProgress(i, picks.length, `正在处理 ${item.filename}`);

      // eslint-disable-next-line no-await-in-loop
      const reply = await sendMessage({
        type: 'DOWNLOAD_ONE',
        payload: { url: item.url, filename: item.filename },
      });

      if (reply.ok) {
        success += 1;
        if (reply.fallback) {
          fallback += 1;
          setCardStatus(item, 'done', '原格式');
        } else {
          setCardStatus(item, 'done', `PNG ${formatBytes(reply.bytes)}`);
        }
        item.el.classList.add('is-downloaded');
      } else {
        failed += 1;
        if (!firstError) firstError = reply.error || '';
        setCardStatus(item, 'failed', '失败');
      }
      showProgress(i + 1, picks.length, `已完成 ${i + 1}/${picks.length}`);
    }

    state.downloading = false;
    els.btnInvert.disabled = false;
    els.checkAll.disabled = false;
    updateToolbar();

    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    const summary = `已下载 ${success} 张${failed ? `，失败 ${failed} 张` : ''}${fallback ? `（其中 ${fallback} 张回退为原格式）` : ''} · 用时 ${seconds}s`;
    showToast(summary, failed ? 'warn' : 'success', 5200);
    els.progressLabel.textContent = summary;
    hideProgress(1200);

    if (failed && /fetch|403|401|HTTP/i.test(firstError)) {
      setTimeout(() => {
        showToast('部分图片被目标站点防盗链拦截，可在扩展详情页补充站点权限后重试', 'error', 6000);
      }, 5600);
    }
  }

  /* ---------------------------------------------------------------- 事件 */

  els.checkAll.addEventListener('change', () => {
    const checked = els.checkAll.checked;
    state.items.forEach((item) => {
      item.checked = checked;
      item.checkbox.checked = checked;
      syncCardSelection(item);
    });
    updateToolbar();
  });

  els.btnInvert.addEventListener('click', () => {
    state.items.forEach((item) => {
      item.checked = !item.checked;
      item.checkbox.checked = item.checked;
      syncCardSelection(item);
    });
    updateToolbar();
  });

  els.btnDownload.addEventListener('click', downloadSelected);

  els.btnClear.addEventListener('click', async () => {
    if (state.downloading) {
      showToast('下载进行中，请稍候再清空', 'warn');
      return;
    }
    await sendMessage({ type: 'CLEAR' });
    render(null);
    showToast('列表已清空', 'success', 2000);
  });

  // 边看预览边回详情页重新提取时，自动刷新列表
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[STORAGE_KEY]) return;
    if (state.downloading) return;
    const next = changes[STORAGE_KEY].newValue || null;
    renderSource(next);
    render(next);
  });

  /* ---------------------------------------------------------------- 启动 */

  (async () => {
    const reply = await sendMessage({ type: 'GET_LAST' });
    const data = reply && reply.data ? reply.data : null;
    renderSource(data);
    render(data);
  })();
})();
