# Cloud Drive Sync for Obsidian

A personal-use Obsidian plugin that provides two-way sync between your vault and Google Drive or an S3 bucket. Works on desktop (macOS, Windows, Linux), Android, and iOS/iPadOS.

> **Note:** This plugin was built for personal use. It is not published to the Obsidian community plugin directory. There is no warranty — use at your own risk. See [LICENSE](LICENSE).

## Features

- **Two-way sync** between your Obsidian vault and a Google Drive folder the plugin creates under `Cloud Drive Sync/` in My Drive
- **Cross-platform** — works on desktop, Android, and iOS/iPadOS
- **Automatic sync** — syncs on file change (5s debounce), on a configurable interval, and/or on startup
- **Manual sync** — ribbon icon and command palette action
- **Conflict resolution** — when a file is modified both locally and on Drive, a modal shows all conflicts with per-file Local/Remote/Skip choices and bulk actions
- **External merge tool support** (desktop only) — configure a command like `bcomp {local} {remote}` for Beyond Compare or any diff tool
- **Error reporting** — failed files shown in a modal with retry option
- **First sync wizard** — choose Download from Drive, Upload to Drive, or Merge on first sync
- **Self-updating** — place new builds in a `.cloud-drive-sync` folder on Drive; the plugin checks for updates on startup and auto-reloads
- **Dotfile exclusion** — `.obsidian`, `.trash`, and all other dotfiles/dotfolders are automatically excluded from sync
- **Custom exclude patterns** — glob patterns to skip additional files (e.g. `archive/**`, `*.tmp`)
- **Provider abstraction** — designed to support additional providers (Proton Drive planned)

## Prerequisites

- A Google account
- A Google Cloud project (free tier is sufficient)

## Setup

### 1. Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (e.g. "Obsidian Cloud Drive Sync")
3. Enable the **Google Drive API**:
   - Go to **APIs & Services** > **Library**
   - Search for "Google Drive API"
   - Click **Enable**

### 2. Configure OAuth Consent Screen

1. Go to **APIs & Services** > **OAuth consent screen** (or **Auth** > **Branding** in the new UI)
2. Set User Type to **External**
3. Fill in the required fields (app name, user support email)
4. Under **Scopes** (or **Data Access** in new UI), add: `https://www.googleapis.com/auth/drive.file`
5. Under **Audience** (or **Test users**), add your Google email address
6. Under **Audience**, click **Publish app** to move it to "In production". `drive.file` is not a sensitive or restricted scope, so this needs no Google review. Left in "Testing", Google expires the sign-in every 7 days

### 3. Create OAuth Credentials

1. Go to **APIs & Services** > **Credentials**
2. Click **Create Credentials** > **OAuth client ID**
3. Application type: **Web application**
4. Add an **Authorized redirect URI**: `https://cloud-drive-sync.pages.dev/`
5. Click **Create**
6. Note the **Client ID** and **Client Secret**

### 4. Build the Plugin

```bash
git clone https://github.com/sm-merlot/cloud-drive-sync.git
cd cloud-drive-sync
npm install
npm run build:obsidian
```

This produces `main.js` in `packages/obsidian-plugin/` and copies all plugin files (`main.js`, `manifest.json`, `styles.css`) to `packages/obsidian-plugin/dist/` for easy deployment.

### 5. Install the Plugin

The plugin must be manually installed into each vault's `.obsidian/plugins/cloud-drive-sync/` folder.

#### Desktop (macOS/Windows/Linux)

```bash
# Create the plugin folder
mkdir -p /path/to/your/vault/.obsidian/plugins/cloud-drive-sync

# Copy the plugin files from packages/obsidian-plugin/dist/
cp packages/obsidian-plugin/dist/* /path/to/your/vault/.obsidian/plugins/cloud-drive-sync/
```

For development, symlink instead of copying:

```bash
ln -s /path/to/cloud-drive-sync/packages/obsidian-plugin/main.js /path/to/vault/.obsidian/plugins/cloud-drive-sync/main.js
ln -s /path/to/cloud-drive-sync/packages/obsidian-plugin/manifest.json /path/to/vault/.obsidian/plugins/cloud-drive-sync/manifest.json
ln -s /path/to/cloud-drive-sync/packages/obsidian-plugin/styles.css /path/to/vault/.obsidian/plugins/cloud-drive-sync/styles.css
```

Then run `npm run dev --workspace=packages/obsidian-plugin` for auto-rebuild on changes.

#### Android

1. Connect your device via USB or use a file manager app
2. Navigate to your vault folder (usually in `Internal Storage/`)
3. Create `.obsidian/plugins/cloud-drive-sync/` if it doesn't exist
4. Copy `main.js`, `manifest.json`, and `styles.css` into that folder
5. Restart Obsidian

#### iOS / iPadOS

The `.obsidian` folder is hidden by default. You'll need a third-party file manager app (e.g. Santander) to access it:

1. Locate your Obsidian vault in the file manager
2. Navigate into `.obsidian/plugins/`
3. Create a `cloud-drive-sync` folder
4. Copy `main.js` and `manifest.json` into it
5. Restart Obsidian

