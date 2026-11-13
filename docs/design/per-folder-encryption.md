# Per-folder encryption (design)

Status: **approved 2026-11-13.** Filename encryption on; `minAppVersion` 1.11.4, secretStorage only.

## Goal

For folders the user chooses, the remote store (the S3 bucket and everything
that reads it: copyparty, server-side scripts, Claude sessions, D'habitude,
offline backups) only ever holds ciphertext. Plaintext exists only on devices
running the Obsidian plugin with the right password.

Accepted limits: plaintext sits on each unlocked device's disk; server-side
search, D'habitude and anything else server-side cannot read these folders.

## User-facing behaviour

- Settings → **Encrypted folders** → *Add*: pick a vault folder, enter a
  password twice. The plugin creates the folder's key file, encrypts and uploads
  every file in it, and removes the old plaintext copies from the remote.
- On another device: *Add* the same folder and enter the password. The plugin
  checks it against the remote key file before syncing anything in the folder.
- A device without the password, or with a wrong or old password, treats the
  folder as **locked**: no upload, no download, no delete, no folder create or
  delete. It shows the notice `Wrong password for <folder>` (or
  `No password for <folder>` / `Key file missing for <folder>`). Local files
  and sync records are left untouched, so unlocking later resumes cleanly.
- *Change password*: re-encrypts the whole folder and gives it a new key id.
  Every other device locks until it gets the new password.
- *Remove encryption*: decrypts and re-uploads as plaintext, then deletes the
  key file. Explicit, confirmed action only. Nothing ever does this
  implicitly.

The settings page tells the user to keep the password in 1Password. **Losing
the password loses the notes on the server.** There is no recovery key.

## Crypto

### Primitives

All WebCrypto (`crypto.subtle`). It is native on desktop Electron and on
Obsidian mobile (iOS WKWebView, Android WebView); no dependencies.

- Content: **AES-256-GCM**, random 96-bit nonce per file, per upload.
- Names: deterministic **AES-SIV-style** construction (below).
- KDF: **PBKDF2-HMAC-SHA256, 600,000 iterations**, 16-byte random salt.
- Subkeys: **HKDF-SHA256** from the PBKDF2 output, with distinct `info`
  strings: `cds/content/v1`, `cds/name-mac/v1`, `cds/name-enc/v1`,
  `cds/check/v1`. Imported as non-extractable `CryptoKey`s.

### KDF choice: PBKDF2, not Argon2id

- PBKDF2 is in WebCrypto on every Obsidian platform. Argon2id needs a WASM
  bundle (~30–60 KB) plus a JS loader, a new dependency to vet and keep
  updated, and WASM memory pressure on iOS, where Obsidian is already tight.
- The attacker model is offline guessing against data taken from the server.
  A 1Password-generated passphrase (5+ random words, or 20+ random chars) is
  out of reach at any KDF cost; the KDF only matters for weak passwords, and the
  fix for those is the passphrase, not the KDF.
- 600k iterations matches current OWASP guidance. It costs roughly 0.3–1 s on a
  phone, paid once per app launch (keys are cached in memory as
  non-extractable `CryptoKey`s, never written to disk).
- The key file records the KDF name and parameters, so a later version can
  move to Argon2id, or raise iterations, as part of a password change.

### Key file

One per encrypted folder, at `<folder>/.cds-folder-key.json` on the remote.
It holds nothing secret.

```json
{
  "format": "cds-folder-key",
  "version": 1,
  "keyId": "<16 random bytes, base32>",
  "kdf": { "name": "PBKDF2-SHA256", "iterations": 600000, "salt": "<base64>" },
  "check": { "nonce": "<base64>", "ciphertext": "<base64>" },
  "rotation": null
}
```

- `check` is AES-GCM under the `check` subkey of the plaintext
  `"cds-check-v1:" + keyId`, with AAD `"cds-folder-key"`. The folder path is
  deliberately not bound in, so a renamed folder reports "key file missing", not
  "wrong password". Verifying a password
  means deriving the keys and decrypting `check`. A GCM tag failure means
  **wrong password**, and the folder locks.
