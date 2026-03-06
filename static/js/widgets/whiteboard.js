// whiteboard.js -- Collaborative vector whiteboard widget

import { WidgetBase, registerWidget } from './widget-api.js';
import { escapeHtml } from '../render.js';
import state from '../state.js';

// ── Section A: Element data model ──────────────────────────────────

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function createElement(type, props) {
  return {
    id: genId(),
    type,
    x: 0, y: 0, w: 0, h: 0,
    stroke: '#ffffff',
    strokeWidth: 2,
    fill: '',
    opacity: 1,
    zIndex: 0,
    author: state.currentUser,
    ...props,
  };
}

// Ramer-Douglas-Peucker path simplification
function simplifyPath(pts, tolerance) {
  if (pts.length <= 4) return pts; // 2 points or fewer
  let maxDist = 0, maxIdx = 0;
  const sx = pts[0], sy = pts[1];
  const ex = pts[pts.length - 2], ey = pts[pts.length - 1];
  const dx = ex - sx, dy = ey - sy;
  const lenSq = dx * dx + dy * dy;
  for (let i = 2; i < pts.length - 2; i += 2) {
    let d;
    if (lenSq === 0) {
      const ddx = pts[i] - sx, ddy = pts[i + 1] - sy;
      d = ddx * ddx + ddy * ddy;
    } else {
      const t = Math.max(0, Math.min(1, ((pts[i] - sx) * dx + (pts[i + 1] - sy) * dy) / lenSq));
      const px = sx + t * dx, py = sy + t * dy;
      const ddx = pts[i] - px, ddy = pts[i + 1] - py;
      d = ddx * ddx + ddy * ddy;
    }
    if (d > maxDist) { maxDist = d; maxIdx = i; }
  }
  if (maxDist > tolerance * tolerance) {
    const left = simplifyPath(pts.slice(0, maxIdx + 2), tolerance);
    const right = simplifyPath(pts.slice(maxIdx), tolerance);
    return left.slice(0, -2).concat(right);
  }
  return [sx, sy, ex, ey];
}

// ── Section B: PDF export ──────────────────────────────────────────

class PdfWriter {
  constructor() {
    this.objects = [];
    this.pages = [];
  }

  _addObj(content) {
    this.objects.push(content);
    return this.objects.length + 2; // +2 to account for catalog and pages prepended in toBlob
  }

  addPage(w, h, streamContent) {
    const streamBytes = new TextEncoder().encode(streamContent);
    const streamId = this._addObj(
      `<< /Length ${streamBytes.length} >>\nstream\n${streamContent}\nendstream`
    );
    const fontId = this._addObj(
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
    );
    const pageId = this._addObj(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] ` +
      `/Contents ${streamId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`
    );
    this.pages.push(pageId);
  }

  toBlob() {
    // Build catalog and pages objects at indices 1 and 2
    const kids = this.pages.map(p => `${p} 0 R`).join(' ');
    // We need to rebuild: obj 1 = catalog, obj 2 = pages
    let parts = ['%PDF-1.4\n'];
    const offsets = [];

    // Prepend catalog and pages
    const allObjs = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      `<< /Type /Pages /Kids [${kids}] /Count ${this.pages.length} >>`,
      ...this.objects,
    ];

    for (let i = 0; i < allObjs.length; i++) {
      offsets.push(parts.join('').length);
      parts.push(`${i + 1} 0 obj\n${allObjs[i]}\nendobj\n`);
    }

    const xrefOffset = parts.join('').length;
    const n = allObjs.length + 1;
    let xref = `xref\n0 ${n}\n0000000000 65535 f \n`;
    for (const off of offsets) {
      xref += String(off).padStart(10, '0') + ' 00000 n \n';
    }

    parts.push(xref);
    parts.push(`trailer\n<< /Size ${n} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);

    return new Blob([parts.join('')], { type: 'application/pdf' });
  }
}

