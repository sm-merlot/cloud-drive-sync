import { describe, it, expect, beforeEach } from "vitest";
import { SyncEngine } from "../src/sync/sync-engine";
import { SyncStateStore } from "../src/sync/sync-state";
import { HASH_VERIFY_THRESHOLD_BYTES } from "../src/util/constants";
import { computeMD5 } from "../src/util/hash";
import type { CloudProvider } from "../src/providers/cloud-provider";
import type { LocalFileEntry, LocalFileSystem } from "../src/fs/local-file-system";
import type { RemoteFileInfo, SyncState, SyncFileRecord } from "../src/types";
import type { FirstSyncStrategy, SyncIssue, SyncIssueResolution, SyncUIPort } from "../src/sync/sync-ui-port";

class FakeLocalFs implements LocalFileSystem {
	files = new Map<string, { bytes: Uint8Array; mtimeMs: number }>();
	folders = new Set<string>();
	readFileCalls = 0;

	setFile(path: string, text: string, mtimeMs: number): void {
		this.files.set(path, { bytes: new TextEncoder().encode(text), mtimeMs });
	}

	// entry with a lied-about size, for large-file threshold tests
	setFileWithSize(path: string, size: number, mtimeMs: number): void {
		this.files.set(path, { bytes: new Uint8Array(0), mtimeMs });
		this.sizeOverrides.set(path, size);
	}
	private sizeOverrides = new Map<string, number>();

	private entry(path: string): LocalFileEntry {
		const f = this.files.get(path)!;
		return { path, mtimeMs: f.mtimeMs, size: this.sizeOverrides.get(path) ?? f.bytes.byteLength };
	}

	async listFiles(): Promise<LocalFileEntry[]> {
		return Array.from(this.files.keys()).map((p) => this.entry(p));
	}
	async listFolders(): Promise<string[]> {
		return Array.from(this.folders);
	}
	async readFile(_root: string, relPath: string): Promise<Uint8Array> {
		this.readFileCalls++;
		const f = this.files.get(relPath);
		if (!f) throw new Error(`not found: ${relPath}`);
		return f.bytes;
	}
	async writeFile(_root: string, relPath: string, content: Uint8Array): Promise<void> {
		this.files.set(relPath, { bytes: content, mtimeMs: Date.now() });
	}
	async deleteFile(_root: string, relPath: string): Promise<void> {
		this.files.delete(relPath);
	}
	async createFolder(_root: string, relPath: string): Promise<void> {
		this.folders.add(relPath);
	}
	async deleteFolder(_root: string, relPath: string): Promise<void> {
		this.folders.delete(relPath);
	}
	async statFile(_root: string, relPath: string): Promise<LocalFileEntry | null> {
		return this.files.has(relPath) ? this.entry(relPath) : null;
	}
}

class FakeProvider implements CloudProvider {
	readonly name = "fake";
	objects = new Map<string, { bytes: Uint8Array; modifiedTime: number; etag?: string }>();
	folders = new Set<string>();
	deleted: string[] = [];

	setObject(key: string, text: string, modifiedTime: number, etag?: string): void {
		this.objects.set(key, { bytes: new TextEncoder().encode(text), modifiedTime, etag });
	}

	async testConnection(): Promise<boolean> { return true; }

	async listAllFiles(): Promise<RemoteFileInfo[]> {
		const files: RemoteFileInfo[] = Array.from(this.objects.entries()).map(([path, o]) => ({
			id: path,
			name: path.split("/").pop() ?? path,
			path,
			modifiedTime: o.modifiedTime,
			md5Checksum: o.etag ?? computeMD5(o.bytes.buffer.slice(0) as ArrayBuffer),
			mimeType: "application/octet-stream",
			isFolder: false,
			parentId: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
		}));
		for (const f of this.folders) {
			files.push({
				id: `${f}/.keep`, name: f.split("/").pop() ?? f, path: f,
				modifiedTime: 0, md5Checksum: "", mimeType: "application/x-directory",
				isFolder: true, parentId: f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "",
			});
		}
		return files;
	}

