import { SyncStateStore } from "../../src/sync/sync-state";
import { computeMD5 } from "../../src/util/hash";
import type { CloudProvider } from "../../src/providers/cloud-provider";
import type { LocalFileEntry, LocalFileSystem } from "../../src/fs/local-file-system";
import type { RemoteFileInfo, SyncState, SyncFileRecord } from "../../src/types";
import type { FirstSyncStrategy, SyncIssue, SyncIssueResolution, SyncUIPort } from "../../src/sync/sync-ui-port";

// Shared in-memory fakes for engine tests.

export class FakeLocalFs implements LocalFileSystem {
	files = new Map<string, { bytes: Uint8Array; mtimeMs: number }>();
	folders = new Set<string>();
	readFileCalls = 0;
	writeCalls = 0;

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
		this.writeCalls++;
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

export class FakeProvider implements CloudProvider {
	readonly name = "fake";
	objects = new Map<string, { bytes: Uint8Array; modifiedTime: number; etag?: string }>();
	folders = new Set<string>();
	deleted: string[] = [];
	writeCalls = 0;
	downloadCalls = 0;

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
		this.downloadCalls++;
		const o = this.objects.get(remoteId);
		if (!o) throw new Error(`not found: ${remoteId}`);
		return o.bytes.buffer.slice(0) as ArrayBuffer;
	}
	async uploadFile(parentFolderId: string, name: string, content: ArrayBuffer): Promise<string> {
		this.writeCalls++;
		const key = parentFolderId ? `${parentFolderId}/${name}` : name;
		this.objects.set(key, { bytes: new Uint8Array(content), modifiedTime: Date.now() });
		return key;
	}
	async updateFile(remoteId: string, content: ArrayBuffer): Promise<void> {
		this.writeCalls++;
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

export class FakeUI implements SyncUIPort {
	firstSyncAnswer: FirstSyncStrategy = "merge";
	surfacedIssues: SyncIssue[] = [];
	cannedResolutions: SyncIssueResolution[] = [];
	externalMerge?: (vaultPath: string, remoteId: string) => Promise<void>;

	async chooseFirstSyncStrategy(): Promise<FirstSyncStrategy> { return this.firstSyncAnswer; }
	async resolveSyncIssues(issues: SyncIssue[]): Promise<SyncIssueResolution[]> {
		this.surfacedIssues.push(...issues);
		return this.cannedResolutions;
	}
}

export function makeState(records: SyncFileRecord[] = [], lastSyncTime = 1000): { state: SyncState; store: SyncStateStore } {
	const state: SyncState = { files: {}, lastSyncTime };
	for (const r of records) state.files[r.vaultPath] = r;
	return { state, store: new SyncStateStore(state, async () => {}) };
}

export function record(path: string, over: Partial<SyncFileRecord> = {}): SyncFileRecord {
	return {
		vaultPath: path, remoteId: path, remoteFolderId: "",
		localModTime: 1000, remoteModTime: 1000,
		contentHash: computeMD5(new TextEncoder().encode("v1").buffer as ArrayBuffer),
		size: 2,
		...over,
	};
}
