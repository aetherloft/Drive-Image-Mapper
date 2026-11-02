// Builds a one-slide PowerPoint file from a map: the image fills the slide and
// each linked area becomes an invisible shape carrying the link. Drive converts
// the upload into a native Google Slides file. Going through .pptx avoids the
// Slides API, which can only insert images from public URLs and can't draw
// freeform shapes.
(function () {
  const SLIDE_WIDTH = 10; // inches
  const MAX_IMAGE_SIDE = 4000; // px; keeps the upload a sensible size
  const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

  let libraryLoaded = null;

  function loadLibrary() {
    if (!libraryLoaded) {
      libraryLoaded = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'js/vendor/pptxgen.bundle.js';
        s.onload = resolve;
        s.onerror = () => {
          libraryLoaded = null;
          reject(new Error('Could not load the slide builder.'));
        };
        document.head.appendChild(s);
      });
    }
    return libraryLoaded;
  }

  // Re-encodes the displayed image so every format (WebP, SVG, BMP...) ends up
  // as something PowerPoint and Slides accept.
  function encodeImage(img, mimeType) {
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    const g = canvas.getContext('2d');
    const jpeg = mimeType === 'image/jpeg';
    if (jpeg) {
      g.fillStyle = '#ffffff';
      g.fillRect(0, 0, canvas.width, canvas.height);
    }
    g.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL(jpeg ? 'image/jpeg' : 'image/png', 0.92);
  }

  async function buildPptx({ img, mimeType, width, height, regions, title }) {
    await loadLibrary();
    const pptx = new window.PptxGenJS();
    const slideHeight = (SLIDE_WIDTH * height) / width;
    pptx.defineLayout({ name: 'IMAGE', width: SLIDE_WIDTH, height: slideHeight });
    pptx.layout = 'IMAGE';
    pptx.title = title;

    const slide = pptx.addSlide();
    slide.addImage({ data: encodeImage(img, mimeType), x: 0, y: 0, w: SLIDE_WIDTH, h: slideHeight, altText: title });

    const k = SLIDE_WIDTH / width; // inches per image pixel
    const invisible = { fill: { color: 'FFFFFF', transparency: 100 }, line: { type: 'none' } };

    for (const region of regions) {
      if (!region.link || !region.link.url) continue;
      const hyperlink = { url: region.link.url, tooltip: region.title || region.link.name || '' };
      const c = region.coords;
      if (region.shape === 'rect') {
        slide.addShape(pptx.ShapeType.rect, { x: c[0] * k, y: c[1] * k, w: c[2] * k, h: c[3] * k, ...invisible, hyperlink });
      } else if (region.shape === 'circle') {
        const [cx, cy, r] = c;
        slide.addShape(pptx.ShapeType.ellipse, { x: (cx - r) * k, y: (cy - r) * k, w: 2 * r * k, h: 2 * r * k, ...invisible, hyperlink });
      } else {
        // A multi-part area becomes one linked shape per outline (holes are skipped).
        const rings = region.shape === 'multi' ? Geometry.outerRings(c) : [c];
        for (const ring of rings) {
          const xs = ring.map((pt) => pt[0]);
          const ys = ring.map((pt) => pt[1]);
          const minX = Math.min(...xs);
          const minY = Math.min(...ys);
          const points = ring.map(([x, y]) => ({ x: (x - minX) * k, y: (y - minY) * k }));
          points.push({ close: true });
          slide.addShape(pptx.ShapeType.custGeom, {
            x: minX * k,
            y: minY * k,
            w: (Math.max(...xs) - minX) * k,
            h: (Math.max(...ys) - minY) * k,
            points,
            ...invisible,
            hyperlink,
          });
        }
      }
    }

    return pptx.write({ outputType: 'blob' });
  }

  window.SlidesExport = { PPTX_MIME, buildPptx };
})();
