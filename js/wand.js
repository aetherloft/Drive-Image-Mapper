// Magic wand: finds the outline of the area around a clicked point by filling
// outwards through similar colours, then traces that area's edge.
//
// Works on a scaled-down copy of the image, which also softens grid lines and
// texture. "Close gaps" cuts narrow openings (doorways, cracks) so a fill that
// leaks through one doesn't spill into the next room.
(function () {
  const WORK_SIZE = 1200; // longest side of the working copy, px

  let cache = null; // { src, data, w, h, scale }

  function workingCopy(img) {
    if (cache && cache.src === img.src) return cache;
    const scale = Math.min(1, WORK_SIZE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0, w, h);
    cache = { src: img.src, data: g.getImageData(0, 0, w, h).data, w, h, scale };
    return cache;
  }

  // Flood fill from (sx, sy) through pixels within `tolerance` of the seed colour.
  function fill(data, w, h, sx, sy, tolerance) {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let y = Math.max(0, sy - 1); y <= Math.min(h - 1, sy + 1); y++) {
      for (let x = Math.max(0, sx - 1); x <= Math.min(w - 1, sx + 1); x++) {
        const i = (y * w + x) * 4;
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        n++;
      }
    }
    r /= n;
    g /= n;
    b /= n;
    const mask = new Uint8Array(w * h);
    const stack = new Int32Array(w * h);
    let top = 0;
    const start = sy * w + sx;
    mask[start] = 1;
    stack[top++] = start;
    while (top) {
      const p = stack[--top];
      const x = p % w;
      const y = (p - x) / w;
      const neighbours = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1];
      for (const q of neighbours) {
        if (q < 0 || mask[q]) continue;
        const i = q * 4;
        if (Math.max(Math.abs(data[i] - r), Math.abs(data[i + 1] - g), Math.abs(data[i + 2] - b)) <= tolerance) {
          mask[q] = 1;
          stack[top++] = q;
        }
      }
    }
    return mask;
  }

  // Keeps only the 4-connected part of `mask` that contains `start`.
  function component(mask, w, h, start) {
    const out = new Uint8Array(w * h);
    if (!mask[start]) return out;
    const stack = new Int32Array(w * h);
    let top = 0;
    out[start] = 1;
    stack[top++] = start;
    while (top) {
      const p = stack[--top];
      const x = p % w;
      const y = (p - x) / w;
      if (x > 0 && mask[p - 1] && !out[p - 1]) { out[p - 1] = 1; stack[top++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !out[p + 1]) { out[p + 1] = 1; stack[top++] = p + 1; }
      if (y > 0 && mask[p - w] && !out[p - w]) { out[p - w] = 1; stack[top++] = p - w; }
      if (y < h - 1 && mask[p + w] && !out[p + w]) { out[p + w] = 1; stack[top++] = p + w; }
    }
    return out;
  }

  // Fills enclosed holes (furniture, labels) so only the outer edge remains.
  function fillHoles(mask, w, h) {
    const outside = new Uint8Array(w * h);
    const stack = new Int32Array(w * h);
    let top = 0;
    const push = (p) => {
      if (!mask[p] && !outside[p]) {
        outside[p] = 1;
        stack[top++] = p;
      }
    };
    for (let x = 0; x < w; x++) {
      push(x);
      push((h - 1) * w + x);
    }
    for (let y = 0; y < h; y++) {
      push(y * w);
      push(y * w + w - 1);
    }
    while (top) {
      const p = stack[--top];
      const x = p % w;
      const y = (p - x) / w;
      if (x > 0) push(p - 1);
      if (x < w - 1) push(p + 1);
      if (y > 0) push(p - w);
      if (y < h - 1) push(p + w);
    }
    for (let p = 0; p < w * h; p++) if (!outside[p]) mask[p] = 1;
    return mask;
  }

  // Chamfer distance (in pixels, roughly Euclidean) from each pixel to the
  // nearest pixel where mask is 0.
  function distance(mask, w, h) {
    const INF = 1e9;
    const d = new Float32Array(w * h);
    for (let p = 0; p < w * h; p++) d[p] = mask[p] ? INF : 0;
    const D = Math.SQRT2;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x;
        if (!d[p]) continue;
        let v = d[p];
        if (x > 0) v = Math.min(v, d[p - 1] + 1);
        if (y > 0) {
          v = Math.min(v, d[p - w] + 1);
          if (x > 0) v = Math.min(v, d[p - w - 1] + D);
          if (x < w - 1) v = Math.min(v, d[p - w + 1] + D);
        } else v = Math.min(v, 1); // image edge counts as outside
        if (x === 0 || x === w - 1) v = Math.min(v, 1);
        d[p] = v;
      }
    }
    for (let y = h - 1; y >= 0; y--) {
      for (let x = w - 1; x >= 0; x--) {
        const p = y * w + x;
        if (!d[p]) continue;
        let v = d[p];
        if (x < w - 1) v = Math.min(v, d[p + 1] + 1);
        if (y < h - 1) {
          v = Math.min(v, d[p + w] + 1);
          if (x < w - 1) v = Math.min(v, d[p + w + 1] + D);
          if (x > 0) v = Math.min(v, d[p + w - 1] + D);
        } else v = Math.min(v, 1);
        d[p] = v;
      }
    }
    return d;
  }

  // Morphological opening restricted to the seed's piece: shrink by r, keep the
  // piece with the seed, grow back by r. Openings narrower than 2r get cut.
  function closeGaps(mask, w, h, seed, r) {
    if (r <= 0) return mask;
    const d = distance(mask, w, h);
    const core = new Uint8Array(w * h);
    for (let p = 0; p < w * h; p++) core[p] = d[p] > r ? 1 : 0;
    let start = seed;
    if (!core[start]) {
      // The click was near an edge; use the closest surviving pixel.
      const sx = seed % w;
      const sy = (seed - sx) / w;
      let best = -1;
      let bestD = Infinity;
      const reach = Math.ceil(r * 3);
      for (let y = Math.max(0, sy - reach); y <= Math.min(h - 1, sy + reach); y++) {
        for (let x = Math.max(0, sx - reach); x <= Math.min(w - 1, sx + reach); x++) {
          const p = y * w + x;
          const dd = (x - sx) ** 2 + (y - sy) ** 2;
          if (core[p] && dd < bestD) {
            bestD = dd;
            best = p;
          }
        }
      }
      if (best === -1) return mask; // area is thinner than the gap size; leave it whole
      start = best;
    }
    const piece = component(core, w, h, start);
    const inv = new Uint8Array(w * h);
    for (let p = 0; p < w * h; p++) inv[p] = piece[p] ? 0 : 1;
    const grow = distance(inv, w, h);
    const out = new Uint8Array(w * h);
    for (let p = 0; p < w * h; p++) out[p] = mask[p] && grow[p] <= r + 0.5 ? 1 : 0;
    return component(out, w, h, out[seed] ? seed : start);
  }

  // Follows the outer edge of the mask along pixel corners, keeping the area on
  // the right. Returns corner points where the direction changes.
  function trace(mask, w, h) {
    let first = -1;
    for (let p = 0; p < w * h; p++) {
      if (mask[p]) {
        first = p;
        break;
      }
    }
    if (first === -1) return null;
    const inside = (x, y) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
    const x0 = first % w;
    const y0 = (first - x0) / w;
    // Directions: 0 east, 1 south, 2 west, 3 north.
    const DX = [1, 0, -1, 0];
    const DY = [0, 1, 0, -1];
    // Pixels ahead-left and ahead-right of a corner for each heading, as offsets.
    const LEFT = [[0, -1], [0, 0], [-1, 0], [-1, -1]];
    const RIGHT = [[0, 0], [-1, 0], [-1, -1], [0, -1]];
    let x = x0;
    let y = y0;
    let dir = 0;
    const pts = [[x, y]];
    const limit = 4 * (w + 1) * (h + 1);
    for (let steps = 0; steps < limit; steps++) {
      x += DX[dir];
      y += DY[dir];
      if (x === x0 && y === y0) break;
      const l = LEFT[dir];
      const r = RIGHT[dir];
      let next;
      if (inside(x + l[0], y + l[1])) next = (dir + 3) % 4;
      else if (inside(x + r[0], y + r[1])) next = dir;
      else next = (dir + 1) % 4;
      if (next !== dir) pts.push([x, y]);
      dir = next;
    }
    return pts;
  }

  // Pictures with a drawn border never let a leak reach the edge, so also treat a
  // fill covering most of the picture as a leak.
  function tooBig(mask, w, h) {
    let n = 0;
    for (let p = 0; p < w * h; p++) n += mask[p];
    return n > 0.4 * w * h;
  }

  function touchesEdge(mask, w, h) {
    for (let x = 0; x < w; x++) if (mask[x] || mask[(h - 1) * w + x]) return true;
    for (let y = 0; y < h; y++) if (mask[y * w] || mask[y * w + w - 1]) return true;
    return false;
  }

  // Returns { ring } in image coordinates, or { error } explaining why nothing
  // usable was found.
  //   tolerance: 0-255, how different a colour may be and still count
  //   gap: openings narrower than about twice this (working px) are cut
  function select(img, x, y, { tolerance = 90, gap = 7 } = {}) {
    const { data, w, h, scale } = workingCopy(img);
    const sx = Math.min(w - 1, Math.max(0, Math.floor(x * scale)));
    const sy = Math.min(h - 1, Math.max(0, Math.floor(y * scale)));
    const seed = sy * w + sx;
    let mask = fill(data, w, h, sx, sy, tolerance);
    mask = fillHoles(mask, w, h);
    mask = closeGaps(mask, w, h, seed, gap);
    mask = fillHoles(mask, w, h);
    // An area that runs into the edge of the picture isn't enclosed by walls;
    // it's the fill escaping through an opening.
    if (touchesEdge(mask, w, h) || tooBig(mask, w, h)) {
      return { error: 'That area isn’t closed off, so the wand spread across the picture. Raise Close gaps or lower Tolerance, or draw this one by hand.' };
    }
    const corners = trace(mask, w, h);
    if (!corners || corners.length < 3) return { error: 'Nothing to outline there.' };
    const ring = Geometry.simplify(corners, 1.5).map(([px, py]) => [Geometry.round(px / scale), Geometry.round(py / scale)]);
    return ring.length >= 3 ? { ring } : { error: 'Nothing to outline there.' };
  }

  function reset() {
    cache = null;
  }

  window.MagicWand = { select, reset };
})();
