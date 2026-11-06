// Thin wrapper around Google Identity Services, the Drive v3 REST API and Google Picker.
// Uses the drive.file scope: the app can only touch files the user opened with it,
// picked in Picker, or that the app created itself.
(function () {
  const SCOPES = [
    'https://www.googleapis.com/auth/drive.file',
    // Lets Drive list the app under "Open with" and "New" for this user.
    'https://www.googleapis.com/auth/drive.install',
  ].join(' ');

  const API = 'https://www.googleapis.com/drive/v3';
  const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
  const MAP_MIME = 'application/vnd.drive-image-map+json';
  const FOLDER_MIME = 'application/vnd.google-apps.folder';
  const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/svg+xml'];
  const FILE_FIELDS = 'id,name,mimeType,trashed,parents,appProperties,webViewLink,resourceKey,capabilities(canEdit,canAddChildren)';

  const cfg = window.IMAGE_MAPPER_CONFIG || {};
  let tokenClient = null;
  let accessToken = null;
  let tokenExpiry = 0;
  let loginHint = '';
  let pickerLoaded = null;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }

  function isConfigured() {
    return !!cfg.clientId && !cfg.clientId.startsWith('YOUR_');
  }

  async function init(hint) {
    loginHint = hint || '';
    await Promise.all([
      loadScript('https://accounts.google.com/gsi/client'),
      loadScript('https://apis.google.com/js/api.js'),
    ]);
    pickerLoaded = new Promise((resolve) => gapi.load('picker', resolve));
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: cfg.clientId,
      scope: SCOPES,
      callback: () => {},
    });
  }

  function hasToken() {
    return !!accessToken && Date.now() < tokenExpiry - 60000;
  }

  // Must run inside a user gesture the first time, or the popup gets blocked.
  function signIn() {
    if (hasToken()) return Promise.resolve(accessToken);
    return new Promise((resolve, reject) => {
      tokenClient.callback = (resp) => {
        if (resp.error) return reject(new Error(resp.error_description || resp.error));
        accessToken = resp.access_token;
        tokenExpiry = Date.now() + resp.expires_in * 1000;
        resolve(accessToken);
      };
      tokenClient.error_callback = (err) => reject(new Error(err.message || err.type || 'Sign-in failed'));
      tokenClient.requestAccessToken({ prompt: '', login_hint: loginHint });
    });
  }

  function resourceKeyHeader(keys) {
    const entries = Object.entries(keys || {}).filter(([, v]) => v);
    if (!entries.length) return {};
    return { 'X-Goog-Drive-Resource-Keys': entries.map(([id, key]) => `${id}/${key}`).join(',') };
  }

  const resourceKeys = {};

  async function request(url, opts = {}) {
    const token = await signIn();
    const res = await fetch(url, {
      ...opts,
      headers: { ...resourceKeyHeader(resourceKeys), ...(opts.headers || {}), Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      accessToken = null;
    }
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try {
        const body = await res.json();
        if (body.error && body.error.message) message = body.error.message;
      } catch (e) { /* not JSON */ }
      const err = new Error(message);
      err.status = res.status;
      throw err;
    }
    return res;
  }

  function addResourceKeys(keys) {
    Object.assign(resourceKeys, keys || {});
  }

  async function getFile(id) {
    const res = await request(`${API}/files/${encodeURIComponent(id)}?fields=${FILE_FIELDS}&supportsAllDrives=true`);
    const file = await res.json();
    if (file.resourceKey) resourceKeys[file.id] = file.resourceKey;
    return file;
  }

  async function download(id) {
    const res = await request(`${API}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`);
    return res.blob();
  }

  async function findMapForImage(imageId) {
    const q = `appProperties has { key='imageId' and value='${imageId.replace(/'/g, "\\'")}' } and trashed=false`;
    const url = `${API}/files?q=${encodeURIComponent(q)}&fields=files(${FILE_FIELDS})&orderBy=modifiedTime desc&pageSize=1&supportsAllDrives=true&includeItemsFromAllDrives=true`;
    const res = await request(url);
    const body = await res.json();
    return body.files && body.files[0] ? body.files[0] : null;
  }

  // Images and maps the app can see, most recently opened or changed first.
  // Under drive.file that's exactly the ones the user has used with this app.
  async function listRecent(limit = 40) {
    const q = `trashed=false and (mimeType='${MAP_MIME}' or mimeType contains 'image/')`;
    const fields = 'files(id,name,mimeType,modifiedTime,viewedByMeTime,iconLink,thumbnailLink)';
    const url = `${API}/files?q=${encodeURIComponent(q)}&orderBy=${encodeURIComponent('recency desc')}` +
      `&pageSize=${limit}&fields=${encodeURIComponent(fields)}&supportsAllDrives=true&includeItemsFromAllDrives=true`;
    const res = await request(url);
    const body = await res.json();
    return body.files || [];
  }

  // Create (no id) or update (id) a file with metadata + content in one request.
  // content is a string or a Blob. When metadata.mimeType is a Google type
  // (e.g. a presentation), Drive converts the uploaded content into it.
  async function upload(id, metadata, content, mimeType) {
    const boundary = 'imagemapper' + Math.random().toString(36).slice(2);
    const body = new Blob([
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
      `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
      content,
      `\r\n--${boundary}--`,
    ]);
    const url = id
      ? `${UPLOAD}/files/${encodeURIComponent(id)}?uploadType=multipart&fields=${FILE_FIELDS}&supportsAllDrives=true`
      : `${UPLOAD}/files?uploadType=multipart&fields=${FILE_FIELDS}&supportsAllDrives=true`;
    const res = await request(url, {
      method: id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    return res.json();
  }

  async function updateMetadata(id, metadata) {
    const res = await request(`${API}/files/${encodeURIComponent(id)}?fields=id&supportsAllDrives=true`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(metadata),
    });
    return res.json();
  }

  // Opens Google Picker. Resolves to an array of picked docs, or null if cancelled.
  //   kind: 'image' (images and maps) | 'map' (.imap files only) | 'any'
  //   fileIds: preselect specific files (used to grant access to a shared map/image)
  //   startFolder: open on this folder first (its own tab ahead of My Drive)
  async function pick({ kind = 'any', fileIds = null, title = '', multiple = false, startFolder = null } = {}) {
    await pickerLoaded;
    const token = await signIn();
    return new Promise((resolve) => {
      const P = google.picker;
      const builder = new P.PickerBuilder()
        .setOAuthToken(token)
        .setDeveloperKey(cfg.apiKey)
        .setAppId(cfg.appId)
        .enableFeature(P.Feature.SUPPORT_DRIVES)
        .setOrigin(window.location.origin)
        .setCallback((data) => {
          if (data[P.Response.ACTION] === P.Action.PICKED) resolve(data[P.Response.DOCUMENTS]);
          else if (data[P.Response.ACTION] === P.Action.CANCEL) resolve(null);
        });
      if (title) builder.setTitle(title);
      if (multiple) builder.enableFeature(P.Feature.MULTISELECT_ENABLED);

      if (fileIds) {
        const view = new P.DocsView().setFileIds(fileIds.join(',')).setMode(P.DocsViewMode.LIST);
        builder.addView(view);
      } else {
        // Folder-browsable tabs. With a MIME filter, folders only show if their
        // type is in the filter too; setSelectFolderEnabled decides whether a
        // folder can be picked or only opened.
        const images = kind === 'image';
        const filtered = images || kind === 'map';
        const mimeTypes = images
          ? IMAGE_MIME_TYPES.concat(MAP_MIME, FOLDER_MIME).join(',')
          : kind === 'map' ? [MAP_MIME, FOLDER_MIME].join(',') : null;
        const tab = (label, configure) => {
          const view = new P.DocsView(P.ViewId.DOCS)
            .setIncludeFolders(true)
            .setSelectFolderEnabled(!filtered)
            .setMode(P.DocsViewMode.LIST);
          if (mimeTypes) view.setMimeTypes(mimeTypes);
          configure(view);
          if (view.setLabel) view.setLabel(label);
          builder.addView(view);
        };
        // Picker opens on the first tab, so the current folder goes first.
        if (startFolder) tab('This folder', (v) => v.setParent(startFolder));
        tab('My Drive', (v) => v.setParent('root'));
        tab('Shared with me', (v) => v.setOwnedByMe(false));
        tab('Shared drives', (v) => v.setEnableDrives(true));
        tab('Starred', (v) => v.setStarred(true));
        if (images) {
          builder.addView(new P.DocsView(P.ViewId.DOCS_IMAGES).setMode(P.DocsViewMode.GRID));
          builder.addView(new P.DocsUploadView().setIncludeFolders(true));
          builder.addView(P.ViewId.RECENTLY_PICKED);
        } else {
          builder.addView(P.ViewId.RECENTLY_PICKED);
        }
      }
      builder.build().setVisible(true);
    });
  }

  window.Drive = {
    MAP_MIME,
    isConfigured,
    init,
    hasToken,
    signIn,
    addResourceKeys,
    getFile,
    download,
    findMapForImage,
    listRecent,
    upload,
    updateMetadata,
    pick,
  };
})();
