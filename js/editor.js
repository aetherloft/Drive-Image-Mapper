// Image map editor: draws an SVG overlay on top of an <img> and lets the user
// create, select, move and reshape regions. All coordinates are stored in the
// image's natural pixel space so maps survive any display size.
//
// Region shapes:
//   { shape: 'rect',   coords: [x, y, w, h] }
//   { shape: 'circle', coords: [cx, cy, r] }
//   { shape: 'poly',   coords: [[x, y], [x, y], ...] }
(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MIN_SIZE = 4;

  function el(name, attrs = {}, parent) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
    if (parent) parent.appendChild(node);
    return node;
  }

  function uid() {
    return 'r' + Math.random().toString(36).slice(2, 9);
  }

  function round(n) {
    return Math.round(n * 10) / 10;
  }

  class ImageMapEditor {
    constructor(container, { onChange, onSelect, onActivate } = {}) {
      this.container = container;
      this.onChange = onChange || (() => {});
      this.onSelect = onSelect || (() => {});
      this.onActivate = onActivate || (() => {});
      this.regions = [];
      this.selectedId = null;
      this.mode = 'edit';
      this.tool = 'select';
      this.width = 0;
      this.height = 0;
      this.draft = null; // shape being drawn
      this.drag = null; // active move/resize operation

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
          this.selectedId = null;
          this.draft = null;
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

    select(id) {
      if (this.selectedId === id) return;
      this.selectedId = id;
      this.render();
      this.onSelect(this.getRegion(id));
    }

    updateRegion(id, patch) {
      const region = this.getRegion(id);
      if (!region) return;
      Object.assign(region, patch);
      this.render();
      this.onChange();
    }

    deleteRegion(id) {
      const i = this.regions.findIndex((r) => r.id === id);
      if (i === -1) return;
      this.regions.splice(i, 1);
      if (this.selectedId === id) this.select(null);
      this.render();
      this.onChange();
    }

    // Moves a region one step up or down in the stacking order (later = on top).
    reorder(id, delta) {
      const i = this.regions.findIndex((r) => r.id === id);
      const j = i + delta;
      if (i === -1 || j < 0 || j >= this.regions.length) return;
      [this.regions[i], this.regions[j]] = [this.regions[j], this.regions[i]];
      this.render();
      this.onChange();
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
      const region = { id: uid(), title: '', link: null, ...shape };
      this.regions.push(region);
      this.selectedId = region.id;
      this.render();
      this.onChange();
      this.onSelect(region);
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

      if (this.tool === 'rect' || this.tool === 'circle') {
        this.draft = { shape: this.tool, start: p, coords: this.tool === 'rect' ? [p.x, p.y, 0, 0] : [p.x, p.y, 0] };
        this.svg.setPointerCapture(e.pointerId);
        this.render();
        return;
      }

      // Select tool
      if (target.dataset.handle !== undefined) {
        const region = this.getRegion(this.selectedId);
        this.drag = { kind: 'handle', handle: target.dataset.handle, start: p, original: JSON.parse(JSON.stringify(region.coords)) };
        this.svg.setPointerCapture(e.pointerId);
        return;
      }
      if (regionId) {
        this.select(regionId);
        const region = this.getRegion(regionId);
        this.drag = { kind: 'move', start: p, original: JSON.parse(JSON.stringify(region.coords)), moved: false };
        this.svg.setPointerCapture(e.pointerId);
        return;
      }
      this.select(null);
    }

    handleMove(e) {
      if (!this.width) return;
      const p = this.point(e);

      if (this.draft) {
        const d = this.draft;
        if (d.shape === 'poly') {
          d.cursor = p;
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
      const o = this.drag.original;

      if (this.drag.kind === 'move') {
        if (Math.abs(dx) + Math.abs(dy) > 0) this.drag.moved = true;
        region.coords = this.moved(region.shape, o, dx, dy);
      } else {
        region.coords = this.reshaped(region.shape, o, this.drag.handle, p);
      }
      this.render();
    }

    handleUp(e) {
      if (this.svg.hasPointerCapture(e.pointerId)) this.svg.releasePointerCapture(e.pointerId);

      if (this.draft && this.draft.shape !== 'poly') {
        const d = this.draft;
        this.draft = null;
        const big = d.shape === 'rect' ? d.coords[2] >= MIN_SIZE && d.coords[3] >= MIN_SIZE : d.coords[2] >= MIN_SIZE;
        if (big) this.addRegion({ shape: d.shape, coords: d.coords });
        else this.render();
        return;
      }

      if (this.drag) {
        const changed = this.drag.kind === 'handle' || this.drag.moved;
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
      const xs = o.map((pt) => pt[0]);
      const ys = o.map((pt) => pt[1]);
      const cdx = Math.min(Math.max(dx, -Math.min(...xs)), W - Math.max(...xs));
      const cdy = Math.min(Math.max(dy, -Math.min(...ys)), H - Math.max(...ys));
      return o.map(([x, y]) => [round(x + cdx), round(y + cdy)]);
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
      const pts = o.map((pt) => pt.slice());
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
        if (region.id === this.selectedId) cls.push('is-selected');
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
        for (const [name, x, y] of this.handlePoints(selected)) {
          el('circle', { class: 'handle', cx: x, cy: y, r: 6 * s, 'stroke-width': 2 * s, 'data-handle': name }, svg);
        }
      }

      if (this.draft) {
        const d = this.draft;
        if (d.shape === 'poly') {
          const pts = d.cursor ? [...d.coords, [d.cursor.x, d.cursor.y]] : d.coords;
          el('polyline', { class: 'draft', points: pts.map((pt) => pt.join(',')).join(' '), 'stroke-width': 2 * s }, svg);
          d.coords.forEach(([x, y], i) => {
            el('circle', { class: i === 0 ? 'handle is-first' : 'handle', cx: x, cy: y, r: (i === 0 ? 7 : 4) * s, 'stroke-width': 2 * s }, svg);
          });
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
        .map((r) => {
          const c = r.coords;
          let coords;
          if (r.shape === 'rect') coords = [c[0], c[1], c[0] + c[2], c[1] + c[3]];
          else if (r.shape === 'circle') coords = c;
          else coords = c.flat();
          const alt = esc(r.title || (r.link && r.link.name) || '');
          return `  <area shape="${r.shape}" coords="${coords.map(Math.round).join(',')}" href="${esc(r.link.url)}" alt="${alt}" title="${alt}" target="_blank">`;
        });
      return `<img src="${esc(imageSrc)}" usemap="#${mapName}" width="${this.width}" height="${this.height}" alt="">\n<map name="${mapName}">\n${areas.join('\n')}\n</map>`;
    }
  }

  window.ImageMapEditor = ImageMapEditor;
})();