function hexToRgb01(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

function pdfEscapeText(str) {
  return str.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function exportPDF(elements, canvasW, canvasH) {
  // Compute bounding box of all elements
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const els = Array.from(elements.values());
  if (els.length === 0) { minX = 0; minY = 0; maxX = canvasW; maxY = canvasH; }
  for (const el of els) {
    const bb = boundingBox(el);
    minX = Math.min(minX, bb.x);
    minY = Math.min(minY, bb.y);
    maxX = Math.max(maxX, bb.x + bb.w);
    maxY = Math.max(maxY, bb.y + bb.h);
  }
  const margin = 20;
  minX -= margin; minY -= margin; maxX += margin; maxY += margin;
  const pw = maxX - minX, ph = maxY - minY;

  let stream = '';
  const sorted = els.sort((a, b) => a.zIndex - b.zIndex);

  for (const el of sorted) {
    const [r, g, b] = hexToRgb01(el.stroke || '#ffffff');
    stream += `${r} ${g} ${b} RG\n`;
    stream += `${el.strokeWidth || 1} w\n`;

    if (el.fill) {
      const [fr, fg, fb] = hexToRgb01(el.fill);
      stream += `${fr} ${fg} ${fb} rg\n`;
    }

    const tx = (x) => x - minX;
    const ty = (y) => ph - (y - minY); // flip Y

    switch (el.type) {
      case 'path': {
        const pts = el.points || [];
        if (pts.length < 4) break;
        stream += `${tx(el.x + pts[0])} ${ty(el.y + pts[1])} m\n`;
        for (let i = 2; i < pts.length; i += 2) {
          stream += `${tx(el.x + pts[i])} ${ty(el.y + pts[i + 1])} l\n`;
        }
        stream += 'S\n';
        break;
      }
      case 'rect':
        stream += `${tx(el.x)} ${ty(el.y + el.h)} ${el.w} ${el.h} re `;
        stream += el.fill ? 'B\n' : 'S\n';
        break;
      case 'ellipse': {
        const cx = tx(el.x + el.w / 2), cy = ty(el.y + el.h / 2);
        const rx = el.w / 2, ry = el.h / 2;
        const k = 0.5522847498;
        stream += `${cx} ${cy + ry} m\n`;
        stream += `${cx + rx * k} ${cy + ry} ${cx + rx} ${cy + ry * k} ${cx + rx} ${cy} c\n`;
        stream += `${cx + rx} ${cy - ry * k} ${cx + rx * k} ${cy - ry} ${cx} ${cy - ry} c\n`;
        stream += `${cx - rx * k} ${cy - ry} ${cx - rx} ${cy - ry * k} ${cx - rx} ${cy} c\n`;
        stream += `${cx - rx} ${cy + ry * k} ${cx - rx * k} ${cy + ry} ${cx} ${cy + ry} c\n`;
        stream += el.fill ? 'B\n' : 'S\n';
        break;
      }
      case 'line':
        stream += `${tx(el.x)} ${ty(el.y)} m ${tx(el.x2)} ${ty(el.y2)} l S\n`;
        break;
      case 'arrow': {
        const x1 = tx(el.x), y1 = ty(el.y), x2 = tx(el.x2), y2 = ty(el.y2);
        stream += `${x1} ${y1} m ${x2} ${y2} l S\n`;
        // Arrowhead
        const angle = Math.atan2(y2 - y1, x2 - x1);
        const hs = 10;
        const a1x = x2 - hs * Math.cos(angle - 0.4);
        const a1y = y2 - hs * Math.sin(angle - 0.4);
        const a2x = x2 - hs * Math.cos(angle + 0.4);
        const a2y = y2 - hs * Math.sin(angle + 0.4);
        stream += `${r} ${g} ${b} rg\n`;
        stream += `${x2} ${y2} m ${a1x} ${a1y} l ${a2x} ${a2y} l f\n`;
        break;
      }
      case 'text': {
        const fontSize = el.fontSize || 16;
        const lines = (el.text || '').split('\n');
        stream += 'BT\n';
        stream += `/F1 ${fontSize} Tf\n`;
        stream += `${r} ${g} ${b} rg\n`;
        stream += `${tx(el.x)} ${ty(el.y + fontSize)} Td\n`;
        for (let i = 0; i < lines.length; i++) {
          if (i > 0) stream += `0 -${fontSize * 1.2} Td\n`;
          stream += `(${pdfEscapeText(lines[i])}) Tj\n`;
        }
        stream += 'ET\n';
        break;
      }
    }
  }

  const pdf = new PdfWriter();
  pdf.addPage(pw, ph, stream);
  return pdf.toBlob();
}

// ── Section C: Hit testing and geometry ────────────────────────────

function boundingBox(el) {
  switch (el.type) {
    case 'path': {
      const pts = el.points || [];
      if (pts.length < 2) return { x: el.x, y: el.y, w: 0, h: 0 };
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
      for (let i = 0; i < pts.length; i += 2) {
        x1 = Math.min(x1, pts[i]); y1 = Math.min(y1, pts[i + 1]);
        x2 = Math.max(x2, pts[i]); y2 = Math.max(y2, pts[i + 1]);
      }
      return { x: el.x + x1, y: el.y + y1, w: x2 - x1, h: y2 - y1 };
    }
    case 'line':
    case 'arrow': {
      const x1 = Math.min(el.x, el.x2), y1 = Math.min(el.y, el.y2);
      return { x: x1, y: y1, w: Math.abs(el.x2 - el.x), h: Math.abs(el.y2 - el.y) };
    }
    case 'text':
      return { x: el.x, y: el.y, w: el.w || 100, h: el.h || (el.fontSize || 16) * 1.3 };
    default: // rect, ellipse
      return { x: el.x, y: el.y, w: el.w, h: el.h };
  }
}

function ptSegDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lenSq));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function hitTestElement(el, wx, wy, tol) {
  switch (el.type) {
    case 'path': {
      const pts = el.points || [];
      for (let i = 0; i < pts.length - 2; i += 2) {
        if (ptSegDist(wx, wy, el.x + pts[i], el.y + pts[i + 1],
                      el.x + pts[i + 2], el.y + pts[i + 3]) < tol) return true;
      }
      return false;
    }
    case 'line':
    case 'arrow':
      return ptSegDist(wx, wy, el.x, el.y, el.x2, el.y2) < tol;
    case 'rect': {
      const bb = { x: el.x, y: el.y, w: el.w, h: el.h };
      if (el.fill) return wx >= bb.x && wx <= bb.x + bb.w && wy >= bb.y && wy <= bb.y + bb.h;
      // Stroke only: check proximity to edges
      return (ptSegDist(wx, wy, bb.x, bb.y, bb.x + bb.w, bb.y) < tol ||
              ptSegDist(wx, wy, bb.x + bb.w, bb.y, bb.x + bb.w, bb.y + bb.h) < tol ||
              ptSegDist(wx, wy, bb.x + bb.w, bb.y + bb.h, bb.x, bb.y + bb.h) < tol ||
              ptSegDist(wx, wy, bb.x, bb.y + bb.h, bb.x, bb.y) < tol);
    }
    case 'ellipse': {
      const cx = el.x + el.w / 2, cy = el.y + el.h / 2;
      const rx = el.w / 2, ry = el.h / 2;
      if (rx === 0 || ry === 0) return false;
      const d = ((wx - cx) / rx) ** 2 + ((wy - cy) / ry) ** 2;
      return el.fill ? d <= 1.0 : Math.abs(d - 1.0) < tol / Math.min(rx, ry);
    }
    case 'text': {
      const bb = boundingBox(el);
      return wx >= bb.x && wx <= bb.x + bb.w && wy >= bb.y && wy <= bb.y + bb.h;
    }
  }
  return false;
}