	async downloadFile(remoteId: string): Promise<ArrayBuffer> {
		const o = this.objects.get(remoteId);
		if (!o) throw new Error(`not found: ${remoteId}`);
		return o.bytes.buffer.slice(0) as ArrayBuffer;
	}
	async uploadFile(parentFolderId: string, name: string, content: ArrayBuffer): Promise<string> {
		const key = parentFolderId ? `${parentFolderId}/${name}` : name;
		this.objects.set(key, { bytes: new Uint8Array(content), modifiedTime: Date.now() });
		return key;
	}
	async updateFile(remoteId: string, content: ArrayBuffer): Promise<void> {
		this.objects.set(remoteId, { bytes: new Uint8Array(content), modifiedTime: Date.now() });
	}
	async deleteFile(remoteId: string): Promise<void> {
		this.deleted.push(remoteId);
		this.objects.delete(remoteId);
		this.folders.delete(remoteId.replace(/\/\.keep$/, ""));
	}
	async createFolder(parentFolderId: string, name: string): Promise<string> {
		const path = parentFolderId ? `${parentFolderId}/${name}` : name;
		this.folders.add(path);
		return path;
	}
	async getRemoteFolderId(relativePath: string): Promise<string> { return relativePath; }
}

class FakeUI implements SyncUIPort {
	firstSyncAnswer: FirstSyncStrategy = "merge";
	surfacedIssues: SyncIssue[] = [];
	cannedResolutions: SyncIssueResolution[] = [];

	async chooseFirstSyncStrategy(): Promise<FirstSyncStrategy> { return this.firstSyncAnswer; }
	async resolveSyncIssues(issues: SyncIssue[]): Promise<SyncIssueResolution[]> {
		this.surfacedIssues.push(...issues);
		return this.cannedResolutions;
	}
}

function makeState(records: SyncFileRecord[] = [], lastSyncTime = 1000): { state: SyncState; store: SyncStateStore } {
	const state: SyncState = { files: {}, lastSyncTime };
	for (const r of records) state.files[r.vaultPath] = r;
	return { state, store: new SyncStateStore(state, async () => {}) };
}

function record(path: string, over: Partial<SyncFileRecord> = {}): SyncFileRecord {
	return {
		vaultPath: path, remoteId: path, remoteFolderId: "",
		localModTime: 1000, remoteModTime: 1000,
		contentHash: computeMD5(new TextEncoder().encode("v1").buffer as ArrayBuffer),
		size: 2,
		...over,
	};
}

function makeEngine(
	fs: FakeLocalFs, provider: FakeProvider, store: SyncStateStore, ui: FakeUI,
	strategy: "prompt" | "smart-merge" | "latest-wins" | "use-local" | "use-remote" = "prompt",
): SyncEngine {
	return new SyncEngine(fs, "/root", provider, store, ui, {
		conflictStrategy: strategy, excludePatterns: [],
	});
}

