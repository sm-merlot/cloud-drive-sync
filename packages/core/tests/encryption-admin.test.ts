import { describe, it, expect, beforeEach } from "vitest";
import { createKeyFile, isEncryptedContent, parseKeyFile, serializeKeyFile } from "../src/crypto/folder-crypto";
import { UnlockCache } from "../src/sync/folder-encryption";
import type { FakeProvider } from "./helpers/fakes";
import {
	FOLDER, KEY_PATH, device, makeProvider, remoteKeysUnder, text, tick, useFakeClock,
	type Device,
} from "./helpers/encryption-world";

useFakeClock();

const FAST = { iterations: 1000 };
const FILES: Record<string, string> = {
	"Journal/one.md": "one",
	"Journal/two.md": "two",
	"Journal/Health/doctor.md": "private",
};

function keyFileOn(provider: FakeProvider) {
	const o = provider.objects.get(KEY_PATH);
	return o ? parseKeyFile(new TextDecoder().decode(o.bytes)) : null;
}

// Everything under Journal/ on the remote, decrypted through a fresh device
async function readBack(provider: FakeProvider, password: string | null): Promise<Record<string, string>> {
	const d = device(provider, password, { lastSyncTime: 0 });
	await d.engine.sync();
	const out: Record<string, string> = {};
	for (const [p, f] of d.fs.files) if (p.startsWith(FOLDER + "/")) out[p] = text(f.bytes)!;
	return out;
}

// Make the provider's Nth upload (1-based) throw, simulating a crash mid-run
function crashOnUpload(provider: FakeProvider, n: number): () => void {
	const real = provider.uploadFile.bind(provider);
	let count = 0;
	provider.uploadFile = async (...args) => {
		if (++count === n) throw new Error("simulated crash");
		return real(...args);
	};
	return () => { provider.uploadFile = real; };
}

