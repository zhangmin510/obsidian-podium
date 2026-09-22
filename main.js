'use strict';

const {
  Plugin,
  PluginSettingTab,
  Setting,
  MarkdownRenderer,
  MarkdownView,
  Component,
  Notice,
  TFile,
} = require('obsidian');

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

const DEFAULT_SETTINGS = Object.freeze({
  splitMode: 'auto', // auto | hr | heading | h1 | h2 | h3
  maxLinesPerSlide: 18, // 0 = 不自动续页
  titleSlide: true,
  theme: 'auto', // auto | dark | light
  fontScale: 1,
  showProgress: true,
});

const SPLIT_MODES = ['auto', 'hr', 'heading', 'h1', 'h2', 'h3'];

/* ------------------------------------------------------------------ */
/* Slide splitting (pure, no Obsidian dependency)                      */
/* ------------------------------------------------------------------ */

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const MARKER_RE = /^\s*<!--\s*(?:slide|pagebreak)\s*-->\s*$/i;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const MATH_RE = /^\s*\$\$\s*$/;
const MEDIA_RE = /^\s*!\[/;
const WRAP_WIDTH = 70;
const MEDIA_WEIGHT = 8;
const HEADING_WEIGHT = 2;
const CONTINUED_SUFFIX = '（续）';

function stripFrontmatter(lines) {
  if (lines.length === 0 || lines[0].trim() !== '---') return 0;
  for (let i = 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '---' || t === '...') return i + 1;
  }
  return 0;
}

/** 'code' for lines inside fenced code / $$ math (delimiters included), else 'text'. */
function classifyLines(lines) {
  let fence = null;
  let inMath = false;
  return lines.map((line) => {
    if (fence) {
      const t = line.trim();
      if (t.length >= fence.length && t[0] === fence[0] && /^(.)\1*$/.test(t)) fence = null;
      return 'code';
    }
    if (inMath) {
      if (MATH_RE.test(line)) inMath = false;
      return 'code';
    }
    const m = line.match(FENCE_RE);
    if (m) {
      fence = m[1];
      return 'code';
    }
    if (MATH_RE.test(line)) {
      inMath = true;
      return 'code';
    }
    return 'text';
  });
}

function headingLevel(line) {
  const m = line.match(HEADING_RE);
  return m ? m[1].length : 0;
}

function isSeparator(lines, kinds, i) {
  if (kinds[i] !== 'text') return false;
  if (MARKER_RE.test(lines[i])) return true;
  // A `---` directly under a paragraph is a setext heading, not a rule.
  return HR_RE.test(lines[i]) && (i === 0 || lines[i - 1].trim() === '');
}

/** Split level = shallowest heading level that occurs at least twice. */
function pickHeadingLevel(levels) {
  for (let l = 1; l <= 6; l++) {
    if (levels.filter((x) => x === l).length >= 2) return l;
  }
  return levels.length > 0 ? Math.min(...levels) : 0;
}

/** Returns [{start, end}] line ranges (end exclusive), separator lines excluded. */
function findSections(lines, kinds, mode) {
  const seps = [];
  for (let i = 0; i < lines.length; i++) if (isSeparator(lines, kinds, i)) seps.push(i);

  if (mode === 'hr' || (mode === 'auto' && seps.length > 0)) {
    const sections = [];
    let start = 0;
    for (const s of [...seps, lines.length]) {
      sections.push({ start, end: s });
      start = s + 1;
    }
    return sections;
  }

  const heads = [];
  for (let i = 0; i < lines.length; i++) {
    const level = kinds[i] === 'text' ? headingLevel(lines[i]) : 0;
    if (level) heads.push({ i, level });
  }
  const fixed = { h1: 1, h2: 2, h3: 3 }[mode];
  const level = fixed || pickHeadingLevel(heads.map((h) => h.level));
  const cuts = heads.filter((h) => h.level <= level).map((h) => h.i);

  const sections = [];
  let start = 0;
  for (const c of [...cuts, lines.length]) {
    if (c > start) sections.push({ start, end: c });
    start = c;
  }
  return sections;
}

function blockWeight(block) {
  if (block.kind === 'code') return block.lines.length;
  if (block.kind === 'heading') return HEADING_WEIGHT;
  return block.lines.reduce(
    (sum, l) => sum + (MEDIA_RE.test(l) ? MEDIA_WEIGHT : Math.max(1, Math.ceil(l.length / WRAP_WIDTH))),
    0,
  );
}

