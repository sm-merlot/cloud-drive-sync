import { describe, it, expect, beforeEach } from "vitest";
import { computeMD5 } from "../src/util/hash";
import { MULTIPART_THRESHOLD_BYTES } from "../src/util/constants";
import { createKeyFile, isEncryptedContent, serializeKeyFile, type FolderKeys } from "../src/crypto/folder-crypto";
import { encryptAtRest, toAtRestPath } from "../src/crypto/at-rest";
import { UnlockCache } from "../src/sync/folder-encryption";
import { AtRestSession, atRestCodec } from "../src/sync/at-rest-session";
import { SyncEngine } from "../src/sync/sync-engine";
import { convertFolderToAtRest, convertFolderToPlaintext, reencryptAtRestFolder } from "../src/sync/at-rest-ops";
import type { ConflictStrategy } from "../src/types";
import type { FakeProvider } from "./helpers/fakes";
import {
	FOLDER, KEY_PATH, device, makeProvider, md5, remoteKeysUnder, snapshot, text, tick, useFakeClock, writeKeyFile,
	type Device,
} from "./helpers/encryption-world";

useFakeClock();

describe("encrypted folders: upload and download", () => {
	let provider: FakeProvider;

	beforeEach(async () => {
		provider = makeProvider();
		await writeKeyFile(provider, "pw1");
	});

	it("uploads only ciphertext and encrypted names", async () => {
		const a = device(provider, "pw1");
		a.fs.setFile("Journal/2026-03-04 talk with doctor.md", "very private", tick());
		a.fs.setFile("public.md", "hello", tick());

		const result = await a.engine.sync();
		expect(result.errors).toBe(0);
		expect(result.uploaded).toBe(2);
		expect(result.lockedFolders).toEqual([]);

		const keys = remoteKeysUnder(provider, FOLDER);
		expect(keys).toHaveLength(1);
		expect(keys[0]).toMatch(/^Journal\/[a-z2-7]+$/);
		expect(keys[0]).not.toContain("doctor");
		const blob = provider.objects.get(keys[0]!)!.bytes;
		expect(isEncryptedContent(blob)).toBe(true);
		expect(text(blob)).not.toContain("very private");
		// unencrypted folders are untouched
		expect(text(provider.objects.get("public.md")?.bytes)).toBe("hello");

		const rec = a.store.getRecord("Journal/2026-03-04 talk with doctor.md")!;
		expect(rec.contentHash).toBe(md5("very private"));
		expect(rec.remoteHash).toBe(computeMD5(blob.buffer.slice(0) as ArrayBuffer));
		expect(rec.remoteId).toBe(keys[0]);
	});

	it("a second device with the password downloads plaintext", async () => {
		const a = device(provider, "pw1");
		a.fs.setFile("Journal/note.md", "secret", tick());
		await a.engine.sync();

		const b = device(provider, "pw1");
		const result = await b.engine.sync();
		expect(result.downloaded).toBe(1);
		expect(text(b.fs.files.get("Journal/note.md")?.bytes)).toBe("secret");
		expect(b.store.getRecord("Journal/note.md")?.contentHash).toBe(md5("secret"));
	});

	it("encrypts subfolder names and recreates them on the other device", async () => {
		const a = device(provider, "pw1");
		a.fs.folders.add("Journal");
		a.fs.folders.add("Journal/Health");
		a.fs.setFile("Journal/Health/x.md", "x", tick());
		const ra = await a.engine.sync();
		expect(ra.errors).toBe(0);
		expect(Array.from(provider.folders).some((f) => f.includes("Health"))).toBe(false);

		const b = device(provider, "pw1");
		await b.engine.sync();
		expect(b.fs.folders.has("Journal/Health")).toBe(true);
		expect(text(b.fs.files.get("Journal/Health/x.md")?.bytes)).toBe("x");
	});

	it("rejects files at or above the multipart threshold", async () => {
		const a = device(provider, "pw1");
		a.fs.files.set("Journal/big.bin", { bytes: new Uint8Array(MULTIPART_THRESHOLD_BYTES), mtimeMs: tick() });
		const result = await a.engine.sync();
		expect(result.errors).toBe(1);
		expect(result.failures[0]?.errorMessage).toMatch(/too large for an encrypted folder/);
		expect(remoteKeysUnder(provider, FOLDER)).toHaveLength(0);
	});
});