describe("enable encryption on an existing plaintext folder", () => {
	let provider: FakeProvider;
	let a: Device;

	beforeEach(async () => {
		provider = makeProvider();
		// A has the folder synced in plaintext, before any encryption
		a = device(provider, null, { configured: false });
		a.fs.folders.add("Journal");
		a.fs.folders.add("Journal/Health");
		for (const [p, body] of Object.entries(FILES)) a.fs.setFile(p, body, tick());
		a.fs.setFile("public.md", "public", tick());
		await a.engine.sync();
		expect(text(provider.objects.get("Journal/one.md")?.bytes)).toBe("one");
	});

	it("replaces every plaintext object with ciphertext and clears the marker", async () => {
		await a.engine.enableEncryption(FOLDER, "pw1", FAST);

		const keys = remoteKeysUnder(provider, FOLDER);
		expect(keys.length).toBe(3);
		for (const k of keys) {
			expect(k).not.toMatch(/one|two|Health|doctor/);
			expect(isEncryptedContent(provider.objects.get(k)!.bytes)).toBe(true);
		}
		expect(Array.from(provider.folders).filter((f) => f.includes("Health"))).toEqual([]);
		expect(keyFileOn(provider)?.rotation).toBeNull();
		expect(text(provider.objects.get("public.md")?.bytes)).toBe("public");
		expect(await readBack(provider, "pw1")).toEqual(FILES);
	});

	it("the enabling device's next sync transfers nothing", async () => {
		await a.engine.enableEncryption(FOLDER, "pw1", FAST);
		a.password = "pw1";
		// a's engine was built with configured:false; a real host rebuilds it
		const a2 = device(provider, "pw1");
		a2.fs.files = a.fs.files;
		a2.fs.folders = a.fs.folders;
		for (const [p, r] of Object.entries(a.store.getAllRecords())) a2.store.setRecord(p, r);
		const writes = provider.writeCalls;
		const downloads = provider.downloadCalls;
		const r = await a2.engine.sync();
		expect([r.uploaded, r.downloaded, r.deleted, r.errors]).toEqual([0, 0, 0, 0]);
		expect(provider.writeCalls).toBe(writes);
		// one download: the key file, unlocked for the first time on a2
		expect(provider.downloadCalls).toBe(downloads + 1);
	});

	it("another device with plaintext records converges with the password, no deletes", async () => {
		const b = device(provider, "pw1");
		b.fs.folders = new Set(a.fs.folders);
		for (const [p, body] of Object.entries(FILES)) b.fs.setFile(p, body, 5000);
		b.fs.setFile("public.md", "public", 5000);
		for (const [p, rec] of Object.entries(a.store.getAllRecords())) {
			b.store.setRecord(p, { ...rec, localModTime: 5000 });
		}
		await a.engine.enableEncryption(FOLDER, "pw1", FAST);

		const r = await b.engine.sync();
		expect(r.lockedFolders).toEqual([]);
		expect(r.deleted).toBe(0);
		expect(r.errors).toBe(0);
		for (const [p, body] of Object.entries(FILES)) expect(text(b.fs.files.get(p)?.bytes)).toBe(body);
		const again = await b.engine.sync();
		expect([again.uploaded, again.downloaded, again.deleted]).toEqual([0, 0, 0]);
	});

	it("a device without the password locks instead of deleting its plaintext copies", async () => {
		const b = device(provider, null);
		for (const [p, body] of Object.entries(FILES)) b.fs.setFile(p, body, 5000);
		b.fs.setFile("public.md", "public", 5000);
		for (const [p, rec] of Object.entries(a.store.getAllRecords())) b.store.setRecord(p, rec);
		await a.engine.enableEncryption(FOLDER, "pw1", FAST);

		const r = await b.engine.sync();
		expect(r.lockedFolders).toEqual([{ path: FOLDER, reason: "No password for Journal" }]);
		expect(r.deleted).toBe(0);
		for (const [p, body] of Object.entries(FILES)) expect(text(b.fs.files.get(p)?.bytes)).toBe(body);
	});

	it("an interrupted enable locks other devices and resumes with no data loss", async () => {
		const restore = crashOnUpload(provider, 3); // key file, one file, then crash
		await expect(a.engine.enableEncryption(FOLDER, "pw1", FAST)).rejects.toThrow("simulated crash");
		restore();
		expect(keyFileOn(provider)?.rotation).toEqual({ fromKeyId: "plaintext" });

		const other = device(provider, "pw1");
		const r = await other.engine.sync();
		expect(r.lockedFolders).toEqual([{ path: FOLDER, reason: "Password change in progress for Journal" }]);
		expect([...other.fs.files.keys()].filter((p) => p.startsWith(FOLDER + "/"))).toEqual([]);

		await a.engine.enableEncryption(FOLDER, "pw1", FAST);
		expect(keyFileOn(provider)?.rotation).toBeNull();
		expect(await readBack(provider, "pw1")).toEqual(FILES);
	});

	it("resuming with a different password is refused", async () => {
		const restore = crashOnUpload(provider, 3);
		await expect(a.engine.enableEncryption(FOLDER, "pw1", FAST)).rejects.toThrow();
		restore();
		await expect(a.engine.enableEncryption(FOLDER, "other", FAST)).rejects.toThrow("Wrong password for Journal");
	});

	it("refuses an already-encrypted folder", async () => {
		await a.engine.enableEncryption(FOLDER, "pw1", FAST);
		await expect(a.engine.enableEncryption(FOLDER, "pw1", FAST)).rejects.toThrow("already encrypted");
	});

	it("refuses overlapping encrypted folders", async () => {
		await a.engine.enableEncryption(FOLDER, "pw1", FAST);
		await expect(a.engine.enableEncryption("Journal/Health", "pw1", FAST)).rejects.toThrow("overlaps");
	});

	it("refuses the vault root and dot folders", async () => {
		await expect(a.engine.enableEncryption("", "pw1", FAST)).rejects.toThrow("Invalid folder");
		await expect(a.engine.enableEncryption(".obsidian", "pw1", FAST)).rejects.toThrow("Invalid folder");
	});

	it("validates names before writing anything", async () => {
		provider.setObject(`Journal/${"x".repeat(150)}.md`, "long", tick());
		const before = new Map(provider.objects);
		await expect(a.engine.enableEncryption(FOLDER, "pw1", FAST)).rejects.toThrow(/Name too long/);
		expect(provider.objects).toEqual(before);
	});

	it("enables a folder that only exists locally so far", async () => {
		const b = device(provider, null, { configured: false });
		await b.engine.enableEncryption("Fresh", "pw1", FAST);
		expect(provider.objects.has(`Fresh/.cds-folder-key.json`)).toBe(true);
	});

	it("dotfiles a server-side tool dropped in the folder neither block nor lock it", async () => {
		provider.setObject("Journal/.DS_Store", "junk", tick());
		await a.engine.enableEncryption(FOLDER, "pw1", FAST);
		const r = await device(provider, "pw1", { lastSyncTime: 0 }).engine.sync();
		expect(r.lockedFolders).toEqual([]);
	});
});

