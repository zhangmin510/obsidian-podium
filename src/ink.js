import {
  inkAlpha,
  pruneStrokes,
  pruneTrail,
  nextTool,
  normalizePoint,
  resampleTrail,
  trailOutline,
} from './ink-model.js';

const INK_COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#af52de'];
const LASER_TRAIL_MS = 450;
const INK_FADE_MS = 800;
// Sizes are fractions of the surface height, so they scale with the screen.
const PEN_WIDTH = 0.0045;
const HIGHLIGHTER_WIDTH = 0.03;
const HIGHLIGHTER_ALPHA = 0.35;
const LASER_RADIUS = 0.009;
const MIN_POINT_GAP = 0.0015; // ignore sub-pixel jitter between samples
const TRAIL_SPACING_PX = 3;
const DRAWING_TOOLS = new Set(['pen', 'highlighter']);

/**
 * Canvas overlay for the laser pointer (fading trail) and pen / highlighter ink.
 * Ink belongs to the slide it was drawn on; with `fade` on, strokes vanish `holdMs` after the pen lifts.
 */
class InkLayer {
  constructor(parent, { fade, holdMs }) {
    this.canvas = parent.createEl('canvas', { cls: 'mdp-ink' });
    this.ctx = this.canvas.getContext('2d');
    this.fadeOpts = { fade, holdMs, fadeMs: INK_FADE_MS };
    this.tool = null;
    this.colorIndex = 0;
    this.slide = 0;
    this.strokes = [];
    this.trail = [];
    this.pointer = null;
    this.current = null;
    this.frame = 0;
    this.resize();
  }

  get color() {
    return INK_COLORS[this.colorIndex];
  }

  get isDrawingTool() {
    return DRAWING_TOOLS.has(this.tool);
  }

  /** Toggle a tool (`null` = off). Returns the tool now active. */
  setTool(tool) {
    this.endStroke();
    this.tool = tool == null ? null : nextTool(this.tool, tool);
    this.trail = [];
    this.schedule();
    return this.tool;
  }

  cycleColor() {
    this.colorIndex = (this.colorIndex + 1) % INK_COLORS.length;
    this.schedule();
  }

  clearSlide() {
    this.endStroke();
    this.strokes = this.strokes.filter((s) => s.slide !== this.slide);
    this.schedule();
  }

  setSlide(index) {
    this.endStroke();
    this.slide = index;
    this.schedule();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.rect = rect;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.schedule();
  }

  /** Returns true when the event starts a stroke (caller should capture the pointer). */
  pointerDown(e) {
    if (!this.isDrawingTool || e.button !== 0) return false;
    this.current = {
      tool: this.tool,
      color: this.color,
      slide: this.slide,
      points: [this.toPoint(e)],
      endedAt: null,
    };
    this.strokes = [...this.strokes, this.current];
    this.schedule();
    return true;
  }

  pointerMove(e) {
    // Fast moves are delivered as one event per frame; the coalesced events hold every sample.
    const events = e.getCoalescedEvents?.() ?? [];
    const raw = events.length > 0 ? events : [e];
    const points = raw.map((ev) => this.toPoint(ev));
    this.pointer = points[points.length - 1];
    if (this.tool === 'laser') {
      // Coalesced samples all belong to the current frame (~16 ms), so they share its time.
      const now = performance.now();
      this.trail = [...pruneTrail(this.trail, now, LASER_TRAIL_MS), ...points.map((p) => ({ ...p, t: now }))];
    }
    if (this.current) this.extendStroke(points);
    if (this.tool) this.schedule();
  }

  pointerUp() {
    if (!this.current) return false;
    this.endStroke();
    return true;
  }

  pointerLeave() {
    this.pointer = null;
    this.schedule();
  }

  destroy() {
    window.cancelAnimationFrame(this.frame);
    this.canvas.remove();
  }

  toPoint(e) {
    return normalizePoint(e.clientX, e.clientY, this.rect);
  }