describe("encrypted folders: no re-upload loops", () => {
	let provider: FakeProvider;
	let a: Device;
	let b: Device;

	beforeEach(async () => {
		provider = makeProvider();
		await writeKeyFile(provider, "pw1");
		a = device(provider, "pw1");
		a.fs.setFile("Journal/one.md", "one", tick());
		a.fs.setFile("Journal/two.md", "two", tick());
		await a.engine.sync();
		b = device(provider, "pw1");
		await b.engine.sync();
	});

	it("a sync with no changes transfers nothing", async () => {
		const before = provider.writeCalls;
		const downloads = provider.downloadCalls;
		const ra = await a.engine.sync();
		const rb = await b.engine.sync();
		expect(provider.writeCalls).toBe(before);
		// Not even a download: the ciphertext ETag matches remoteHash. (The key
		// file isn't re-fetched either, its unlock is cached by ETag.)
		expect(provider.downloadCalls).toBe(downloads);
		expect([ra.uploaded, ra.downloaded, rb.uploaded, rb.downloaded]).toEqual([0, 0, 0, 0]);
	});

	it("server clock ahead of the device: ETag vs remoteHash keeps it quiet", async () => {
		// S3 LastModified comes from the server clock; the record stamps the
		// device clock. With the server ahead, the mtime gate always says
		// "maybe changed" and only the ciphertext hash comparison stops a
		// download on every pass.
		for (const o of provider.objects.values()) o.modifiedTime += 3_600_000;
		const downloads = provider.downloadCalls;
		const r = await a.engine.sync();
		await a.engine.sync();
		expect(r.downloaded).toBe(0);
		expect(provider.downloadCalls).toBe(downloads);
	});

	it("two devices alternating syncs settle to zero transfers", async () => {
		const before = provider.writeCalls;
		const bWrites = b.fs.writeCalls;
		for (let i = 0; i < 5; i++) {
			await a.engine.sync();
			await b.engine.sync();
		}
		expect(provider.writeCalls).toBe(before);
		expect(b.fs.writeCalls).toBe(bWrites);
	});

	it("an mtime bump with the same bytes (mobile stat race) does not re-upload", async () => {
		const f = a.fs.files.get("Journal/one.md")!;
		f.mtimeMs = tick();
		const before = provider.writeCalls;
		const r = await a.engine.sync();
		expect(r.uploaded).toBe(0);
		expect(provider.writeCalls).toBe(before);
	});

	it("same through the file-watcher path (syncPaths)", async () => {
		const f = a.fs.files.get("Journal/one.md")!;
		f.mtimeMs = tick();
		const before = provider.writeCalls;
		const r = await a.engine.syncPaths(new Set(["Journal/one.md"]));
		expect(r.uploaded).toBe(0);
		expect(provider.writeCalls).toBe(before);
	});

	it("identical plaintext re-uploaded elsewhere is not rewritten locally", async () => {
		// a re-uploads identical content (e.g. an older client): new ciphertext
		await a.engine.syncPaths(new Set()); // no-op, keeps state warm
		const remoteId = a.store.getRecord("Journal/one.md")!.remoteId;
		const blob = provider.objects.get(remoteId)!;
		const c = device(provider, "pw1");
		await c.engine.sync();
		c.fs.files.get("Journal/one.md")!.mtimeMs = tick();
		c.fs.files.get("Journal/one.md")!.bytes = new TextEncoder().encode("one!");
		await c.engine.sync();
		c.fs.files.get("Journal/one.md")!.bytes = new TextEncoder().encode("one");
		c.fs.files.get("Journal/one.md")!.mtimeMs = tick();
		await c.engine.sync();
		expect(provider.objects.get(remoteId)!.bytes).not.toEqual(blob.bytes);

		const bWrites = b.fs.writeCalls;
		const mtime = b.fs.files.get("Journal/one.md")!.mtimeMs;
		const r = await b.engine.sync();
		expect(r.downloaded).toBe(0);
		expect(b.fs.writeCalls).toBe(bWrites);
		expect(b.fs.files.get("Journal/one.md")!.mtimeMs).toBe(mtime);
		// and the new ciphertext is now recorded, so the next pass is quiet too
		const again = await b.engine.sync();
		expect(again.downloaded).toBe(0);
	});

	it("a real remote edit still comes down", async () => {
		a.fs.setFile("Journal/one.md", "one edited", tick());
		await a.engine.sync();
		const r = await b.engine.sync();
		expect(r.downloaded).toBe(1);
		expect(text(b.fs.files.get("Journal/one.md")?.bytes)).toBe("one edited");
	});
});