function rectsIntersect(a, b) {
  return !(a.x + a.w < b.x || b.x + b.w < a.x || a.y + a.h < b.y || b.y + b.h < a.y);
}

// ── Section D: Canvas rendering ────────────────────────────────────

function renderElement(ctx, el) {
  ctx.strokeStyle = el.stroke || '#ffffff';
  ctx.lineWidth = el.strokeWidth || 2;
  ctx.globalAlpha = el.opacity ?? 1;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  switch (el.type) {
    case 'path': {
      const pts = el.points || [];
      if (pts.length < 4) break;
      ctx.beginPath();
      ctx.moveTo(el.x + pts[0], el.y + pts[1]);
      for (let i = 2; i < pts.length; i += 2) {
        ctx.lineTo(el.x + pts[i], el.y + pts[i + 1]);
      }
      ctx.stroke();
      break;
    }
    case 'rect':
      if (el.fill) { ctx.fillStyle = el.fill; ctx.fillRect(el.x, el.y, el.w, el.h); }
      ctx.strokeRect(el.x, el.y, el.w, el.h);
      break;
    case 'ellipse': {
      ctx.beginPath();
      ctx.ellipse(el.x + el.w / 2, el.y + el.h / 2, Math.abs(el.w / 2), Math.abs(el.h / 2), 0, 0, Math.PI * 2);
      if (el.fill) { ctx.fillStyle = el.fill; ctx.fill(); }
      ctx.stroke();
      break;
    }
    case 'line':
      ctx.beginPath();
      ctx.moveTo(el.x, el.y);
      ctx.lineTo(el.x2, el.y2);
      ctx.stroke();
      break;
    case 'arrow': {
      ctx.beginPath();
      ctx.moveTo(el.x, el.y);
      ctx.lineTo(el.x2, el.y2);
      ctx.stroke();
      // Arrowhead
      const angle = Math.atan2(el.y2 - el.y, el.x2 - el.x);
      const hs = 10 + el.strokeWidth;
      ctx.beginPath();
      ctx.moveTo(el.x2, el.y2);
      ctx.lineTo(el.x2 - hs * Math.cos(angle - 0.4), el.y2 - hs * Math.sin(angle - 0.4));
      ctx.lineTo(el.x2 - hs * Math.cos(angle + 0.4), el.y2 - hs * Math.sin(angle + 0.4));
      ctx.closePath();
      ctx.fillStyle = el.stroke;
      ctx.fill();
      break;
    }
    case 'text': {
      const fontSize = el.fontSize || 16;
      ctx.font = `${fontSize}px sans-serif`;
      ctx.fillStyle = el.stroke;
      ctx.textBaseline = 'top';
      const lines = (el.text || '').split('\n');
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], el.x, el.y + i * fontSize * 1.2);
      }
      // Measure for bounding box
      if (!el.w) {
        let maxW = 0;
        for (const line of lines) maxW = Math.max(maxW, ctx.measureText(line).width);
        el.w = maxW + 4;
        el.h = lines.length * fontSize * 1.2;
      }
      break;
    }
  }
  ctx.globalAlpha = 1;
}

function renderSelection(ctx, selectedIds, elements, zoom) {
  for (const id of selectedIds) {
    const el = elements.get(id);
    if (!el) continue;
    const bb = boundingBox(el);
    ctx.save();
    ctx.strokeStyle = '#58a6ff';
    ctx.lineWidth = 1.5 / zoom;
    ctx.setLineDash([4 / zoom, 4 / zoom]);
    ctx.strokeRect(bb.x - 3 / zoom, bb.y - 3 / zoom, bb.w + 6 / zoom, bb.h + 6 / zoom);
    ctx.setLineDash([]);
    // Corner handles
    const hs = 4 / zoom;
    ctx.fillStyle = '#58a6ff';
    for (const [hx, hy] of [[bb.x, bb.y], [bb.x + bb.w, bb.y], [bb.x, bb.y + bb.h], [bb.x + bb.w, bb.y + bb.h]]) {
      ctx.fillRect(hx - hs, hy - hs, hs * 2, hs * 2);
    }
    ctx.restore();
  }
}

// ── Section E: Undo/Redo system ────────────────────────────────────

class UndoStack {
  constructor(maxSize = 50) {
    this.stack = [];
    this.index = -1;
    this.maxSize = maxSize;
  }

  push(entry) {
    this.stack = this.stack.slice(0, this.index + 1);
    this.stack.push(entry);
    if (this.stack.length > this.maxSize) this.stack.shift();
    this.index = this.stack.length - 1;
  }

  undo() {
    if (this.index < 0) return null;
    return this.stack[this.index--];
  }

  redo() {
    if (this.index >= this.stack.length - 1) return null;
    return this.stack[++this.index];
  }
}

