# Encrypted-at-rest folders (design)

Status: **approved 2026-11-13; implemented in #19, #20, #21 (see DEV-390 for remaining tickets)** (names encrypted locally; password only, no PIN; auto-lock 5 min + on background; CM6 editor + reading view; transit mode kept). Builds on
[per-folder encryption](per-folder-encryption.md) (DEV-378).

## Goal

For a chosen folder, note content and names are **never written to disk
unencrypted**, on any device. Plaintext exists only in memory, while the
folder is unlocked in our own viewer. If someone picks up the unlocked
phone or Mac, they see a locked folder until they type the password.

This is "option A" (Meld Encrypt style), chosen over patching Obsidian's file
adapter.

## What changes compared to today's encrypted folders

Today's encrypted folders encrypt in transit only. Plaintext `.md` files sit
in the vault, and the sync engine encrypts them on upload and decrypts them on
download.

An **at-rest** folder keeps the server's format on the local disk too:

| | Transit (today) | At rest (new) |
| --- | --- | --- |
| Local files | plaintext `.md` | ciphertext, encrypted names |
| Server files | ciphertext, encrypted names | **the same bytes and names as local** |
| Sync engine | encrypts and decrypts, maps names | copies opaque files; **no keys needed** |
| Opened in | Obsidian's editor | our viewer |
| Password on device | stored in keychain | **never stored**; typed to unlock |
| Search, backlinks, graph, Dataview | yes | no (only our own search) |

Both modes stay available per folder. The key file records the mode.

## Design

### On-disk layout (local and server identical)

```
Journal/                          ← folder name stays plaintext
  .cds-folder-key.json            ← same key file as today, plus "mode": "at-rest"
  ab3k…q7xm.cdse                  ← a note: encrypted name + ".cdse"
  c5tt…e2ra/                      ← a subfolder: encrypted name
    zz9k…mm1a.cdse
```

- Names use the existing SIV-style scheme (deterministic, base32). The
  `.cdse` extension routes the file to our viewer. Names are capped at 141
  bytes, same as today.
- Content uses the existing `CDSE` format (AES-256-GCM, path-bound AAD).
  Because the layout is the same on both sides, the bytes on disk are exactly
  the bytes on the server.
- Attachments (images and PDFs) in the folder are stored the same way, and the
  viewer decrypts them into in-memory `blob:` URLs.

### Sync

The engine treats an at-rest folder as **ordinary opaque files**: no lock
check, no name mapping, no encrypt or decrypt. Consequences:

- **A device with no password still syncs the folder** (it's all
  ciphertext). It just can't open anything. That's safer than the transit
  mode, which locks the folder: every device keeps a full encrypted copy.
- An older plugin version syncs it correctly too, with nothing to break.
- Change detection is plain: an edit is a save, which writes new ciphertext.
  Spurious re-saves can't happen, because only our viewer writes these files.
- **Conflicts:** the files are binary, so they can't be line-merged by the
  engine. The conflict dialog offers Local or Remote. Our viewer adds
  **"Merge"** when the folder is unlocked: it decrypts both sides and runs the
  existing 2-way merge in memory.

### The private notes panel

Obsidian's file explorer shows `.cdse` files by their encrypted names, which
is useless. So:

- The at-rest folder is **hidden from the file explorer** (CSS on its path).
- A side-panel view, **Private notes**, shows the decrypted tree while
  unlocked. It supports new note, new folder, rename, move, delete, and open.
  While locked it shows a single "Unlock" button.
- A rename or move re-encrypts the file, because names and content AAD are
  bound to the path. Our panel writes the new file, then deletes the old one.

### The note view

A `FileView` registered for `.cdse`:

- **Edit mode:** a CodeMirror 6 markdown editor (Obsidian ships CM6). It has
  plain markdown syntax highlighting, **not** Live Preview.
- **Reading mode:** `MarkdownRenderer.render`, which gives callouts, tables,
  code blocks and checkboxes. `[[wiki links]]` resolve against other private
  notes by title, and images resolve to decrypted `blob:` URLs.
- **Autosave:** about 2 s after typing stops, the view encrypts the note and
  writes it with `vault.modifyBinary`. Plaintext is never written.
- **No plaintext in workspace state:** `getState()` holds only the file path,
  which is already encrypted.

### Lock and unlock

- **Unlock:** type the folder password, which is checked against the key file
  (cached in plugin data; it holds nothing secret). Keys live in memory only.
