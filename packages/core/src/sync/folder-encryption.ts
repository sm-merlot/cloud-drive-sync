// Sync-engine side of per-folder encryption (design:
// docs/design/per-folder-encryption.md, sections 1-2).
//
// Each sync pass calls prepare() with the raw remote listing. It finds the
// key files, decides per encrypted folder whether this device can read it, and
// returns the listing with encrypted names turned into plaintext vault paths.
// A folder this device cannot read is *locked*: every path in it is dropped
// from the listing, and the engine skips it in planning (shouldSkip), so a
// locked folder can never look deleted.

import type { CloudProvider } from "../providers/cloud-provider";
import type { RemoteFileInfo } from "../types";
import { computeMD5 } from "../util/hash";
import {
	KEY_FILE_NAME,
	decryptContent,
	decryptName,
	encryptContent,
	encryptName,
	parseKeyFile,
	unlockKeyFile,
	type FolderKeyFile,
	type FolderKeys,
} from "../crypto/folder-crypto";

export interface EncryptionSettings {
	// Vault-relative folders this device has configured as encrypted
	folders: string[];
	// Password for a folder, or null when this device has none for it
	passwordFor(folder: string): string | null;
}

export interface LockedFolder {
	path: string;
	reason: string;
}

interface UnlockedFolder {
	keyFile: FolderKeyFile;
	keys: FolderKeys;
}

interface CachedUnlock extends UnlockedFolder {
	etag: string;
	password: string;
}

function isUnder(path: string, folder: string): boolean {
	return path === folder || path.startsWith(folder + "/");
}

export class FolderEncryption {
	// Survives across passes: PBKDF2 at 600k iterations runs once per
	// (folder, key file version, password), not once per sync.
	private unlockCache = new Map<string, CachedUnlock>();

	private locked = new Map<string, string>();
	private unlocked = new Map<string, UnlockedFolder>();
	private remotePathCache = new Map<string, string>();

	constructor(
		private provider: CloudProvider,
		private settings: EncryptionSettings,
	) {}

	get lockedFolders(): LockedFolder[] {
		return Array.from(this.locked, ([path, reason]) => ({ path, reason }));
	}

	isLocked(path: string): boolean {
		for (const f of this.locked.keys()) if (isUnder(path, f)) return true;
		return false;
	}

	private unlockedFolderOf(path: string): string | null {
		for (const f of this.unlocked.keys()) if (path.startsWith(f + "/")) return f;
		return null;
	}

	// True for files (not the folder root itself) inside an unlocked encrypted
	// folder: their content is encrypted on the remote.
	isEncryptedPath(path: string): boolean {
		return this.unlockedFolderOf(path) !== null;
	}

	async prepare(remote: RemoteFileInfo[]): Promise<RemoteFileInfo[]> {
		this.locked = new Map();
		this.unlocked = new Map();
		this.remotePathCache = new Map();

		// 1. Key files on the remote. Nested key files (inside another
		// encrypted folder) are unsupported and ignored here; their folder is
		// already covered by the outer one.
		const keyFiles = new Map<string, RemoteFileInfo>();
		for (const f of remote) {
			if (f.isFolder || f.name !== KEY_FILE_NAME) continue;
			const folder = f.path.slice(0, -(KEY_FILE_NAME.length + 1));
			if (folder) keyFiles.set(folder, f);
		}

		// 2. Decide locked/unlocked per folder
		const folders = new Set<string>([...keyFiles.keys(), ...this.settings.folders]);
		for (const folder of folders) {
			const reason = await this.tryUnlock(folder, keyFiles.get(folder));
			if (reason) this.locked.set(folder, reason);
		}

		// 3. Translate names in unlocked folders. Any name that doesn't
		// decrypt locks the whole folder: dropping just that entry would make
		// it look deleted remotely.
		const out: RemoteFileInfo[] = [];
		const translated = new Map<string, RemoteFileInfo[]>();
		const plainPrefix = new Map<string, string>(); // remote path → plain path
		for (const f of remote) {
			if (this.isLocked(f.path)) continue;
			const folder = this.unlockedFolderOf(f.path);
			if (!folder) {
				out.push(f);
				continue;
			}
			if (this.locked.has(folder)) continue;
			if (f.name === KEY_FILE_NAME && f.path === `${folder}/${KEY_FILE_NAME}`) continue;
			try {
				const plain = await this.toPlainPath(folder, f.path, plainPrefix);
				const list = translated.get(folder) ?? [];
				list.push({
					...f,
					path: plain,
					name: plain.slice(plain.lastIndexOf("/") + 1),
					parentId: f.parentId,
				});
				translated.set(folder, list);
			} catch {
				this.locked.set(folder, `Unreadable file ${f.path} in ${folder}`);
				this.unlocked.delete(folder);
			}
		}
		for (const [folder, list] of translated) {
			if (!this.locked.has(folder)) out.push(...list);
		}
		return out;
	}

