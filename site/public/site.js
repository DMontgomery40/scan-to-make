// Counterpart docs: small, dependency-free behaviour. Every page works without it.
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  // The masthead gets its rule once the page scrolls under it.
  const head = $('.masthead');
  if (head) {
    const mark = () => head.classList.toggle('scrolled', window.scrollY > 8);
    mark(); window.addEventListener('scroll', mark, {passive: true});
  }

  // Help contents: open on wide screens, a disclosure on phones.
  const tocBox = $('.toc-disclosure');
  if (tocBox) {
    const sync = () => { tocBox.open = window.innerWidth > 980; };
    sync(); window.addEventListener('resize', sync);
  }

  // Tabs: the step-through and the device switch. Arrow keys move between tabs.
  for (const list of $$('[role="tablist"]')) {
    const tabs = $$('[role="tab"]', list);
    const select = (tab, focus) => {
      for (const other of tabs) {
        const on = other === tab;
        other.setAttribute('aria-selected', on);
        other.tabIndex = on ? 0 : -1;
        const panel = document.getElementById(other.getAttribute('aria-controls'));
        if (panel) panel.hidden = !on;
      }
      if (focus) tab.focus();
      list.dispatchEvent(new CustomEvent('tabchange', {detail: tabs.indexOf(tab)}));
    };
    tabs.forEach(tab => {
      tab.addEventListener('click', () => select(tab, false));
      tab.addEventListener('keydown', event => {
        const index = tabs.indexOf(tab);
        const next = {ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1}[event.key];
        if (next) { event.preventDefault(); select(tabs[(index + next + tabs.length) % tabs.length], true); }
        if (event.key === 'Home') { event.preventDefault(); select(tabs[0], true); }
        if (event.key === 'End') { event.preventDefault(); select(tabs.at(-1), true); }
      });
    });
    list.select = index => select(tabs[Math.max(0, Math.min(tabs.length - 1, index))], false);
  }

  // Back and Next under the step-through.
  const steps = $('.tour-steps');
  const back = $('[data-tour="back"]'), next = $('[data-tour="next"]');
  if (steps && back && next) {
    const count = $$('[role="tab"]', steps).length;
    const sync = index => { back.disabled = index === 0; next.disabled = index === count - 1; };
    steps.addEventListener('tabchange', event => sync(event.detail));
    const current = () => $$('[role="tab"]', steps).findIndex(tab => tab.getAttribute('aria-selected') === 'true');
    back.addEventListener('click', () => steps.select(current() - 1));
    next.addEventListener('click', () => steps.select(current() + 1));
    sync(0);
  }

  // Any screen opens larger. Without the script the link opens the image itself.
  const zoom = $('#zoom');
  if (zoom && typeof zoom.showModal === 'function') {
    const img = $('img', zoom), caption = $('figcaption', zoom);
    document.addEventListener('click', event => {
      const shot = event.target.closest('a.shot');
      if (!shot) return;
      event.preventDefault();
      const inner = $('img', shot);
      img.src = shot.href; img.alt = inner?.alt ?? '';
      caption.textContent = shot.closest('figure')?.querySelector('figcaption')?.textContent ?? inner?.alt ?? '';
      zoom.showModal();
    });
    zoom.addEventListener('click', event => { if (event.target === zoom) zoom.close(); });
  }

  // What you need: ticking every line says you're ready. Remembered on this device only.

  // Help: search filters the sections and questions, and the contents follow your place on the page.
  const search = $('#help-search');
  const sections = $$('.help-body > section');
  const toc = $$('.toc a');
  if (search && sections.length) {
    const none = $('.nomatch');
    const originals = new Map();
    const textNodes = root => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode); return nodes;
    };
    const unmark = () => { for (const [section, html] of originals) section.innerHTML = html; originals.clear(); };
    const markIn = (root, term) => {
      const pattern = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      for (const node of textNodes(root)) {
        if (!pattern.test(node.nodeValue) || node.parentElement.closest('summary, h2, figcaption, mark')) { pattern.lastIndex = 0; continue; }
        pattern.lastIndex = 0;
        const span = document.createElement('span');
        span.innerHTML = node.nodeValue.replace(/[&<>]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'}[c])).replace(pattern, m => `<mark>${m}</mark>`);
        node.replaceWith(...span.childNodes);
      }
    };
    const run = () => {
      unmark();
      const term = search.value.trim();
      let shown = 0;
      for (const section of sections) {
        const hit = !term || section.textContent.toLowerCase().includes(term.toLowerCase());
        section.hidden = !hit;
        if (hit) shown++;
        const link = toc.find(a => a.hash === `#${section.id}`);
        link?.classList.toggle('dim', !hit);
        if (hit && term.length > 1) {
          originals.set(section, section.innerHTML);
          for (const details of $$('details', section)) details.open = details.textContent.toLowerCase().includes(term.toLowerCase());
          markIn(section, term);
        }
      }
      if (none) { none.hidden = shown > 0; none.querySelector('q').textContent = term; }
    };
    search.addEventListener('input', run);
    search.addEventListener('keydown', event => { if (event.key === 'Escape') { search.value = ''; run(); } });
    document.addEventListener('keydown', event => {
      if (event.key === '/' && document.activeElement !== search && !event.target.closest('input, textarea')) { event.preventDefault(); search.focus(); }
    });
    if ('IntersectionObserver' in window) {
      const seen = new Map();
      const observer = new IntersectionObserver(entries => {
        for (const entry of entries) seen.set(entry.target.id, entry.isIntersecting);
        const first = sections.find(section => seen.get(section.id));
        if (first) toc.forEach(a => a.classList.toggle('here', a.hash === `#${first.id}`));
      }, {rootMargin: '-80px 0px -55% 0px'});
      sections.forEach(section => observer.observe(section));
    }
  }
})();
