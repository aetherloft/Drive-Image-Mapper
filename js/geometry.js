// Shape helpers shared by the editor and the exporters.
//
// Every region can be expressed as a list of rings (closed outlines, each a list
// of [x, y] points). A 'multi' region stores its rings directly; a ring that
// sits inside another ring is a hole, matching SVG's even-odd fill rule.
(function () {
  const CIRCLE_SEGMENTS = 48;

  function round(n) {
    return Math.round(n * 10) / 10;
  }

  function toRings(region) {
    const c = region.coords;
    if (region.shape === 'rect') {
      return [[[c[0], c[1]], [c[0] + c[2], c[1]], [c[0] + c[2], c[1] + c[3]], [c[0], c[1] + c[3]]]];
    }
    if (region.shape === 'circle') {
      const ring = [];
      for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
        const a = (i / CIRCLE_SEGMENTS) * Math.PI * 2;
        ring.push([round(c[0] + c[2] * Math.cos(a)), round(c[1] + c[2] * Math.sin(a))]);
      }
      return [ring];
    }
    if (region.shape === 'multi') return c;
    return [c];
  }

  function pointInRing([x, y], ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // How many other rings contain this one. Even = outline, odd = hole.
  function depths(rings) {
    return rings.map((ring, i) => rings.reduce((n, other, j) => n + (j !== i && pointInRing(ring[0], other) ? 1 : 0), 0));
  }

  function outerRings(rings) {
    const d = depths(rings);
    return rings.filter((_, i) => d[i] % 2 === 0);
  }

  // Groups rings into polygons ([outline, ...holes]) for polygon-clipping.
  function toPolygons(rings) {
    const d = depths(rings);
    const polys = [];
    const owner = new Map();
    rings.forEach((ring, i) => {
      if (d[i] % 2 === 0) {
        owner.set(i, polys.length);
        polys.push([ring]);
      }
    });
    rings.forEach((ring, i) => {
      if (d[i] % 2 === 1) {
        // A hole belongs to the outline it sits in that is one level up.
        const j = rings.findIndex((other, k) => d[k] === d[i] - 1 && pointInRing(ring[0], other));
        if (owner.has(j)) polys[owner.get(j)].push(ring);
      }
    });
    return polys;
  }

  function cleanRing(ring) {
    const out = [];
    for (const [x, y] of ring) {
      const p = [round(x), round(y)];
      const last = out[out.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
    }
    const first = out[0];
    const last = out[out.length - 1];
    if (out.length > 1 && first[0] === last[0] && first[1] === last[1]) out.pop();
    return out;
  }

  // Merges regions into one outline set. Returns a list of rings.
  function union(regions) {
    const polys = regions.map((r) => toPolygons(toRings(r)));
    const merged = window.polygonClipping.union(...polys);
    return merged.flat().map(cleanRing).filter((ring) => ring.length >= 3);
  }

  // Shape for a set of rings: a plain polygon when there's only one.
  function shapeFromRings(rings) {
    return rings.length === 1 ? { shape: 'poly', coords: rings[0] } : { shape: 'multi', coords: rings };
  }

  // Ramer–Douglas–Peucker on a closed ring (iterative; wand outlines can have
  // thousands of points).
  function simplify(ring, epsilon) {
    const n = ring.length;
    if (n < 4) return ring;
    const segDist = (p, a, b) => {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len = Math.hypot(dx, dy);
      return len ? Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / len : Math.hypot(p[0] - a[0], p[1] - a[1]);
    };
    // Treat the ring as a path from point 0 to the point farthest from it and back.
    let far = 0;
    let farD = -1;
    ring.forEach((p, i) => {
      const d = Math.hypot(p[0] - ring[0][0], p[1] - ring[0][1]);
      if (d > farD) {
        farD = d;
        far = i;
      }
    });
    const pts = ring.concat([ring[0]]);
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[far] = keep[pts.length - 1] = 1;
    const stack = [[0, far], [far, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let max = 0;
      let index = -1;
      for (let i = a + 1; i < b; i++) {
        const d = segDist(pts[i], pts[a], pts[b]);
        if (d > max) {
          max = d;
          index = i;
        }
      }
      if (index !== -1 && max > epsilon) {
        keep[index] = 1;
        stack.push([a, index], [index, b]);
      }
    }
    const out = [];
    for (let i = 0; i < pts.length - 1; i++) if (keep[i]) out.push(pts[i]);
    return out;
  }

  function bounds(rings) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const ring of rings) {
      for (const [x, y] of ring) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    return { minX, minY, maxX, maxY };
  }

  window.Geometry = { round, toRings, outerRings, union, shapeFromRings, simplify, bounds, cleanRing };
})();
