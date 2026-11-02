// Image map editor: draws an SVG overlay on top of an <img> and lets the user
// create, select, move and reshape regions. All coordinates are stored in the
// image's natural pixel space so maps survive any display size.
//
// Region shapes:
//   { shape: 'rect',   coords: [x, y, w, h] }
//   { shape: 'circle', coords: [cx, cy, r] }
//   { shape: 'poly',   coords: [[x, y], [x, y], ...] }
//   { shape: 'multi',  coords: [ring, ring, ...] }  several outlines, one link;
//                                                    a ring inside another is a hole
(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MIN_SIZE = 4;
  const HISTORY_LIMIT = 100;

  const { round } = Geometry;

  function el(name, attrs = {}, parent) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (parent) parent.appendChild(node);
    return node;
  }

  function uid() {
    return 'r' + Math.random().toString(36).slice(2, 9);
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function ringPath(rings) {
    return rings.map((ring) => 'M' + ring.map((pt) => pt.join(',')).join('L') + 'Z').join('');
  }

  class ImageMapEditor {
    constructor(container, { onChange, onSelect, onActivate, onBusy, onNotice } = {}) {
      this.container = container;
      this.onChange = onChange || (() => {});
      this.onSelect = onSelect || (() => {});
      this.onActivate = onActivate || (() => {});
      this.onBusy = onBusy || (() => {});
      this.onNotice = onNotice || (() => {});
      this.regions = [];
      this.selection = []; // ids, in the order they were picked
      this.mode = 'edit';
      this.tool = 'select';
      this.width = 0;
      this.height = 0;
      this.draft = null; // shape being drawn
      this.drag = null; // active move/resize operation
      this.wandOptions = { tolerance: 90, gap: 7 };
      this.undoStack = [];
      this.redoStack = [];
      this.lastHistoryKey = null;
      this.lastHistoryTime = 0;

      this.stage = document.createElement('div');
      this.stage.className = 'stage';
      this.img = document.createElement('img');
      this.img.className = 'stage-image';
      this.img.alt = '';
      this.img.draggable = false;
      this.svg = el('svg', { class: 'stage-overlay', preserveAspectRatio: 'none' });
      this.stage.append(this.img, this.svg);
      container.appendChild(this.stage);

      this.svg.addEventListener('pointerdown', (e) => this.handleDown(e));
      this.svg.addEventListener('pointermove', (e) => this.handleMove(e));
      this.svg.addEventListener('pointerup', (e) => this.handleUp(e));
      this.svg.addEventListener('dblclick', (e) => this.handleDoubleClick(e));
      this.svg.addEventListener('click', (e) => {
        const region = this.mode === 'view' && this.getRegion(e.target.dataset.region);
        if (region) this.onActivate(region);
      });
      new ResizeObserver(() => this.render()).observe(this.stage);
    }

    load(src, regions) {
      return new Promise((resolve, reject) => {
        this.img.onload = () => {
          this.width = this.img.naturalWidth;
          this.height = this.img.naturalHeight;
          this.svg.setAttribute('viewBox', `0 0 ${this.width} ${this.height}`);
          this.regions = (regions || []).map((r) => ({ ...r, id: r.id || uid() }));
          this.selection = [];
          this.draft = null;
          this.undoStack = [];
          this.redoStack = [];
          MagicWand.reset();
          this.render();
          resolve({ width: this.width, height: this.height });
        };
        this.img.onerror = () => reject(new Error('The image could not be displayed.'));
        this.img.src = src;
      });
    }

    setMode(mode) {
      this.mode = mode;
      this.draft = null;
      this.drag = null;
      this.stage.dataset.mode = mode;
      if (mode === 'view') this.select(null);
      this.render();
    }

    setTool(tool) {
      this.tool = tool;
      this.draft = null;
      this.stage.dataset.tool = tool;
      this.render();
    }

    getRegion(id) {
      return this.regions.find((r) => r.id === id) || null;
    }

    // The one selected region, or null when nothing or several are selected.
    get selectedId() {
      return this.selection.length === 1 ? this.selection[0] : null;
    }

    // additive: toggle id in a multi-selection (Shift-click).
    select(id, additive = false) {
      let next;
      if (!id) next = [];
      else if (additive) next = this.selection.includes(id) ? this.selection.filter((s) => s !== id) : [...this.selection, id];
      else next = [id];
      if (next.length === this.selection.length && next.every((s, i) => s === this.selection[i])) return;
      this.selection = next;
      this.render();
      this.onSelect(this.getRegion(this.selectedId));
    }

    // ----- history -----

    // Call before changing regions. Repeated edits with the same key in quick
    // succession (typing a label) collapse into one undo step.
    remember(key = null) {
      const now = Date.now();
      if (key && key === this.lastHistoryKey && now - this.lastHistoryTime < 1500) {
        this.lastHistoryTime = now;
        return;
      }
      this.lastHistoryKey = key;
      this.lastHistoryTime = now;
      this.undoStack.push({ regions: clone(this.regions), selection: this.selection.slice() });
      if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
      this.redoStack = [];
    }

    restore(from, to) {
      const snap = from.pop();
      if (!snap) return false;
      to.push({ regions: clone(this.regions), selection: this.selection.slice() });
      this.regions = snap.regions;
      this.selection = snap.selection.filter((id) => this.getRegion(id));
      this.lastHistoryKey = null;
      this.draft = null;
      this.render();
      this.onChange();
      this.onSelect(this.getRegion(this.selectedId));
      return true;
    }

    undo() {
      return this.restore(this.undoStack, this.redoStack);
    }

    redo() {
      return this.restore(this.redoStack, this.undoStack);
    }

    // ----- region changes -----

    updateRegion(id, patch) {
      const region = this.getRegion(id);
      if (!region) return;
      this.remember(`update:${id}:${Object.keys(patch).join(',')}`);
      Object.assign(region, patch);
      this.render();
      this.onChange();
    }

    deleteRegions(ids) {
      const doomed = new Set(ids);
      if (!this.regions.some((r) => doomed.has(r.id))) return;
      this.remember();
      this.regions = this.regions.filter((r) => !doomed.has(r.id));
      this.selection = this.selection.filter((id) => !doomed.has(id));
      this.render();
      this.onChange();
      this.onSelect(this.getRegion(this.selectedId));
    }

    deleteRegion(id) {
      this.deleteRegions([id]);
    }

    // Moves a region one step up or down in the stacking order (later = on top).
    reorder(id, delta) {
      const i = this.regions.findIndex((r) => r.id === id);
      const j = i + delta;
      if (i === -1 || j < 0 || j >= this.regions.length) return;
      this.remember();
      [this.regions[i], this.regions[j]] = [this.regions[j], this.regions[i]];
      this.render();
      this.onChange();
    }

    // Merges the selected regions into one. Overlapping or touching shapes become a
    // single outline; separate ones become one region with several parts. The
    // label and link come from the first selected region that has a link.
    combine(ids = this.selection) {
      const picked = ids.map((id) => this.getRegion(id)).filter(Boolean);
      if (picked.length < 2) return null;
      const rings = Geometry.union(picked);
      if (!rings.length) return null;
      const source = picked.find((r) => r.link && r.link.url) || picked[0];
      this.remember();
      const index = Math.max(...picked.map((r) => this.regions.indexOf(r)));
      const merged = { id: uid(), title: source.title || '', link: source.link || null, ...Geometry.shapeFromRings(rings) };
      const doomed = new Set(picked.map((r) => r.id));
      const before = this.regions.slice(0, index + 1).filter((r) => !doomed.has(r.id));
      const after = this.regions.slice(index + 1);
      this.regions = [...before, merged, ...after];
      this.selection = [merged.id];
      this.render();
      this.onChange();
      this.onSelect(merged);
      return merged;
    }

    // Breaks a multi-part region into one region per outline (holes are dropped).
    split(id) {
      const region = this.getRegion(id);
      if (!region || region.shape !== 'multi') return;
      this.remember();
      const parts = Geometry.outerRings(region.coords).map((ring) => ({
        id: uid(),
        title: region.title,
        link: region.link ? { ...region.link } : null,
        shape: 'poly',
        coords: ring,
      }));
      const i = this.regions.indexOf(region);
      this.regions.splice(i, 1, ...parts);
      this.selection = parts.map((p) => p.id);
      this.render();
      this.onChange();
      this.onSelect(null);
    }

    cancelDraft() {
      if (!this.draft) return false;
      this.draft = null;
      this.render();
      return true;
    }

    finishPolygon() {
      if (!this.draft || this.draft.shape !== 'poly') return;
      const pts = this.draft.coords;
      this.draft = null;
      if (pts.length >= 3) this.addRegion({ shape: 'poly', coords: pts });
      else this.render();
    }

    addRegion(shape) {
      this.remember();
      const region = { id: uid(), title: '', link: null, ...shape };
      this.regions.push(region);
      this.selection = [region.id];
      this.render();
      this.onChange();
      this.onSelect(region);
      return region;
    }

    // Adds an outline either as a new region or, with `into`, merged into an
    // existing one.
    addOutline(ring, into = null) {
      if (into) {
        const rings = Geometry.union([into, { shape: 'poly', coords: ring }]);
        if (!rings.length) return;
        this.remember();
        Object.assign(into, Geometry.shapeFromRings(rings));
        this.render();
        this.onChange();
        this.onSelect(into);
      } else {
        this.addRegion({ shape: 'poly', coords: ring });
      }
    }

    runWand(p, additive) {
      const target = additive ? this.getRegion(this.selectedId) : null;
      this.onBusy(true);
      // Let the busy cursor paint before the (synchronous) fill runs.
      setTimeout(() => {
        try {
          const result = MagicWand.select(this.img, p.x, p.y, this.wandOptions);
          if (result.ring) this.addOutline(result.ring, target);
          else this.onNotice(result.error);
        } finally {
          this.onBusy(false);
        }
      }, 0);
    }

    // ----- pointer handling -----

    point(e) {
      const pt = this.svg.createSVGPoint();
      pt.x = e.clientX;
      pt.y = e.clientY;
      const p = pt.matrixTransform(this.svg.getScreenCTM().inverse());
      return {
        x: round(Math.min(Math.max(p.x, 0), this.width)),
        y: round(Math.min(Math.max(p.y, 0), this.height)),
      };
    }

    // Size of one screen pixel in image pixels.
    scale() {
      const box = this.svg.getBoundingClientRect();
      return box.width ? this.width / box.width : 1;
    }

    handleDown(e) {
      if (!this.width || e.button !== 0) return;
      const target = e.target;
      const regionId = target.dataset.region;

      if (this.mode === 'view') return;

      const p = this.point(e);

      if (this.tool === 'wand') {
        this.runWand(p, e.shiftKey);
        return;
      }

      if (this.tool === 'poly') {
        if (!this.draft) {
          this.draft = { shape: 'poly', coords: [[p.x, p.y]], cursor: p };
        } else {
          const first = this.draft.coords[0];
          const closeDist = 8 * this.scale();
          if (this.draft.coords.length >= 3 && Math.hypot(first[0] - p.x, first[1] - p.y) < closeDist) {
            this.finishPolygon();
            return;
          }
          this.draft.coords.push([p.x, p.y]);
        }
        this.render();
        return;
      }

      if (this.tool === 'free') {
        this.draft = { shape: 'free', coords: [[p.x, p.y]], additive: e.shiftKey };
        this.svg.setPointerCapture(e.pointerId);
        this.render();
        return;
      }

      if (this.tool === 'rect' || this.tool === 'circle') {
        this.draft = { shape: this.tool, start: p, coords: this.tool === 'rect' ? [p.x, p.y, 0, 0] : [p.x, p.y, 0] };
        this.svg.setPointerCapture(e.pointerId);
        this.render();
        return;
      }

      // Select tool
      if (target.dataset.handle !== undefined) {
        const region = this.getRegion(this.selectedId);
        this.drag = { kind: 'handle', handle: target.dataset.handle, start: p, original: clone(region.coords), moved: false };
        this.svg.setPointerCapture(e.pointerId);
        return;
      }
      if (regionId) {
        if (e.shiftKey) {
          this.select(regionId, true);
          return;
        }
        this.select(regionId);
        const region = this.getRegion(regionId);
        this.drag = { kind: 'move', start: p, original: clone(region.coords), moved: false };
        this.svg.setPointerCapture(e.pointerId);
        return;
      }
      if (!e.shiftKey) this.select(null);
    }

    handleMove(e) {
      if (!this.width) return;
      const p = this.point(e);

      if (this.draft) {
        const d = this.draft;
        if (d.shape === 'poly') {
          d.cursor = p;
        } else if (d.shape === 'free') {
          const last = d.coords[d.coords.length - 1];
          if (Math.hypot(p.x - last[0], p.y - last[1]) < 3 * this.scale()) return;
          d.coords.push([p.x, p.y]);
        } else if (d.shape === 'rect') {
          d.coords = [Math.min(d.start.x, p.x), Math.min(d.start.y, p.y), Math.abs(p.x - d.start.x), Math.abs(p.y - d.start.y)];
        } else if (d.shape === 'circle') {
          const maxR = Math.min(d.start.x, d.start.y, this.width - d.start.x, this.height - d.start.y);
          d.coords = [d.start.x, d.start.y, round(Math.min(Math.hypot(p.x - d.start.x, p.y - d.start.y), maxR))];
        }
        this.render();
        return;
      }

      if (!this.drag) return;
      const region = this.getRegion(this.selectedId);
      if (!region) return;
      const dx = p.x - this.drag.start.x;
      const dy = p.y - this.drag.start.y;
      if (!this.drag.moved) {
        if (Math.abs(dx) + Math.abs(dy) === 0) return;
        this.drag.moved = true;
        this.remember();
      }
      const o = this.drag.original;
      if (this.drag.kind === 'move') region.coords = this.moved(region.shape, o, dx, dy);
      else region.coords = this.reshaped(region.shape, o, this.drag.handle, p);
      this.render();
    }

    handleUp(e) {
      if (this.svg.hasPointerCapture(e.pointerId)) this.svg.releasePointerCapture(e.pointerId);

      if (this.draft && this.draft.shape === 'free') {
        const d = this.draft;
        this.draft = null;
        const ring = Geometry.simplify(d.coords, 1.5 * this.scale());
        if (ring.length >= 3) this.addOutline(ring, d.additive ? this.getRegion(this.selectedId) : null);
        else this.render();
        return;
      }

      if (this.draft && this.draft.shape !== 'poly') {
        const d = this.draft;
        this.draft = null;
        const big = d.shape === 'rect' ? d.coords[2] >= MIN_SIZE && d.coords[3] >= MIN_SIZE : d.coords[2] >= MIN_SIZE;
        if (big) this.addRegion({ shape: d.shape, coords: d.coords });
        else this.render();
        return;
      }

      if (this.drag) {
        const changed = this.drag.moved;
        this.drag = null;
        if (changed) this.onChange();
      }
    }

    handleDoubleClick(e) {
      if (this.mode === 'edit' && this.tool === 'poly' && this.draft) {
        // The two clicks of a double-click each added a point; drop the duplicate.
        const pts = this.draft.coords;
        if (pts.length > 1) {
          const [a, b] = pts.slice(-2);
          if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 3 * this.scale()) pts.pop();
        }
        this.finishPolygon();
        e.preventDefault();
      }
    }

    // ----- geometry -----

    moved(shape, o, dx, dy) {
      const W = this.width;
      const H = this.height;
      if (shape === 'rect') {
        const x = Math.min(Math.max(o[0] + dx, 0), W - o[2]);
        const y = Math.min(Math.max(o[1] + dy, 0), H - o[3]);
        return [round(x), round(y), o[2], o[3]];
      }
      if (shape === 'circle') {
        const cx = Math.min(Math.max(o[0] + dx, o[2]), W - o[2]);
        const cy = Math.min(Math.max(o[1] + dy, o[2]), H - o[2]);
        return [round(cx), round(cy), o[2]];
      }
      const rings = shape === 'multi' ? o : [o];
      const b = Geometry.bounds(rings);
      const cdx = Math.min(Math.max(dx, -b.minX), W - b.maxX);
      const cdy = Math.min(Math.max(dy, -b.minY), H - b.maxY);
      const shifted = rings.map((ring) => ring.map(([x, y]) => [round(x + cdx), round(y + cdy)]));
      return shape === 'multi' ? shifted : shifted[0];
    }

    reshaped(shape, o, handle, p) {
      if (shape === 'rect') {
        // Handle names are corners: nw, ne, sw, se. The opposite corner stays fixed.
        let [x1, y1] = [o[0], o[1]];
        let [x2, y2] = [o[0] + o[2], o[1] + o[3]];
        if (handle.includes('w')) x1 = p.x;
        if (handle.includes('e')) x2 = p.x;
        if (handle.includes('n')) y1 = p.y;
        if (handle.includes('s')) y2 = p.y;
        return [round(Math.min(x1, x2)), round(Math.min(y1, y2)), round(Math.max(Math.abs(x2 - x1), MIN_SIZE)), round(Math.max(Math.abs(y2 - y1), MIN_SIZE))];
      }
      if (shape === 'circle') {
        const maxR = Math.min(o[0], o[1], this.width - o[0], this.height - o[1]);
        return [o[0], o[1], round(Math.max(Math.min(Math.hypot(p.x - o[0], p.y - o[1]), maxR), MIN_SIZE))];
      }
      if (shape === 'multi') {
        // Handle names are "ring:point".
        const [ri, pi] = handle.split(':').map(Number);
        const rings = clone(o);
        rings[ri][pi] = [p.x, p.y];
        return rings;
      }
      const pts = clone(o);
      pts[Number(handle)] = [p.x, p.y];
      return pts;
    }

    // ----- rendering -----

    shapeNode(shape, coords, attrs, parent) {
      if (shape === 'rect') {
        return el('rect', { x: coords[0], y: coords[1], width: coords[2], height: coords[3], ...attrs }, parent);
      }
      if (shape === 'circle') {
        return el('circle', { cx: coords[0], cy: coords[1], r: coords[2], ...attrs }, parent);
      }
      if (shape === 'multi') {
        return el('path', { d: ringPath(coords), 'fill-rule': 'evenodd', ...attrs }, parent);
      }
      return el('polygon', { points: coords.map((pt) => pt.join(',')).join(' '), ...attrs }, parent);
    }

    handlePoints(region) {
      const c = region.coords;
      if (region.shape === 'rect') {
        return [
          ['nw', c[0], c[1]],
          ['ne', c[0] + c[2], c[1]],
          ['sw', c[0], c[1] + c[3]],
          ['se', c[0] + c[2], c[1] + c[3]],
        ];
      }
      if (region.shape === 'circle') return [['r', c[0] + c[2], c[1]]];
      if (region.shape === 'multi') return c.flatMap((ring, ri) => ring.map((pt, pi) => [`${ri}:${pi}`, pt[0], pt[1]]));
      return c.map((pt, i) => [String(i), pt[0], pt[1]]);
    }

    render() {
      if (!this.width) return;
      const s = this.scale();
      const svg = this.svg;
      svg.replaceChildren();
      svg.style.setProperty('--stroke', `${2 * s}px`);

      this.regions.forEach((region, index) => {
        const linked = !!(region.link && region.link.url);
        const cls = ['region', linked ? 'is-linked' : 'is-unlinked'];
        if (this.selection.includes(region.id)) cls.push('is-selected');
        const node = this.shapeNode(region.shape, region.coords, {
          class: cls.join(' '),
          'data-region': region.id,
          'stroke-width': 2 * s,
        }, svg);
        if (this.mode === 'view') {
          node.setAttribute('role', 'link');
          node.setAttribute('tabindex', '0');
          node.setAttribute('aria-label', region.title || (region.link && region.link.name) || `Region ${index + 1}`);
          node.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              this.onActivate(region);
            }
          });
        }
        const label = region.title || (region.link && region.link.name);
        if (label) el('title', {}, node).textContent = label;
      });

      const selected = this.mode === 'edit' && this.getRegion(this.selectedId);
      if (selected && this.tool === 'select') {
        // Dense outlines (from the wand) get smaller handles so the shape stays visible.
        const many = selected.shape === 'multi' || (selected.shape === 'poly' && selected.coords.length > 30);
        for (const [name, x, y] of this.handlePoints(selected)) {
          el('circle', { class: 'handle', cx: x, cy: y, r: (many ? 4 : 6) * s, 'stroke-width': 2 * s, 'data-handle': name }, svg);
        }
      }

      if (this.draft) {
        const d = this.draft;
        if (d.shape === 'poly' || d.shape === 'free') {
          const pts = d.cursor ? [...d.coords, [d.cursor.x, d.cursor.y]] : d.coords;
          el('polyline', { class: 'draft', points: pts.map((pt) => pt.join(',')).join(' '), 'stroke-width': 2 * s }, svg);
          if (d.shape === 'poly') {
            d.coords.forEach(([x, y], i) => {
              el('circle', { class: i === 0 ? 'handle is-first' : 'handle', cx: x, cy: y, r: (i === 0 ? 7 : 4) * s, 'stroke-width': 2 * s }, svg);
            });
          }
        } else {
          this.shapeNode(d.shape, d.coords, { class: 'draft', 'stroke-width': 2 * s }, svg);
        }
      }
    }

    // ----- export -----

    toHtml(imageSrc, name) {
      const mapName = (name || 'image-map').replace(/[^a-z0-9_-]+/gi, '-').toLowerCase();
      const esc = (str) => String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
      const areas = this.regions
        .filter((r) => r.link && r.link.url)
        .slice()
        .reverse() // HTML gives the first matching <area> priority; the editor draws later regions on top.
        .flatMap((r) => {
          const c = r.coords;
          const alt = esc(r.title || (r.link && r.link.name) || '');
          const area = (shape, coords) =>
            `  <area shape="${shape}" coords="${coords.map(Math.round).join(',')}" href="${esc(r.link.url)}" alt="${alt}" title="${alt}" target="_blank">`;
          if (r.shape === 'rect') return [area('rect', [c[0], c[1], c[0] + c[2], c[1] + c[3]])];
          if (r.shape === 'circle') return [area('circle', c)];
          // HTML areas can't have holes, so each outline becomes its own <area>.
          if (r.shape === 'multi') return Geometry.outerRings(c).map((ring) => area('poly', ring.flat()));
          return [area('poly', c.flat())];
        });
      return `<img src="${esc(imageSrc)}" usemap="#${mapName}" width="${this.width}" height="${this.height}" alt="">\n<map name="${mapName}">\n${areas.join('\n')}\n</map>`;
    }
  }

  window.ImageMapEditor = ImageMapEditor;
})();
