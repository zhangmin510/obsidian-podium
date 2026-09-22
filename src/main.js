import { Plugin, MarkdownView, Notice, TFile } from 'obsidian';
import { buildSlides, slideIndexForLine } from './split.js';
import { DEFAULT_SETTINGS, PodiumSettingTab } from './settings.js';
import { Presentation } from './presentation.js';

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

export default PodiumPlugin;
