// Run: npm test
import test from 'node:test';
import assert from 'node:assert';
import { buildSlides, slideIndexForLine, isTitleOnly } from '../src/split.js';

const mds = (slides) => slides.map((s) => s.md);

test('splits on --- separators and ignores frontmatter', () => {
  const text = '---\ntitle: X\n---\nA\n\n---\n\nB\n\n---\nC';
  const slides = buildSlides(text, { maxLines: 0 });
  assert.deepStrictEqual(mds(slides).map((m) => m.trim()), ['A', 'B', 'C']);
  assert.strictEqual(slides[1].startLine, 7);
});

test('setext underline is not a separator', () => {
  const slides = buildSlides('Title\n---\ntext', { maxLines: 0 });
  assert.strictEqual(slides.length, 1);
});

test('--- inside code fence is not a separator', () => {
  const text = '# H\n\n```yaml\n---\nkey: v\n---\n```\n';
  const slides = buildSlides(text, { maxLines: 0 });
  assert.strictEqual(slides.length, 1);
  assert.match(slides[0].md, /key: v/);
});

test('auto mode without rules splits at shallowest repeated heading level', () => {
  const text = '# Doc\n\nintro\n\n## A\n\na\n\n### A1\n\nx\n\n## B\n\nb';
  const slides = buildSlides(text, { maxLines: 0 });
  assert.deepStrictEqual(
    slides.map((s) => s.md.split('\n')[0]),
    ['# Doc', '## A', '## B'],
  );
});

test('headings inside code fences are ignored', () => {
  const text = '## A\n\n```\n## not a heading\n```\n\n## B';
  assert.strictEqual(buildSlides(text, { maxLines: 0 }).length, 2);
});

test('plain text with no headings becomes one slide', () => {
  assert.strictEqual(buildSlides('just some\n\nparagraphs', { maxLines: 0 }).length, 1);
});

test('fixed h2 mode also cuts at h1', () => {
  const text = '# T\n\n## A\n\n### x\n\n### y';
  assert.strictEqual(buildSlides(text, { mode: 'h2', maxLines: 0 }).length, 2);
});

