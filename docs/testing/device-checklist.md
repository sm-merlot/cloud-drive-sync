# Device test checklist

A manual pass on real devices, against the **test bucket**, never the real
notes. Run it before releasing a plugin version that changes sync behaviour.
Use it for anything CI can't reproduce: iOS networking and caching (DEV-208),
Obsidian's cached file stats (DEV-33), the OS keychain, and the settings UI.

Devices: the **Mac** (desktop) and the **iPhone** (mobile). Add the iPad when a
change touches mobile paths.

Use a throwaway vault named `CDS Test` on each device, never your real vault.
Credentials for the test bucket are in 1Password (see DEV-388 for the item
name and endpoint).

Record each run (date, plugin version, pass/fail, notes) as a comment on the
release's Linear ticket.

## 0. Setup

- [ ] Build the plugin from the branch under test (`npm run build:obsidian`).
- [ ] Install it into `CDS Test` on each device: copy `main.js`, `manifest.json`
      and `styles.css` from `packages/obsidian-plugin/dist`.
- [ ] Confirm Settings → Cloud Drive Sync → Status shows the expected version.
- [ ] Provider: S3 / rclone, with the test bucket's endpoint and credentials.
      **Test connection** succeeds.
- [ ] Optional: empty the test bucket first, so earlier runs don't interfere.

## 1. Basic sync

- [ ] Mac: create `basics/hello.md` and `basics/with space (1).md`, then sync.
- [ ] iPhone: first sync with "Merge". Both files arrive with the right content.
- [ ] iPhone: edit `hello.md` and wait about 10 s (the auto-sync after an edit).
      The Mac gets the edit on its next sync.
- [ ] Mac: rename `with space (1).md` to `renamed.md`. The iPhone ends up with
      `renamed.md` only, with no duplicate and no resurrected old name.
- [ ] iPhone: delete `hello.md`. The Mac deletes it on its next sync.
- [ ] Mac: create an empty folder `basics/empty`. It appears on the iPhone.
- [ ] Sync both devices twice more with no changes. Each manual sync says
      "Everything up to date" (no phantom uploads or downloads).

## 2. Conflicts

- [ ] Both devices are synced. Turn the iPhone offline (airplane mode).
- [ ] Edit `basics/renamed.md` differently on both devices.
- [ ] Mac syncs, then the iPhone comes online and syncs. A conflict dialog
      appears on the iPhone. Choose Local. The Mac then gets the iPhone's
      version.

## 3. Mobile regressions

- [ ] **Stale cache (DEV-208).** Edit a note on the Mac and sync. On the iPhone,
      sync twice in quick succession. The iPhone shows the new content and
      doesn't revert it on a later sync.
- [ ] **Stat race (DEV-33).** On the iPhone, open a note without editing it,
      switch away, then sync three times. There are no uploads.

## 4. Encrypted folders

Use a disposable password for this run, not one you use elsewhere.

- [ ] Mac: create `Journal/2026-01-01 private.md` and `Journal/Sub/(x) note.md`,
      containing the text `CANARY-PLAINTEXT`. Sync both devices so the iPhone
      has the plaintext copies.
- [ ] Mac: Settings → Encrypted folders → **Add** → `Journal` → password. Check
      the confirm dialog's wording, then Encrypt. A "done" notice appears.
- [ ] **On the server**, check the test bucket's directory (the home session or
      Scott can run this):
  - [ ] Every name under `Journal/` is a base32 string, apart from
        `.cds-folder-key.json` and `.keep`.
  - [ ] `grep -r CANARY-PLAINTEXT` over the bucket finds nothing.
  - [ ] `grep -r "private\|(x)"` over the listing finds nothing.
- [ ] iPhone (no password yet): sync. A notice says `No password for Journal`
      and the status bar shows `· 1 locked`. The iPhone's existing plaintext
      `Journal` files are still there, unchanged.
- [ ] iPhone: Encrypted folders → **Add** → `Journal` → the same password. A
      notice says `Journal unlocked on this device`. The next sync shows no
      deletes or conflicts, and the content is unchanged.
- [ ] iPhone: edit `Journal/Sub/(x) note.md`. The Mac gets the edit.
- [ ] **Keychain.** Quit Obsidian on the iPhone and reopen it. The folder is
      still unlocked, and you weren't asked for the password again.
- [ ] Mac: **Change password**. Afterwards the iPhone syncs and shows
      `Wrong password for Journal`, with nothing deleted.
- [ ] iPhone: **Re-enter password** with the new one. It syncs cleanly.
- [ ] **Interrupted change.** Mac: start Change password again, and quit
      Obsidian while it says "Re-encrypting". Reopen it: the operation resumes
      by itself and says "done". The iPhone shows `Password change in progress`
      while it runs, then unlocks with the newest password.
- [ ] Mac: **Remove encryption**. Plaintext names and content are back on the
      server. The iPhone shows `Key file missing for Journal` until you click
      **✕ Forget on this device** next to the folder. After that it syncs
      `Journal` as plain files again, with no deletes.

## 5. Clean up

- [ ] Delete the `CDS Test` vault on each device, or keep it for the next run.
- [ ] Empty the test bucket.
- [ ] Record the result on the Linear ticket.
