/**
 * 图提取 ImageGrab · 官网交互
 * 1) 导航栏吸顶（滚动后加毛玻璃阴影）
 * 2) 移动端汉堡菜单
 * 3) 滚动进入视口的淡入上移动画（IntersectionObserver）
 * 4) 导航当前区块高亮（滚动监听）
 * 纯原生 JS，无依赖，可直接 file:// 打开。
 */
(() => {
  'use strict';

  const header = document.getElementById('siteHeader');
  const navToggle = document.getElementById('navToggle');
  const navLinks = document.getElementById('navLinks');
  const navAnchors = Array.from(document.querySelectorAll('[data-nav]'));

  /* --------------------------------------------------- 1. 导航吸顶 */
  const onScroll = () => {
    header.classList.toggle('is-stuck', window.scrollY > 8);
  };
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  /* --------------------------------------------------- 2. 移动端菜单 */
  const closeMenu = () => {
    navLinks.classList.remove('is-open');
    navToggle.classList.remove('is-open');
    navToggle.setAttribute('aria-expanded', 'false');
    navToggle.setAttribute('aria-label', '展开菜单');
  };

  navToggle.addEventListener('click', () => {
    const open = navLinks.classList.toggle('is-open');
    navToggle.classList.toggle('is-open', open);
    navToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    navToggle.setAttribute('aria-label', open ? '收起菜单' : '展开菜单');
  });

  // 点击导航项后收起菜单（含锚点跳转）
  navLinks.addEventListener('click', (event) => {
    if (event.target.closest('a')) closeMenu();
  });

  // 点击页面其它区域 / 按 Esc 也收起
  document.addEventListener('click', (event) => {
    if (!navLinks.classList.contains('is-open')) return;
    if (event.target.closest('#navLinks') || event.target.closest('#navToggle')) return;
    closeMenu();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu();
  });

  /* --------------------------------------------------- 3. 淡入动效 */
  const revealItems = document.querySelectorAll('[data-reveal]');

  if ('IntersectionObserver' in window) {
    revealItems.forEach((el) => {
      const delay = Number(el.dataset.delay || 0);
      if (delay) el.style.setProperty('--reveal-delay', `${delay}ms`);
    });

    const revealObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-visible');
          revealObserver.unobserve(entry.target);
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 }
    );

    revealItems.forEach((el) => revealObserver.observe(el));
  } else {
    // 兜底：不支持 IntersectionObserver 时直接显示
    revealItems.forEach((el) => el.classList.add('is-visible'));
  }

  /* --------------------------------------------------- 4. 导航高亮 */
  const sections = Array.from(document.querySelectorAll('section[id]'));
  const linkFor = (id) => navAnchors.find((a) => a.getAttribute('href') === `#${id}`);

  if ('IntersectionObserver' in window && sections.length) {
    const spy = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          navAnchors.forEach((a) => a.classList.remove('is-active'));
          const active = linkFor(entry.target.id);
          if (active) active.classList.add('is-active');
        });
      },
      // 视口中部一条窄带，避免多个区块同时命中
      { rootMargin: '-45% 0px -50% 0px', threshold: 0 }
    );
    sections.forEach((section) => spy.observe(section));
  }

  /* --------------------------------------------------- 5. 年份 */
  const year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());
})();