> After the initial install, the plugin can self-update from Google Drive — see [Self-Updating](#self-updating) below.

### 6. Configure the Plugin

1. Open Obsidian > **Settings** > **Community Plugins** > enable **Cloud Drive Sync**
2. Go to the **Cloud Drive Sync** settings tab
3. Enter your **Client ID** and **Client Secret**
4. Click **Open Google Auth** — this opens your browser
5. Sign in and authorize the app
6. Copy the authorization code from the redirect page
7. Paste the code into the **Auth code** field and click **Submit**
8. Click **Choose** next to Sync folder and create a folder for this vault, or select one another device already created. The plugin only sees files it created itself (`drive.file`), so files added to the folder through the Drive website or the Drive desktop app are not synced
9. Configure sync interval, startup sync, and exclude patterns as desired

## Self-Updating

To update the plugin on all devices without manual file copying:

1. Build the plugin on your desktop: `npm run build:obsidian`
2. In Google Drive, create a folder called `.cloud-drive-sync` inside your sync root folder
3. Upload the contents of `packages/obsidian-plugin/dist/` to that folder
4. On each device, the plugin checks this folder after every manual sync and on startup, auto-updating and reloading if files have changed

The `.cloud-drive-sync` folder is excluded from vault sync (dotfolder), so it only contains plugin build artifacts and won't appear in your vault.

### What gets updated

The auto-updater compares MD5 hashes of the following files between your installed plugin and the Drive folder:

| File | Purpose |
|------|---------|
| `main.js` | Plugin code |
| `manifest.json` | Plugin metadata/version |
| `styles.css` | Plugin styles |

If any file differs, all three are downloaded and the plugin reloads automatically.

### When updates are checked

- **On startup** — if "Sync on startup" is enabled
- **After manual sync** — clicking the status bar icon, ribbon icon, or using the command palette
- **On demand** — via command palette: **Cloud Drive Sync: Check for plugin update**

Auto-sync (interval and file watcher) does **not** check for updates to avoid unnecessary API calls.

## Usage

- **Ribbon icon** (cloud icon) — triggers a full sync
- **Command palette** — "Cloud Drive Sync: Sync now" or "Cloud Drive Sync: Check for plugin update"
- **Automatic** — file changes are synced after 5 seconds of idle time; periodic full sync runs on the configured interval

### First Sync

On the first sync, a modal will ask you to choose a strategy:

- **Download from Drive** — treats Drive as the source of truth
- **Upload to Drive** — treats the local vault as the source of truth
- **Merge** — keeps both sides, prompts on conflicts

### Conflict Resolution

When a file is modified both locally and on Drive between syncs, a results modal appears showing all conflicts. For each file you can choose:

- **Local** — upload your local version to Drive
- **Remote** — download the Drive version
- **Merge** (desktop only) — opens an external merge tool
- **Skip** — leave the conflict unresolved for now

Bulk actions ("All Local", "All Remote") are available at the top.

## OAuth Redirect Page

The OAuth redirect page lives at `docs/index.html` and is hosted on **Cloudflare Pages** at `https://cloud-drive-sync.pages.dev/`.

It receives the `?code=` parameter from Google after the user authorises the app, displays it, and auto-copies it to the clipboard so the user can paste it back into Obsidian.

### Updating the redirect page

1. Edit `docs/index.html`
2. Go to [Cloudflare Pages](https://dash.cloudflare.com/) → **Workers & Pages** → **cloud-drive-sync**
3. **Deployments** → **Upload assets** (or push to the connected Git branch if using Git deploy)
4. Upload the updated `docs/index.html`

### Changing the redirect URI

If the Cloudflare Pages URL ever changes:

1. Update `REDIRECT_URI` in `packages/obsidian-plugin/src/providers/google-drive/google-drive-auth.ts`
2. Update the **Authorized redirect URI** in [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services** → **Credentials** → your OAuth client
3. Update this README

## Development

```bash
# Install dependencies (all workspaces)
npm install

# Build the Obsidian plugin for production
npm run build:obsidian

# Watch mode (auto-rebuild)
npm run dev --workspace=packages/obsidian-plugin

# Run all workspace tests
npm test

# Watch core package tests
npm run test:watch --workspace=packages/core
```

### Project Structure

This is an npm-workspaces monorepo. `packages/core` holds the framework-agnostic
sync logic (providers, sync engines, state store, utils) shared by every
consumer; `packages/obsidian-plugin` is the Obsidian plugin shell.

```
packages/
  core/                             # @cloud-drive-sync/core — no Obsidian dependency
    src/
      types.ts                      # Shared types and interfaces
      index.ts                      # Public barrel export
      providers/
        cloud-provider.ts           # Abstract provider interface
        s3/
          s3-api.ts                 # S3 REST client (SigV4 via Web Crypto)
          s3-provider.ts            # CloudProvider implementation
      sync/
        sync-state.ts               # Per-file tracking database
        mirror-sync-engine.ts       # Existence-only bidirectional mirror (no content-conflict handling — for write-once files)
      http/
        http-client.ts              # HttpClient port — host shell supplies the transport (CORS bypass)
      fs/
        local-file-system.ts        # LocalFileSystem port — host shell supplies real filesystem access
      util/
        hash.ts                     # MD5 implementation
        path.ts                     # Path helpers, glob matching
        merge.ts                    # 2-way line merge (used by the Obsidian plugin's full SyncEngine)
    tests/

  obsidian-plugin/                   # Obsidian plugin shell
    manifest.json / versions.json / styles.css / esbuild.config.mjs
    src/
      main.ts                       # Plugin entry point
      settings.ts                   # Settings tab UI
      http/
        obsidian-http-client.ts     # HttpClient impl: Node https (desktop) / requestUrl (mobile)
      providers/google-drive/       # Google Drive provider (Obsidian-only — requestUrl-based, not shared)
      sync/
        sync-engine.ts              # Full bidirectional sync engine w/ content-conflict handling
        sync-state.ts / *-modal.ts  # Conflict/first-sync/results modals (Obsidian Modal UI)

docs/
  index.html                        # Cloudflare Pages OAuth redirect (https://cloud-drive-sync.pages.dev/)
```

## License

MIT — see [LICENSE](LICENSE).