- **Auto-lock** after N minutes without interaction (default 5), when Obsidian
  goes to the background (mobile `visibilitychange`), or with the **Lock now**
  command or ribbon action.
- **Locking** closes our views, drops the keys, clears the panel, and revokes
  `blob:` URLs. Unsaved edits are saved before the keys drop.
- **The password is never stored** for at-rest folders. If it were in the
  keychain, anyone with the unlocked device could open the folder, which
  defeats the purpose. A convenience PIN is an open question below.

### Plaintext leak audit

| Place | Status |
| --- | --- |
| Vault files | ciphertext only |
| Obsidian metadata cache (IndexedDB) | `.cdse` isn't markdown → not indexed |
| File Recovery snapshots | `.md` only → not captured |
| `workspace.json` (open tabs, recent files) | encrypted paths only |
| Search, graph, backlinks | `.cdse` is not indexed |
| Our panel and views | DOM, in memory, cleared on lock |
| Clipboard | outside our control (user action) |
| OS swap / crash dumps | out of scope; FileVault / iOS Data Protection cover the disk |

### Setting up and converting

- **New at-rest folder:** choose a folder name and a password. This creates
  the key file with `mode: "at-rest"`.
- **Convert an existing folder** (plaintext or transit-encrypted) to at rest:
  1. Mark the key file with a rotation marker.
  2. For each note, write the `.cdse` file, then delete the old file. This
     happens locally, and the normal sync carries it to the server.
  3. Clear the marker.

  Resumable, like the existing operations.
- **Change password:** re-encrypts every file locally (new names, new content)
  under a rotation marker; sync carries it. Other devices' open views lock
  when the key file's keyId changes.
- **Convert back to plaintext:** the reverse, behind a warning.

### Implementation notes

- The editor is CodeMirror 6 with undo history and line wrapping, but **no
  markdown syntax highlighting**. Obsidian doesn't expose its markdown
  language to plugins, and bundling a second copy risks CodeMirror version
  clashes.
- Links, tags and embeds in the reading view are intercepted in the capture
  phase. Otherwise Obsidian would offer to create a new plaintext note for an
  unresolved `[[link]]`.
- The engine refuses to upload any non-`.cdse` file in an at-rest folder.
  `AtRestSession.list()` reports such files, and the panel offers to encrypt
  them.
- At-rest folders are discovered from key files seen during sync and cached
  in `data.json`. Creating one requires a folder that's empty on the server.

## Interactions and risks

- **The editor is weaker than Obsidian's.** No Live Preview, no plugins inside
  it, and no links into the folder from normal notes. That's the price of
  plaintext never touching disk.
- **Typing a long passphrase on the phone** at every unlock is painful.
  1Password autofill works in Obsidian's password field on iOS. A PIN is
  possible (open question 2).
- **Large attachments** are decrypted fully into memory. The existing 80 MB
  cap applies.
- **Losing the password** loses the notes, on every device. Same as today:
  keep it in 1Password.

## Open questions for Scott

1. **Should names stay encrypted locally?** Recommended: yes. Titles are
   sensitive, and the panel shows them only while unlocked. The alternative is
   plaintext titles plus `.cdse`, which is simpler and keeps Obsidian's
   explorer, but leaks titles at rest.
2. **Password only, or an optional per-device PIN?** A PIN would unlock a key
   stored in the keychain. It's fast on the phone, but weaker: anyone who can
   read the keychain (desktop devtools) can skip it. Recommended: password
   only in v1, and add the PIN later if typing is painful.
3. **Auto-lock default:** 5 minutes, plus lock on background?
4. **Is the editor acceptable?** CM6 markdown editing plus a reading view, no
   Live Preview.
5. **Keep the transit mode?** Recommended: yes. It's for folders you still
   want searchable in Obsidian.

## Tickets (proposed)

1. Core: an `at-rest` mode in the key file, engine passthrough, and helpers
   for `.cdse` names and paths.
2. Plugin: lock and unlock, auto-lock, key-file cache.
3. Plugin: the Private notes panel (tree, create, rename, move, delete) and
   hiding the folder from the explorer.
4. Plugin: the note view (CM6 editor, reading view, autosave, links, images).
5. Plugin: the decrypt-and-merge conflict action.
6. Conversion (plaintext or transit → at rest, and back) and password change.
7. Docs and a device-checklist section.

Rough size: 4–6 days.
