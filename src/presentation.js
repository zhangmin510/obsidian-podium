import { MarkdownRenderer, Component, setIcon } from 'obsidian';
import { isTitleOnly } from './split.js';
import { InkLayer } from './ink.js';

const MIN_ZOOM = 0.45;
const MIN_TABLE_ZOOM = 0.6;
const WIDE_TABLE_COLUMNS = 5;
const DENSE_TABLE_COLUMNS = 7;
const CONTROLS_IDLE_MS = 2000;
const SWIPE_PX = 50;
const ESC_DEBOUNCE_MS = 500;
const NO_CLICK_NAV = 'a, button, input, textarea, select, summary, video, audio, iframe, .internal-link, .mdp-bar';

// Letters are reserved for tools (PowerPoint-style: L laser, P pen, H highlighter, E erase).
const NEXT_KEYS = new Set(['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter']);
const PREV_KEYS = new Set(['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace']);
const TOOL_KEYS = { l: 'laser', p: 'pen', h: 'highlighter' };
const TOOLS = [
  { id: 'laser', icon: 'mouse-pointer-2', name: '激光笔', key: 'L', hint: '光点跟随鼠标并留下残影，点击仍可翻页' },
  { id: 'pen', icon: 'pencil', name: '画笔', key: 'P', hint: '按住拖动做标记' },
  { id: 'highlighter', icon: 'highlighter', name: '荧光笔', key: 'H', hint: '半透明粗笔，适合划重点' },
];

const TIP_MARGIN_PX = 8;

/** Centre the tooltip over its button, nudged inwards so it never leaves the screen. */
function placeTip(button, tip) {
  const b = button.getBoundingClientRect();
  const width = tip.offsetWidth;
  const centred = b.left + b.width / 2 - width / 2;
  const left = Math.min(Math.max(centred, TIP_MARGIN_PX), window.innerWidth - width - TIP_MARGIN_PX);
  tip.setCssProps({ left: `${left - b.left}px` });
}

function stopEvent(e) {
  e.preventDefault();
  e.stopPropagation();
}