describe("encrypted folders: conflicts", () => {
	let provider: FakeProvider;

	beforeEach(async () => {
		provider = makeProvider();
		await writeKeyFile(provider, "pw1");
	});

	async function twoDevices(strategy: ConflictStrategy) {
		const a = device(provider, "pw1", { strategy });
		a.fs.setFile("Journal/n.md", "base\n", tick());
		await a.engine.sync();
		const b = device(provider, "pw1", { strategy });
		await b.engine.sync();
		return { a, b };
	}

	it("both devices editing the same file is reported as a conflict", async () => {
		const { a, b } = await twoDevices("prompt");
		a.fs.setFile("Journal/n.md", "from a\n", tick());
		await a.engine.sync();
		b.fs.setFile("Journal/n.md", "from b\n", tick());
		await b.engine.sync();
		expect(b.ui.surfacedIssues.map((i) => [i.vaultPath, i.type])).toEqual([["Journal/n.md", "conflict"]]);
		expect(text(b.fs.files.get("Journal/n.md")?.bytes)).toBe("from b\n");
	});

	it("both devices making the same edit resolves silently on decrypted content", async () => {
		const { a, b } = await twoDevices("prompt");
		a.fs.setFile("Journal/n.md", "same\n", tick());
		await a.engine.sync();
		b.fs.setFile("Journal/n.md", "same\n", tick());
		const r = await b.engine.sync();
		expect(b.ui.surfacedIssues).toEqual([]);
		expect(r.errors).toBe(0);
		const again = await b.engine.sync();
		expect([again.uploaded, again.downloaded]).toEqual([0, 0]);
	});

	it("smart-merge works on decrypted text and uploads ciphertext", async () => {
		const { a, b } = await twoDevices("smart-merge");
		a.fs.setFile("Journal/n.md", "base\nfrom a\n", tick());
		await a.engine.sync();
		b.fs.setFile("Journal/n.md", "base\nfrom b\n", tick());
		const r = await b.engine.sync();
		const merged = text(b.fs.files.get("Journal/n.md")?.bytes)!;
		if (r.conflicts > 0 && b.ui.surfacedIssues.length === 0) {
			expect(merged).toContain("from a");
			expect(merged).toContain("from b");
		}
		for (const key of remoteKeysUnder(provider, FOLDER)) {
			expect(isEncryptedContent(provider.objects.get(key)!.bytes)).toBe(true);
		}
	});

	it("external merge falls back to the built-in merge in encrypted folders", async () => {
		const { a, b } = await twoDevices("prompt");
		let externalCalled = false;
		b.ui.externalMerge = async () => { externalCalled = true; };
		b.ui.cannedResolutions = [{ vaultPath: "Journal/n.md", resolution: "external", remoteId: a.store.getRecord("Journal/n.md")!.remoteId }];
		a.fs.setFile("Journal/n.md", "from a\n", tick());
		await a.engine.sync();
		b.fs.setFile("Journal/n.md", "from b\n", tick());
		await b.engine.sync();
		expect(externalCalled).toBe(false);
		expect(b.notices.some((n) => n.includes("External merge is not available"))).toBe(true);
		for (const key of remoteKeysUnder(provider, FOLDER)) {
			expect(isEncryptedContent(provider.objects.get(key)!.bytes)).toBe(true);
		}
	});
});