describe("change password", () => {
	let provider: FakeProvider;
	let a: Device;
	let b: Device;

	beforeEach(async () => {
		provider = makeProvider();
		a = device(provider, null, { configured: false });
		for (const [p, body] of Object.entries(FILES)) a.fs.setFile(p, body, tick());
		await a.engine.sync();
		await a.engine.enableEncryption(FOLDER, "pw1", FAST);
		b = device(provider, "pw1", { lastSyncTime: 0 });
		await b.engine.sync();
	});

	it("re-encrypts under a new key id; old-password devices lock, new-password devices converge", async () => {
		const oldKeyId = keyFileOn(provider)!.keyId;
		const oldObjects = remoteKeysUnder(provider, FOLDER);
		await a.engine.changeEncryptionPassword(FOLDER, "pw1", "pw2", FAST);

		const kf = keyFileOn(provider)!;
		expect(kf.keyId).not.toBe(oldKeyId);
		expect(kf.rotation).toBeNull();
		const newObjects = remoteKeysUnder(provider, FOLDER);
		expect(newObjects.length).toBe(oldObjects.length);
		for (const k of newObjects) expect(oldObjects).not.toContain(k);

		const before = Array.from(b.fs.files, ([p, f]) => [p, text(f.bytes)]);
		const locked = await b.engine.sync();
		expect(locked.lockedFolders).toEqual([{ path: FOLDER, reason: "Wrong password for Journal" }]);
		expect(Array.from(b.fs.files, ([p, f]) => [p, text(f.bytes)])).toEqual(before);

		b.password = "pw2";
		const r = await b.engine.sync();
		expect(r.lockedFolders).toEqual([]);
		expect([r.deleted, r.errors]).toEqual([0, 0]);
		expect(provider.deleted.filter((d) => newObjects.includes(d))).toEqual([]);
		for (const [p, body] of Object.entries(FILES)) expect(text(b.fs.files.get(p)?.bytes)).toBe(body);
		expect(await readBack(provider, "pw2")).toEqual(FILES);
	});

	it("wrong old password changes nothing", async () => {
		const before = new Map(provider.objects);
		await expect(a.engine.changeEncryptionPassword(FOLDER, "nope", "pw2", FAST)).rejects.toThrow("Wrong password");
		expect(provider.objects).toEqual(before);
	});

	it("an interrupted change keeps everyone locked and resumes from the key file", async () => {
		const restore = crashOnUpload(provider, 2); // first re-encrypted file, then crash
		await expect(a.engine.changeEncryptionPassword(FOLDER, "pw1", "pw2", FAST)).rejects.toThrow("simulated crash");
		restore();
		const kf = keyFileOn(provider)!;
		expect(kf.rotation?.previous?.keyId).toBeDefined();

		b.password = "pw2";
		const r = await b.engine.sync();
		expect(r.lockedFolders).toEqual([{ path: FOLDER, reason: "Password change in progress for Journal" }]);
		expect(r.deleted).toBe(0);

		// Resume — e.g. after an app restart; only the key file carries the old salt
		const a2 = device(provider, "pw2");
		await a2.engine.changeEncryptionPassword(FOLDER, "pw1", "pw2", FAST);
		expect(keyFileOn(provider)?.rotation).toBeNull();
		expect(await readBack(provider, "pw2")).toEqual(FILES);
		const after = await b.engine.sync();
		expect([after.deleted, after.errors]).toEqual([0, 0]);
	});

	it("a junk object stops the change before anything is written", async () => {
		provider.setObject("Journal/dropped.md", "junk", tick());
		const before = new Map(provider.objects);
		await expect(a.engine.changeEncryptionPassword(FOLDER, "pw1", "pw2", FAST)).rejects.toThrow("Unreadable file Journal/dropped.md");
		expect(provider.objects).toEqual(before);
	});

	it("refuses to run while a sync is in progress", async () => {
		const pending = a.engine.sync();
		await expect(a.engine.changeEncryptionPassword(FOLDER, "pw1", "pw2", FAST)).rejects.toThrow("sync is in progress");
		await pending;
	});
});