- `rotation` is non-null only while a password change is in progress (below).
- The salt lives here, not in each file: a per-file salt would need a PBKDF2
  run per file.

### File format (content)

```
offset  size  field
0       4     magic "CDSE"
4       1     format version (1)
5       16    keyId (raw bytes)
21      12    nonce
33      n+16  AES-256-GCM ciphertext + tag
```

AAD = the 33 header bytes + UTF-8 plaintext vault path. Binding the path stops
the server (or anyone with write access) from swapping two encrypted files
without detection.

Overhead: 49 bytes per file.

### Filenames: encrypt them

**Recommendation: yes, encrypt every path segment below the encrypted folder.**
Titles like `2026-03-04 talk with doctor.md` are often as sensitive as the
body.

The encrypted folder's own name stays plaintext (for example `Journal/`),
because devices find the folder by name.

Construction, per segment (file or subfolder name):

1. `iv = HMAC-SHA256(k_name_mac, parentPlainPath + "/" + name)[0..16]`
2. `ct = AES-256-CTR(k_name_enc, iv, utf8(name))`
3. remote segment = `base32lower(keyTag(2 bytes) ‖ iv ‖ ct)` with no padding

This is the SIV pattern built from WebCrypto primitives. It is deterministic,
so every device maps the same plaintext path to the same remote key, and no
index file is needed. It is authenticated: on decrypt, recompute the HMAC and
compare it to `iv`. Including the parent path in the MAC means identical names
in different subfolders don't produce identical ciphertext.

Why base32 lowercase (`a-z2-7`): it is safe on case-insensitive backends, and
it contains no characters that need the RFC 3986 SigV4 key encoding (fix
`ff7f1c9`). That code path still runs, but it has nothing to escape.

Why not random names plus an encrypted index file: every device would edit one
shared index, and every edit to it would be a sync conflict. Deterministic names
avoid that.

**What filename encryption costs:**