/** Group a line range into blocks: paragraphs, headings, code/math fences. */
function toBlocks(lines, kinds, start, end) {
  const blocks = [];
  let cur = null;
  const flush = () => {
    if (cur) blocks.push({ ...cur, weight: blockWeight(cur) });
    cur = null;
  };
  for (let i = start; i < end; i++) {
    const line = lines[i];
    if (kinds[i] === 'code') {
      if (cur && cur.kind !== 'code') flush();
      // A new fence right after a closed one starts a new block.
      if (cur && FENCE_RE.test(line) && cur.closed) flush();
      if (!cur) cur = { kind: 'code', start: i, lines: [], closed: false };
      cur.lines.push(line);
      cur.closed = cur.lines.length > 1 && (FENCE_RE.test(line) || MATH_RE.test(line));
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    if (headingLevel(line)) {
      flush();
      blocks.push({ kind: 'heading', start: i, lines: [line], weight: HEADING_WEIGHT });
      continue;
    }
    if (cur && cur.kind !== 'text') flush();
    if (!cur) cur = { kind: 'text', start: i, lines: [] };
    cur.lines.push(line);
  }
  flush();
  return blocks;
}

function joinBlocks(blocks) {
  return blocks.map((b) => b.lines.join('\n')).join('\n\n');
}

/** Break an oversized section into continuation slides at block boundaries. */
function chunkSection(blocks, maxLines) {
  const chunks = [];
  let cur = [];
  let weight = 0;
  for (const block of blocks) {
    const hasBody = cur.some((b) => b.kind !== 'heading');
    if (hasBody && weight + block.weight > maxLines) {
      // Never leave a heading stranded at the bottom of a slide.
      const carry = [];
      while (cur.length && cur[cur.length - 1].kind === 'heading') carry.unshift(cur.pop());
      chunks.push(cur);
      cur = carry;
      weight = carry.reduce((s, b) => s + b.weight, 0);
    }
    cur.push(block);
    weight += block.weight;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

function continuationHeading(block) {
  const m = block.lines[0].match(HEADING_RE);
  return `${m[1]} ${m[2]}${CONTINUED_SUFFIX}`;
}

function isBlank(md) {
  return md.replace(/<!--[\s\S]*?-->/g, '').trim() === '';
}

/**
 * Split markdown into slides.
 * @param {string} text    full note text (frontmatter allowed)
 * @param {{mode?: string, maxLines?: number, title?: string}} opts
 * @returns {{md: string, startLine: number}[]}  startLine is 0-based in the original text
 */
function buildSlides(text, opts = {}) {
  const mode = SPLIT_MODES.includes(opts.mode) ? opts.mode : 'auto';
  const maxLines = Number(opts.maxLines) > 0 ? Number(opts.maxLines) : 0;
  const allLines = text.split(/\r?\n/);
  const offset = stripFrontmatter(allLines);
  const lines = allLines.slice(offset);
  const kinds = classifyLines(lines);

  const slides = [];
  for (const { start, end } of findSections(lines, kinds, mode)) {
    const blocks = toBlocks(lines, kinds, start, end);
    if (blocks.length === 0) continue;
    const chunks = maxLines ? chunkSection(blocks, maxLines) : [blocks];
    const lead = blocks[0].kind === 'heading' ? blocks[0] : null;
    chunks.forEach((chunk, n) => {
      const needsHeading = n > 0 && lead && chunk[0].kind !== 'heading';
      const md = maxLines
        ? (needsHeading ? continuationHeading(lead) + '\n\n' : '') + joinBlocks(chunk)
        : lines.slice(start, end).join('\n');
      if (!isBlank(md)) slides.push({ md, startLine: chunk[0].start + offset });
    });
  }

  const title = (opts.title || '').trim();
  const firstIsH1 = slides.length > 0 && /^#\s/.test(slides[0].md.trimStart());
  if (title && !firstIsH1) slides.unshift({ md: `# ${title}`, startLine: 0 });
  return slides;
}

function isTitleOnly(md) {
  const lines = md.split('\n').filter((l) => l.trim() !== '');
  return lines.length > 0 && lines.length <= 3 && headingLevel(lines[0]) > 0 && lines.every((l) => l.length < 80);
}

function slideIndexForLine(slides, line) {
  let idx = 0;
  slides.forEach((s, i) => {
    if (s.startLine <= line) idx = i;
  });
  return idx;
}

/* ------------------------------------------------------------------ */
/* Presentation overlay                                                */
/* ------------------------------------------------------------------ */

const MIN_ZOOM = 0.45;
const CONTROLS_IDLE_MS = 2000;
const SWIPE_PX = 50;
const NO_CLICK_NAV = 'a, button, input, textarea, select, summary, video, audio, iframe, .internal-link, .mdp-bar';

const NEXT_KEYS = new Set(['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'n', 'j', 'l']);
const PREV_KEYS = new Set(['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p', 'k', 'h']);

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
    root.style.setProperty('--mdp-font-scale', String(s.fontScale));
    this.root = root;

    this.stage = root.createDiv({ cls: 'mdp-stage' });
    this.blackout = root.createDiv({ cls: 'mdp-blackout' });

    const bar = root.createDiv({ cls: 'mdp-bar' });
    this.progress = root.createDiv({ cls: 'mdp-progress' });
    this.progress.toggle(s.showProgress);
    const btn = (label, title, fn) => {
      const b = bar.createEl('button', { text: label, attr: { 'aria-label': title } });
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
      });
    };
    btn('‹', '上一页', () => this.go(this.index - 1));
    this.counter = bar.createSpan({ cls: 'mdp-counter' });
    btn('›', '下一页', () => this.go(this.index + 1));
    btn('⛶', '切换全屏', () => this.toggleFullscreen());
    btn('✕', '退出演示', () => this.close());

    this.listen(window, 'keydown', (e) => this.onKey(e), true);
    this.listen(root, 'click', (e) => this.onClick(e));
    this.listen(root, 'mousemove', () => this.wakeControls());
    this.listen(root, 'touchstart', (e) => (this.touchX = e.changedTouches[0].clientX), { passive: true });
    this.listen(root, 'touchend', (e) => this.onSwipe(e));
    this.listen(window, 'resize', () => this.scheduleFit());
    this.listen(document, 'fullscreenchange', () => {
      if (!document.fullscreenElement && this.exitClosesDeck) this.close();
      this.exitClosesDeck = !!document.fullscreenElement;
    });

    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.wakeControls();
    this.enterFullscreen();
    this.go(startIndex);
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
    this.counter.setText(`${i + 1} / ${this.slides.length}`);
    this.progress.style.width = `${((i + 1) / this.slides.length) * 100}%`;
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
    this.fitFrame = requestAnimationFrame(() => {
      this.fitFrame = 0;
      this.fit();
    });
  }

  /** Shrink content with CSS zoom until it fits; beyond MIN_ZOOM, let the slide scroll. */
  fit() {
    const { slideEl, contentEl } = this;
    if (!slideEl || !contentEl) return;
    contentEl.style.zoom = '1';
    const cs = getComputedStyle(slideEl);
    const availH = slideEl.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    const availW = slideEl.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const needH = contentEl.scrollHeight;
    const needW = contentEl.scrollWidth;
    const zoom = Math.min(1, availH / Math.max(needH, 1), availW / Math.max(needW, 1));
    const clamped = Math.max(MIN_ZOOM, zoom);
    contentEl.style.zoom = String(clamped);
    slideEl.toggleClass('is-overflow', zoom < MIN_ZOOM);
  }

  onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const key = e.key;
    let handled = true;
    if (/^[0-9]$/.test(key)) {
      this.jumpBuffer += key;
    } else if (key === 'Enter' && this.jumpBuffer) {
      this.go(parseInt(this.jumpBuffer, 10) - 1);
      this.jumpBuffer = '';
    } else if (key === 'Escape') {
      this.close();
    } else if (NEXT_KEYS.has(key)) {
      this.go(this.index + 1);
    } else if (PREV_KEYS.has(key)) {
      this.go(this.index - 1);
    } else if (key === 'Home') {
      this.go(0);
    } else if (key === 'End') {
      this.go(this.slides.length - 1);
    } else if (key === 'f') {
      this.toggleFullscreen();
    } else if (key === 'b' || key === '.') {
      this.blackout.toggleClass('is-on', !this.blackout.hasClass('is-on'));
    } else {
      handled = false;
    }
    if (!/^[0-9]$/.test(key) && key !== 'Enter') this.jumpBuffer = '';
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  onClick(e) {
    if (e.target.closest(NO_CLICK_NAV)) return;
    if (window.getSelection()?.toString()) return;
    const leftThird = e.clientX < window.innerWidth / 3;
    this.go(this.index + (leftThird ? -1 : 1));
  }

  onSwipe(e) {
    if (this.touchX == null) return;
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
    cancelAnimationFrame(this.fitFrame);
    window.clearTimeout(this.idleTimer);
    this.component?.unload();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    this.root.remove();
    this.plugin.onPresentationClosed(this);
  }
}

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

class PodiumPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.active = null;

    this.addRibbonIcon('presentation', '全屏演示当前笔记', () => this.startFromActive(false));

    this.addCommand({
      id: 'start',
      name: '全屏演示当前笔记（从头开始）',
      checkCallback: (checking) => this.commandGuard(checking, () => this.startFromActive(false)),
    });
    this.addCommand({
      id: 'start-here',
      name: '全屏演示当前笔记（从光标处开始）',
      checkCallback: (checking) => this.commandGuard(checking, () => this.startFromActive(true)),
    });

    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        menu.addItem((item) =>
          item.setTitle('全屏演示').setIcon('presentation').onClick(() => this.present(file, 0)),
        );
      }),
    );

    this.addSettingTab(new PodiumSettingTab(this.app, this));
  }

  onunload() {
    this.active?.close();
  }

  commandGuard(checking, run) {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') return false;
    if (!checking) run();
    return true;
  }

  async startFromActive(fromCursor) {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') {
      new Notice('请先打开一篇 Markdown 笔记');
      return;
    }
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const line = fromCursor && view?.getMode() === 'source' ? view.editor.getCursor().line : 0;
    await this.present(file, line);
  }

  async readText(file) {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (view?.file?.path === file.path) return view.editor.getValue();
    return this.app.vault.cachedRead(file);
  }

  async present(file, cursorLine) {
    this.active?.close();
    try {
      const text = await this.readText(file);
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter || {};
      const slides = buildSlides(text, {
        mode: fm['slide-split'] || this.settings.splitMode,
        maxLines: fm['slide-max-lines'] ?? this.settings.maxLinesPerSlide,
        title: this.settings.titleSlide ? String(fm.title || file.basename) : '',
      });
      if (slides.length === 0) {
        new Notice('这篇笔记没有可演示的内容');
        return;
      }
      this.active = new Presentation(this, file, slides);
      this.active.open(slideIndexForLine(slides, cursorLine));
    } catch (err) {
      console.error('[podium] failed to start presentation', err);
      new Notice(`无法开始演示：${err.message || err}`);
    }
  }

  onPresentationClosed(p) {
    if (this.active === p) this.active = null;
  }

  async loadSettings() {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
  }

  async updateSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    await this.saveData(this.settings);
  }
}

class PodiumSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    const save = (patch) => this.plugin.updateSettings(patch);
    containerEl.empty();

    new Setting(containerEl)
      .setName('分页方式')
      .setDesc('自动：有 --- 分隔线就按分隔线，否则按出现 ≥2 次的最高级标题。单篇笔记可用 frontmatter `slide-split` 覆盖。')
      .addDropdown((d) =>
        d
          .addOptions({
            auto: '自动',
            hr: '按 --- 分隔线',
            heading: '按标题（自动选层级）',
            h1: '按 H1',
            h2: '按 H1–H2',
            h3: '按 H1–H3',
          })
          .setValue(s.splitMode)
          .onChange((v) => save({ splitMode: v })),
      );

    new Setting(containerEl)
      .setName('每页最大行数')
      .setDesc('超出后在段落边界自动续页（标题会加「（续）」）。0 = 不续页，只缩放。frontmatter `slide-max-lines` 可覆盖。')
      .addSlider((sl) =>
        sl
          .setLimits(0, 40, 1)
          .setValue(s.maxLinesPerSlide)
          .setDynamicTooltip()
          .onChange((v) => save({ maxLinesPerSlide: v })),
      );

    new Setting(containerEl)
      .setName('自动封面页')
      .setDesc('笔记不以 H1 开头时，用 frontmatter title 或文件名生成封面页。')
      .addToggle((t) => t.setValue(s.titleSlide).onChange((v) => save({ titleSlide: v })));

    new Setting(containerEl)
      .setName('配色')
      .addDropdown((d) =>
        d
          .addOptions({ auto: '跟随 Obsidian', dark: '深色', light: '浅色' })
          .setValue(s.theme)
          .onChange((v) => save({ theme: v })),
      );

    new Setting(containerEl)
      .setName('字号倍率')
      .addSlider((sl) =>
        sl
          .setLimits(0.6, 1.8, 0.1)
          .setValue(s.fontScale)
          .setDynamicTooltip()
          .onChange((v) => save({ fontScale: v })),
      );

    new Setting(containerEl)
      .setName('显示进度条')
      .addToggle((t) => t.setValue(s.showProgress).onChange((v) => save({ showProgress: v })));

    new Setting(containerEl).setName('快捷键').setHeading();
    const ul = containerEl.createEl('ul');
    [
      '→ ↓ 空格 PageDown / 点击右侧：下一页',
      '← ↑ PageUp / 点击左侧三分之一：上一页',
      'Home / End：首页 / 末页；输入数字 + 回车：跳页',
      'F：切换全屏；B 或 .：黑屏；Esc：退出',
      '分页标记：--- 分隔线，或 <!-- slide -->',
    ].forEach((t) => ul.createEl('li', { text: t }));
  }
}

module.exports = {
  default: PodiumPlugin,
  buildSlides,
  slideIndexForLine,
  isTitleOnly,
};