describe("encrypted folders: locked devices never touch the folder", () => {
	let provider: FakeProvider;
	let a: Device;

	beforeEach(async () => {
		provider = makeProvider();
		await writeKeyFile(provider, "pw1");
		a = device(provider, "pw1");
		a.fs.setFile("Journal/one.md", "one", tick());
		a.fs.setFile("Journal/two.md", "two", tick());
		await a.engine.sync();
	});

	// A device that synced Journal in plaintext before it was encrypted:
	// local files plus records that point at the old plaintext objects.
	function preEncryptionDevice(password: string | null, opts: { configured?: boolean } = {}): Device {
		const d = device(provider, password, opts);
		for (const [name, body] of [["one", "one"], ["two", "two"]] as const) {
			const path = `Journal/${name}.md`;
			d.fs.setFile(path, body, 5000);
			d.store.setRecord(path, {
				vaultPath: path, remoteId: path, remoteFolderId: "Journal",
				localModTime: 5000, remoteModTime: 5000, contentHash: md5(body), size: body.length,
			});
		}
		return d;
	}

	async function expectUntouched(d: Device, reason: string) {
		const before = snapshot(d);
		const remoteBefore = new Map(provider.objects);
		const r = await d.engine.sync();
		expect(snapshot(d)).toEqual(before);
		expect(provider.objects).toEqual(remoteBefore);
		expect(provider.deleted).toEqual([]);
		expect(r.lockedFolders).toEqual([{ path: FOLDER, reason }]);
		expect(d.notices).toContain(reason);
		expect(d.ui.surfacedIssues).toEqual([]);
		return r;
	}

	it("no password: locked, no upload/download/delete, records kept", async () => {
		const b = preEncryptionDevice(null);
		await expectUntouched(b, "No password for Journal");
	});

	it("no password and not even configured (other app, old settings): locked", async () => {
		const b = preEncryptionDevice(null, { configured: false });
		await expectUntouched(b, "No password for Journal");
	});

	it("engine with no encryption settings at all still locks key-file folders", async () => {
		const b = device(provider, null, { encryption: false });
		const r = await b.engine.sync();
		expect(r.downloaded).toBe(0);
		expect(b.fs.files.size).toBe(0);
		expect(r.lockedFolders.map((l) => l.path)).toEqual([FOLDER]);
	});

	it("no password: a local edit through syncPaths is not uploaded", async () => {
		const b = preEncryptionDevice(null);
		b.fs.setFile("Journal/one.md", "edited while locked", tick());
		b.fs.setFile("Journal/new.md", "new while locked", tick());
		const before = provider.writeCalls;
		const r = await b.engine.syncPaths(new Set(["Journal/one.md", "Journal/new.md"]));
		expect(provider.writeCalls).toBe(before);
		expect(r.uploaded).toBe(0);
		expect(text(b.fs.files.get("Journal/one.md")?.bytes)).toBe("edited while locked");
	});

	it("locked folder doesn't block the rest of the vault", async () => {
		const b = preEncryptionDevice(null);
		b.fs.setFile("other.md", "fine", tick());
		const r = await b.engine.sync();
		expect(r.uploaded).toBe(1);
		expect(text(provider.objects.get("other.md")?.bytes)).toBe("fine");
	});

	it("wrong password: locked with a wrong-password notice", async () => {
		const b = preEncryptionDevice("not it");
		await expectUntouched(b, "Wrong password for Journal");
	});

	it("old password after a password change: locked, then converges on the new password with no deletes", async () => {
		const b = device(provider, "pw1");
		await b.engine.sync();
		expect(text(b.fs.files.get("Journal/one.md")?.bytes)).toBe("one");

		// Password change on A: new key file, every file re-encrypted under
		// new names, old objects removed (DEV-382 does this incrementally).
		for (const k of remoteKeysUnder(provider, FOLDER)) provider.objects.delete(k);
		await writeKeyFile(provider, "pw2");
		const a2 = device(provider, "pw2", { lastSyncTime: 0 });
		a2.fs.setFile("Journal/one.md", "one", tick());
		a2.fs.setFile("Journal/two.md", "two", tick());
		await a2.engine.sync();
		provider.deleted.length = 0;

		await expectUntouched(b, "Wrong password for Journal");

		b.password = "pw2";
		b.notices.length = 0;
		const r = await b.engine.sync();
		expect(r.lockedFolders).toEqual([]);
		expect(r.deleted).toBe(0);
		expect(provider.deleted).toEqual([]);
		expect(text(b.fs.files.get("Journal/one.md")?.bytes)).toBe("one");
		expect(text(b.fs.files.get("Journal/two.md")?.bytes)).toBe("two");
		const again = await b.engine.sync();
		expect([again.uploaded, again.downloaded, again.deleted]).toEqual([0, 0, 0]);
	});

	it("key file missing: locked, nothing uploaded in plaintext", async () => {
		provider.objects.delete(KEY_PATH);
		const b = preEncryptionDevice("pw1");
		b.fs.setFile("Journal/new.md", "would leak", tick());
		await expectUntouched(b, "Key file missing for Journal");
	});

	it("unreadable key file: locked", async () => {
		provider.setObject(KEY_PATH, "{ not json", tick());
		const b = preEncryptionDevice("pw1");
		const before = snapshot(b);
		const r = await b.engine.sync();
		expect(snapshot(b)).toEqual(before);
		expect(r.lockedFolders[0]?.reason).toMatch(/^Unreadable key file for Journal/);
	});

	it("password change in progress elsewhere: locked even with the new password", async () => {
		await writeKeyFile(provider, "pw2", { fromKeyId: "whatever" });
		const b = preEncryptionDevice("pw2");
		await expectUntouched(b, "Password change in progress for Journal");
	});

	it("an undecryptable object in the folder locks it instead of looking like deletes", async () => {
		const b = device(provider, "pw1");
		await b.engine.sync();
		provider.setObject("Journal/Dropped by copyparty.md", "junk", tick());
		// b also has its own records for one.md/two.md; nothing may be deleted
		const r = await b.engine.sync();
		expect(r.lockedFolders).toEqual([
			{ path: FOLDER, reason: "Unreadable file Journal/Dropped by copyparty.md in Journal" },
		]);
		expect(r.deleted).toBe(0);
		expect(b.fs.files.has("Journal/one.md")).toBe(true);
		expect(b.store.getRecord("Journal/one.md")).toBeDefined();
	});

	it("locked on one pass, unlocked on the next: nothing is deleted", async () => {
		// Regression: local paths were filtered with the previous pass's lock
		// state, so a just-unlocked folder looked locally deleted and its
		// remote folders and unchanged files were deleted.
		const b = device(provider, "pw1", { lastSyncTime: 0 });
		b.fs.folders.add("Journal");
		b.fs.folders.add("Journal/Sub");
		b.fs.setFile("Journal/Sub/s.md", "s", tick());
		await b.engine.sync();
		await b.engine.sync();
		b.password = null;
		expect((await b.engine.sync()).lockedFolders).toHaveLength(1);
		b.password = "pw1";
		const r = await b.engine.sync();
		expect(r.lockedFolders).toEqual([]);
		expect(r.deleted).toBe(0);
		expect(provider.deleted).toEqual([]);
		expect(b.ui.surfacedIssues).toEqual([]);
		expect(text(b.fs.files.get("Journal/one.md")?.bytes)).toBe("one");
	});

	it("unlocking later resumes cleanly from the kept records", async () => {
		const b = device(provider, null);
		b.fs.setFile("Journal/one.md", "one", 5000); // same bytes as remote
		await b.engine.sync();
		b.password = "pw1";
		const r = await b.engine.sync();
		expect(r.errors).toBe(0);
		expect(r.deleted).toBe(0);
		expect(text(b.fs.files.get("Journal/two.md")?.bytes)).toBe("two");
	});
});