// ── Section F: Whiteboard widget class ─────────────────────────────

const COLORS = ['#ffffff', '#ff4444', '#ff8800', '#ffdd00', '#44ff44', '#44ddff', '#4488ff', '#aa44ff', '#ff44aa', '#888888', '#000000'];
const WIDTHS = [1, 2, 4, 6, 10];
const TOOLS = [
  { id: 'select', label: 'Select', icon: '&#9096;' },
  { id: 'pen', label: 'Pen', icon: '&#9998;' },
  { id: 'line', label: 'Line', icon: '&#9585;' },
  { id: 'arrow', label: 'Arrow', icon: '&#8599;' },
  { id: 'rect', label: 'Rect', icon: '&#9633;' },
  { id: 'ellipse', label: 'Ellipse', icon: '&#9711;' },
  { id: 'text', label: 'Text', icon: 'T' },
];

class Whiteboard extends WidgetBase {
  activate() {
    this.elements = new Map();
    this.nextZ = 1;
    this.selectedIds = new Set();
    this.currentTool = 'pen';
    this.currentColor = '#ffffff';
    this.currentWidth = 2;
    this.currentFill = '';
    this.viewX = 0;
    this.viewY = 0;
    this.zoom = 1;
    this.needsRedraw = true;
    this.drawing = false;
    this.drawState = null;
    this.clipboard = [];
    this.undoStack = new UndoStack();
    this._saveTimer = null;
    this._savePending = false;
    this._serverStateLoaded = false;
    this._rafId = null;
    this._pointerDown = false;
    this._isPanning = false;
    this._panStart = null;
    this._lastMouse = { x: 0, y: 0 };
    this._textEditing = false;

    this._buildDOM();
    this._setupEvents();
    this._startRenderLoop();

    // Load persisted state from server
    this.loadFromServer();
  }

  _buildDOM() {
    // Toolbar
    const toolBtns = TOOLS.map(t =>
      `<button class="wb-tool-btn${t.id === this.currentTool ? ' active' : ''}" data-tool="${t.id}" title="${t.label}">${t.icon}</button>`
    ).join('');

    const colorBtns = COLORS.map(c =>
      `<span class="wb-color-swatch${c === this.currentColor ? ' active' : ''}" data-color="${c}" style="background:${c}" title="${c}"></span>`
    ).join('');

    const widthBtns = WIDTHS.map(w =>
      `<button class="wb-width-btn${w === this.currentWidth ? ' active' : ''}" data-width="${w}" title="${w}px">${w}</button>`
    ).join('');

    this.container.innerHTML = `
      <div class="widget-header">
        <span class="widget-title">Whiteboard</span>
        <div style="display:flex;gap:0.3rem;align-items:center">
          <button class="wb-action-btn" data-action="clear" title="Clear all">Clear</button>
          <button class="wb-action-btn" data-action="export" title="Export to PDF">PDF</button>
          <button class="widget-close" onclick="deactivateCurrentWidget('${this.id}')">&times;</button>
        </div>
      </div>
      <div class="whiteboard-widget">
        <div class="wb-toolbar">
          <div class="wb-tool-group">${toolBtns}</div>
          <div class="wb-color-group">${colorBtns}
            <input type="color" class="wb-color-custom" value="${this.currentColor}" title="Custom color">
          </div>
          <div class="wb-width-group">${widthBtns}</div>
          <label class="wb-fill-toggle" title="Fill shapes">
            <input type="checkbox" class="wb-fill-check"> Fill
          </label>
        </div>
        <div class="wb-canvas-wrap">
          <canvas class="wb-canvas"></canvas>
        </div>
      </div>`;

    this.canvas = this.container.querySelector('.wb-canvas');
    this.ctx = this.canvas.getContext('2d');
    this._resizeCanvas();
  }

  _resizeCanvas() {
    const wrap = this.container.querySelector('.wb-canvas-wrap');
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(rect.width, 300);
    const h = Math.max(rect.height, 200);
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.needsRedraw = true;
  }

