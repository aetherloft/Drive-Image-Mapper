# Drive Image Mapper

A Google Drive app for drawing clickable areas on images. Open any image from Drive, draw rectangles, circles or polygons over it, and link each area to a Doc, Sheet, Slides deck, folder, PDF or web page. Switch to View mode and clicking an area opens its link.

It's a static site (HTML, CSS and plain JavaScript, no build step), so it can be hosted on GitHub Pages for free. Once registered with Google, it shows up in Drive under **Open with → Image Mapper** and **New → More → Image Mapper**, and can be listed so people install it from **New → More → Connect more apps**.

Try the editor without a Google account by opening `index.html?demo` (the demo saves to your browser only).

## How maps are stored

Each map is a small JSON file with the extension `.imap` and the MIME type `application/vnd.drive-image-map+json`, saved next to the image in Drive (or in My Drive if you can't add files to the image's folder). The app also writes the map's file ID into a private app property on the image, so opening the image with Image Mapper loads its map.

Because the map is an ordinary Drive file, sharing works the way Drive sharing always does: share the image and its `.imap` file with the same people. People with view access to the map get a view-only map; people with edit access can change it.

The app uses the `drive.file` scope, which only grants access to files the user opens with the app or picks in Google Picker. It cannot browse the rest of anyone's Drive. When someone follows a viewer link to a map they haven't opened before, the app shows Google Picker with that file preselected so one click grants access.

## Features

- Rectangle, circle and polygon areas, stored in the image's own pixel coordinates
- Select, move, reshape, reorder and delete areas
- Link areas to Drive files through Google Picker, or to any `http`, `https` or `mailto` URL
- View mode with hover highlighting, keyboard access and a "Show areas" toggle
- Copy a viewer link, or copy a standard HTML `<map>` snippet for use on a website
- Keyboard shortcuts: `V` select, `R` rectangle, `C` circle, `P` polygon, `Enter` closes a polygon, `Esc` cancels, `Delete` removes the selected area, `Ctrl/Cmd+S` saves

## Setup

You need a Google account, a place to host the files over HTTPS, and about half an hour in the Google Cloud console.

### 1. Host the files

Any static host works. For GitHub Pages: in this repository go to **Settings → Pages**, set the source to **Deploy from a branch**, pick your branch and `/ (root)`, and save. The site will be at `https://<your-user>.github.io/<repo-name>/`. The rest of this guide calls that address `APP_URL`.

### 2. Create a Google Cloud project

1. Open [console.cloud.google.com](https://console.cloud.google.com/) and create a project.
2. Note the **project number** on the project dashboard (a long number, not the project ID).
3. Under **APIs & Services → Library**, enable:
   - Google Drive API
   - Google Picker API
   - Google Workspace Marketplace SDK (only needed for "Connect more apps")

### 3. OAuth consent screen

Under **Google Auth Platform** (older consoles: **APIs & Services → OAuth consent screen**):

1. User type **External**.
2. App name `Image Mapper`, support email, and the logo from `assets/icons/icon-128.png`.
3. App domain links: home page `APP_URL`, privacy policy `APP_URL/privacy.html`, terms `APP_URL/terms.html`.
4. Authorized domain: your host's domain (for GitHub Pages, `github.io` won't verify; see the note under publishing below).
5. Scopes are on a separate page: **Google Auth Platform → Data Access → Add or remove scopes**. Scroll to **Manually add scopes** at the bottom of the panel and paste both full URLs (the shortened `.../auth/...` form is rejected as invalid):

   ```
   https://www.googleapis.com/auth/drive.file
   https://www.googleapis.com/auth/drive.install
   ```

   Click **Add to table**, then **Update**, then **Save**. Both should appear under "Your non-sensitive scopes", so the app won't need Google's security assessment. If they're rejected, enable the Google Drive API (section 2 above) and try again. Older consoles show this as step 2 of the OAuth consent screen wizard.
6. While the app is in **Testing**, add your own address (and anyone else's who'll try it) as a test user.

### 4. Credentials

Under **APIs & Services → Credentials**:

1. **Create credentials → OAuth client ID**, type **Web application**. Add `APP_URL`'s origin (for example `https://your-user.github.io`) under **Authorized JavaScript origins**. No redirect URI is needed.
2. **Create credentials → API key**, then click the key's name to restrict it:
   - **Application restrictions**: choose **Websites** (older consoles: **HTTP referrers (web sites)**). Under **Website restrictions** click **Add** and add your site's domain followed by `/*`, for example `https://your-username.github.io/*`. Use the domain only: browsers send just the domain to other sites, so a pattern with a path never matches. Google Picker runs in a frame on Google's own domains, so also add `https://docs.google.com/*` and `https://drive.google.com/*`. For local testing, add `http://localhost:8000/*` as well and remove it later.
   - **API restrictions**: choose **Restrict key** and tick only **Google Picker API**. If it isn't listed, enable it under **APIs & Services → Library** first.
   - Click **Save**. Restrictions can take five minutes or more to apply.