describe("at-rest folders: the engine syncs them as opaque files", () => {
	let provider: FakeProvider;
	let keys: FolderKeys;
	const notes: Record<string, string> = { "Journal/a.md": "secret a", "Journal/Sub/b.md": "secret b" };
	const onDisk = new Map<string, Uint8Array>(); // at-rest path → ciphertext

	beforeEach(async () => {
		provider = makeProvider();
		const created = await createKeyFile("pw1", { iterations: 1000, mode: "at-rest" });
		keys = created.keys;
		provider.setObject(KEY_PATH, serializeKeyFile(created.keyFile), tick());
		onDisk.clear();
		for (const [plain, body] of Object.entries(notes)) {
			const path = await toAtRestPath(keys, FOLDER, plain, true);
			onDisk.set(path, await encryptAtRest(keys, plain, new TextEncoder().encode(body)));
		}
	});

	function writer(opts: Parameters<typeof device>[2] = {}, password: string | null = null): Device {
		const d = device(provider, password, opts);
		for (const [p, bytes] of onDisk) d.fs.files.set(p, { bytes, mtimeMs: tick() });
		return d;
	}

	it("a device without the password keeps a byte-identical encrypted copy", async () => {
		const a = writer({ configured: false });
		const ra = await a.engine.sync();
		expect(ra.lockedFolders).toEqual([]);
		expect(ra.uploaded).toBe(onDisk.size);
		for (const [p, bytes] of onDisk) expect(provider.objects.get(p)?.bytes).toEqual(bytes);

		const b = device(provider, null, { configured: false, lastSyncTime: 0 });
		const rb = await b.engine.sync();
		expect(rb.lockedFolders).toEqual([]);
		for (const [p, bytes] of onDisk) expect(b.fs.files.get(p)?.bytes).toEqual(bytes);
		for (const f of b.fs.files.values()) expect(text(f.bytes)).not.toContain("secret");

		expect([(await a.engine.sync()).uploaded, (await b.engine.sync()).downloaded]).toEqual([0, 0]);
	});

	it("is never decrypted by the engine, even when configured with the password", async () => {
		const a = writer({}, "pw1"); // FOLDER is in settings.folders and has a password
		const r = await a.engine.sync();
		expect(r.lockedFolders).toEqual([]);
		expect(r.errors).toBe(0);
		for (const [p, bytes] of onDisk) expect(provider.objects.get(p)?.bytes).toEqual(bytes);
		expect([...provider.objects.keys()].some((k) => k.includes("Sub") || k.endsWith(".md"))).toBe(false);
	});

	it("a host with no encryption settings (Tauri) syncs it too", async () => {
		const a = writer({ encryption: false });
		const r = await a.engine.sync();
		expect(r.lockedFolders).toEqual([]);
		expect(r.uploaded).toBe(onDisk.size);
	});

	it("an edit is just new bytes: it propagates and then goes quiet", async () => {
		const a = writer({ configured: false });
		await a.engine.sync();
		const b = device(provider, null, { configured: false, lastSyncTime: 0 });
		await b.engine.sync();

		const path = [...onDisk.keys()][0]!;
		const edited = await encryptAtRest(keys, "Journal/a.md", new TextEncoder().encode("secret a, edited"));
		a.fs.files.set(path, { bytes: edited, mtimeMs: tick() });
		expect((await a.engine.sync()).uploaded).toBe(1);
		expect((await b.engine.sync()).downloaded).toBe(1);
		expect(b.fs.files.get(path)?.bytes).toEqual(edited);
		expect((await b.engine.sync()).downloaded).toBe(0);
	});

	it("reads the key file once per ETag with a shared UnlockCache", async () => {
		const cache = new UnlockCache();
		const a = writer({ configured: false, unlockCache: cache });
		await a.engine.sync();
		const downloads = provider.downloadCalls;
		const again = device(provider, null, { configured: false, unlockCache: cache });
		again.fs.files = a.fs.files;
		for (const [p, r] of Object.entries(a.store.getAllRecords())) again.store.setRecord(p, r);
		await again.engine.sync();
		expect(provider.downloadCalls).toBe(downloads);
	});

	it("a key file with a mode from a newer plugin locks the folder", async () => {
		const { keyFile } = await createKeyFile("pw1", { iterations: 1000 });
		provider.setObject(KEY_PATH, JSON.stringify({ ...keyFile, mode: "future-mode" }), tick());
		const a = writer({ configured: false });
		const r = await a.engine.sync();
		expect(r.lockedFolders[0]?.reason).toMatch(/^Unreadable key file for Journal: .*unsupported mode/);
		expect(r.uploaded).toBe(0);
	});
});

