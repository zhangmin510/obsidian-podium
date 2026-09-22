'use strict';

/* Annotation state rules — pure, no DOM. */

/** Opacity of a pen/highlighter stroke at `now`. Strokes still being drawn have `endedAt: null`. */
function inkAlpha(stroke, now, { fade, holdMs, fadeMs }) {
  if (!fade || stroke.endedAt == null) return 1;
  const fading = now - stroke.endedAt - holdMs;
  if (fading <= 0) return 1;
  return Math.max(0, 1 - fading / fadeMs);
}

/** Strokes that are still visible (new array). */
function pruneStrokes(strokes, now, opts) {
  return strokes.filter((s) => inkAlpha(s, now, opts) > 0);
}

/** Laser trail points younger than `trailMs` (new array). */
function pruneTrail(points, now, trailMs) {
  return points.filter((p) => now - p.t < trailMs);
}

function trailAlpha(age, trailMs) {
  return Math.max(0, 1 - age / trailMs);
}

/** Choosing the active tool again turns it off. */
function nextTool(current, chosen) {
  return current === chosen ? null : chosen;
}

/** Client coordinates → 0..1 relative to `rect`, so ink stays put across resizes. */
function normalizePoint(clientX, clientY, rect) {
  return { x: (clientX - rect.left) / rect.width, y: (clientY - rect.top) / rect.height };
}

const lerp = (a, b, u) => a + (b - a) * u;

/** Catmull-Rom point on segment p1→p2 at u ∈ [0, 1). */
function catmullRom(p0, p1, p2, p3, u) {
  const u2 = u * u;
  const u3 = u2 * u;
  const axis = (k) =>
    0.5 *
    (2 * p1[k] +
      (p2[k] - p0[k]) * u +
      (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * u2 +
      (3 * p1[k] - p0[k] - 3 * p2[k] + p3[k]) * u3);
  return { x: axis('x'), y: axis('y'), t: lerp(p1.t, p2.t, u) };
}

/**
 * Fill the gaps between sparse pointer samples with a smooth curve through them,
 * at most ~`spacing` px apart. Input and output are pixel points `{x, y, t}`, oldest first.
 */
function resampleTrail(points, spacing) {
  if (points.length < 2) return points.slice();
  const out = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    // Catmull-Rom can bulge past the chord, so oversample a little.
    const steps = Math.max(1, Math.ceil((Math.hypot(p2.x - p1.x, p2.y - p1.y) * 1.25) / spacing));
    out.push(p1);
    for (let s = 1; s < steps; s++) out.push(catmullRom(p0, p1, p2, p3, s / steps));
  }
  out.push(points[points.length - 1]);
  return out;
}

/**
 * Left/right edges of a comet-shaped trail: full `maxWidth` at the newest sample,
 * narrowing to nothing as samples age towards `trailMs`. Fill it as one polygon so
 * overlapping segments never stack into beads.
 */
function trailOutline(samples, now, trailMs, maxWidth) {
  const left = [];
  const right = [];
  const n = samples.length;
  let normal = { x: 0, y: 1 };
  for (let i = 0; i < n; i++) {
    const a = samples[Math.max(0, i - 1)];
    const b = samples[Math.min(n - 1, i + 1)];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len > 0) normal = { x: -(b.y - a.y) / len, y: (b.x - a.x) / len };
    const half = (maxWidth * trailAlpha(now - samples[i].t, trailMs)) / 2;
    const p = samples[i];
    left.push({ x: p.x + normal.x * half, y: p.y + normal.y * half });
    right.push({ x: p.x - normal.x * half, y: p.y - normal.y * half });
  }
  return { left, right };
}

module.exports = {
  inkAlpha,
  pruneStrokes,
  pruneTrail,
  trailAlpha,
  nextTool,
  normalizePoint,
  resampleTrail,
  trailOutline,
};