  _setupEvents() {
    const canvas = this.canvas;
    const toolbar = this.container.querySelector('.wb-toolbar');

    // Pointer events on canvas
    this._onPointerDown = (e) => this._handlePointerDown(e);
    this._onPointerMove = (e) => this._handlePointerMove(e);
    this._onPointerUp = (e) => this._handlePointerUp(e);
    this._onWheel = (e) => this._handleWheel(e);
    canvas.addEventListener('pointerdown', this._onPointerDown);
    canvas.addEventListener('pointermove', this._onPointerMove);
    canvas.addEventListener('pointerup', this._onPointerUp);
    canvas.addEventListener('pointerleave', this._onPointerUp);
    canvas.addEventListener('wheel', this._onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    // Prevent touch scrolling on canvas
    canvas.style.touchAction = 'none';

    // Toolbar events
    toolbar.addEventListener('click', (e) => {
      const toolBtn = e.target.closest('[data-tool]');
      if (toolBtn) {
        this.currentTool = toolBtn.dataset.tool;
        toolbar.querySelectorAll('.wb-tool-btn').forEach(b => b.classList.toggle('active', b.dataset.tool === this.currentTool));
        return;
      }
      const widthBtn = e.target.closest('[data-width]');
      if (widthBtn) {
        this.currentWidth = parseInt(widthBtn.dataset.width, 10);
        toolbar.querySelectorAll('.wb-width-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.width, 10) === this.currentWidth));
        return;
      }
      const swatch = e.target.closest('[data-color]');
      if (swatch) {
        this.currentColor = swatch.dataset.color;
        toolbar.querySelectorAll('.wb-color-swatch').forEach(s => s.classList.toggle('active', s.dataset.color === this.currentColor));
        const customInput = toolbar.querySelector('.wb-color-custom');
        if (customInput) customInput.value = this.currentColor;
        return;
      }
    });

    // Custom color picker
    const customColor = toolbar.querySelector('.wb-color-custom');
    if (customColor) {
      customColor.addEventListener('input', (e) => {
        this.currentColor = e.target.value;
        toolbar.querySelectorAll('.wb-color-swatch').forEach(s => s.classList.remove('active'));
      });
    }

    // Fill toggle
    const fillCheck = toolbar.querySelector('.wb-fill-check');
    if (fillCheck) {
      fillCheck.addEventListener('change', (e) => {
        this.currentFill = e.target.checked ? this.currentColor : '';
      });
    }

    // Action buttons
    this.container.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        switch (btn.dataset.action) {
          case 'clear': this._clearAll(); break;
          case 'export': this._exportPDF(); break;
        }
      });
    });

    // Keyboard
    this._onKeyDown = (e) => this._handleKeyDown(e);
    document.addEventListener('keydown', this._onKeyDown);

    // Resize
    this._onResize = () => this._resizeCanvas();
    window.addEventListener('resize', this._onResize);

    // Save on page unload (reload, tab close, navigation)
    this._onBeforeUnload = () => {
      if (this._savePending && this.elements.size > 0) {
        this._doSave();
      }
    };
    window.addEventListener('beforeunload', this._onBeforeUnload);

    // ResizeObserver for widget container resize
    this._resizeObserver = new ResizeObserver(() => this._resizeCanvas());
    const wrap = this.container.querySelector('.wb-canvas-wrap');
    if (wrap) this._resizeObserver.observe(wrap);
  }

  _startRenderLoop() {
    const loop = () => {
      if (this.needsRedraw) {
        this._renderCanvas();
        this.needsRedraw = false;
      }
      this._rafId = requestAnimationFrame(loop);
    };
    this._rafId = requestAnimationFrame(loop);
  }

  _renderCanvas() {
    const ctx = this.ctx;
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.width / dpr;
    const h = this.canvas.height / dpr;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Apply view transform
    ctx.translate(-this.viewX * this.zoom, -this.viewY * this.zoom);
    ctx.scale(this.zoom, this.zoom);

    // Render elements sorted by zIndex
    const sorted = Array.from(this.elements.values()).sort((a, b) => a.zIndex - b.zIndex);
    for (const el of sorted) {
      renderElement(ctx, el);
    }

    // Draw in-progress element
    if (this.drawState && this.drawState.preview) {
      renderElement(ctx, this.drawState.preview);
    }

    // Selection
    if (this.selectedIds.size > 0) {
      renderSelection(ctx, this.selectedIds, this.elements, this.zoom);
    }

    // Marquee
    if (this.drawState && this.drawState.marquee) {
      const m = this.drawState.marquee;
      ctx.save();
      ctx.strokeStyle = '#58a6ff';
      ctx.lineWidth = 1 / this.zoom;
      ctx.setLineDash([4 / this.zoom, 4 / this.zoom]);
      ctx.fillStyle = 'rgba(88, 166, 255, 0.1)';
      ctx.fillRect(m.x, m.y, m.w, m.h);
      ctx.strokeRect(m.x, m.y, m.w, m.h);
      ctx.setLineDash([]);
      ctx.restore();
    }

    ctx.restore();
  }

  // ── Pointer handlers ──

  _screenToWorld(e) {
    const rect = this.canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    return {
      x: sx / this.zoom + this.viewX,
      y: sy / this.zoom + this.viewY,
    };
  }

  _handlePointerDown(e) {
    if (this._textEditing) return;

    // Middle button or ctrl+left = pan
    if (e.button === 1 || (e.button === 0 && e.ctrlKey && this.currentTool !== 'text')) {
      this._isPanning = true;
      this._panStart = { x: e.clientX, y: e.clientY, vx: this.viewX, vy: this.viewY };
      this.canvas.setPointerCapture(e.pointerId);
      return;
    }

    if (e.button !== 0) return;
    this._pointerDown = true;
    this.canvas.setPointerCapture(e.pointerId);
    const pt = this._screenToWorld(e);
    this._lastMouse = pt;

    switch (this.currentTool) {
      case 'select': this._selectDown(pt, e.shiftKey); break;
      case 'pen': this._penDown(pt); break;
      case 'line':
      case 'arrow': this._lineDown(pt); break;
      case 'rect':
      case 'ellipse': this._shapeDown(pt); break;
      case 'text': this._textDown(pt); break;
    }
  }

  _handlePointerMove(e) {
    if (this._isPanning) {
      const dx = e.clientX - this._panStart.x;
      const dy = e.clientY - this._panStart.y;
      this.viewX = this._panStart.vx - dx / this.zoom;
      this.viewY = this._panStart.vy - dy / this.zoom;
      this.needsRedraw = true;
      return;
    }

    if (!this._pointerDown) return;
    const pt = this._screenToWorld(e);

    switch (this.currentTool) {
      case 'select': this._selectMove(pt); break;
      case 'pen': this._penMove(pt); break;
      case 'line':
      case 'arrow': this._lineMove(pt); break;
      case 'rect':
      case 'ellipse': this._shapeMove(pt); break;
    }
    this._lastMouse = pt;
  }

  _handlePointerUp(e) {
    if (this._isPanning) {
      this._isPanning = false;
      this._panStart = null;
      return;
    }
    if (!this._pointerDown) return;
    this._pointerDown = false;
    const pt = this._screenToWorld(e);

    switch (this.currentTool) {
      case 'select': this._selectUp(pt); break;
      case 'pen': this._penUp(pt); break;
      case 'line':
      case 'arrow': this._lineUp(pt); break;
      case 'rect':
      case 'ellipse': this._shapeUp(pt); break;
    }
  }

  _handleWheel(e) {
    e.preventDefault();
    const delta = -e.deltaY * 0.001;
    const oldZoom = this.zoom;
    this.zoom = Math.max(0.1, Math.min(5, this.zoom * (1 + delta)));

    // Zoom toward cursor
    const rect = this.canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    this.viewX += mx / oldZoom - mx / this.zoom;
    this.viewY += my / oldZoom - my / this.zoom;
    this.needsRedraw = true;
  }

  _handleKeyDown(e) {
    // Only handle if whiteboard is visible and focused area
    if (!this.container.closest('.widget-panel')) return;
    if (this._textEditing) return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (this.selectedIds.size > 0) {
        e.preventDefault();
        this._deleteSelected();
      }
    } else if (e.key === 'a' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      this.selectedIds = new Set(this.elements.keys());
      this.needsRedraw = true;
    } else if (e.key === 'c' && (e.ctrlKey || e.metaKey)) {
      if (this.selectedIds.size > 0) {
        this.clipboard = [...this.selectedIds].map(id => {
          const el = this.elements.get(id);
          return el ? { ...el } : null;
        }).filter(Boolean);
      }
    } else if (e.key === 'v' && (e.ctrlKey || e.metaKey)) {
      if (this.clipboard.length > 0) {
        e.preventDefault();
        this._pasteClipboard();
      }
    } else if (e.key === 'z' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault();
      this._undo();
    } else if ((e.key === 'z' && (e.ctrlKey || e.metaKey) && e.shiftKey) ||
               (e.key === 'y' && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      this._redo();
    }
  }

  // ── Select tool ──

  _selectDown(pt, addToSelection) {
    // Hit test
    const tol = 6 / this.zoom;
    const sorted = Array.from(this.elements.values()).sort((a, b) => b.zIndex - a.zIndex);
    let hit = null;
    for (const el of sorted) {
      if (hitTestElement(el, pt.x, pt.y, tol)) { hit = el; break; }
    }

    if (hit) {
      if (addToSelection) {
        if (this.selectedIds.has(hit.id)) this.selectedIds.delete(hit.id);
        else this.selectedIds.add(hit.id);
      } else if (!this.selectedIds.has(hit.id)) {
        this.selectedIds = new Set([hit.id]);
      }
      // Start drag
      this.drawState = {
        mode: 'drag',
        startPt: pt,
        origPositions: new Map([...this.selectedIds].map(id => {
          const el = this.elements.get(id);
          return [id, { x: el.x, y: el.y, x2: el.x2, y2: el.y2 }];
        })),
      };
    } else {
      if (!addToSelection) this.selectedIds.clear();
      // Start marquee
      this.drawState = {
        mode: 'marquee',
        startPt: pt,
        marquee: { x: pt.x, y: pt.y, w: 0, h: 0 },
      };
    }
    this.needsRedraw = true;
  }

  _selectMove(pt) {
    if (!this.drawState) return;

    if (this.drawState.mode === 'drag') {
      const dx = pt.x - this.drawState.startPt.x;
      const dy = pt.y - this.drawState.startPt.y;
      for (const [id, orig] of this.drawState.origPositions) {
        const el = this.elements.get(id);
        if (!el) continue;
        el.x = orig.x + dx;
        el.y = orig.y + dy;
        if (el.x2 !== undefined) { el.x2 = orig.x2 + dx; el.y2 = orig.y2 + dy; }
      }
      this.needsRedraw = true;
    } else if (this.drawState.mode === 'marquee') {
      const sx = this.drawState.startPt.x, sy = this.drawState.startPt.y;
      this.drawState.marquee = {
        x: Math.min(sx, pt.x), y: Math.min(sy, pt.y),
        w: Math.abs(pt.x - sx), h: Math.abs(pt.y - sy),
      };
      // Highlight elements in marquee
      this.selectedIds.clear();
      for (const el of this.elements.values()) {
        if (rectsIntersect(boundingBox(el), this.drawState.marquee)) {
          this.selectedIds.add(el.id);
        }
      }
      this.needsRedraw = true;
    }
  }

  _selectUp(pt) {
    if (!this.drawState) return;

    if (this.drawState.mode === 'drag') {
      const dx = pt.x - this.drawState.startPt.x;
      const dy = pt.y - this.drawState.startPt.y;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        // Broadcast updates
        const ops = [];
        for (const [id, orig] of this.drawState.origPositions) {
          const el = this.elements.get(id);
          if (!el) continue;
          const props = { x: el.x, y: el.y };
          if (el.x2 !== undefined) { props.x2 = el.x2; props.y2 = el.y2; }
          ops.push({ action: 'update', data: { id, props } });
        }
        this.undoStack.push({ type: 'move', ops: [...this.drawState.origPositions] });
        if (ops.length === 1) {
          this.send('update', ops[0].data);
        } else {
          this.send('batch', { ops });
        }
        this._scheduleSave();
      }
    }

    this.drawState = null;
    this.needsRedraw = true;
  }

  // ── Pen tool ──

  _penDown(pt) {
    this.drawState = {
      preview: createElement('path', {
        x: pt.x, y: pt.y,
        points: [0, 0],
        stroke: this.currentColor,
        strokeWidth: this.currentWidth,
        zIndex: this.nextZ,
      }),
    };
    this.needsRedraw = true;
  }

  _penMove(pt) {
    if (!this.drawState || !this.drawState.preview) return;
    const p = this.drawState.preview;
    p.points.push(pt.x - p.x, pt.y - p.y);
    this.needsRedraw = true;
  }

  _penUp(pt) {
    if (!this.drawState || !this.drawState.preview) return;
    const el = this.drawState.preview;
    if (el.points.length < 4) { this.drawState = null; this.needsRedraw = true; return; }

    // Simplify path if too many points
    if (el.points.length > 200) {
      el.points = simplifyPath(el.points, 1.5);
    }

    el.zIndex = this.nextZ++;
    this.elements.set(el.id, el);
    this.undoStack.push({ type: 'add', id: el.id, el: { ...el, points: [...el.points] } });
    this.send('add', { el });
    this._scheduleSave();
    this.drawState = null;
    this.needsRedraw = true;
  }

  // ── Line/Arrow tool ──

  _lineDown(pt) {
    this.drawState = {
      preview: createElement(this.currentTool, {
        x: pt.x, y: pt.y, x2: pt.x, y2: pt.y,
        stroke: this.currentColor,
        strokeWidth: this.currentWidth,
        zIndex: this.nextZ,
      }),
    };
    this.needsRedraw = true;
  }

  _lineMove(pt) {
    if (!this.drawState || !this.drawState.preview) return;
    this.drawState.preview.x2 = pt.x;
    this.drawState.preview.y2 = pt.y;
    this.needsRedraw = true;
  }

  _lineUp(pt) {
    if (!this.drawState || !this.drawState.preview) return;
    const el = this.drawState.preview;
    if (Math.hypot(el.x2 - el.x, el.y2 - el.y) < 3) {
      this.drawState = null; this.needsRedraw = true; return;
    }
    el.zIndex = this.nextZ++;
    this.elements.set(el.id, el);
    this.undoStack.push({ type: 'add', id: el.id, el: { ...el } });
    this.send('add', { el });
    this._scheduleSave();
    this.drawState = null;
    this.needsRedraw = true;
  }

  // ── Shape tool (rect/ellipse) ──

  _shapeDown(pt) {
    this.drawState = {
      preview: createElement(this.currentTool, {
        x: pt.x, y: pt.y, w: 0, h: 0,
        stroke: this.currentColor,
        strokeWidth: this.currentWidth,
        fill: this.currentFill,
        zIndex: this.nextZ,
      }),
      startPt: pt,
    };
    this.needsRedraw = true;
  }

  _shapeMove(pt) {
    if (!this.drawState || !this.drawState.preview) return;
    const s = this.drawState.startPt;
    this.drawState.preview.x = Math.min(s.x, pt.x);
    this.drawState.preview.y = Math.min(s.y, pt.y);
    this.drawState.preview.w = Math.abs(pt.x - s.x);
    this.drawState.preview.h = Math.abs(pt.y - s.y);
    this.needsRedraw = true;
  }

  _shapeUp(pt) {
    if (!this.drawState || !this.drawState.preview) return;
    const el = this.drawState.preview;
    if (el.w < 3 && el.h < 3) {
      this.drawState = null; this.needsRedraw = true; return;
    }
    el.zIndex = this.nextZ++;
    this.elements.set(el.id, el);
    this.undoStack.push({ type: 'add', id: el.id, el: { ...el } });
    this.send('add', { el });
    this._scheduleSave();
    this.drawState = null;
    this.needsRedraw = true;
  }

  // ── Text tool ──

  _textDown(pt) {
    this._textEditing = true;
    const wrap = this.container.querySelector('.wb-canvas-wrap');
    const input = document.createElement('textarea');
    input.className = 'wb-text-input';
    const rect = this.canvas.getBoundingClientRect();
    input.style.left = ((pt.x - this.viewX) * this.zoom) + 'px';
    input.style.top = ((pt.y - this.viewY) * this.zoom) + 'px';
    input.style.color = this.currentColor;
    input.style.fontSize = '16px';
    wrap.appendChild(input);
    input.focus();

    const finalize = () => {
      const text = input.value.trim();
      input.remove();
      this._textEditing = false;
      if (!text) return;
      const el = createElement('text', {
        x: pt.x, y: pt.y, w: 0, h: 0,
        text,
        fontSize: 16,
        stroke: this.currentColor,
        strokeWidth: 1,
        zIndex: this.nextZ++,
      });
      this.elements.set(el.id, el);
      this.undoStack.push({ type: 'add', id: el.id, el: { ...el } });
      this.send('add', { el });
      this._scheduleSave();
      this.needsRedraw = true;
    };

    input.addEventListener('blur', finalize);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { input.value = ''; input.blur(); }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); input.blur(); }
    });
  }

  // ── Actions ──

  _deleteSelected() {
    const ids = [...this.selectedIds];
    const deleted = ids.map(id => ({ ...this.elements.get(id) })).filter(Boolean);
    for (const id of ids) this.elements.delete(id);
    this.selectedIds.clear();
    this.undoStack.push({ type: 'delete', elements: deleted });
    this.send('delete', { ids });
    this._scheduleSave();
    this.needsRedraw = true;
  }

  _clearAll() {
    if (this.elements.size === 0) return;
    const all = Array.from(this.elements.values()).map(el => ({ ...el }));
    this.elements.clear();
    this.selectedIds.clear();
    this.nextZ = 1;
    this.undoStack.push({ type: 'clear', elements: all });
    this.send('clear', {});
    this._scheduleSave();
    this.needsRedraw = true;
  }

  _pasteClipboard() {
    const ops = [];
    const newIds = new Set();
    for (const orig of this.clipboard) {
      const el = { ...orig, id: genId(), zIndex: this.nextZ++, x: orig.x + 20, y: orig.y + 20 };
      if (el.points) el.points = [...el.points];
      this.elements.set(el.id, el);
      ops.push({ action: 'add', data: { el } });
      newIds.add(el.id);
    }
    this.selectedIds = newIds;
    if (ops.length === 1) {
      this.send('add', ops[0].data);
    } else {
      this.send('batch', { ops });
    }
    this._scheduleSave();
    this.needsRedraw = true;
  }

  _undo() {
    const entry = this.undoStack.undo();
    if (!entry) return;
    switch (entry.type) {
      case 'add':
        this.elements.delete(entry.id);
        this.send('delete', { ids: [entry.id] });
        break;
      case 'delete':
        for (const el of entry.elements) {
          this.elements.set(el.id, { ...el });
          this.send('add', { el });
        }
        break;
      case 'move':
        for (const [id, orig] of entry.ops) {
          const el = this.elements.get(id);
          if (!el) continue;
          Object.assign(el, orig);
          this.send('update', { id, props: orig });
        }
        break;
      case 'clear':
        for (const el of entry.elements) {
          this.elements.set(el.id, { ...el });
          this.send('add', { el });
        }
        break;
    }
    this._scheduleSave();
    this.needsRedraw = true;
  }

  _redo() {
    const entry = this.undoStack.redo();
    if (!entry) return;
    switch (entry.type) {
      case 'add':
        this.elements.set(entry.id, { ...entry.el });
        this.send('add', { el: entry.el });
        break;
      case 'delete':
        for (const el of entry.elements) {
          this.elements.delete(el.id);
        }
        this.send('delete', { ids: entry.elements.map(e => e.id) });
        break;
      case 'move':
        // move entries store original positions; redo means re-apply current
        break;
      case 'clear':
        this.elements.clear();
        this.send('clear', {});
        break;
    }
    this._scheduleSave();
    this.needsRedraw = true;
  }

  _exportPDF() {
    const dpr = window.devicePixelRatio || 1;
    const blob = exportPDF(this.elements, this.canvas.width / dpr, this.canvas.height / dpr);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `whiteboard-${this.channel}-${Date.now()}.pdf`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Persistence ──

  _scheduleSave() {
    this._savePending = true;
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      if (this._savePending) {
        this._savePending = false;
        this._doSave();
      }
    }, 1000);
  }

  _doSave() {
    const data = {
      elements: Object.fromEntries(this.elements),
      nextZ: this.nextZ,
    };
    this.saveToServer(data);
  }

  // ── Widget protocol ──

  onServerResponse(type, msg) {
    if (type === 'WidgetStateLoaded' && msg.state) {
      if (!this._serverStateLoaded) {
        this._serverStateLoaded = true;
        this._applyState(msg.state);
      }
    }
  }

  getState() {
    if (this.elements.size === 0) return null;
    return {
      elements: Object.fromEntries(this.elements),
      nextZ: this.nextZ,
    };
  }

  setState(data) {
    this._applyState(data);
  }

  _applyState(data) {
    if (!data || !data.elements) return;
    this.elements.clear();
    for (const [id, el] of Object.entries(data.elements)) {
      this.elements.set(id, el);
    }
    this.nextZ = data.nextZ || this.elements.size + 1;
    this.needsRedraw = true;
  }

  onMessage(fromUser, action, data) {
    switch (action) {
      case 'add':
        if (data.el) {
          this.elements.set(data.el.id, data.el);
          if (data.el.zIndex >= this.nextZ) this.nextZ = data.el.zIndex + 1;
          this.needsRedraw = true;
        }
        break;
      case 'update':
        if (data.id && data.props) {
          const el = this.elements.get(data.id);
          if (el) { Object.assign(el, data.props); this.needsRedraw = true; }
        }
        break;
      case 'delete':
        if (data.ids) {
          for (const id of data.ids) {
            this.elements.delete(id);
            this.selectedIds.delete(id);
          }
          this.needsRedraw = true;
        }
        break;
      case 'clear':
        this.elements.clear();
        this.selectedIds.clear();
        this.nextZ = 1;
        this.needsRedraw = true;
        break;
      case 'batch':
        if (data.ops) {
          for (const op of data.ops) {
            this.onMessage(fromUser, op.action, op.data);
          }
        }
        break;
    }
  }

  deactivate() {
    // Save before closing
    if (this.elements.size > 0) this._doSave();

    if (this._rafId) cancelAnimationFrame(this._rafId);
    if (this._saveTimer) clearTimeout(this._saveTimer);
    document.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('beforeunload', this._onBeforeUnload);
    if (this._resizeObserver) this._resizeObserver.disconnect();
    this.container.innerHTML = '';
  }
}

registerWidget('whiteboard', 'Whiteboard', Whiteboard);