describe("at-rest folders: plaintext inside is never uploaded", () => {
	it("a stray .md in an at-rest folder is refused with an issue; .cdse files still sync", async () => {
		const provider = makeProvider();
		const created = await createKeyFile("pw1", { iterations: 1000, mode: "at-rest" });
		provider.setObject(KEY_PATH, serializeKeyFile(created.keyFile), tick());
		const a = device(provider, null, { configured: false });
		const good = await toAtRestPath(created.keys, FOLDER, "Journal/ok.md", true);
		a.fs.files.set(good, { bytes: await encryptAtRest(created.keys, "Journal/ok.md", new TextEncoder().encode("ok")), mtimeMs: tick() });
		a.fs.setFile("Journal/Leaked.md", "PLAINTEXT LEAK", tick());

		const r = await a.engine.sync();
		expect(provider.objects.has(good)).toBe(true);
		expect(provider.objects.has("Journal/Leaked.md")).toBe(false);
		expect(a.ui.surfacedIssues.map((i) => [i.vaultPath, i.type])).toEqual([["Journal/Leaked.md", "error"]]);
		expect(r.uploaded).toBe(1);

		// and through the file-watcher path
		a.fs.setFile("Journal/Leaked.md", "PLAINTEXT LEAK 2", tick());
		await a.engine.syncPaths(new Set(["Journal/Leaked.md"]));
		expect(provider.objects.has("Journal/Leaked.md")).toBe(false);
	});
});