describe("remove encryption", () => {
	let provider: FakeProvider;
	let a: Device;

	beforeEach(async () => {
		provider = makeProvider();
		a = device(provider, null, { configured: false });
		for (const [p, body] of Object.entries(FILES)) a.fs.setFile(p, body, tick());
		await a.engine.sync();
		await a.engine.enableEncryption(FOLDER, "pw1", FAST);
	});

	it("restores plaintext objects and deletes the key file", async () => {
		await a.engine.removeEncryption(FOLDER, "pw1");
		expect(provider.objects.has(KEY_PATH)).toBe(false);
		for (const [p, body] of Object.entries(FILES)) expect(text(provider.objects.get(p)?.bytes)).toBe(body);
		expect(remoteKeysUnder(provider, FOLDER).sort()).toEqual(Object.keys(FILES).sort());
	});

	it("a device still configured for encryption locks (key file missing) instead of syncing", async () => {
		const b = device(provider, "pw1", { lastSyncTime: 0 });
		await b.engine.sync();
		await a.engine.removeEncryption(FOLDER, "pw1");
		const r = await b.engine.sync();
		expect(r.lockedFolders).toEqual([{ path: FOLDER, reason: "Key file missing for Journal" }]);
		expect(r.deleted).toBe(0);
	});

	it("a device that drops the folder from its config converges with no deletes", async () => {
		const b = device(provider, "pw1", { lastSyncTime: 0 });
		await b.engine.sync();
		await a.engine.removeEncryption(FOLDER, "pw1");
		const plain = device(provider, null, { configured: false });
		plain.fs.files = b.fs.files;
		plain.fs.folders = b.fs.folders;
		for (const [p, rec] of Object.entries(b.store.getAllRecords())) plain.store.setRecord(p, rec);
		const r = await plain.engine.sync();
		expect([r.deleted, r.errors]).toEqual([0, 0]);
		for (const [p, body] of Object.entries(FILES)) expect(text(plain.fs.files.get(p)?.bytes)).toBe(body);
	});

	it("an interrupted removal resumes", async () => {
		const restore = crashOnUpload(provider, 2);
		await expect(a.engine.removeEncryption(FOLDER, "pw1")).rejects.toThrow("simulated crash");
		restore();
		expect(keyFileOn(provider)?.rotation?.toPlaintext).toBe(true);
		await a.engine.removeEncryption(FOLDER, "pw1");
		expect(provider.objects.has(KEY_PATH)).toBe(false);
		for (const [p, body] of Object.entries(FILES)) expect(text(provider.objects.get(p)?.bytes)).toBe(body);
	});

	it("wrong password changes nothing", async () => {
		const before = new Map(provider.objects);
		await expect(a.engine.removeEncryption(FOLDER, "nope")).rejects.toThrow("Wrong password");
		expect(provider.objects).toEqual(before);
	});
});

