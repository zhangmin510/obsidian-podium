/* Slide splitting — pure, no Obsidian dependency. */

const SPLIT_MODES = ['auto', 'hr', 'heading', 'h1', 'h2', 'h3'];

const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;
const HR_RE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const MARKER_RE = /^\s*<!--\s*(?:slide|pagebreak)\s*-->\s*$/i;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const MATH_RE = /^\s*\$\$\s*$/;
const MEDIA_RE = /^\s*!\[/;
const TABLE_DELIM_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
// CJK / fullwidth characters take roughly two latin columns.
const WIDE_CHAR_RE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/g;
// Display columns per rendered line: content is ~46em wide, a latin char is ~0.5em.
const WRAP_WIDTH = 90;
const MEDIA_WEIGHT = 8;
const HEADING_WEIGHT = 2;
const TABLE_ROW_PADDING = 0.5; // cell padding + borders, in lines
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

function displayWidth(text) {
  return text.length + (text.match(WIDE_CHAR_RE) || []).length;
}

function wrappedLines(text) {
  return Math.max(1, Math.ceil(displayWidth(text) / WRAP_WIDTH));
}

function isTableDelimiter(line) {
  return line.includes('|') && TABLE_DELIM_RE.test(line);
}

/** GFM table: a row containing `|` followed by a delimiter row. Quoted tables are left as text. */
function isTableStart(lines, kinds, i, end) {
  return (
    i + 1 < end &&
    kinds[i] === 'text' &&
    kinds[i + 1] === 'text' &&
    lines[i].includes('|') &&
    !/^\s*>/.test(lines[i]) &&
    isTableDelimiter(lines[i + 1])
  );
}

/** Split a table row on unescaped `|`. No regex lookbehind: iOS < 16.4 can't parse it. */
function splitCells(row) {
  let text = row.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const cells = [];
  let cell = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '|' && text[i - 1] !== '\\') {
      cells.push(cell);
      cell = '';
    } else {
      cell += text[i];
    }
  }
  cells.push(cell);
  return cells;
}

/**
 * Estimated rendered height of each table row (delimiter row = 0).
 * Mirrors auto table layout: columns get width in proportion to their widest cell,
 * and a row is as tall as its most-wrapped cell.
 */
function tableRowWeights(lines) {
  const rows = lines.map((l, i) => (i === 1 ? null : splitCells(l).map((c) => displayWidth(c.trim()))));
  const cells = rows.filter(Boolean);
  const columns = Math.max(...cells.map((r) => r.length));
  const colMax = Array.from({ length: columns }, (_, c) => Math.max(1, ...cells.map((r) => r[c] || 0)));
  const scale = Math.min(1, WRAP_WIDTH / colMax.reduce((a, b) => a + b, 0));
  return rows.map((r) =>
    r ? Math.max(1, ...r.map((w, c) => Math.ceil(w / Math.max(1, colMax[c] * scale)))) + TABLE_ROW_PADDING : 0,
  );
}

function tableWeight(lines) {
  return tableRowWeights(lines).reduce((a, b) => a + b, 0);
}

function blockWeight(block) {
  if (block.kind === 'code') return block.lines.length;
  if (block.kind === 'heading') return HEADING_WEIGHT;
  if (block.kind === 'table') return tableWeight(block.lines);
  return block.lines.reduce((sum, l) => sum + (MEDIA_RE.test(l) ? MEDIA_WEIGHT : wrappedLines(l)), 0);
}

/**
 * Split a table taller than `budget` into evenly sized pieces, each repeating the header.
 * Pieces are budgeted below maxLines because continuation slides also carry a heading.
 */
function splitTable(block, budget) {
  const [header, delimiter, ...rows] = block.lines;
  const bodyBudget = Math.max(1, budget - tableWeight([header, delimiter]));
  const bodyWeight = block.weight - tableWeight([header, delimiter]);
  const pieces = Math.min(rows.length, Math.ceil(bodyWeight / bodyBudget));
  if (pieces <= 1) return [block];
  // First (rows % pieces) pieces get one extra row, so sizes differ by at most one.
  const base = Math.floor(rows.length / pieces);
  const extra = rows.length % pieces;
  const out = [];
  let r = 0;
  for (let p = 0; p < pieces; p++) {
    const size = base + (p < extra ? 1 : 0);
    const lines = [header, delimiter, ...rows.slice(r, r + size)];
    out.push({ kind: 'table', start: r === 0 ? block.start : block.start + 2 + r, lines, weight: tableWeight(lines) });
    r += size;
  }
  return out;
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
    if (isTableStart(lines, kinds, i, end)) {
      flush();
      let j = i + 2;
      while (j < end && kinds[j] === 'text' && lines[j].trim() !== '' && lines[j].includes('|')) j++;
      const tableLines = lines.slice(i, j);
      blocks.push({ kind: 'table', start: i, lines: tableLines, weight: tableWeight(tableLines) });
      i = j - 1;
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
  const tableBudget = maxLines - HEADING_WEIGHT;
  const pieces = blocks.flatMap((b) => (b.kind === 'table' && b.weight > maxLines ? splitTable(b, tableBudget) : [b]));
  const chunks = [];
  let cur = [];
  let weight = 0;
  for (const block of pieces) {
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

export { SPLIT_MODES, buildSlides, slideIndexForLine, isTitleOnly };