describe("at-rest conversion across two devices (what the plugin orchestrates)", () => {
	const removeNow = (d: Device) => async (p: string) => { d.fs.files.delete(p); };

	async function setup(transit: boolean) {
		const provider = makeProvider();
		const a = device(provider, transit ? "tpw" : null, { configured: transit });
		a.fs.setFile("Journal/a.md", "SECRET a", tick());
		a.fs.setFile("Journal/Sub/b.md", "SECRET b", tick());
		a.fs.setFile("public.md", "public", tick());
		if (transit) await a.engine.enableEncryption(FOLDER, "tpw", { iterations: 1000 });
		await a.engine.sync();
		const b = device(provider, transit ? "tpw" : null, { configured: transit, lastSyncTime: 0 });
		await b.engine.sync();
		expect(text(b.fs.files.get("Journal/a.md")?.bytes)).toBe("SECRET a");
		return { provider, a, b };
	}

	async function convert(a: Device, transit: boolean) {
		const { keyFile, keys } = await createKeyFile("rest", { iterations: 1000, mode: "at-rest" });
		await a.engine.sync();
		await a.engine.writeKeyFileToServer(FOLDER, keyFile);
		if (transit) await a.engine.deleteServerObjectsUnder(FOLDER);
		await convertFolderToAtRest(a.fs, "", FOLDER, keys, { removePlaintext: removeNow(a) });
		if (transit) a.password = null; // the plugin forgets the transit config
		const r = await a.engine.sync();
		expect(r.errors).toBe(0);
		return { keyFile, keys };
	}

	for (const transit of [false, true]) {
		it(`${transit ? "transit" : "plaintext"} → at rest: the server and both devices end with ciphertext only, nothing lost`, async () => {
			const { provider, a, b } = await setup(transit);
			const { keyFile } = await convert(a, transit);

			const serverText = [...provider.objects].map(([k, o]) => `${k} ${text(o.bytes)}`).join("\n");
			expect(serverText).not.toContain("SECRET");
			expect(serverText).not.toMatch(/a\.md|b\.md|Sub/);
			expect(text(provider.objects.get("public.md")?.bytes)).toBe("public");

			b.password = null;
			const rb = await b.engine.sync();
			expect(rb.errors).toBe(0);
			expect(rb.atRestFolders).toEqual([FOLDER]);
			const bText = [...b.fs.files].map(([k, f]) => `${k} ${text(f.bytes)}`).join("\n");
			expect(bText).not.toContain("SECRET");
			expect([...b.fs.files.keys()].filter((p) => p.startsWith("Journal/") && !p.endsWith(".cdse"))).toEqual([]);

			// Everything is still readable on b with the new password
			const s = new AtRestSession(b.fs, "", FOLDER, keyFile);
			await s.unlock("rest");
			expect(text(await s.read("Journal/a.md"))).toBe("SECRET a");
			expect(text(await s.read("Journal/Sub/b.md"))).toBe("SECRET b");

			expect([(await a.engine.sync()).uploaded, (await b.engine.sync()).downloaded]).toEqual([0, 0]);
		});
	}

	it("at rest → plaintext: both devices end with the plain files and no key file", async () => {
		const { provider, a, b } = await setup(false);
		const { keys } = await convert(a, false);
		await b.engine.sync();

		await convertFolderToPlaintext(a.fs, "", FOLDER, keys);
		await a.engine.deleteKeyFileFromServer(FOLDER);
		await a.engine.sync();
		expect(provider.objects.has(KEY_PATH)).toBe(false);
		expect(text(provider.objects.get("Journal/a.md")?.bytes)).toBe("SECRET a");

		const rb = await b.engine.sync();
		expect(rb.errors).toBe(0);
		expect(rb.atRestFolders).toEqual([]);
		expect(text(b.fs.files.get("Journal/Sub/b.md")?.bytes)).toBe("SECRET b");
		expect([...b.fs.files.keys()].some((p) => p.endsWith(".cdse"))).toBe(false);
	});

	it("password change: re-encrypted on one device, the other converges with nothing lost", async () => {
		const { a, b } = await setup(false);
		const { keyFile: oldKf, keys: oldKeys } = await convert(a, false);
		await b.engine.sync();

		const { keyFile: newKf, keys: newKeys } = await createKeyFile("rest2", {
			iterations: 1000, mode: "at-rest", rotation: { fromKeyId: oldKf.keyId },
		});
		await a.engine.writeKeyFileToServer(FOLDER, newKf);
		await reencryptAtRestFolder(a.fs, "", FOLDER, oldKeys, newKeys);
		await a.engine.sync();
		await a.engine.writeKeyFileToServer(FOLDER, { ...newKf, rotation: null });

		const rb = await b.engine.sync();
		expect(rb.errors).toBe(0);
		const s = new AtRestSession(b.fs, "", FOLDER, { ...newKf, rotation: null });
		await s.unlock("rest2");
		const listing = await s.list();
		expect(listing.unreadable).toEqual([]);
		expect(listing.nodes.filter((n) => n.isFile).map((n) => n.plainPath).sort()).toEqual(["Journal/Sub/b.md", "Journal/a.md"]);
	});
});