  extendStroke(points) {
    const added = [];
    let last = this.current.points[this.current.points.length - 1];
    for (const p of points) {
      if (Math.hypot(p.x - last.x, p.y - last.y) < MIN_POINT_GAP) continue;
      added.push(p);
      last = p;
    }
    if (added.length === 0) return;
    this.replaceCurrent({ ...this.current, points: [...this.current.points, ...added] });
  }

  endStroke() {
    if (!this.current) return;
    this.replaceCurrent({ ...this.current, endedAt: performance.now() });
    this.current = null;
    this.schedule(); // start the fade-out loop
  }

  replaceCurrent(next) {
    const prev = this.current;
    this.strokes = this.strokes.map((s) => (s === prev ? next : s));
    this.current = next;
  }

  schedule() {
    if (this.frame) return;
    this.frame = window.requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  draw() {
    const now = performance.now();
    const { width, height } = this.rect;
    this.strokes = pruneStrokes(this.strokes, now, this.fadeOpts);
    this.trail = pruneTrail(this.trail, now, LASER_TRAIL_MS);
    this.ctx.clearRect(0, 0, width, height);

    for (const s of this.strokes) {
      if (s.slide === this.slide) this.drawStroke(s, inkAlpha(s, now, this.fadeOpts));
    }
    if (this.tool === 'laser' && this.pointer) this.drawLaser(now);

    const fading = this.fadeOpts.fade && this.strokes.some((s) => s.endedAt != null);
    if (fading || this.trail.length > 0) this.schedule();
  }

  px(p) {
    return { x: p.x * this.rect.width, y: p.y * this.rect.height };
  }

  drawStroke(stroke, alpha) {
    const { ctx } = this;
    const isHighlighter = stroke.tool === 'highlighter';
    const width = (isHighlighter ? HIGHLIGHTER_WIDTH : PEN_WIDTH) * this.rect.height;
    const pts = stroke.points.map((p) => this.px(p));
    ctx.save();
    ctx.globalAlpha = alpha * (isHighlighter ? HIGHLIGHTER_ALPHA : 1);
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (pts.length === 1) {
      ctx.beginPath();
      ctx.arc(pts[0].x, pts[0].y, width / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Quadratic curves through segment midpoints smooth out mouse sampling.
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length - 1; i++) {
        const mid = { x: (pts[i].x + pts[i + 1].x) / 2, y: (pts[i].y + pts[i + 1].y) / 2 };
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, mid.x, mid.y);
      }
      const last = pts[pts.length - 1];
      ctx.lineTo(last.x, last.y);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawLaser(now) {
    const { ctx } = this;
    const r = Math.max(5, LASER_RADIUS * this.rect.height);
    const samples = resampleTrail(
      this.trail.map((p) => ({ ...this.px(p), t: p.t })),
      TRAIL_SPACING_PX,
    );
    ctx.save();
    ctx.fillStyle = this.color;
    ctx.shadowColor = this.color;
    if (samples.length > 1) {
      // One tapered polygon, filled once: no overlapping caps, so no beads when moving fast.
      const { left, right } = trailOutline(samples, now, LASER_TRAIL_MS, r * 1.6);
      ctx.globalAlpha = 0.75;
      ctx.shadowBlur = r;
      ctx.beginPath();
      ctx.moveTo(left[0].x, left[0].y);
      for (let i = 1; i < left.length; i++) ctx.lineTo(left[i].x, left[i].y);
      for (let i = right.length - 1; i >= 0; i--) ctx.lineTo(right[i].x, right[i].y);
      ctx.closePath();
      ctx.fill();
    }
    const dot = this.px(this.pointer);
    ctx.globalAlpha = 1;
    ctx.shadowBlur = r * 2.5;
    ctx.beginPath();
    ctx.arc(dot.x, dot.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(dot.x, dot.y, r * 0.4, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

export { InkLayer, INK_COLORS };
