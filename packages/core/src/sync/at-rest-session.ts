// One encrypted-at-rest folder on this device, while the app runs (DEV-392,
// DEV-393; design: docs/design/at-rest-encryption.md).
//
// Holds the folder's keys in memory between unlock() and lock(), and does
// every file operation on decrypted paths: list the tree, read, write,
// create, rename/move and delete. Plaintext only ever exists in memory and
// in what callers do with it; everything written goes through
// encryptAtRest() first.
//
// Locks itself after `idleMs` without touch(), and on lock("background") /
// lock("manual") from the host. Before dropping the keys it awaits every
// registered flusher, so an editor can save pending edits.

import type { LocalFileSystem } from "../fs/local-file-system";
import { isDotPath } from "../util/path";
import { MULTIPART_THRESHOLD_BYTES } from "../util/constants";
import {
	CONTENT_OVERHEAD_BYTES,
	folderMode,
	unlockKeyFile,
	type FolderKeyFile,
	type FolderKeys,
} from "../crypto/folder-crypto";
import { decryptAtRest, encryptAtRest, fromAtRestPath, isAtRestFile, toAtRestPath } from "../crypto/at-rest";

export const DEFAULT_IDLE_LOCK_MS = 5 * 60 * 1000;

export type LockReason = "manual" | "idle" | "background" | "key-changed";

export interface AtRestNode {
	plainPath: string;
	// Path on disk (encrypted segments, ".cdse" on files)
	diskPath: string;
	isFile: boolean;
}

export interface AtRestListing {
	nodes: AtRestNode[];
	// Disk paths under the folder that aren't readable with these keys:
	// leftovers from another key generation, or junk
	unreadable: string[];
	// Files without ".cdse" (not encrypted): a leak, shown to the user so they
	// can encrypt or remove them. The sync engine refuses to upload them.
	plaintext: string[];
}

export class AtRestLockedError extends Error {
	constructor(folder: string) {
		super(`${folder} is locked`);
		this.name = "AtRestLockedError";
	}
}

export interface AtRestSessionOptions {
	idleMs?: number;
	onLock?: (reason: LockReason) => void;
}

export class AtRestSession {
	private keys: FolderKeys | null = null;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private flushers = new Set<() => Promise<void>>();
	private readonly idleMs: number;

	constructor(
		private fs: LocalFileSystem,
		private root: string,
		readonly folder: string,
		private keyFile: FolderKeyFile,
		private opts: AtRestSessionOptions = {},
	) {
		if (folderMode(keyFile) !== "at-rest") throw new Error(`${folder} is not an at-rest folder`);
		this.idleMs = opts.idleMs ?? DEFAULT_IDLE_LOCK_MS;
	}

	get unlocked(): boolean {
		return this.keys !== null;
	}

	get keyId(): string {
		return this.keyFile.keyId;
	}

	// ---------- lock / unlock ----------

	// Throws WrongPasswordError on a wrong password
	async unlock(password: string): Promise<void> {
		this.keys = await unlockKeyFile(this.keyFile, password);
		this.touch();
	}

	// Any user interaction with the folder's UI: restarts the idle timer
	touch(): void {
		if (!this.keys) return;
		if (this.idleTimer !== null) clearTimeout(this.idleTimer);
		this.idleTimer = setTimeout(() => void this.lock("idle"), this.idleMs);
	}

	// Lets an open editor save before the keys are dropped
	addFlusher(flush: () => Promise<void>): () => void {
		this.flushers.add(flush);
		return () => this.flushers.delete(flush);
	}

	async lock(reason: LockReason): Promise<void> {
		if (!this.keys) return;
		for (const flush of [...this.flushers]) {
			try {
				await flush();
			} catch (e) {
				console.error(`Saving before lock failed for ${this.folder}:`, e);
			}
		}
		this.keys = null;
		if (this.idleTimer !== null) clearTimeout(this.idleTimer);
		this.idleTimer = null;
		this.opts.onLock?.(reason);
	}

	// A newer key file arrived (synced from another device). A new key
	// generation means a password change elsewhere: lock, so the user unlocks
	// with the new password.
	async updateKeyFile(keyFile: FolderKeyFile): Promise<void> {
		const changed = keyFile.keyId !== this.keyFile.keyId;
		this.keyFile = keyFile;
		if (changed) await this.lock("key-changed");
	}

	private requireKeys(): FolderKeys {
		if (!this.keys) throw new AtRestLockedError(this.folder);
		return this.keys;
	}

	// ---------- tree ----------

	async list(): Promise<AtRestListing> {
		const keys = this.requireKeys();
		const prefix = this.folder + "/";
		const out: AtRestListing = { nodes: [], unreadable: [], plaintext: [] };
		const consider = async (diskPath: string, isFile: boolean) => {
			if (!diskPath.startsWith(prefix) || isDotPath(diskPath.slice(prefix.length))) return;
			if (isFile && !isAtRestFile(diskPath)) {
				out.plaintext.push(diskPath);
				return;
			}
			try {
				const entry = await fromAtRestPath(keys, this.folder, diskPath);
				if (entry.isFile !== isFile) throw new Error("kind mismatch");
				out.nodes.push({ plainPath: entry.plainPath, diskPath, isFile });
			} catch {
				out.unreadable.push(diskPath);
			}
		};
		for (const f of await this.fs.listFiles(this.root)) await consider(f.path, true);
		for (const d of await this.fs.listFolders(this.root)) await consider(d, false);
		out.nodes.sort((a, b) => a.plainPath.localeCompare(b.plainPath));
		return out;
	}