test('long section continues onto new slides with (续) heading', () => {
  const paras = Array.from({ length: 10 }, (_, i) => `para ${i}`).join('\n\n');
  const slides = buildSlides(`## Long\n\n${paras}`, { maxLines: 5 });
  assert.ok(slides.length >= 2);
  assert.match(slides[1].md, /^## Long（续）/);
  assert.ok(slides.every((s) => s.md.includes('para')));
});

test('code blocks are never split', () => {
  const code = ['```js', ...Array.from({ length: 30 }, (_, i) => `line${i}`), '```'].join('\n');
  const slides = buildSlides(`## C\n\nbefore\n\n${code}\n\nafter`, { maxLines: 10 });
  const holder = slides.find((s) => s.md.includes('line0'));
  assert.match(holder.md, /line29\n```/);
});

test('a heading is never stranded at the bottom of a chunk', () => {
  const text = '## S\n\n' + 'a\n\nb\n\nc\n\n### Sub\n\nd\n\ne';
  const slides = buildSlides(text, { mode: 'h2', maxLines: 5 });
  slides.forEach((s) => assert.doesNotMatch(s.md, /### Sub\s*$/));
});

test('adds title slide when note does not start with H1', () => {
  const slides = buildSlides('## A\n\na\n\n## B\n\nb', { title: 'My Note', maxLines: 0 });
  assert.strictEqual(slides[0].md, '# My Note');
  assert.ok(isTitleOnly(slides[0].md));
});

test('no title slide when note already starts with H1', () => {
  const slides = buildSlides('# Real\n\n## A\n\n## B', { title: 'Other', maxLines: 0 });
  assert.match(slides[0].md, /^# Real/);
});

test('slideIndexForLine maps cursor line to containing slide', () => {
  const slides = buildSlides('## A\n\na\n\n## B\n\nb\n\n## C', { maxLines: 0 });
  assert.strictEqual(slideIndexForLine(slides, 0), 0);
  assert.strictEqual(slideIndexForLine(slides, 5), 1);
  assert.strictEqual(slideIndexForLine(slides, 99), 2);
});

test('slide markers split like rules', () => {
  const slides = buildSlides('A\n<!-- slide -->\nB', { maxLines: 0 });
  assert.strictEqual(slides.length, 2);
});

/* ---------------- tables ---------------- */

const table = (rows, cell = 'x') =>
  ['| 名称 | 描述 | 状态 |', '|---|:---:|---|', ...Array.from({ length: rows }, (_, i) => `| r${i} | ${cell} | ok |`)].join('\n');

test('long table is split across slides with the header row repeated', () => {
  const slides = buildSlides(`## 大表格\n\n${table(40)}`, { maxLines: 18 });
  const parts = slides.filter((s) => s.md.includes('| r'));
  assert.ok(parts.length >= 3, `expected >=3 table slides, got ${parts.length}`);
  for (const s of parts) {
    assert.match(s.md, /\| 名称 \| 描述 \| 状态 \|\n\|---\|:---:\|---\|/);
  }
  const rows = parts.flatMap((s) => s.md.match(/\| r\d+ \|/g));
  assert.strictEqual(rows.length, 40);
  assert.strictEqual(new Set(rows).size, 40);
  assert.match(parts[1].md, /^## 大表格（续）/);
});

test('table rows are spread evenly, no tiny last fragment', () => {
  const cjk = '这是一段比较长的中文说明文字，用来测试表格单元格换行时的高度估算';
  for (const cell of ['x', cjk + cjk]) {
    const slides = buildSlides(`## T\n\n${table(40, cell)}`, { maxLines: 18 });
    const counts = slides.map((s) => (s.md.match(/\| r\d+ \|/g) || []).length).filter(Boolean);
    assert.ok(counts.length > 1, 'expected a split');
    assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `uneven split: ${counts}`);
  }
});

test('small table stays whole', () => {
  const slides = buildSlides(`## T\n\n${table(5)}`, { maxLines: 18 });
  assert.strictEqual(slides.length, 1);
});

test('table directly after a paragraph (no blank line) is its own block', () => {
  const slides = buildSlides(`## T\n\n说明文字\n${table(40)}`, { maxLines: 18 });
  assert.match(slides[0].md, /说明文字/);
  const withIntro = slides.filter((s) => s.md.includes('说明文字'));
  assert.strictEqual(withIntro.length, 1);
  assert.ok(slides.filter((s) => s.md.includes('| r')).length >= 3);
});

test('tables are not split when continuation is off', () => {
  const slides = buildSlides(`## T\n\n${table(40)}`, { maxLines: 0 });
  assert.strictEqual(slides.length, 1);
});

test('table inside a code fence is left alone', () => {
  const slides = buildSlides('## T\n\n```\n' + table(40) + '\n```', { maxLines: 18 });
  assert.strictEqual(slides.length, 1);
});

test('cells too wide for one line make rows heavier (CJK counts double)', () => {
  const cjk = '这是一段比较长的中文说明文字，用来测试表格单元格换行时的高度估算';
  const short = buildSlides(`## T\n\n${table(30, 'x')}`, { maxLines: 18 });
  const long = buildSlides(`## T\n\n${table(30, cjk + cjk)}`, { maxLines: 18 });
  assert.ok(long.length > short.length, `cjk ${long.length} vs latin ${short.length}`);
});

test('escaped pipes inside cells do not add columns', () => {
  const md = '| a | b |\n|---|---|\n' + Array.from({ length: 40 }, (_, i) => `| [[Note${i}\\|别名]] | v |`).join('\n');
  const slides = buildSlides(`## T\n\n${md}`, { maxLines: 18 });
  slides.forEach((s) => assert.match(s.md, /\| a \| b \|\n\|---\|---\|/));
});
