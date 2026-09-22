# Podium · 讲台

**中文** | [English](#english)

把**任意** Markdown 笔记一键全屏演示成幻灯片——不需要改写成特定格式，不需要加 `---`，打开就能讲。

## 特点

- **自适应分页**：笔记里有 `---` 分隔线（或 `<!-- slide -->`）就按分隔线分；没有就按「出现 ≥2 次的最高级标题」分。代码块和 `$$` 公式里的 `---`、`#` 不会被误判，`文字\n---` 这种 setext 标题也不会。
- **长内容自动续页**：一节内容太长时在段落边界拆成多页，标题自动加「（续）」；代码块永不拆开，标题不会孤零零落在页尾。
- **自动缩放**：仍然放不下的内容按屏幕缩小（最低 45%），再放不下就允许滚动。
- **Obsidian 原生渲染**：双链、嵌入、图片、Callout、数学公式、Mermaid、代码高亮都和阅读视图一致。
- **自动封面页**：笔记不以 H1 开头时，用 frontmatter `title` 或文件名生成封面。
- **从光标处开始**：从当前编辑位置所在的那一页开讲。
- **表格友好**：表格字号跟随幻灯片（不受主题固定字号影响）；长表格按行分页并重复表头；宽表格自动占满页宽，只缩放表格本身。
- **激光笔 / 画笔 / 荧光笔**：激光笔带渐隐残影；画笔和荧光笔默认松手后停留片刻淡出，也可以设为保留（按页分开，E 清除）。黑屏上也能画。

## 使用

- 左侧功能区 🖥 图标，或命令面板：
  - `Podium: 全屏演示当前笔记（从头开始）`
  - `Podium: 全屏演示当前笔记（从光标处开始）`
- 文件列表右键 → **全屏演示**

| 操作 | 按键 |
|---|---|
| 下一页 | → ↓ 空格 PageDown，或点击屏幕右侧 |
| 上一页 | ← ↑ PageUp，或点击屏幕左侧三分之一 |
| 首页 / 末页 | Home / End |
| 跳到第 N 页 | 输入数字 + 回车 |
| 切换全屏 | F |
| 黑屏 | B 或 `.` |
| 激光笔 / 画笔 / 荧光笔 | L / P / H（再按一次关闭） |
| 切换颜色 | C |
| 清除本页笔迹 | E |
| 退出 | Esc（有工具时先退出工具，再按退出演示） |

画笔模式下点击不会翻页，也不会打开链接；激光笔模式下点击照常翻页。触屏设备可左右滑动翻页（画笔模式下除外）。

### 单篇笔记覆盖设置

```yaml
---
slide-split: h2        # auto | hr | heading | h1 | h2 | h3
slide-max-lines: 0     # 0 = 不续页，只缩放
---
```

### 设置项

分页方式、每页最大行数（默认 18）、自动封面页、配色（跟随 / 深色 / 浅色）、字号倍率、进度条、笔迹自动消失（默认开）与停留时间（默认 2 秒）。

## 安装

**通过 BRAT（推荐，自动更新）**：安装 [BRAT](https://github.com/TfTHacker/obsidian42-brat) → `Add beta plugin` → 填入 `zhangmin510/obsidian-podium`。

**手动**：从 [Releases](https://github.com/zhangmin510/obsidian-podium/releases) 下载 `main.js`、`manifest.json`、`styles.css`，放到 `<你的 vault>/.obsidian/plugins/podium/`，然后在 设置 → 第三方插件 中启用 Podium。

**校验来源**：Release 中的文件都带有 GitHub 构建来源证明（artifact attestation），可以验证它们确实由本仓库源码经 GitHub Actions 构建：

```bash
gh attestation verify main.js -R zhangmin510/obsidian-podium
```

## 与同类插件的区别

- [Advanced Slides](https://github.com/mszturc/obsidian-advanced-slides) / Marp：功能强大，但需要按它们的格式写幻灯片。Podium 面向「现成的笔记直接讲」。
- Obsidian 内置 Slides：只按 `---` 分页，没有分隔线的笔记只有一页。
- [Paperish Presentation](https://github.com/bcardiff/obsidian-paperish-presentation)：思路相近，按固定标题层级分页；Podium 自动选层级、长节自动续页并缩放适配。

## 开发

源码在 `src/`，用 esbuild 打包成 `main.js`（`main.js` 是构建产物，不入库）。

```bash
npm install
npm test          # 单元测试（分页、笔迹规则）
npm run lint      # Obsidian 官方审核规则（eslint-plugin-obsidianmd）
npm run build     # 生成 main.js
npm run dev       # 监听 src/ 自动重新构建
```

| 文件 | 职责 |
|---|---|
| `src/split.js` | 分页（纯函数） |
| `src/ink-model.js` | 笔迹淡出、残影、工具切换规则（纯函数） |
| `src/ink.js` | 激光笔 / 画笔画布层 |
| `src/presentation.js` | 全屏演示界面、键盘与指针交互、自适应缩放 |
| `src/settings.js` | 默认设置与设置页 |
| `src/main.js` | 插件入口、命令、菜单 |

发布：更新 `manifest.json` / `versions.json` 版本号，推送同名 tag（如 `0.2.0`），GitHub Actions 测试、构建并自动创建 Release。

---

## English

Present **any** Markdown note as fullscreen slides — no special syntax required.

- **Adaptive splitting**: splits on `---` rules (or `<!-- slide -->`) when present, otherwise at the shallowest heading level that occurs at least twice. Rules and headings inside code fences / math blocks are ignored.
- **Overflow continuation**: long sections are split at paragraph boundaries onto continuation slides; code blocks are never split.
- **Auto-fit**: remaining overflow is scaled down to fit the screen.
- **Native rendering**: wikilinks, embeds, callouts, math, Mermaid and code highlighting render exactly as in reading view.
- **Cover slide** from frontmatter `title` or file name; **start from cursor**.
- **Tables**: text follows the slide size (ignores theme px sizes); long tables split by rows with the header repeated; wide tables use the full width.
- **Laser pointer, pen, highlighter**: the laser leaves a fading trail; ink fades out shortly after the pen lifts (or stays per slide, cleared with `E`).

Keys: →/Space next, ← previous, Home/End, number + Enter to jump, `F` fullscreen, `B` blackout, `L` laser, `P` pen, `H` highlighter, `C` color, `E` erase slide ink, `Esc` leave tool / exit.

Per-note overrides: `slide-split: auto | hr | heading | h1 | h2 | h3`, `slide-max-lines: <n>`.

Install via [BRAT](https://github.com/TfTHacker/obsidian42-brat) with `zhangmin510/obsidian-podium`, or copy the release assets into `.obsidian/plugins/podium/`.

## License

[MIT](LICENSE)