	// ---------- files ----------

	async read(plainPath: string): Promise<Uint8Array> {
		const keys = this.requireKeys();
		const disk = await toAtRestPath(keys, this.folder, plainPath, true);
		return decryptAtRest(keys, plainPath, await this.fs.readFile(this.root, disk));
	}

	async write(plainPath: string, plaintext: Uint8Array): Promise<void> {
		const keys = this.requireKeys();
		if (plaintext.byteLength + CONTENT_OVERHEAD_BYTES >= MULTIPART_THRESHOLD_BYTES) {
			throw new Error(`${plainPath} is too large for an encrypted folder`);
		}
		const disk = await toAtRestPath(keys, this.folder, plainPath, true);
		await this.fs.writeFile(this.root, disk, await encryptAtRest(keys, plainPath, plaintext));
	}

	async exists(plainPath: string): Promise<boolean> {
		const keys = this.requireKeys();
		const asFile = await toAtRestPath(keys, this.folder, plainPath, true);
		if (await this.fs.statFile(this.root, asFile)) return true;
		const asFolder = await toAtRestPath(keys, this.folder, plainPath, false);
		return (await this.fs.listFolders(this.root)).includes(asFolder);
	}

	async createNote(plainPath: string, initial = ""): Promise<void> {
		if (await this.exists(plainPath)) throw new Error(`${plainPath} already exists`);
		await this.write(plainPath, new TextEncoder().encode(initial));
	}

	async createFolder(plainPath: string): Promise<void> {
		const keys = this.requireKeys();
		if (await this.exists(plainPath)) throw new Error(`${plainPath} already exists`);
		await this.fs.createFolder(this.root, await toAtRestPath(keys, this.folder, plainPath, false));
	}

	// Rename or move a file or folder. Names and content are bound to the
	// path, so every affected file is re-encrypted: new file first, old one
	// deleted after.
	async rename(fromPlain: string, toPlain: string): Promise<void> {
		const keys = this.requireKeys();
		if (fromPlain === toPlain) return;
		if (toPlain.startsWith(fromPlain + "/")) throw new Error(`Can't move ${fromPlain} into itself`);
		if (await this.exists(toPlain)) throw new Error(`${toPlain} already exists`);

		const { nodes } = await this.list();
		const moving = nodes.filter((n) => n.plainPath === fromPlain || n.plainPath.startsWith(fromPlain + "/"));
		if (moving.length === 0) throw new Error(`${fromPlain} not found`);
		const target = (p: string) => toPlain + p.slice(fromPlain.length);

		for (const n of moving.filter((m) => !m.isFile).sort((a, b) => a.plainPath.length - b.plainPath.length)) {
			await this.fs.createFolder(this.root, await toAtRestPath(keys, this.folder, target(n.plainPath), false));
		}
		for (const n of moving.filter((m) => m.isFile)) {
			const plain = await decryptAtRest(keys, n.plainPath, await this.fs.readFile(this.root, n.diskPath));
			const dest = target(n.plainPath);
			await this.fs.writeFile(
				this.root,
				await toAtRestPath(keys, this.folder, dest, true),
				await encryptAtRest(keys, dest, plain),
			);
			await this.fs.deleteFile(this.root, n.diskPath);
		}
		for (const n of moving.filter((m) => !m.isFile).sort((a, b) => b.plainPath.length - a.plainPath.length)) {
			await this.fs.deleteFolder(this.root, n.diskPath);
		}
	}

	async delete(plainPath: string): Promise<void> {
		this.requireKeys();
		const { nodes } = await this.list();
		const doomed = nodes.filter((n) => n.plainPath === plainPath || n.plainPath.startsWith(plainPath + "/"));
		if (doomed.length === 0) throw new Error(`${plainPath} not found`);
		for (const n of doomed.filter((d) => d.isFile)) await this.fs.deleteFile(this.root, n.diskPath);
		for (const n of doomed.filter((d) => !d.isFile).sort((a, b) => b.plainPath.length - a.plainPath.length)) {
			await this.fs.deleteFolder(this.root, n.diskPath);
		}
	}

	// [[Title]] → the note whose file name (without .md) matches, preferring
	// one in the same folder as `fromPath`
	async resolveLink(title: string, fromPath?: string): Promise<string | null> {
		const { nodes } = await this.list();
		const wanted = title.toLowerCase();
		const matches = nodes.filter((n) => {
			if (!n.isFile) return false;
			const base = n.plainPath.slice(n.plainPath.lastIndexOf("/") + 1);
			const bare = base.replace(/\.md$/i, "");
			return base.toLowerCase() === wanted || bare.toLowerCase() === wanted
				|| n.plainPath.toLowerCase() === `${this.folder}/${wanted}`.toLowerCase()
				|| n.plainPath.replace(/\.md$/i, "").toLowerCase() === `${this.folder}/${wanted}`.toLowerCase();
		});
		if (matches.length === 0) return null;
		if (fromPath) {
			const dir = fromPath.slice(0, fromPath.lastIndexOf("/"));
			const near = matches.find((m) => m.plainPath.slice(0, m.plainPath.lastIndexOf("/")) === dir);
			if (near) return near.plainPath;
		}
		return matches[0]!.plainPath;
	}
}