class Presentation {
  constructor(plugin, file, slides) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.file = file;
    this.slides = slides;
    this.index = 0;
    this.renderToken = 0;
    this.component = null;
    this.jumpBuffer = '';
    this.closed = false;
    this.cleanups = [];
  }

  open(startIndex) {
    const s = this.plugin.settings;
    const root = document.body.createDiv({ cls: 'mdp-overlay' });
    if (s.theme !== 'auto') root.addClass(`theme-${s.theme}`);
    root.setCssProps({ '--mdp-font-scale': String(s.fontScale) });
    this.root = root;

    this.stage = root.createDiv({ cls: 'mdp-stage' });
    this.blackout = root.createDiv({ cls: 'mdp-blackout' });
    this.ink = new InkLayer(root, { fade: s.inkFade, holdMs: s.inkHoldSeconds * 1000 });
    this.progress = root.createDiv({ cls: 'mdp-progress' });
    this.progress.toggle(s.showProgress);
    this.buildToolbar(root.createDiv({ cls: 'mdp-bar' }));
    this.bindEvents(root);

    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.wakeControls();
    this.enterFullscreen();
    this.go(startIndex);
  }

  buildToolbar(bar) {
    const inkHint = this.plugin.settings.inkFade ? '，松手后自动淡出' : '，笔迹保留在本页';
    const btn = (icon, { name, key, hint }, fn) => {
      const b = bar.createEl('button');
      setIcon(b, icon);
      // Own tooltip: Obsidian's aria-label tooltips live outside the fullscreen element and never show.
      const tip = b.createSpan({ cls: 'mdp-tip' });
      tip.createSpan({ cls: 'mdp-tip-name', text: name });
      if (key) tip.createEl('kbd', { text: key });
      if (hint) tip.createSpan({ cls: 'mdp-tip-hint', text: hint });
      b.addEventListener('mouseenter', () => placeTip(b, tip));
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
      });
      return b;
    };
    this.toolButtons = TOOLS.map((t) => {
      const hint = t.id === 'laser' ? t.hint : t.hint + inkHint;
      return { id: t.id, el: btn(t.icon, { ...t, hint }, () => this.selectTool(t.id)) };
    });
    this.colorButton = btn('circle', { name: '切换颜色', key: 'C', hint: '红 → 黄 → 绿 → 蓝 → 紫' }, () =>
      this.cycleColor(),
    );
    this.colorButton.addClass('mdp-color');
    btn('eraser', { name: '清除本页笔迹', key: 'E' }, () => this.ink.clearSlide());
    bar.createDiv({ cls: 'mdp-bar-sep' });
    btn('chevron-left', { name: '上一页', key: '←' }, () => this.go(this.index - 1));
    this.counter = bar.createSpan({ cls: 'mdp-counter' });
    btn('chevron-right', { name: '下一页', key: '→' }, () => this.go(this.index + 1));
    btn('maximize', { name: '切换全屏', key: 'F' }, () => this.toggleFullscreen());
    btn('x', { name: '退出演示', key: 'Esc', hint: '有工具时先退出工具' }, () => this.close());
    this.syncToolbar();
  }

  bindEvents(root) {
    this.listen(window, 'keydown', (e) => this.onKey(e), true);
    // Capture phase: while drawing, clicks must neither follow links nor turn the page.
    this.listen(root, 'click', (e) => this.blockClickWhileDrawing(e), true);
    this.listen(root, 'click', (e) => this.onClick(e));
    this.listen(root, 'pointerdown', (e) => this.onPointerDown(e));
    this.listen(root, 'pointermove', (e) => {
      this.ink.pointerMove(e);
      this.wakeControls();
    });
    this.listen(root, 'pointerup', () => this.ink.pointerUp());
    this.listen(root, 'pointercancel', () => this.ink.pointerUp());
    this.listen(root, 'pointerleave', () => this.ink.pointerLeave());
    this.listen(root, 'touchstart', (e) => (this.touchX = e.changedTouches[0].clientX), { passive: true });
    this.listen(root, 'touchend', (e) => this.onSwipe(e));
    this.listen(window, 'resize', () => {
      this.scheduleFit();
      this.ink.resize();
    });
    this.listen(document, 'fullscreenchange', () => this.onFullscreenChange());
  }

  selectTool(tool) {
    this.ink.setTool(tool);
    this.syncToolbar();
  }

  cycleColor() {
    this.ink.cycleColor();
    this.syncToolbar();
  }

  syncToolbar() {
    const tool = this.ink.tool;
    for (const b of this.toolButtons) b.el.toggleClass('is-active', b.id === tool);
    this.colorButton.setCssProps({ color: this.ink.color });
    for (const t of TOOLS) this.root.toggleClass(`tool-${t.id}`, t.id === tool);
    this.root.toggleClass('is-drawing', this.ink.isDrawingTool);
  }

  onPointerDown(e) {
    if (e.target.closest('.mdp-bar')) return;
    if (!this.ink.pointerDown(e)) return;
    this.root.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  }

  blockClickWhileDrawing(e) {
    if (!this.ink.isDrawingTool || e.target.closest('.mdp-bar')) return;
    e.preventDefault();
    e.stopPropagation();
  }

  listen(target, type, fn, opts) {
    target.addEventListener(type, fn, opts);
    this.cleanups.push(() => target.removeEventListener(type, fn, opts));
  }

  enterFullscreen() {
    if (!this.root.requestFullscreen) return;
    this.root.requestFullscreen().catch(() => {
      /* windowed overlay still works */
    });
  }

  toggleFullscreen() {
    if (document.fullscreenElement) {
      this.exitClosesDeck = false;
      document.exitFullscreen().catch(() => {});
    } else {
      this.enterFullscreen();
    }
  }

  async go(target) {
    const i = Math.max(0, Math.min(this.slides.length - 1, target));
    if (i === this.index && this.component) return;
    const forward = i >= this.index;
    this.index = i;
    this.blackout.removeClass('is-on');
    this.ink.setSlide(i);
    this.counter.setText(`${i + 1} / ${this.slides.length}`);
    this.progress.setCssProps({ width: `${((i + 1) / this.slides.length) * 100}%` });
    await this.render(i, forward);
  }

  async render(i, forward) {
    const token = ++this.renderToken;
    const component = new Component();
    component.load();

    const slide = createDiv({ cls: 'mdp-slide' });
    const content = slide.createDiv({ cls: 'mdp-content markdown-rendered' });
    const md = this.slides[i].md;
    if (isTitleOnly(md)) slide.addClass('is-title');
    slide.addClass(forward ? 'enter-next' : 'enter-prev');

    try {
      await MarkdownRenderer.render(this.app, md, content, this.file.path, component);
    } catch (err) {
      console.error('[podium] render failed', err);
      content.createEl('pre', { text: md });
    }
    if (token !== this.renderToken || this.closed) {
      component.unload();
      return;
    }

    this.component?.unload();
    this.component = component;
    this.resizeObserver.disconnect();
    this.stage.empty();
    this.stage.appendChild(slide);
    this.slideEl = slide;
    this.contentEl = content;
    content.addEventListener('load', () => this.scheduleFit(), true);
    this.resizeObserver.observe(content);
    this.fit();
  }

  scheduleFit() {
    if (this.fitFrame) return;
    this.fitFrame = window.requestAnimationFrame(() => {
      this.fitFrame = 0;
      this.fit();
    });
  }

  /**
   * Wide or many-column tables get the full slide width instead of the text column;
   * a table still wider than that is zoomed on its own, so the rest of the slide keeps its size.
   */
  fitTables() {
    const { slideEl, contentEl } = this;
    const tables = Array.from(contentEl.querySelectorAll('table'));
    slideEl.removeClass('has-wide-table');
    if (tables.length === 0) return;
    const columns = (t) => t.rows[0]?.cells.length || 0;
    for (const t of tables) {
      t.setCssProps({ zoom: '' });
      t.toggleClass('mdp-table-dense', columns(t) >= DENSE_TABLE_COLUMNS);
    }
    const textWidth = contentEl.clientWidth;
    if (tables.some((t) => columns(t) >= WIDE_TABLE_COLUMNS || t.scrollWidth > textWidth)) {
      slideEl.addClass('has-wide-table');
    }
    const avail = contentEl.clientWidth;
    for (const t of tables) {
      if (t.scrollWidth > avail) t.setCssProps({ zoom: String(Math.max(MIN_TABLE_ZOOM, avail / t.scrollWidth)) });
    }
  }

  /** Shrink content with CSS zoom until it fits; beyond MIN_ZOOM, let the slide scroll. */
  fit() {
    const { slideEl, contentEl } = this;
    if (!slideEl || !contentEl) return;
    contentEl.setCssProps({ zoom: '1' });
    this.fitTables();
    const cs = getComputedStyle(slideEl);
    const availH = slideEl.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const availW = slideEl.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const needH = contentEl.scrollHeight;
    const needW = contentEl.scrollWidth;
    const zoom = Math.min(1, availH / Math.max(needH, 1), availW / Math.max(needW, 1));
    const clamped = Math.max(MIN_ZOOM, zoom);
    contentEl.setCssProps({ zoom: String(clamped) });
    slideEl.toggleClass('is-overflow', zoom < MIN_ZOOM);
  }

  onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const key = e.key;
    if (/^[0-9]$/.test(key)) {
      this.jumpBuffer += key;
      stopEvent(e);
      return;
    }
    if (key === 'Enter' && this.jumpBuffer) {
      this.go(parseInt(this.jumpBuffer, 10) - 1);
      this.jumpBuffer = '';
      stopEvent(e);
      return;
    }
    this.jumpBuffer = '';
    const action = this.keyAction(key);
    if (!action) return;
    action();
    stopEvent(e);
  }

  keyAction(key) {
    if (NEXT_KEYS.has(key)) return () => this.go(this.index + 1);
    if (PREV_KEYS.has(key)) return () => this.go(this.index - 1);
    const k = key.length === 1 ? key.toLowerCase() : key;
    if (TOOL_KEYS[k]) return () => this.selectTool(TOOL_KEYS[k]);
    const actions = {
      Escape: () => this.escape(),
      Home: () => this.go(0),
      End: () => this.go(this.slides.length - 1),
      f: () => this.toggleFullscreen(),
      b: () => this.toggleBlackout(),
      '.': () => this.toggleBlackout(),
      e: () => this.ink.clearSlide(),
      c: () => this.cycleColor(),
    };
    return actions[k];
  }

  /** Esc leaves the active tool first (like PowerPoint), then leaves the presentation. */
  escape() {
    if (this.ink.tool) {
      this.selectTool(null);
      this.toolEscapedAt = performance.now();
      return;
    }
    this.close();
  }

  /**
   * In fullscreen the browser consumes Esc to leave fullscreen, often without a keydown.
   * Treat that exit as the first Esc when a tool is (or just was) active; the deck stays open.
   */
  onFullscreenChange() {
    const exited = !document.fullscreenElement && this.exitClosesDeck;
    this.exitClosesDeck = !!document.fullscreenElement;
    if (!exited) return;
    const justEscapedTool = performance.now() - (this.toolEscapedAt || 0) < ESC_DEBOUNCE_MS;
    if (this.ink.tool || justEscapedTool) {
      this.selectTool(null);
      return;
    }
    this.close();
  }

  toggleBlackout() {
    this.blackout.toggleClass('is-on', !this.blackout.hasClass('is-on'));
  }

  onClick(e) {
    if (e.target.closest(NO_CLICK_NAV)) return;
    if (window.getSelection()?.toString()) return;
    const leftThird = e.clientX < window.innerWidth / 3;
    this.go(this.index + (leftThird ? -1 : 1));
  }

  onSwipe(e) {
    if (this.touchX == null || this.ink.isDrawingTool) return;
    const dx = e.changedTouches[0].clientX - this.touchX;
    this.touchX = null;
    if (Math.abs(dx) > SWIPE_PX) this.go(this.index + (dx < 0 ? 1 : -1));
  }

  wakeControls() {
    this.root.addClass('controls-visible');
    window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => this.root?.removeClass('controls-visible'), CONTROLS_IDLE_MS);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.cleanups.forEach((fn) => fn());
    this.resizeObserver?.disconnect();
    window.cancelAnimationFrame(this.fitFrame);
    window.clearTimeout(this.idleTimer);
    this.component?.unload();
    this.ink.destroy();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    this.root.remove();
    this.plugin.onPresentationClosed(this);
  }
}

export { Presentation };
