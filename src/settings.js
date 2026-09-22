import { PluginSettingTab, Setting } from 'obsidian';

const DEFAULT_SETTINGS = Object.freeze({
  splitMode: 'auto', // auto | hr | heading | h1 | h2 | h3
  maxLinesPerSlide: 18, // 0 = 不自动续页
  titleSlide: true,
  theme: 'auto', // auto | dark | light
  fontScale: 1,
  showProgress: true,
  inkFade: true,
  inkHoldSeconds: 2,
});

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
      .setDesc('笔记不以一级标题开头时，用 frontmatter 的 title 或文件名生成封面页。')
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

    new Setting(containerEl).setName('画笔').setHeading();

    new Setting(containerEl)
      .setName('笔迹自动消失')
      .setDesc('开启：画笔 / 荧光笔松开后停留片刻再淡出。关闭：笔迹保留在当前页，可用橡皮擦清除，退出演示后丢弃。')
      .addToggle((t) =>
        t.setValue(s.inkFade).onChange(async (v) => {
          await save({ inkFade: v });
          this.display();
        }),
      );

    if (s.inkFade) {
      new Setting(containerEl)
        .setName('笔迹停留时间（秒）')
        .addSlider((sl) =>
          sl
            .setLimits(0.5, 10, 0.5)
            .setValue(s.inkHoldSeconds)
            .setDynamicTooltip()
            .onChange((v) => save({ inkHoldSeconds: v })),
        );
    }

    new Setting(containerEl).setName('快捷键').setHeading();
    const ul = containerEl.createEl('ul');
    [
      '→ ↓ 空格 PageDown / 点击右侧：下一页',
      '← ↑ PageUp / 点击左侧三分之一：上一页',
      'Home / End：首页 / 末页；输入数字 + 回车：跳页',
      'L：激光笔；P：画笔；H：荧光笔（再按一次关闭）',
      'C：切换颜色；E：清除本页笔迹',
      'F：切换全屏；B 或 .：黑屏（黑屏上也能画）',
      'Esc：先退出画笔，再按退出演示',
      '分页标记：--- 分隔线，或 <!-- slide -->',
    ].forEach((t) => ul.createEl('li', { text: t }));
  }
}

export { DEFAULT_SETTINGS, PodiumSettingTab };