- **Name length.** ZFS and most filesystems cap a segment at 255 bytes. The
  overhead is 18 bytes, then ×1.6 for base32. That allows about **140 bytes of
  UTF-8 per name**, roughly 140 ASCII or ~45 CJK/emoji characters. A longer
  name surfaces as a sync issue for that file ("name too long for an encrypted
  folder"), not a silent skip. The S3 key cap (1024 bytes) limits nesting
  depth in the same way.
- **Server-side browsing is useless** for these folders: copyparty shows
  `Journal/ab3k…`. This is already accepted.
- **Recovery without Obsidian** needs a tool. Ticket: a small Node CLI
  (`cds-decrypt <dir> --password`) using the same core code. It is cheap and
  removes "only the plugin can read my notes" as a single point of failure.
- **A rename re-uploads the file.** That is already how S3 sync handles a
  rename (delete + upload), so nothing new.
- **Still visible to the server:** file count, sizes (±49 bytes), mtimes, tree
  shape and depth, and when files change. Size padding is out of scope for v1.

## Sync engine changes (core)

All of this lives in `packages/core`, behind a `FolderCrypto` module, so the
Tauri app can adopt it later. Only the Obsidian plugin exposes it in v1.

### 1. Lock check before planning (both `sync()` and `syncPaths()`)

After the remote listing, and before any classification:

1. Find every remote key file (`*/.cds-folder-key.json`). The provider listing
   already returns dotfiles; the engine filters dot-paths only later, in
   `shouldSkip`. The key file is read explicitly through the provider.
2. Build the set of encrypted folders = folders that have a remote key file ∪
   folders the local config says are encrypted.
3. For each one, decide **unlocked** or **locked**:
   - no local password → locked (`No password for <folder>`)
   - password fails the `check` decrypt, or the local cached keyId ≠ the remote
     keyId and the stored password fails → locked (`Wrong password for <folder>`)
   - local config says encrypted, but there is no remote key file → locked
     (`Key file missing for <folder>`). Never re-create the key implicitly and
     never upload plaintext.
   - key file `rotation` is set and this device is not the one rotating →
     locked (`Password change in progress for <folder>`)
   - any remote object under the folder whose name fails to decrypt or
     authenticate → locked (`Unreadable file <remote key> in <folder>`). Fail
     closed: an undecryptable name would otherwise drop out of `remoteMap` and
     look like a remote delete.
4. Every path in a locked folder (the folder itself and everything under it) is
   removed from `localMap`, `remoteMap`, `localFolderPaths`, `remoteFolderMap`,
   **and** from the tracked-path iteration in `computeActions` and
   `computeFolderActions`. Records are not removed or modified. This is the
   guarantee that a locked folder is never treated as deleted.

Notices go through `onNotice` once per sync per folder. `SyncResult` gets a
`lockedFolders: {path, reason}[]` field so the UI (status bar, results modal)
can show them.

`syncPaths()` must run the same check. The file-watcher path is easy to miss,
and an edit in a locked folder must not upload.

### 2. Name mapping

For unlocked folders, the listing is translated: remote `Journal/ab3k…/q7xm…`
becomes `Journal/Health/2026-03-04.md` before it enters `remoteMap` or
`remoteFolderMap`. `RemoteFileInfo.id` keeps the real remote key. Uploads,
folder creates and `getRemoteFolderId` map plaintext → ciphertext names.

### 3. Change detection: plaintext hashes

Ciphertext differs on every upload (random nonce), so the remote ETag and size
say nothing about plaintext. `SyncFileRecord` gets a new optional field:

- `contentHash`: keeps meaning **MD5 of the local plaintext**. That is what
  `healStaleLocalModTimes` and `localChanged` already compare against, so the
  local side works unchanged.
- `remoteHash?`: **MD5 of the ciphertext** as uploaded or downloaded, i.e. the
  ETag the listing returns. Absent for plaintext files.

`remoteChanged()` compares `remote.md5Checksum` against
`record.remoteHash ?? record.contentHash`. Without this, every encrypted file
reads as "remote changed" on every sync (`ETag ≠ plaintext hash`) and the
engine loops on `update-local`.

The other spots that equate an ETag with a plaintext hash need encrypted-aware
branches:

- `verifyOrMergeConflict`: the `localHash === remote.md5Checksum` shortcut can
  never match. For encrypted files, download, decrypt, then compare plaintext
  MD5s.
- `downloadVerified` (iOS stale-cache guard, DEV-208): unchanged. It checks the
  **ciphertext** MD5 against the listing ETag, then decrypts.
- After an upload, `remoteHash = MD5(ciphertext)`, computed locally (a
  single-PUT ETag is the body MD5).

### 4. No-op guards (cross-device ping-pong)

With plaintext, a spurious re-upload of identical bytes is harmless: the ETag
doesn't change, so other devices do nothing. With encryption, every re-upload
produces a new ETag, every other device downloads and rewrites the file, and
that bumps their local mtime. If any device then re-uploads it on a stale
mtime, the cycle repeats across devices forever. Two guards:

- **Before `update-remote` / `upload` of an encrypted file:** hash the
  plaintext. If it equals `record.contentHash`, skip the upload and only heal
  the record's mtime and size. This applies at any size: the 50 MB
  `HASH_VERIFY_THRESHOLD_BYTES` bypass in `healStaleLocalModTimes` must not
  apply to encrypted files, since the read is needed for encryption anyway.
- **Before `update-local` of an encrypted file:** after decrypting, if the
  plaintext MD5 equals `record.contentHash`, don't write the file (no mtime
  bump); just update `remoteHash` and `remoteModTime`.

These also cover the **mobile stat race** (DEV-33: Obsidian's cached
`TFile.stat` refreshing after the record is stamped). Today, healing handles it
by hashing. Encryption makes a missed heal far more expensive (a cross-device
loop instead of one redundant PUT), so the first guard is the backstop.

### 5. Size cap

v1 limits encrypted files to below `MULTIPART_THRESHOLD_BYTES` (80 MB). Larger
files surface as a sync issue. Reasons: WebCrypto AES-GCM is one-shot (whole
buffer in memory, twice), which is risky on iOS, and multipart ETags aren't
MD5s, so `remoteHash` would be unknown. Notes folders don't need more. A
chunked format (v2 header) can lift the cap later.

