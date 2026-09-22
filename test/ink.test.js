// Run: npm test
import test from 'node:test';
import assert from 'node:assert';
import {
  inkAlpha,
  pruneStrokes,
  pruneTrail,
  trailAlpha,
  nextTool,
  normalizePoint,
  resampleTrail,
  trailOutline,
} from '../src/ink-model.js';

const FADE = { fade: true, holdMs: 2000, fadeMs: 1000 };
const KEEP = { fade: false, holdMs: 2000, fadeMs: 1000 };

test('a stroke being drawn is fully visible', () => {
  assert.strictEqual(inkAlpha({ endedAt: null }, 99999, FADE), 1);
});

test('fading stroke holds, then fades linearly, then is gone', () => {
  const s = { endedAt: 1000 };
  assert.strictEqual(inkAlpha(s, 1000 + 1999, FADE), 1);
  assert.strictEqual(inkAlpha(s, 1000 + 2500, FADE), 0.5);
  assert.strictEqual(inkAlpha(s, 1000 + 3000, FADE), 0);
  assert.strictEqual(inkAlpha(s, 1000 + 9000, FADE), 0);
});

test('persistent ink never fades', () => {
  assert.strictEqual(inkAlpha({ endedAt: 0 }, 1e9, KEEP), 1);
});

test('pruneStrokes drops only fully faded strokes and returns a new array', () => {
  const strokes = [{ endedAt: 0 }, { endedAt: 5000 }, { endedAt: null }];
  const out = pruneStrokes(strokes, 6000, FADE);
  assert.deepStrictEqual(out, [strokes[1], strokes[2]]);
  assert.notStrictEqual(out, strokes);
  assert.strictEqual(strokes.length, 3);
});

test('pruneTrail keeps points younger than the trail length', () => {
  const pts = [{ t: 0 }, { t: 500 }, { t: 900 }];
  assert.deepStrictEqual(pruneTrail(pts, 1000, 450), [{ t: 900 }]);
});

test('trail alpha goes from 1 (new) to 0 (trail length old)', () => {
  assert.strictEqual(trailAlpha(0, 400), 1);
  assert.strictEqual(trailAlpha(200, 400), 0.5);
  assert.strictEqual(trailAlpha(400, 400), 0);
  assert.strictEqual(trailAlpha(900, 400), 0);
});

test('selecting the active tool turns it off, another tool switches', () => {
  assert.strictEqual(nextTool(null, 'pen'), 'pen');
  assert.strictEqual(nextTool('pen', 'pen'), null);
  assert.strictEqual(nextTool('pen', 'laser'), 'laser');
});

test('points are stored relative to the surface so ink survives resizes', () => {
  const rect = { left: 100, top: 50, width: 800, height: 400 };
  assert.deepStrictEqual(normalizePoint(500, 250, rect), { x: 0.5, y: 0.5 });
  assert.deepStrictEqual(normalizePoint(100, 50, rect), { x: 0, y: 0 });
});

/* ---------------- laser trail geometry ---------------- */

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

test('fast, sparse laser samples are filled in with no gaps larger than the spacing', () => {
  const pts = [
    { x: 0, y: 0, t: 0 },
    { x: 120, y: 40, t: 16 },
    { x: 260, y: 10, t: 32 },
  ];
  const out = resampleTrail(pts, 4);
  for (let i = 1; i < out.length; i++) assert.ok(dist(out[i - 1], out[i]) <= 4.5, `gap ${dist(out[i - 1], out[i])} at ${i}`);
  assert.deepStrictEqual(out[0], pts[0]);
  assert.deepStrictEqual(out[out.length - 1], pts[2]);
  for (let i = 1; i < out.length; i++) assert.ok(out[i].t >= out[i - 1].t, 'time must not go backwards');
});

test('resampled trail passes through the original samples (curve, not shortcut)', () => {
  const pts = [{ x: 0, y: 0, t: 0 }, { x: 100, y: 100, t: 10 }, { x: 200, y: 0, t: 20 }];
  const out = resampleTrail(pts, 5);
  assert.ok(out.some((p) => dist(p, pts[1]) < 1e-9), 'middle sample kept');
});

test('resampleTrail leaves 0 or 1 points alone', () => {
  assert.deepStrictEqual(resampleTrail([], 4), []);
  assert.deepStrictEqual(resampleTrail([{ x: 1, y: 2, t: 3 }], 4), [{ x: 1, y: 2, t: 3 }]);
});

test('trail outline tapers from full width at the head to nothing at the tail', () => {
  const now = 1000;
  const samples = Array.from({ length: 11 }, (_, i) => ({ x: i * 10, y: 50, t: now - 400 + i * 40 }));
  const { left, right } = trailOutline(samples, now, 400, 12);
  assert.strictEqual(left.length, samples.length);
  assert.strictEqual(right.length, samples.length);
  const width = (i) => dist(left[i], right[i]);
  assert.ok(Math.abs(width(10) - 12) < 1e-9, `head width ${width(10)}`);
  assert.ok(width(0) < 1e-9, `tail width ${width(0)}`);
  for (let i = 1; i < samples.length; i++) assert.ok(width(i) >= width(i - 1), 'width grows toward the head');
});

test('trail outline is centred on the path', () => {
  const now = 100;
  const samples = [{ x: 0, y: 0, t: 90 }, { x: 10, y: 10, t: 95 }, { x: 20, y: 0, t: 100 }];
  const { left, right } = trailOutline(samples, now, 400, 10);
  samples.forEach((p, i) => {
    assert.ok(Math.abs((left[i].x + right[i].x) / 2 - p.x) < 1e-9);
    assert.ok(Math.abs((left[i].y + right[i].y) / 2 - p.y) < 1e-9);
  });
});