	// Returns a lock reason, or null when the folder is unlocked.
	private async tryUnlock(folder: string, keyInfo: RemoteFileInfo | undefined): Promise<string | null> {
		if (!keyInfo) return `Key file missing for ${folder}`;
		const password = this.settings.passwordFor(folder);
		if (!password) return `No password for ${folder}`;

		const cached = this.unlockCache.get(folder);
		const etag = keyInfo.md5Checksum;
		if (cached && etag && cached.etag === etag && cached.password === password) {
			if (cached.keyFile.rotation) return `Password change in progress for ${folder}`;
			this.unlocked.set(folder, cached);
			return null;
		}

		let keyFile: FolderKeyFile;
		try {
			const bytes = await this.provider.downloadFile(keyInfo.id);
			// Same stale-cache guard as file downloads (iOS, DEV-208)
			if (etag && computeMD5(bytes) !== etag) return `Key file for ${folder} is stale; next sync retries`;
			keyFile = parseKeyFile(new TextDecoder().decode(bytes));
		} catch (e) {
			return `Unreadable key file for ${folder}: ${e instanceof Error ? e.message : String(e)}`;
		}

		let keys: FolderKeys;
		try {
			keys = await unlockKeyFile(keyFile, password);
		} catch {
			return `Wrong password for ${folder}`;
		}
		this.unlockCache.set(folder, { etag, password, keyFile, keys });
		if (keyFile.rotation) return `Password change in progress for ${folder}`;
		this.unlocked.set(folder, { keyFile, keys });
		return null;
	}

	private async toPlainPath(folder: string, remotePath: string, cache: Map<string, string>): Promise<string> {
		const keys = this.unlocked.get(folder)!.keys;
		const segments = remotePath.slice(folder.length + 1).split("/");
		let remotePrefix = folder;
		let plainPrefix = folder;
		for (const seg of segments) {
			remotePrefix = `${remotePrefix}/${seg}`;
			let plain = cache.get(remotePrefix);
			if (plain === undefined) {
				plain = `${plainPrefix}/${await decryptName(keys, plainPrefix, seg)}`;
				cache.set(remotePrefix, plain);
				this.remotePathCache.set(plain, remotePrefix);
			}
			plainPrefix = plain;
		}
		return plainPrefix;
	}

	// Plain vault path → path on the remote (encrypted segments below an
	// unlocked folder; unchanged elsewhere).
	async toRemotePath(plainPath: string): Promise<string> {
		const folder = this.unlockedFolderOf(plainPath);
		if (!folder) return plainPath;
		const hit = this.remotePathCache.get(plainPath);
		if (hit) return hit;
		const keys = this.unlocked.get(folder)!.keys;
		const segments = plainPath.slice(folder.length + 1).split("/");
		let plainPrefix = folder;
		let remotePrefix = folder;
		for (const seg of segments) {
			remotePrefix = `${remotePrefix}/${await encryptName(keys, plainPrefix, seg)}`;
			plainPrefix = `${plainPrefix}/${seg}`;
		}
		this.remotePathCache.set(plainPath, remotePrefix);
		return remotePrefix;
	}

	// Encrypted name of the last segment of a plain path
	async remoteName(plainPath: string): Promise<string> {
		const remote = await this.toRemotePath(plainPath);
		return remote.slice(remote.lastIndexOf("/") + 1);
	}

	async encrypt(plainPath: string, plaintext: Uint8Array): Promise<Uint8Array> {
		const folder = this.unlockedFolderOf(plainPath);
		if (!folder) throw new Error(`Not in an unlocked encrypted folder: ${plainPath}`);
		return encryptContent(this.unlocked.get(folder)!.keys, plainPath, plaintext);
	}

	async decrypt(plainPath: string, data: Uint8Array): Promise<Uint8Array> {
		const folder = this.unlockedFolderOf(plainPath);
		if (!folder) throw new Error(`Not in an unlocked encrypted folder: ${plainPath}`);
		return decryptContent(this.unlocked.get(folder)!.keys, plainPath, data);
	}
}