### 6. Decrypt failures on individual files

- Header keyId ≠ the folder's current keyId: a mid-rotation leftover. Skip the
  file this sync (no write, no delete, no record change).
- GCM tag failure with a matching keyId: tampered or corrupt. Surface it as an
  error issue and never write it locally.

### 7. Implementation notes (DEV-380/381)

- Key-file detection is **always on**, even when the host passes no
  encryption settings (the Tauri app today). A folder with a key file and no
  password is locked, so ciphertext is never synced as ordinary files.
- External merge tools read and upload raw remote bytes, so they are refused
  in encrypted folders. The "external" resolution falls back to the built-in
  merge (conflict markers) with a notice.
- `remoteHash` matters most when the server clock runs ahead of the device
  clock. Then `remote.modifiedTime > record.remoteModTime` is always true and
  only the ciphertext-hash comparison prevents a download on every pass.
- `syncPaths()` now runs the stale-mtime heal as well (it was `sync()`-only),
  because the file-watcher path also hits the mobile stat race.
- Key-file unlocks are cached by (folder, key-file ETag, password), so
  PBKDF2 runs once per launch, not once per sync.

### 8. Implementation notes (DEV-382)

- The `rotation` marker carries what a restart needs to resume: `fromKeyId`,
  plus `previous` (the replaced key file, so the old salt survives) for a
  password change, or `toPlaintext: true` for a removal. None of it is secret.
- Each operation validates up front (unreadable objects, names over 141
  bytes, multipart-sized objects) and writes nothing if validation fails.
- Calling an operation again with the same password(s) resumes it. The engine
  exposes `enableEncryption`, `changeEncryptionPassword` and
  `removeEncryption`, which refuse to run during a sync. The host (DEV-383)
  remembers a pending operation and re-runs it on launch.
- The operating device updates its own sync records as it moves each file, so
  its next sync is quiet.
- Dot-path objects inside an encrypted folder (for example `.DS_Store` from a
  server-side tool) are ignored. They are never synced, and an encrypted name
  never starts with ".", so they can't cause a lock.