describe("probe and unlock cache", () => {
	it("reports not-encrypted, right and wrong passwords", async () => {
		const provider = makeProvider();
		const a = device(provider, null, { configured: false });
		a.fs.setFile("Journal/one.md", "one", tick());
		await a.engine.sync();
		expect(await a.engine.probeEncryption(FOLDER, "pw1")).toEqual({ state: "not-encrypted" });
		await a.engine.enableEncryption(FOLDER, "pw1", FAST);
		expect(await a.engine.probeEncryption(FOLDER, "pw1")).toMatchObject({ state: "encrypted", passwordOk: true, changeInProgress: false });
		expect(await a.engine.probeEncryption(FOLDER, "nope")).toMatchObject({ state: "encrypted", passwordOk: false, changeInProgress: false });
	});

	it("a shared UnlockCache skips the key file download on a new engine", async () => {
		const provider = makeProvider();
		const a = device(provider, null, { configured: false });
		a.fs.setFile("Journal/one.md", "one", tick());
		await a.engine.sync();
		await a.engine.enableEncryption(FOLDER, "pw1", FAST);

		const cache = new UnlockCache();
		const first = device(provider, "pw1", { lastSyncTime: 0, unlockCache: cache });
		await first.engine.sync();
		const second = device(provider, "pw1", { unlockCache: cache });
		second.fs.files = first.fs.files;
		for (const [p, r] of Object.entries(first.store.getAllRecords())) second.store.setRecord(p, r);
		const downloads = provider.downloadCalls;
		await second.engine.sync();
		expect(provider.downloadCalls).toBe(downloads);
	});
});

describe("transit operations refuse at-rest folders", () => {
	it("change password and remove are refused", async () => {
		const provider = makeProvider();
		const { keyFile } = await createKeyFile("pw1", { iterations: 1000, mode: "at-rest" });
		provider.setObject(KEY_PATH, serializeKeyFile(keyFile), tick());
		const a = device(provider, null, { configured: false });
		const before = new Map(provider.objects);
		await expect(a.engine.changeEncryptionPassword(FOLDER, "pw1", "pw2", FAST)).rejects.toThrow("at-rest");
		await expect(a.engine.removeEncryption(FOLDER, "pw1")).rejects.toThrow("at-rest");
		await expect(a.engine.enableEncryption(FOLDER, "pw1", FAST)).rejects.toThrow("already encrypted");
		expect(provider.objects).toEqual(before);
	});
});

describe("create an at-rest folder", () => {
	it("writes an at-rest key file, and probe reports the mode", async () => {
		const provider = makeProvider();
		const a = device(provider, null, { configured: false });
		const kf = await a.engine.createAtRestFolder("Private", "pw1", FAST);
		expect(kf.mode).toBe("at-rest");
		expect(parseKeyFile(new TextDecoder().decode(provider.objects.get("Private/.cds-folder-key.json")!.bytes))).toEqual(kf);
		const probe = await a.engine.probeEncryption("Private", "pw1");
		expect(probe).toMatchObject({ state: "encrypted", passwordOk: true, mode: "at-rest" });
		await expect(a.engine.createAtRestFolder("Private", "pw1", FAST)).rejects.toThrow("already encrypted");
	});

	it("refuses a folder that already has files on the server", async () => {
		const provider = makeProvider();
		provider.setObject("Diary/old.md", "plaintext", tick());
		const a = device(provider, null, { configured: false });
		await expect(a.engine.createAtRestFolder("Diary", "pw1", FAST)).rejects.toThrow("already has files");
		expect(provider.objects.has("Diary/.cds-folder-key.json")).toBe(false);
	});
});