describe("SyncEngine classification", () => {
	let fs: FakeLocalFs;
	let provider: FakeProvider;
	let ui: FakeUI;

	beforeEach(() => {
		fs = new FakeLocalFs();
		provider = new FakeProvider();
		ui = new FakeUI();
	});

	it("uploads a new local file", async () => {
		fs.setFile("a.md", "hello", 2000);
		const { store } = makeState();
		const result = await makeEngine(fs, provider, store, ui).sync();
		expect(result.uploaded).toBe(1);
		expect(provider.objects.has("a.md")).toBe(true);
		expect(store.getRecord("a.md")?.size).toBe(5);
	});

	it("downloads a new remote file", async () => {
		provider.setObject("b.md", "remote", 500);
		const { store } = makeState();
		const result = await makeEngine(fs, provider, store, ui).sync();
		expect(result.downloaded).toBe(1);
		expect(fs.files.has("b.md")).toBe(true);
	});

	it("local edit propagates as update-remote", async () => {
		fs.setFile("a.md", "v2", 2000);
		provider.setObject("a.md", "v1", 1000);
		const { store } = makeState([record("a.md")]);
		const result = await makeEngine(fs, provider, store, ui).sync();
		expect(result.uploaded).toBe(1);
		expect(new TextDecoder().decode(provider.objects.get("a.md")!.bytes)).toBe("v2");
	});

	it("size change alone (mtime preserved) still counts as a local change", async () => {
		fs.setFile("a.md", "longer content", 1000); // mtime NOT newer than record
		provider.setObject("a.md", "v1", 1000);
		const { store } = makeState([record("a.md", { size: 2 })]);
		const result = await makeEngine(fs, provider, store, ui).sync();
		expect(result.uploaded).toBe(1);
	});

	it("legacy record without size falls back to mtime-only (no false positive)", async () => {
		fs.setFile("a.md", "v1", 1000);
		provider.setObject("a.md", "v1", 1000);
		const { store } = makeState([record("a.md", { size: undefined })]);
		const result = await makeEngine(fs, provider, store, ui).sync();
		expect(result.uploaded).toBe(0);
		expect(result.downloaded).toBe(0);
	});

	it("remote edit propagates as update-local", async () => {
		fs.setFile("a.md", "v1", 1000);
		provider.setObject("a.md", "v2", 2000);
		const { store } = makeState([record("a.md")]);
		const result = await makeEngine(fs, provider, store, ui).sync();
		expect(result.downloaded).toBe(1);
		expect(new TextDecoder().decode(fs.files.get("a.md")!.bytes)).toBe("v2");
	});

	it("stale download that doesn't match the listing etag is not written locally", async () => {
		fs.setFile("a.md", "v2 local edit", 1000);
		provider.setObject("a.md", "v1 cached", 2000, computeMD5(new TextEncoder().encode("v3 server").buffer as ArrayBuffer));
		const { store } = makeState([record("a.md", { size: 13 })]);
		const before = { ...store.getRecord("a.md")! };
		const result = await makeEngine(fs, provider, store, ui).sync();
		expect(result.downloaded).toBe(0);
		expect(result.errors).toBe(1);
		expect(new TextDecoder().decode(fs.files.get("a.md")!.bytes)).toBe("v2 local edit");
		expect(store.getRecord("a.md")).toEqual(before);
	});

	it("both changed with identical content auto-resolves silently (verification read)", async () => {
		fs.setFile("a.md", "same", 2000);
		provider.setObject("a.md", "same", 2000);
		const { store } = makeState([record("a.md")]);
		const result = await makeEngine(fs, provider, store, ui).sync();
		expect(result.conflicts).toBe(0);
		expect(ui.surfacedIssues).toHaveLength(0);
		expect(store.getRecord("a.md")?.contentHash).toBe(computeMD5(new TextEncoder().encode("same").buffer as ArrayBuffer));
	});

	it("both changed above the hash threshold skips the verification read", async () => {
		fs.setFileWithSize("big.bin", HASH_VERIFY_THRESHOLD_BYTES, 2000);
		provider.setObject("big.bin", "x", 2000);
		const { store } = makeState([record("big.bin", { size: HASH_VERIFY_THRESHOLD_BYTES })]);
		fs.readFileCalls = 0;
		await makeEngine(fs, provider, store, ui).sync();
		expect(fs.readFileCalls).toBe(0); // no verification read
		expect(ui.surfacedIssues.some((i) => i.type === "conflict")).toBe(true);
	});

	it("multipart etag is treated as changed, never hash-compared", async () => {
		fs.setFile("big.bin", "v1", 1000); // local unchanged
		provider.setObject("big.bin", "irrelevant", 2000, "abc123-5");
		const { store } = makeState([record("big.bin")]);
		const result = await makeEngine(fs, provider, store, ui).sync();
		expect(result.downloaded).toBe(1); // remote considered changed
	});

	it("binary content under smart-merge is never merge2way'd", async () => {
		const bin = new Uint8Array([1, 0, 2, 0, 3]);
		fs.files.set("blob.dat", { bytes: bin, mtimeMs: 2000 });
		provider.objects.set("blob.dat", { bytes: new Uint8Array([9, 0, 8]), modifiedTime: 2000 });
		const { store } = makeState([record("blob.dat", { contentHash: "nope" })]);
		await makeEngine(fs, provider, store, ui, "smart-merge").sync();
		// surfaced as conflict rather than merged/corrupted
		expect(ui.surfacedIssues.some((i) => i.type === "conflict")).toBe(true);
		expect(fs.files.get("blob.dat")!.bytes).toEqual(bin);
	});
});