- `sync()` now lists the remote **before** the local side. The local filter
  depends on the lock state, which the remote listing decides; listing local
  first used the previous pass's state and made a just-unlocked folder look
  locally deleted (a bug in #13, fixed here).

### 9. Implementation notes (DEV-383, Obsidian plugin)

- Settings → **Encrypted folders** offers Add (encrypt, or join a folder another
  device already encrypted, chosen by probing the remote key file), Enter
  password, Change password and Remove encryption. A folder with an
  unfinished operation shows Resume.
- Passwords live in `app.secretStorage` under `cds-folder-<md5(path)>`, with
  `-old` holding the previous password only while a change runs. `data.json`
  holds just the folder list and any pending operation.
- The plugin builds a new engine per sync, so it shares one `UnlockCache`
  across engines; otherwise PBKDF2 would run on every sync and every edit.
- Lock reasons go through `engine.onLocked`, and each one is shown once per
  session. The status bar shows "· N locked", with the reasons in its tooltip.
- `minAppVersion` is now 1.11.4.

## Password change (key rotation)

Done on one device, resumable, atomic per file:

1. Derive new keys (new salt, new keyId). Write the key file with the **new**
   keyId/salt/check and `rotation: { fromKeyId }`. From this moment every other
   device locks: old-password devices fail `check`, and new-password devices see
   `rotation` set.
2. Keep the old password in plugin state until rotation finishes.
3. For each file: download, decrypt with the old key, re-encrypt with the new
   key, upload under the **new** encrypted name, and only then delete the
   old-named object. A crash at any point leaves every file readable in at least
   one generation.
4. When no old-tag objects remain, clear `rotation` in the key file and drop the
   old password.
5. On the next launch, a device with `rotation` set and the old password still
   in its own state resumes at step 3.

The 2-byte `keyTag` prefix on encrypted names is what lets step 3 tell old
objects from new ones without trying a decrypt.

## Enabling on an existing (plaintext) folder

1. Write the key file (`rotation: { fromKeyId: "plaintext" }`), which locks the
   folder on other devices that run the new version.
2. Per file: upload the encrypted copy, then delete the plaintext object.
3. Clear `rotation`.

**Caveats to tell the user plainly:**

- **Old plaintext persists in history.** ZFS snapshots of `/tank/documents`,
  offline backups, and anything copyparty or another tool cached all keep the
  old plaintext. Encryption protects new writes only. To scrub, destroy the
  snapshots and backups that predate the switch, or accept the exposure.
- **Update every device before enabling.** A device on an old plugin version
  doesn't know about key files. It sees the plaintext objects deleted remotely
  (and, if it hadn't edited them, deletes its local copies, which is
  recoverable from the enabling device and from the trash). It then downloads
  ciphertext files with gibberish names. Ship the feature, let every device
  update, then enable.

## Password storage

- Use Obsidian **`app.secretStorage`** (OS keychain-backed, since Obsidian
  1.11.4; typings are already in our `obsidian` 1.13.1). Secret id:
  `cds-folder-<hash of folder path>`.
- Decided: bump `minAppVersion` to 1.11.4, no `data.json` fallback.
- Derived keys are memory-only (non-extractable `CryptoKey`).

## Interactions to watch

| Existing behaviour | Interaction | Handling |
| --- | --- | --- |
| `isDotPath` skips any `.`-segment | Key file is a dotfile | Read explicitly via the provider, never synced as a vault file |
| S3 `.keep` folder placeholders | Encrypted subfolders need them too | `.keep` stays plaintext inside encrypted subfolder names (no content) |
| RFC 3986 key encoding (`ff7f1c9`) | Encrypted names are `a-z2-7` | Nothing to escape; add a round-trip test anyway |
| iOS stale GET cache (DEV-208) | Must verify before decrypt | ETag check on ciphertext, unchanged |
| Stale local mtime / stat race (DEV-33) | Re-upload → cross-device loop | No-op guards (§4) |
| `delete-local` when remote is missing | Locked/undecryptable folder looks empty | Lock filter + fail-closed name decrypt (§1) |
| `computeFolderActions` "tracked folder gone remotely → delete local" | Same risk for folders | Locked folders removed from folder planning too |
| Google Drive provider | Names map the same way; ids are opaque | Works, but v1 is tested on S3 only |

## Tests (core, vitest)

Fakes: the in-memory `LocalFileSystem` and `CloudProvider` already used by
`sync-engine.test.ts`.

**Locked: no password.** Device B has plaintext records for `Journal/` and no
password. A encrypts `Journal/`. B syncs: zero actions touching `Journal/**`,
local files byte-identical, records unchanged, notice `No password for Journal`.
Also via `syncPaths()` with an edited `Journal/x.md`: no upload.

**Locked: old password.** B has the old password. A changes it. B syncs: the
same assertions, notice `Wrong password for Journal`. B then enters the new
password, syncs, and converges with no deletes.

**Locked: key file missing.** The local config says encrypted and the remote
key file is gone: locked, nothing uploaded in plaintext.

**Locked: undecryptable object.** A junk object is dropped into `Journal/` on
the remote: locked, no `delete-local` for any tracked file.

**Rotation mid-flight.** Stop rotation after half the files. A third device
with the new password stays locked. The rotating device resumes and finishes,
then the third device converges.

**No re-upload loop.** Sync twice with no changes: zero uploads and zero
downloads on the second pass. Bump the mtime without changing bytes (stat race):
zero uploads. Two devices alternating syncs five times: zero transfers after
the first.

**Conflict detection.** Both devices edit the same file: a conflict is
reported (not a silent overwrite), and smart-merge works on decrypted text.

**Crypto units.** Round-trip, tamper (flip a byte → tag failure), path swap
(AAD mismatch), deterministic names across instances, name-length limit error,
base32 alphabet, wrong-password `check` failure.

## Out of scope (v1)

Tauri app UI, size padding, files ≥ 80 MB, sharing a folder with a different
password per person, a recovery key.
