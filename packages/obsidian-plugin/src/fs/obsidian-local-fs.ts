import { App, TFile, TFolder } from "obsidian";
import type { LocalFileEntry, LocalFileSystem } from "@cloud-drive-sync/core";

// Vault-backed LocalFileSystem. `root` is unused — vault paths are already
// relative to the vault root. Deletes go through vault.trash() so files land
// in Obsidian's recoverable trash, preserving the plugin's historical
// soft-delete behavior.
export class ObsidianLocalFileSystem implements LocalFileSystem {
	constructor(private app: App) {}

	async listFiles(_root: string): Promise<LocalFileEntry[]> {
		return this.app.vault.getFiles().map((f) => ({
			path: f.path,
			mtimeMs: f.stat.mtime,
			size: f.stat.size,
		}));
	}

	async listFolders(_root: string): Promise<string[]> {
		const paths: string[] = [];
		const walk = (folder: TFolder) => {
			for (const child of folder.children) {
				if (child instanceof TFolder) {
					paths.push(child.path);
					walk(child);
				}
			}
		};
		walk(this.app.vault.getRoot());
		return paths;
	}

	async readFile(_root: string, relPath: string): Promise<Uint8Array> {
		const file = this.app.vault.getAbstractFileByPath(relPath);
		if (!(file instanceof TFile)) throw new Error(`not a file: ${relPath}`);
		return new Uint8Array(await this.app.vault.readBinary(file));
	}

	async writeFile(_root: string, relPath: string, content: Uint8Array): Promise<void> {
		const buffer = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
		const existing = this.app.vault.getAbstractFileByPath(relPath);
		if (existing instanceof TFile) {
			await this.app.vault.modifyBinary(existing, buffer);
			return;
		}
		if (existing) throw new Error(`a folder already exists at ${relPath}, can't write a file there`);
		const parentPath = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
		if (parentPath) await this.ensureFolder(parentPath);
		try {
			await this.app.vault.createBinary(relPath, buffer);
		} catch (e) {
			// createBinary refuses when something is already on disk, which the
			// index lookup above missed. Two ways that happens, handled apart:
			// a case-only twin on a case-insensitive filesystem (Android), where
			// overwriting would clobber a different file, and a file the vault
			// index doesn't know about yet, which is safe to overwrite.
			const clash = await this.caseClash(relPath);
			if (clash) {
				throw new Error(`"${clash}" already exists locally and differs only by upper/lower case; rename one of them`);
			}
			if (await this.app.vault.adapter.exists(relPath, true)) {
				await this.app.vault.adapter.writeBinary(relPath, buffer);
				return;
			}
			throw e;
		}
	}

	async deleteFile(_root: string, relPath: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(relPath);
		if (file instanceof TFile) {
			await this.app.vault.trash(file, true);
		}
	}

	async createFolder(_root: string, relPath: string): Promise<void> {
		await this.ensureFolder(relPath);
	}

	async deleteFolder(_root: string, relPath: string): Promise<void> {
		const folder = this.app.vault.getAbstractFileByPath(relPath);
		if (folder instanceof TFolder) {
			await this.app.vault.trash(folder, true);
		}
	}

	async statFile(_root: string, relPath: string): Promise<LocalFileEntry | null> {
		const file = this.app.vault.getAbstractFileByPath(relPath);
		if (!(file instanceof TFile)) return null;
		return { path: relPath, mtimeMs: file.stat.mtime, size: file.stat.size };
	}

	private async ensureFolder(path: string): Promise<void> {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing instanceof TFolder) return;
		if (existing) throw new Error(`a file already exists at ${path}, can't create a folder there`);
		const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
		if (parent) {
			await this.ensureFolder(parent);
		}
		try {
			await this.app.vault.createFolder(path);
		} catch (e) {
			// Same split as writeFile: a case-only twin is a real clash, a
			// folder that's on disk but missing from the index is fine as is.
			const clash = await this.caseClash(path);
			if (clash) {
				throw new Error(`"${clash}" already exists locally and differs only by upper/lower case; rename one of them`);
			}
			if (await this.app.vault.adapter.exists(path, true)) return;
			throw e;
		}
	}

	// Finds an on-disk entry whose path equals `path` ignoring case but not
	// exactly. Checks the real directory listing, not the vault index, since
	// a stale index is one of the cases this is guarding against.
	private async caseClash(path: string): Promise<string | null> {
		const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
		const lower = path.toLowerCase();
		try {
			const listing = await this.app.vault.adapter.list(parent || "/");
			for (const entry of [...listing.files, ...listing.folders]) {
				const p = entry.replace(/^\/+/, "");
				if (p !== path && p.toLowerCase() === lower) return p;
			}
		} catch {
			// parent unreadable; fall through to the exact-path check
		}
		const inIndex = this.app.vault
			.getAllLoadedFiles()
			.find((f) => f.path !== path && f.path.toLowerCase() === lower);
		return inIndex?.path ?? null;
	}
}