describe("SyncEngine delete handling", () => {
	let fs: FakeLocalFs;
	let provider: FakeProvider;
	let ui: FakeUI;

	beforeEach(() => {
		fs = new FakeLocalFs();
		provider = new FakeProvider();
		ui = new FakeUI();
	});

	it("propagates a local delete when remote is unchanged (safe case)", async () => {
		provider.setObject("a.md", "v1", 1000);
		const { store } = makeState([record("a.md")]);
		const result = await makeEngine(fs, provider, store, ui).sync();
		expect(result.deleted).toBe(1);
		expect(provider.objects.has("a.md")).toBe(false);
	});

	it("delete-conflict: local delete vs remote change re-downloads under latest-wins", async () => {
		provider.setObject("a.md", "newer remote", 2000);
		const { store } = makeState([record("a.md")]);
		const result = await makeEngine(fs, provider, store, ui, "latest-wins").sync();
		expect(result.downloaded).toBe(1);
		expect(fs.files.has("a.md")).toBe(true);
		expect(provider.objects.has("a.md")).toBe(true);
	});

	it("delete-conflict honors the deletion under use-local", async () => {
		provider.setObject("a.md", "newer remote", 2000);
		const { store } = makeState([record("a.md")]);
		const result = await makeEngine(fs, provider, store, ui, "use-local").sync();
		expect(result.deleted).toBe(1);
		expect(provider.objects.has("a.md")).toBe(false);
	});

	it("delete-conflict surfaces an issue under prompt, resolvable both ways", async () => {
		provider.setObject("a.md", "newer remote", 2000);
		const { store } = makeState([record("a.md")]);
		ui.cannedResolutions = [{ vaultPath: "a.md", resolution: "remote", remoteId: "a.md" }];
		await makeEngine(fs, provider, store, ui, "prompt").sync();
		expect(ui.surfacedIssues).toEqual([expect.objectContaining({ type: "delete-conflict", vaultPath: "a.md" })]);
		expect(fs.files.has("a.md")).toBe(true); // "remote" → re-download
	});

	it("delete-conflict resolution 'local' deletes remote", async () => {
		provider.setObject("a.md", "newer remote", 2000);
		const { store } = makeState([record("a.md")]);
		ui.cannedResolutions = [{ vaultPath: "a.md", resolution: "local", remoteId: "a.md" }];
		await makeEngine(fs, provider, store, ui, "prompt").sync();
		expect(provider.objects.has("a.md")).toBe(false);
	});

	it("remote delete propagates locally when local is unchanged", async () => {
		fs.setFile("a.md", "v1", 1000);
		const { store } = makeState([record("a.md")]);
		const result = await makeEngine(fs, provider, store, ui).sync();
		expect(result.deleted).toBe(1);
		expect(fs.files.has("a.md")).toBe(false);
	});

	it("remote delete vs local edit keeps the edit (re-upload)", async () => {
		fs.setFile("a.md", "edited locally", 2000);
		const { store } = makeState([record("a.md")]);
		const result = await makeEngine(fs, provider, store, ui).sync();
		expect(result.uploaded).toBe(1);
		expect(fs.files.has("a.md")).toBe(true);
		expect(provider.objects.has("a.md")).toBe(true);
	});

	it("stale record with nothing left on either side is dropped", async () => {
		const { store } = makeState([record("gone.md")]);
		const result = await makeEngine(fs, provider, store, ui).sync();
		expect(result.deleted).toBe(0);
		expect(store.getRecord("gone.md")).toBeUndefined();
	});
});

describe("SyncEngine first sync + folders", () => {
	let fs: FakeLocalFs;
	let provider: FakeProvider;
	let ui: FakeUI;

	beforeEach(() => {
		fs = new FakeLocalFs();
		provider = new FakeProvider();
		ui = new FakeUI();
	});

	it("first sync 'download' prefers remote for files existing on both sides", async () => {
		fs.setFile("a.md", "local", 2000);
		provider.setObject("a.md", "remote", 1000);
		const { store } = makeState([], 0);
		ui.firstSyncAnswer = "download";
		await makeEngine(fs, provider, store, ui).sync();
		expect(new TextDecoder().decode(fs.files.get("a.md")!.bytes)).toBe("remote");
	});

	it("first sync 'upload' prefers local for files existing on both sides", async () => {
		fs.setFile("a.md", "local", 2000);
		provider.setObject("a.md", "remote", 1000);
		const { store } = makeState([], 0);
		ui.firstSyncAnswer = "upload";
		await makeEngine(fs, provider, store, ui).sync();
		expect(new TextDecoder().decode(provider.objects.get("a.md")!.bytes)).toBe("local");
	});

	it("creates a remote folder for a new local folder and tracks it", async () => {
		fs.folders.add("Audio");
		const { store } = makeState();
		const result = await makeEngine(fs, provider, store, ui).sync();
		expect(result.uploaded).toBe(1);
		expect(provider.folders.has("Audio")).toBe(true);
		expect(store.getRecord("Audio")?.contentHash).toBe("__folder__");
	});

	it("creates a local folder for a new remote folder", async () => {
		provider.folders.add("Docs");
		const { store } = makeState();
		const result = await makeEngine(fs, provider, store, ui).sync();
		expect(result.downloaded).toBe(1);
		expect(fs.folders.has("Docs")).toBe(true);
	});

	it("tracked folder gone locally deletes the remote folder", async () => {
		provider.folders.add("Old");
		const { store } = makeState([record("Old", { contentHash: "__folder__", remoteId: "Old" })]);
		const result = await makeEngine(fs, provider, store, ui).sync();
		expect(result.deleted).toBe(1);
		expect(provider.folders.has("Old")).toBe(false);
	});
});
