// App controller: wires Drive, the editor and the page UI together.
(function () {
  const $ = (id) => document.getElementById(id);
  const MAP_FORMAT = 'drive-image-map';
  const DEMO_KEY = 'imageMapper.demo';

  const TOOL_HINTS = {
    select: 'Click an area to select it. Drag to move, drag the handles to reshape. Delete removes it.',
    rect: 'Drag across the image to draw a rectangle.',
    circle: 'Press at the centre and drag outwards.',
    poly: 'Click each corner of the shape in turn. Click the first corner again, double-click, or press Enter to close it. Esc cancels.',
    free: 'Drag around the area to outline it. Shift-drag adds to the selected area.',
    wand: 'Click inside a room or shape to outline it automatically. Shift-click adds to the selected area. If it spills into a neighbour, lower Tolerance or raise Close gaps, then undo (Ctrl+Z) and try again.',
  };

  const state = {
    demo: false,
    image: null, // Drive file metadata of the image
    mapFile: null, // Drive file metadata of the saved map (null until first save)
    slidesId: null, // Google Slides copy made by "Save as Google Slides"
    canEdit: true,
    dirty: false,
    saving: false,
    mode: 'edit',
    objectUrl: null,
  };

  const editor = new ImageMapEditor($('canvasWrap'), {
    onChange: () => {
      markDirty();
      renderRegionList();
      renderProps();
    },
    onSelect: () => {
      renderRegionList();
      renderProps();
    },
    onActivate: openLink,
    onBusy: (busy) => editor.stage.classList.toggle('is-busy', busy),
    onNotice: (message) => toast(message),
  });

  // ---------- small UI helpers ----------

  let toastTimer = null;
  function toast(message, isError = false, link = null) {
    const t = $('toast');
    t.textContent = message;
    if (link) {
      const a = document.createElement('a');
      a.href = link.href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = link.text;
      t.append(' ', a);
    }
    t.classList.toggle('is-error', isError);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, isError || link ? 9000 : 3500);
  }

  function setLoading(text) {
    $('loading').hidden = !text;
    if (text) $('loadingText').textContent = text;
  }

  function showWelcome(text, error) {
    $('workspace').hidden = true;
    $('fileActions').hidden = true;
    $('welcome').hidden = false;
    if (text) $('welcomeText').textContent = text;
    $('welcomeError').hidden = !error;
    $('welcomeError').textContent = error || '';
  }

  function showWorkspace() {
    $('welcome').hidden = true;
    $('workspace').hidden = false;
    $('fileActions').hidden = false;
  }

  function markDirty() {
    state.dirty = true;
    updateSaveStatus();
  }

  function updateSaveStatus() {
    const status = $('saveStatus');
    const btn = $('saveBtn');
    btn.hidden = !state.canEdit;
    btn.disabled = state.saving || !state.dirty;
    if (state.saving) status.textContent = 'Saving…';
    else if (state.dirty) status.textContent = 'Unsaved changes';
    else if (state.mapFile || state.demo) status.textContent = 'All changes saved';
    else status.textContent = '';
  }

  function linkLabel(link) {
    if (!link || !link.url) return '';
    if (link.name) return link.name;
    try {
      const u = new URL(link.url);
      return u.hostname + (u.pathname === '/' ? '' : u.pathname);
    } catch (e) {
      return link.url;
    }
  }

  function regionLabel(region, index) {
    return region.title || linkLabel(region.link) || `Area ${index + 1}`;
  }

  // ---------- region list + properties ----------

  function renderRegionList() {
    const list = $('regionList');
    list.replaceChildren();
    editor.regions.forEach((region, index) => {
      const li = document.createElement('li');
      if (editor.selection.includes(region.id)) li.classList.add('is-selected');
      const swatch = document.createElement('span');
      swatch.className = 'swatch' + (region.link && region.link.url ? '' : ' is-unlinked');
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = region.title || `Area ${index + 1}`;
      const target = document.createElement('span');
      target.className = 'target';
      target.textContent = linkLabel(region.link) || 'No link';
      li.append(swatch, label, target);
      li.tabIndex = 0;
      const activate = (e) => {
        if (state.mode === 'view') openLink(region);
        else {
          editor.setTool('select');
          syncToolButtons();
          editor.select(region.id, !!(e && e.shiftKey));
        }
      };
      li.addEventListener('click', activate);
      li.addEventListener('mouseenter', () => editor.setHover(region.id));
      li.addEventListener('mouseleave', () => editor.setHover(null));
      li.addEventListener('focus', () => editor.setHover(region.id));
      li.addEventListener('blur', () => editor.setHover(null));
      li.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') activate();
      });
      list.appendChild(li);
    });
    $('regionCount').textContent = editor.regions.length;
    $('emptyHint').hidden = editor.regions.length > 0;
    $('emptyHint').textContent = state.mode === 'view'
      ? 'This image has no linked areas yet.'
      : 'No areas yet. Pick a drawing tool and drag across the image.';
  }

  function renderProps() {
    const editing = state.mode === 'edit';
    const count = editing ? editor.selection.length : 0;
    $('multiPanel').hidden = count < 2;
    $('multiCount').textContent = count;
    const region = editing ? editor.getRegion(editor.selectedId) : null;
    $('propsPanel').hidden = !region;
    if (!region) return;
    $('splitBtn').hidden = region.shape !== 'multi';
    const title = $('regionTitle');
    if (document.activeElement !== title) title.value = region.title || '';
    const link = region.link;
    $('linkCard').hidden = !(link && link.url);
    if (link && link.url) {
      $('linkName').textContent = linkLabel(link);
      $('linkName').href = link.url;
      $('linkIcon').src = link.iconUrl || '';
    }
    const urlInput = $('linkUrl');
    if (document.activeElement !== urlInput) urlInput.value = link && !link.fileId ? link.url : '';
    $('pickLink').disabled = state.demo;
    $('pickLink').title = state.demo ? 'Sign in with Google to link Drive files' : '';
    const index = editor.regions.indexOf(region);
    $('raiseBtn').disabled = index === editor.regions.length - 1;
    $('lowerBtn').disabled = index === 0;
  }

  function syncToolButtons() {
    document.querySelectorAll('.tool').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === editor.tool)));
    $('toolHint').textContent = TOOL_HINTS[editor.tool];
    $('wandOptions').hidden = editor.tool !== 'wand';
  }

  function setMode(mode) {
    if (!state.canEdit) mode = 'view';
    state.mode = mode;
    editor.setMode(mode);
    $('modeEdit').setAttribute('aria-pressed', String(mode === 'edit'));
    $('modeView').setAttribute('aria-pressed', String(mode === 'view'));
    $('toolPanel').hidden = mode === 'view';
    $('highlightBtn').hidden = mode !== 'view';
    document.body.classList.toggle('view-only', !state.canEdit);
    document.querySelector('.segmented').hidden = !state.canEdit;
    renderRegionList();
    renderProps();
  }

  function openLink(region) {
    if (!region.link || !region.link.url) {
      if (state.mode === 'view') toast('This area has no link yet.');
      return;
    }
    window.open(region.link.url, '_blank', 'noopener');
  }

  // ---------- Drive flows ----------

  function isMapFile(file) {
    return file.mimeType === Drive.MAP_MIME || /\.imap$/i.test(file.name);
  }

  // Under drive.file the app can only read files the user has handed it.
  // When a read fails, show Picker with those files preselected so one click grants access.
  async function withAccess(ids, fn, why) {
    try {
      return await fn();
    } catch (err) {
      if (err.status !== 404 && err.status !== 403) throw err;
      setLoading(null);
      toast(why || 'Select the highlighted file to give Image Mapper access to it.');
      const picked = await Drive.pick({ fileIds: ids, multiple: ids.length > 1, title: 'Select to open in Image Mapper' });
      if (!picked) throw new Error('Image Mapper needs access to that file to open it.');
      for (const doc of picked) if (doc.resourceKey) Drive.addResourceKeys({ [doc.id]: doc.resourceKey });
      setLoading('Opening…');
      return fn();
    }
  }

  async function readMap(fileId) {
    const blob = await Drive.download(fileId);
    const data = JSON.parse(await blob.text());
    if (data.format !== MAP_FORMAT || !data.imageId) throw new Error('That file is not an Image Mapper map.');
    return data;
  }

  async function openFile(id, relatedIds = []) {
    setLoading('Opening…');
    try {
      const allIds = [id, ...relatedIds.filter(Boolean)];
      const file = await withAccess(allIds, () => Drive.getFile(id));
      let image;
      let mapFile = null;
      let mapData = null;

      if (isMapFile(file)) {
        mapFile = file;
        mapData = await readMap(file.id);
        image = await withAccess([mapData.imageId], () => Drive.getFile(mapData.imageId),
          'This map points to an image you need to select once to open.');
        // Maps made outside the app (by hand or by another tool) aren't linked from
        // their image yet. Link them so opening the image finds this map next time.
        if (!(image.appProperties && image.appProperties.imageMapFileId)) {
          Drive.updateMetadata(image.id, { appProperties: { imageMapFileId: mapFile.id } }).catch(() => {});
        }
        if (!(mapFile.appProperties && mapFile.appProperties.imageId) && mapFile.capabilities && mapFile.capabilities.canEdit) {
          Drive.updateMetadata(mapFile.id, { appProperties: { imageId: image.id } }).catch(() => {});
        }
      } else if (file.mimeType && file.mimeType.startsWith('image/')) {
        image = file;
        const mapId = file.appProperties && file.appProperties.imageMapFileId;
        if (mapId) {
          mapFile = await withAccess([mapId], () => Drive.getFile(mapId),
            'This image already has a map. Select it to open it.');
        } else {
          mapFile = await Drive.findMapForImage(file.id);
        }
        if (mapFile && mapFile.trashed) mapFile = null;
        if (mapFile) mapData = await readMap(mapFile.id);
      } else {
        throw new Error(`"${file.name}" isn't an image. Image Mapper opens PNG, JPEG, GIF, WebP, BMP and SVG files.`);
      }

      const blob = await Drive.download(image.id);
      await showImage(blob, image, mapFile, mapData);
      history.replaceState(null, '', mapFile ? `?map=${mapFile.id}&image=${image.id}` : `?file=${image.id}`);
    } catch (err) {
      console.error(err);
      if ($('workspace').hidden) showWelcome(null, err.message);
      else toast(err.message, true);
    } finally {
      setLoading(null);
    }
  }

  async function showImage(blob, image, mapFile, mapData) {
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = URL.createObjectURL(blob);
    state.image = image;
    state.mapFile = mapFile;
    state.slidesId = (mapData && mapData.slidesId) || null;
    state.canEdit = state.demo || !mapFile || !mapFile.capabilities || mapFile.capabilities.canEdit !== false;
    state.dirty = false;
    showWorkspace();
    await editor.load(state.objectUrl, mapData ? mapData.regions : []);
    $('fileName').textContent = image.name;
    document.title = `${image.name} – Image Mapper`;
    editor.setTool('select');
    syncToolButtons();
    // Maps with content open ready to click; new or empty maps open ready to draw.
    setMode(editor.regions.length ? 'view' : 'edit');
    updateSaveStatus();
    updateMenu();
  }

  async function chooseImage(folderId) {
    try {
      // Start where the user is: the folder Drive's "New" was used in, else the
      // current image's folder.
      const startFolder = folderId || (state.image && state.image.parents && state.image.parents[0]) || null;
      const picked = await Drive.pick({ kind: 'image', title: 'Choose an image or an .imap map', startFolder });
      if (!picked || !picked[0]) {
        if ($('workspace').hidden) showWelcome('Choose an image from your Drive to start mapping.');
        return;
      }
      if (picked[0].resourceKey) Drive.addResourceKeys({ [picked[0].id]: picked[0].resourceKey });
      state.newMapFolderId = folderId || null;
      await openFile(picked[0].id);
    } catch (err) {
      toast(err.message, true);
    }
  }

  // ---------- open dialog: recent files ----------

  let recentFiles = [];
  let recentFilter = 'all';

  function ago(iso) {
    const secs = (Date.parse(iso) - Date.now()) / 1000;
    const units = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]];
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    for (const [unit, size] of units) {
      if (Math.abs(secs) >= size) return rtf.format(Math.round(secs / size), unit);
    }
    return 'just now';
  }

  function renderRecent() {
    const list = $('recentList');
    list.replaceChildren();
    const shown = recentFiles.filter((f) => recentFilter === 'all' || (recentFilter === 'map') === isMapFile(f));
    for (const f of shown) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      const thumb = document.createElement('span');
      thumb.className = 'recent-thumb';
      if (f.thumbnailLink && !isMapFile(f)) {
        thumb.style.backgroundImage = `url("${f.thumbnailLink}")`;
      } else {
        const icon = document.createElement('img');
        icon.alt = '';
        icon.src = isMapFile(f) ? 'assets/icon.svg' : (f.iconLink || 'assets/icon.svg');
        thumb.appendChild(icon);
      }
      const text = document.createElement('span');
      text.className = 'recent-text';
      const name = document.createElement('span');
      name.className = 'recent-name';
      name.textContent = f.name;
      const meta = document.createElement('span');
      meta.className = 'recent-meta';
      const changed = f.modifiedTime && (!f.viewedByMeTime || f.modifiedTime >= f.viewedByMeTime);
      const when = changed ? f.modifiedTime : f.viewedByMeTime;
      meta.textContent = `${isMapFile(f) ? 'Map' : 'Image'} · ${changed ? 'changed' : 'opened'} ${when ? ago(when) : ''}`;
      text.append(name, meta);
      btn.append(thumb, text);
      btn.addEventListener('click', () => {
        $('openDialog').close();
        state.newMapFolderId = null;
        openFile(f.id);
      });
      li.appendChild(btn);
      list.appendChild(li);
    }
    const note = $('recentNote');
    note.hidden = shown.length > 0;
    if (!shown.length) {
      note.textContent = recentFiles.length
        ? `No recent ${recentFilter === 'map' ? 'maps' : 'images'}.`
        : 'Nothing opened in Image Mapper yet. Browse Google Drive to pick an image or map.';
    }
  }

  async function showOpenDialog(folderId) {
    const dialog = $('openDialog');
    dialog.dataset.folderId = folderId || '';
    $('recentList').replaceChildren();
    $('recentNote').hidden = false;
    $('recentNote').textContent = 'Loading recent files…';
    if (!dialog.open) dialog.showModal();
    try {
      recentFiles = await Drive.listRecent();
    } catch (err) {
      recentFiles = [];
      $('recentNote').textContent = 'Could not load recent files: ' + err.message;
      return;
    }
    // First visit: nothing to list, so go straight to Drive.
    if (!recentFiles.length && $('workspace').hidden) {
      dialog.close();
      chooseImage(folderId);
      return;
    }
    renderRecent();
  }

  document.querySelectorAll('#openDialog .chip').forEach((chip) => chip.addEventListener('click', () => {
    recentFilter = chip.dataset.filter;
    document.querySelectorAll('#openDialog .chip').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
    renderRecent();
  }));
  $('openClose').addEventListener('click', () => $('openDialog').close());
  $('browseBtn').addEventListener('click', () => {
    const folderId = $('openDialog').dataset.folderId || undefined;
    // Picker can't sit above a modal dialog, so close it first.
    $('openDialog').close();
    chooseImage(folderId);
  });

  function serialize() {
    return JSON.stringify({
      format: MAP_FORMAT,
      version: 1,
      imageId: state.image.id,
      imageName: state.image.name,
      width: editor.width,
      height: editor.height,
      updatedAt: new Date().toISOString(),
      slidesId: state.slidesId || undefined,
      regions: editor.regions.map(({ id, shape, coords, title, link }) => ({ id, shape, coords, title: title || '', link: link || null })),
    }, null, 2);
  }

  async function save() {
    if (!state.image || state.saving || !state.canEdit) return;
    state.saving = true;
    updateSaveStatus();
    try {
      if (state.demo) {
        try { localStorage.setItem(DEMO_KEY, serialize()); } catch (e) { /* storage blocked */ }
      } else if (state.mapFile) {
        state.mapFile = await Drive.upload(state.mapFile.id, { appProperties: { imageId: state.image.id } }, serialize(), Drive.MAP_MIME);
      } else {
        await createMapFile();
      }
      state.dirty = false;
      if (!state.demo) history.replaceState(null, '', `?map=${state.mapFile.id}&image=${state.image.id}`);
    } catch (err) {
      console.error(err);
      toast('Could not save: ' + err.message, true);
    } finally {
      state.saving = false;
      updateSaveStatus();
    }
  }

  async function createMapFile() {
    const base = state.image.name.replace(/\.[^.]+$/, '') || 'Image';
    const meta = {
      name: `${base}.imap`,
      mimeType: Drive.MAP_MIME,
      description: `Clickable areas for "${state.image.name}". Open with Image Mapper.`,
      appProperties: { imageId: state.image.id },
    };
    const folder = state.newMapFolderId || (state.image.parents && state.image.parents[0]);
    const content = serialize();
    try {
      state.mapFile = await Drive.upload(null, folder ? { ...meta, parents: [folder] } : meta, content, Drive.MAP_MIME);
    } catch (err) {
      // No write access to the image's folder: fall back to the user's My Drive.
      if (!folder || (err.status !== 403 && err.status !== 404)) throw err;
      state.mapFile = await Drive.upload(null, meta, content, Drive.MAP_MIME);
      toast(`Saved "${meta.name}" to My Drive (no permission to save next to the image).`);
    }
    state.newMapFolderId = null;
    // Point the image at its map so anyone opening the image with this app finds it.
    // Needs edit access to the image; findMapForImage covers the case where this fails.
    try {
      await Drive.updateMetadata(state.image.id, { appProperties: { imageMapFileId: state.mapFile.id } });
    } catch (e) { /* view-only image */ }
  }

  // ---------- links ----------

  async function pickLinkTarget() {
    const region = editor.getRegion(editor.selectedId);
    if (!region) return;
    try {
      const picked = await Drive.pick({ kind: 'any', title: 'Choose what this area links to' });
      if (!picked || !picked[0]) return;
      const doc = picked[0];
      editor.updateRegion(region.id, {
        link: { url: doc.url, name: doc.name, fileId: doc.id, mimeType: doc.mimeType, iconUrl: doc.iconUrl || '' },
        title: region.title || doc.name,
      });
    } catch (err) {
      toast(err.message, true);
    }
  }

  function applyUrl() {
    const region = editor.getRegion(editor.selectedId);
    const raw = $('linkUrl').value.trim();
    if (!region) return;
    if (!raw) {
      editor.updateRegion(region.id, { link: null });
      return;
    }
    let url;
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
    } catch (e) {
      toast('That doesn’t look like a web address.', true);
      return;
    }
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol)) {
      toast('Links must start with http://, https:// or mailto:', true);
      return;
    }
    editor.updateRegion(region.id, { link: { url: url.href, name: '' } });
  }

  // ---------- Google Slides copy ----------

  const SLIDES_MIME = 'application/vnd.google-apps.presentation';

  function baseName() {
    return state.image.name.replace(/\.[^.]+$/, '') || 'Image';
  }

  async function exportSlides() {
    if (!editor.regions.some((r) => r.link && r.link.url)) {
      toast('Link at least one area first.');
      return;
    }
    if (!state.demo && state.canEdit && (state.dirty || !state.mapFile)) {
      await save();
      if (state.dirty) return; // save failed and already said why
    }
    setLoading('Building Google Slides…');
    try {
      const pptx = await SlidesExport.buildPptx({
        img: editor.img,
        mimeType: state.image.mimeType,
        width: editor.width,
        height: editor.height,
        regions: editor.regions,
        title: baseName(),
      });

      if (state.demo) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(pptx);
        a.download = `${baseName()}.pptx`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        toast('Downloaded a .pptx. Signed in, this goes straight into Drive as Google Slides.');
        return;
      }

      const previousId = state.slidesId;
      let file = null;
      if (previousId) {
        // Replace the contents of the existing deck so its link and sharing stay the same.
        try {
          file = await Drive.upload(previousId, {}, pptx, SlidesExport.PPTX_MIME);
          if (file.trashed) file = null;
        } catch (err) {
          if (err.status === 401 || err.status >= 500) throw err;
        }
      }
      if (!file) file = await createSlidesFile(pptx);

      if (file.id !== previousId) {
        state.slidesId = file.id;
        if (state.canEdit) await save(); // records the deck in the map file
      }
      updateMenu();
      const msg = file.id === previousId
        ? 'Google Slides version updated.'
        : previousId
          ? 'Made a new Google Slides version (the old one couldn’t be updated).'
          : 'Google Slides version created next to the image.';
      toast(msg, false, { href: slidesUrl(file), text: 'Open it' });
    } catch (err) {
      console.error(err);
      toast('Could not make the Slides version: ' + err.message, true);
    } finally {
      setLoading(null);
    }
  }

  async function createSlidesFile(pptx) {
    const meta = {
      name: `${baseName()} (linked)`,
      mimeType: SLIDES_MIME,
      description: `Clickable version of "${state.image.name}" made by Image Mapper. Present it, or open it view-only, to click the areas.`,
      appProperties: { imageId: state.image.id },
    };
    const parents = (state.mapFile && state.mapFile.parents) || state.image.parents;
    const folder = parents && parents[0];
    try {
      return await Drive.upload(null, folder ? { ...meta, parents: [folder] } : meta, pptx, SlidesExport.PPTX_MIME);
    } catch (err) {
      if (!folder || (err.status !== 403 && err.status !== 404)) throw err;
      return Drive.upload(null, meta, pptx, SlidesExport.PPTX_MIME);
    }
  }

  function slidesUrl(file) {
    return file.webViewLink || `https://docs.google.com/presentation/d/${file.id}/edit`;
  }

  function updateMenu() {
    const item = $('menuList').querySelector('[data-action="slides"]');
    item.textContent = state.slidesId ? 'Update Google Slides version' : 'Save as Google Slides';
    const open = $('menuList').querySelector('[data-action="openslides"]');
    open.hidden = !state.slidesId || state.demo;
  }

  // ---------- menu actions ----------

  async function copy(text, done) {
    try {
      await navigator.clipboard.writeText(text);
      toast(done);
    } catch (e) {
      window.prompt('Copy this:', text);
    }
  }

  async function menuAction(action) {
    $('menuList').hidden = true;
    $('menuBtn').setAttribute('aria-expanded', 'false');
    if (action === 'open') {
      if (state.dirty && !confirm('Discard unsaved changes?')) return;
      if (state.demo) {
        location.href = location.pathname;
        return;
      }
      showOpenDialog();
    } else if (action === 'share') {
      if (state.demo) return toast('Sign in with Google to share maps.');
      if (state.dirty || !state.mapFile) await save();
      if (!state.mapFile) return;
      const url = `${location.origin}${location.pathname}?map=${state.mapFile.id}&image=${state.image.id}`;
      copy(url, 'Viewer link copied. Share the image and its .imap file in Drive with the same people.');
    } else if (action === 'html') {
      const src = state.demo ? 'image.png' : `https://drive.google.com/uc?id=${state.image.id}`;
      copy(editor.toHtml(src, state.image.name), 'HTML image map copied.');
    } else if (action === 'slides') {
      exportSlides();
    } else if (action === 'openslides') {
      window.open(`https://docs.google.com/presentation/d/${state.slidesId}/present`, '_blank', 'noopener');
    } else if (action === 'mapfile') {
      if (state.demo || !state.mapFile) return toast('Save the map first.');
      window.open(state.mapFile.webViewLink || `https://drive.google.com/file/d/${state.mapFile.id}/view`, '_blank', 'noopener');
    }
  }

  // ---------- demo mode (no Google account needed) ----------

  function demoImage() {
    const c = document.createElement('canvas');
    c.width = 960;
    c.height = 600;
    const g = c.getContext('2d');
    g.fillStyle = '#f1f3f4';
    g.fillRect(0, 0, 960, 600);
    g.strokeStyle = '#3c4043';
    g.lineWidth = 6;
    g.strokeRect(40, 40, 880, 520);
    g.beginPath();
    g.moveTo(420, 40); g.lineTo(420, 260);
    g.moveTo(420, 340); g.lineTo(420, 560);
    g.moveTo(40, 300); g.lineTo(330, 300);
    g.moveTo(420, 300); g.lineTo(920, 300);
    g.stroke();
    const rooms = [
      ['Reception', 230, 170, '#d2e3fc'],
      ['Studio', 670, 170, '#ceead6'],
      ['Archive', 230, 430, '#fef7e0'],
      ['Meeting room', 670, 430, '#fce8e6'],
    ];
    g.textAlign = 'center';
    g.font = '600 28px system-ui, sans-serif';
    for (const [name, x, y, fill] of rooms) {
      g.fillStyle = fill;
      g.beginPath();
      g.arc(x, y, 60, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#202124';
      g.fillText(name, x, y + 10);
    }
    return new Promise((resolve) => c.toBlob(resolve, 'image/png'));
  }

  async function startDemo() {
    state.demo = true;
    let data = null;
    try { data = JSON.parse(localStorage.getItem(DEMO_KEY)); } catch (e) { /* none saved */ }
    if (!data) {
      data = {
        regions: [
          { shape: 'rect', coords: [46, 46, 371, 251], title: 'Reception', link: { url: 'https://www.google.com/drive/', name: 'Google Drive' } },
          { shape: 'circle', coords: [670, 430, 110], title: 'Meeting room', link: { url: 'https://calendar.google.com/', name: 'Google Calendar' } },
          { shape: 'poly', coords: [[46, 303], [417, 303], [417, 554], [180, 554]], title: 'Archive', link: null },
        ],
      };
    }
    const blob = await demoImage();
    await showImage(blob, { id: 'demo', name: 'Demo floor plan.png' }, null, data);
    $('menuList').querySelector('[data-action="mapfile"]').hidden = true;
  }

  // ---------- event wiring ----------

  document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => {
    editor.setTool(b.dataset.tool);
    syncToolButtons();
  }));
  $('modeEdit').addEventListener('click', () => setMode('edit'));
  $('modeView').addEventListener('click', () => setMode('view'));
  $('highlightBtn').addEventListener('click', () => {
    const on = editor.stage.classList.toggle('show-areas');
    $('highlightBtn').setAttribute('aria-pressed', String(on));
    $('highlightBtn').textContent = on ? 'Hide areas' : 'Show areas';
  });
  $('saveBtn').addEventListener('click', save);
  $('regionTitle').addEventListener('input', (e) => {
    const region = editor.getRegion(editor.selectedId);
    if (region) editor.updateRegion(region.id, { title: e.target.value });
  });
  $('pickLink').addEventListener('click', pickLinkTarget);
  $('linkUrlApply').addEventListener('click', applyUrl);
  $('linkUrl').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyUrl();
  });
  $('linkClear').addEventListener('click', () => {
    const region = editor.getRegion(editor.selectedId);
    if (region) editor.updateRegion(region.id, { link: null });
  });
  $('deleteBtn').addEventListener('click', () => editor.deleteRegion(editor.selectedId));
  $('deleteManyBtn').addEventListener('click', () => editor.deleteRegions(editor.selection));
  $('combineBtn').addEventListener('click', () => {
    if (!editor.combine()) toast('Those areas could not be combined.', true);
  });
  $('splitBtn').addEventListener('click', () => editor.split(editor.selectedId));
  for (const [input, out, key] of [['wandTol', 'wandTolOut', 'tolerance'], ['wandGap', 'wandGapOut', 'gap']]) {
    $(input).addEventListener('input', (e) => {
      editor.wandOptions[key] = Number(e.target.value);
      $(out).textContent = e.target.value;
    });
  }
  $('raiseBtn').addEventListener('click', () => editor.reorder(editor.selectedId, 1));
  $('lowerBtn').addEventListener('click', () => editor.reorder(editor.selectedId, -1));

  $('menuBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const list = $('menuList');
    list.hidden = !list.hidden;
    $('menuBtn').setAttribute('aria-expanded', String(!list.hidden));
  });
  $('menuList').addEventListener('click', (e) => {
    const action = e.target.dataset.action;
    if (action) menuAction(action);
  });
  document.addEventListener('click', () => {
    $('menuList').hidden = true;
    $('menuBtn').setAttribute('aria-expanded', 'false');
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
      return;
    }
    const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName) && document.activeElement.type !== 'range';
    if (typing || $('workspace').hidden || state.mode !== 'edit') return;
    if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'z' || e.key.toLowerCase() === 'y')) {
      e.preventDefault();
      if (e.key.toLowerCase() === 'y' || e.shiftKey) editor.redo();
      else editor.undo();
      return;
    }
    const tools = { v: 'select', r: 'rect', c: 'circle', p: 'poly', f: 'free', w: 'wand' };
    if (!e.ctrlKey && !e.metaKey && !e.altKey && tools[e.key.toLowerCase()]) {
      editor.setTool(tools[e.key.toLowerCase()]);
      syncToolButtons();
    } else if (e.key === 'Escape') {
      if (!editor.cancelDraft()) editor.select(null);
    } else if (e.key === 'Enter') {
      editor.finishPolygon();
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && editor.selection.length) {
      e.preventDefault();
      editor.deleteRegions(editor.selection);
    }
  });

  window.addEventListener('beforeunload', (e) => {
    if (state.dirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });

  // ---------- boot ----------

  // Drive opens the app with ?state={"action":"open","ids":[...],"userId":...}
  // or ?state={"action":"create","folderId":...,"userId":...}.
  function readLaunchRequest() {
    const params = new URLSearchParams(location.search);
    if (params.has('demo')) return { action: 'demo' };
    if (params.has('state')) {
      try {
        const s = JSON.parse(params.get('state'));
        if (s.resourceKeys) Drive.addResourceKeys(s.resourceKeys);
        if (s.action === 'open' && s.ids && s.ids.length) return { action: 'open', id: s.ids[0], userId: s.userId };
        if (s.action === 'create') return { action: 'create', folderId: s.folderId, userId: s.userId };
      } catch (e) { /* malformed state: fall through to the picker */ }
    }
    if (params.get('map')) return { action: 'open', id: params.get('map'), related: [params.get('image')] };
    if (params.get('file')) return { action: 'open', id: params.get('file') };
    return { action: 'pick' };
  }

  async function boot() {
    const request = readLaunchRequest();
    if (request.action === 'demo') {
      startDemo();
      return;
    }

    if (!Drive.isConfigured()) {
      showWelcome('This copy of Image Mapper hasn’t been connected to a Google Cloud project yet. Fill in js/config.js (see README.md), or try the demo.');
      $('startBtn').disabled = true;
      return;
    }

    const prompts = {
      open: 'Sign in to open this file in Image Mapper.',
      create: 'Sign in to choose an image to map.',
      pick: null,
    };
    showWelcome(prompts[request.action]);
    $('startBtn').disabled = true;
    try {
      await Drive.init(request.userId);
    } catch (err) {
      showWelcome(null, 'Could not reach Google. Check your connection and reload.');
      return;
    }
    $('startBtn').disabled = false;
    $('startBtn').addEventListener('click', async () => {
      try {
        await Drive.signIn();
      } catch (err) {
        showWelcome(null, err.message);
        return;
      }
      $('startBtn').textContent = 'Open an image or map';
      if (request.action === 'open' && !state.image) openFile(request.id, request.related);
      else if (request.action === 'create') chooseImage(request.folderId);
      else showOpenDialog();
    });
  }

  boot();
})();