Put the three values in `js/config.js`:

```js
window.IMAGE_MAPPER_CONFIG = {
  clientId: '1234567890-abc.apps.googleusercontent.com',
  apiKey: 'AIza...',
  appId: '1234567890', // project number
};
```

These values are public by design; every browser that loads the app sees them. The referrer restriction on the API key and the origin restriction on the client ID stop other sites from using them.

Commit and push. At this point `APP_URL` works as a normal web app: sign in, pick an image, draw, save.

### 5. Drive UI integration ("Open with" and "New")

In the console go to **APIs & Services → Enabled APIs → Google Drive API → Drive UI integration** and fill in:

| Field | Value |
| --- | --- |
| Application name | Image Mapper |
| Short / long description | Draw clickable areas on images and link them to other files. |
| Application icons | `assets/icons/icon-256.png`, `-128`, `-64`, `-32`, `-16` |
| Open URL | `APP_URL` (Drive appends `?state=...`) |
| Default MIME types | `application/vnd.drive-image-map+json` |
| Default file extensions | `imap` |
| Secondary MIME types | `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/bmp`, `image/svg+xml` |
| Creating files | Enabled. New URL: `APP_URL` |
| Document icons | Same set of icons |

Default types make Image Mapper the app that opens `.imap` files on double-click. Secondary types list it under **Open with** for images without taking over the normal image preview.

Check **Shared drives support** if you use shared drives. Save.

Once you've signed in to the app with this project's client ID, Drive should start listing Image Mapper under **Open with** on images (reload Drive after signing in). That's enough for personal use and for anyone you add as a test user.

### 6. "Connect more apps" (Google Workspace Marketplace)

"Connect more apps" in Drive is a filtered view of the Google Workspace Marketplace, so the app has to be listed there.

1. Open **Google Workspace Marketplace SDK → App Configuration**.
   - App visibility: **Public** (consumer `@gmail.com` accounts can't choose Private; Private listings are only for one Workspace organisation).
   - Installation settings: **Individual + Admin install**.
   - App integrations: check **Drive app** (it picks up the Drive UI integration from step 5).
   - OAuth scopes: `https://www.googleapis.com/auth/drive.file` and `https://www.googleapis.com/auth/drive.install`.
   - Developer name, website and email.
2. Fill in **Store Listing**: description, category (Productivity works), the icons (32, 48, 96 and 128 px are in `assets/icons/`), at least one screenshot, and the privacy policy and terms URLs.
3. Publish. Public listings go through Google's review, which usually takes a few days to a few weeks. Before you submit, move the OAuth consent screen from Testing to **In production** and complete brand verification.

Google's review requires that the home page and privacy policy live on a domain you've verified in [Search Console](https://search.google.com/search-console). A `*.github.io` address can't be verified as yours, so for a public listing use a custom domain (GitHub Pages supports one under **Settings → Pages → Custom domain**) and set `APP_URL` to it throughout.

If you're on Google Workspace, a **Private** listing skips the public review and appears under "Connect more apps" for everyone in your organisation.

## Project layout

```
index.html        App shell
css/app.css       Styles (light and dark)
js/config.js      Your Google Cloud IDs
js/drive.js       Sign-in, Drive REST calls, Google Picker
js/editor.js      SVG drawing and editing of areas
js/app.js         Opening, saving, linking and the rest of the UI
privacy.html      Privacy policy (required by Google)
terms.html        Terms of service (required by Google)
assets/icons/     PNG icons for Drive and the Marketplace
```

## Map file format

```json
{
  "format": "drive-image-map",
  "version": 1,
  "imageId": "1AbC...",
  "imageName": "Floor plan.png",
  "width": 960,
  "height": 600,
  "updatedAt": "2026-10-29T12:00:00.000Z",
  "regions": [
    { "id": "r1", "shape": "rect", "coords": [46, 46, 371, 251], "title": "Reception",
      "link": { "url": "https://docs.google.com/document/d/.../edit", "name": "Reception notes", "fileId": "...", "mimeType": "application/vnd.google-apps.document" } },
    { "id": "r2", "shape": "circle", "coords": [670, 430, 110], "title": "Meeting room", "link": null },
    { "id": "r3", "shape": "poly", "coords": [[46, 303], [417, 303], [417, 554], [180, 554]], "title": "Archive", "link": null }
  ]
}
```

Rectangles are `[x, y, width, height]`, circles `[centreX, centreY, radius]`, and polygons a list of `[x, y]` points, all in the image's natural pixels.
