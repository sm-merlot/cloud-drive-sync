import { describe, it, expect, beforeEach } from "vitest";
import { SyncEngine } from "../src/sync/sync-engine";
import { SyncStateStore } from "../src/sync/sync-state";
import { HASH_VERIFY_THRESHOLD_BYTES } from "../src/util/constants";
import { computeMD5 } from "../src/util/hash";
import { FakeLocalFs, FakeProvider, FakeUI, makeState, record } from "./helpers/fakes";

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

	it("creates a nested remote folder under the parent's id, not its path", async () => {
		// Google Drive ids are opaque, unlike the fake's path-shaped ones
		const ids = new Map<string, string>([["", "root-id"], ["Work", "work-id"]]);
		const parents: string[] = [];
		provider.getRemoteFolderId = async (p) => ids.get(p) ?? `${p}-id`;
		provider.createFolder = async (parentId, name) => {
			parents.push(parentId);
			return `${name}-id`;
		};
		fs.folders.add("Work");
		fs.folders.add("Work/Projects");
		const { store } = makeState();
		await makeEngine(fs, provider, store, ui).sync();
		expect(parents).toEqual(["root-id", "work-id"]);
		expect(store.getRecord("Work/Projects")?.remoteFolderId).toBe("work-id");
	});

	it("surfaces a failed folder create in the issues dialog", async () => {
		provider.createFolder = async () => { throw new Error("Drive create folder failed (404)"); };
		fs.folders.add("Audio");
		const { store } = makeState();
		const result = await makeEngine(fs, provider, store, ui).sync();
		expect(result.errors).toBe(1);
		expect(ui.surfacedIssues).toEqual([
			expect.objectContaining({ vaultPath: "Audio", type: "error", errorMessage: "Drive create folder failed (404)" }),
		]);
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

// DEV-33: a newer local mtime with unchanged bytes (Obsidian's cached
// TFile.stat refreshing late, or a file touched outside Obsidian) must not
// count as a local edit.
describe("SyncEngine stale local mtime", () => {
	let fs: FakeLocalFs;
	let provider: FakeProvider;
	let ui: FakeUI;

	beforeEach(() => {
		fs = new FakeLocalFs();
		provider = new FakeProvider();
		ui = new FakeUI();
	});

	it("does not re-upload a file whose bytes match the record", async () => {
		fs.setFile("a.md", "v1", 5000);
		provider.setObject("a.md", "v1", 1000);
		const { store } = makeState([record("a.md")]);
		const engine = makeEngine(fs, provider, store, ui);

		const first = await engine.sync();
		expect(first.uploaded).toBe(0);
		expect(store.getRecord("a.md")?.localModTime).toBe(5000);

		const readsAfterFirst = fs.readFileCalls;
		const second = await engine.sync();
		expect(second.uploaded).toBe(0);
		expect(fs.readFileCalls).toBe(readsAfterFirst); // healed: no re-hash
	});

	it("deletes locally, not re-uploads, when the file was moved or deleted on the server", async () => {
		fs.setFile("old/a.md", "v1", 5000);
		provider.setObject("new/a.md", "v1", 3000);
		const { store } = makeState([record("old/a.md")]);
		const result = await makeEngine(fs, provider, store, ui).sync();

		expect(provider.objects.has("old/a.md")).toBe(false);
		expect(fs.files.has("old/a.md")).toBe(false);
		expect(fs.files.has("new/a.md")).toBe(true);
		expect(result.uploaded).toBe(0);
	});

	it("takes a remote edit instead of raising a conflict", async () => {
		fs.setFile("a.md", "v1", 5000);
		provider.setObject("a.md", "v2 from server", 3000);
		const { store } = makeState([record("a.md")]);
		const result = await makeEngine(fs, provider, store, ui).sync();

		expect(result.downloaded).toBe(1);
		expect(result.uploaded).toBe(0);
		expect(ui.surfacedIssues).toHaveLength(0);
		expect(new TextDecoder().decode(fs.files.get("a.md")!.bytes)).toBe("v2 from server");
	});

	it("still uploads a same-size edit", async () => {
		fs.setFile("a.md", "v2", 5000);
		provider.setObject("a.md", "v1", 1000);
		const { store } = makeState([record("a.md")]);
		const result = await makeEngine(fs, provider, store, ui).sync();
		expect(result.uploaded).toBe(1);
	});
});