describe("at-rest conflicts: merged in memory when unlocked (DEV-395)", () => {
	async function twoDevices(strategy: ConflictStrategy) {
		const provider = makeProvider();
		const created = await createKeyFile("pw", { iterations: 1000, mode: "at-rest" });
		provider.setObject(KEY_PATH, serializeKeyFile(created.keyFile), tick());
		const mk = (lastSyncTime?: number) => {
			const d = device(provider, null, { configured: false, strategy, lastSyncTime });
			const session = new AtRestSession(d.fs, "", FOLDER, created.keyFile);
			// rebuild the engine with a codec bound to this device's session
			d.engine = new SyncEngine(d.fs, "/root", provider, d.store, d.ui, {
				conflictStrategy: strategy, excludePatterns: [],
				atRestCodec: atRestCodec(() => session),
			});
			d.engine.onNotice = (m) => d.notices.push(m);
			return { d, session };
		};
		const A = mk();
		await A.session.unlock("pw");
		await A.session.write("Journal/n.md", new TextEncoder().encode("line 1\nline 2\nline 3\n"));
		await A.d.engine.sync();
		const B = mk(0);
		await B.d.engine.sync();
		await B.session.unlock("pw");
		const path = await A.session.diskPathOf("Journal/n.md", true);
		return { provider, A, B, path };
	}

	const edit = async (x: { d: Device; session: AtRestSession }, body: string) => {
		await x.session.write("Journal/n.md", new TextEncoder().encode(body));
		// the fake fs stamps writes with Date.now(); move past the last sync
		for (const v of x.d.fs.files.values()) v.mtimeMs = tick();
	};

	it("the same edit on both devices resolves silently", async () => {
		const { A, B } = await twoDevices("prompt");
		await edit(A, "same\n");
		await A.d.engine.sync();
		await edit(B, "same\n");
		const r = await B.d.engine.sync();
		expect(B.d.ui.surfacedIssues).toEqual([]);
		expect(r.errors).toBe(0);
		expect(text(await B.session.read("Journal/n.md"))).toBe("same\n");
		const again = await B.d.engine.sync();
		expect([again.uploaded, again.downloaded]).toEqual([0, 0]);
	});

	it("smart-merge merges non-overlapping edits in memory and uploads ciphertext", async () => {
		const { provider, A, B, path } = await twoDevices("smart-merge");
		await edit(A, "line 1 from A\nline 2\nline 3\n");
		await A.d.engine.sync();
		await edit(B, "line 1\nline 2\nline 3 from B\n");
		await B.d.engine.sync();
		const merged = text(await B.session.read("Journal/n.md"))!;
		// A 2-way merge without a base may or may not resolve this cleanly;
		// either way: merged and uploaded, or surfaced untouched. Never lost.
		if (B.d.ui.surfacedIssues.length === 0) {
			expect(merged).toContain("from A");
			expect(merged).toContain("from B");
			await A.d.engine.sync();
			expect(text(await A.session.read("Journal/n.md"))).toBe(merged);
		} else {
			expect(B.d.ui.surfacedIssues.map((i) => i.type)).toEqual(["conflict"]);
			expect(merged).toBe("line 1\nline 2\nline 3 from B\n");
		}
		expect(text(provider.objects.get(path)!.bytes)).not.toContain("line");
	});

	it("an explicit Merge resolution merges when unlocked", async () => {
		const { A, B, path } = await twoDevices("prompt");
		await edit(A, "A only\n");
		await A.d.engine.sync();
		await edit(B, "B only\n");
		B.d.ui.cannedResolutions = [{ vaultPath: path, resolution: "merge", remoteId: path }];
		await B.d.engine.sync();
		const merged = text(await B.session.read("Journal/n.md"))!;
		expect(merged).toContain("A only");
		expect(merged).toContain("B only");
		// markers or a clean merge: either way the next save goes up and A converges
		await edit(B, merged.replace(/<<<<<<<.*\n|=======\n|>>>>>>>.*\n/g, ""));
		await B.d.engine.sync();
		await A.d.engine.sync();
		expect(text(await A.session.read("Journal/n.md"))).toBe(text(await B.session.read("Journal/n.md")));
	});

	it("while locked, Merge asks to unlock and changes nothing", async () => {
		const { A, B, path } = await twoDevices("prompt");
		await edit(A, "A\n");
		await A.d.engine.sync();
		await edit(B, "B\n");
		await B.session.lock("manual");
		const before = B.d.fs.files.get(path)!.bytes;
		B.d.ui.cannedResolutions = [{ vaultPath: path, resolution: "merge", remoteId: path }];
		await B.d.engine.sync();
		expect(B.d.notices.some((n) => n.includes("Unlock the folder in Private notes"))).toBe(true);
		expect(B.d.fs.files.get(path)!.bytes).toEqual(before);
	});
});

describe("at-rest conflicts never reach an external merge tool", () => {
	it("an external resolution on a .cdse file uses the in-app merge", async () => {
		const provider = makeProvider();
		const created = await createKeyFile("pw", { iterations: 1000, mode: "at-rest" });
		provider.setObject(KEY_PATH, serializeKeyFile(created.keyFile), tick());
		const path = await toAtRestPath(created.keys, FOLDER, "Journal/n.md", true);
		const enc = (s: string) => encryptAtRest(created.keys, "Journal/n.md", new TextEncoder().encode(s));
		const a = device(provider, null, { configured: false });
		a.fs.files.set(path, { bytes: await enc("local"), mtimeMs: tick() });
		provider.objects.set(path, { bytes: await enc("remote"), modifiedTime: tick() });
		a.store.setRecord(path, { vaultPath: path, remoteId: path, remoteFolderId: FOLDER, localModTime: 1, remoteModTime: 1, contentHash: "x", size: 1 });
		let external = false;
		a.ui.externalMerge = async () => { external = true; };
		a.ui.cannedResolutions = [{ vaultPath: path, resolution: "external", remoteId: path }];
		await a.engine.sync();
		expect(external).toBe(false);
	});
});
