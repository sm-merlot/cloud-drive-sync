// Enable / change password / remove for an encrypted folder (DEV-382; design:
// docs/design/per-folder-encryption.md, "Password change" and "Enabling").
//
// Every operation follows the same pattern:
//   1. validate everything up front (nothing written on failure)
//   2. write the key file with a `rotation` marker, which locks the folder on
//      every other device
//   3. move each object to its new generation: write the new copy first, then
//      delete the old one, so a crash at any point leaves every file readable
//      in at least one generation
//   4. clear the marker (or delete the key file, for removal)
// Calling the same operation again with the same passwords resumes from
// wherever a crash left it.

import type { CloudProvider } from "../providers/cloud-provider";
import type { RemoteFileInfo } from "../types";
import type { SyncStateStore } from "./sync-state";
import { computeMD5 } from "../util/hash";
import { getParentPath, isDotPath } from "../util/path";
import { MULTIPART_THRESHOLD_BYTES } from "../util/constants";
import {
	CONTENT_OVERHEAD_BYTES,
	KEY_FILE_NAME,
	MAX_NAME_BYTES,
	NameTooLongError,
	createKeyFile,
	decryptContent,
	decryptName,
	encryptContent,
	encryptName,
	folderMode,
	parseKeyFile,
	serializeKeyFile,
	unlockKeyFile,
	type FolderKeyFile,
	type FolderKeys,
	type FolderMode,
} from "../crypto/folder-crypto";

export class EncryptionAdminError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EncryptionAdminError";
	}
}

export interface EncryptionAdminOptions {
	// PBKDF2 iterations for a new key file (tests use a low value)
	iterations?: number;
	onProgress?: (message: string) => void;
}

export type EncryptionProbe =
	| { state: "not-encrypted" }
	| { state: "encrypted"; passwordOk: boolean; changeInProgress: boolean; mode: FolderMode; keyFile: FolderKeyFile };

// A key generation: null keys = plaintext
type Gen = FolderKeys | null;

interface KeyFileOnRemote {
	info: RemoteFileInfo;
	keyFile: FolderKeyFile;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function isMultipartEtag(etag: string): boolean {
	return /-\d+$/.test(etag);
}

function lastSegment(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

function depth(path: string): number {
	return path.split("/").length;
}

export class EncryptionAdmin {
	constructor(
		private provider: CloudProvider,
		private stateStore: SyncStateStore,
		private opts: EncryptionAdminOptions = {},
	) {}

	private progress(message: string): void {
		this.opts.onProgress?.(message);
	}

	// ---------- operations ----------

	async probe(folder: string, password: string): Promise<EncryptionProbe> {
		this.checkFolder(folder);
		const existing = await this.readKeyFile(folder, await this.provider.listAllFiles());
		if (!existing) return { state: "not-encrypted" };
		let passwordOk = true;
		try {
			await unlockKeyFile(existing.keyFile, password);
		} catch {
			passwordOk = false;
		}
		return {
			state: "encrypted",
			passwordOk,
			changeInProgress: existing.keyFile.rotation !== null,
			mode: folderMode(existing.keyFile),
			keyFile: existing.keyFile,
		};
	}

	// A new, empty encrypted-at-rest folder: just its key file on the server.
	// Converting a folder that already has files is DEV-396.
	async createAtRest(folder: string, password: string): Promise<FolderKeyFile> {
		this.checkFolder(folder);
		const listing = await this.provider.listAllFiles();
		this.checkNotNested(folder, listing);
		if (await this.readKeyFile(folder, listing)) throw new EncryptionAdminError(`${folder} is already encrypted`);
		if (this.objectsUnder(folder, listing).some((f) => !f.isFolder)) {
			throw new EncryptionAdminError(`${folder} already has files on the server; pick a new folder name`);
		}
		const { keyFile } = await createKeyFile(password, { iterations: this.opts.iterations, mode: "at-rest" });
		await this.ensureRemoteFolder(folder, listing);
		await this.writeKeyFile(folder, keyFile, null);
		return keyFile;
	}

	async enable(folder: string, password: string): Promise<void> {
		this.checkFolder(folder);
		let listing = await this.provider.listAllFiles();
		this.checkNotNested(folder, listing);
		let existing = await this.readKeyFile(folder, listing);

		let keys: FolderKeys;
		if (existing) {
			// Resume an interrupted enable; anything else means the folder is
			// already encrypted (or being changed by someone else).
			if (existing.keyFile.rotation?.fromKeyId !== "plaintext") {
				throw new EncryptionAdminError(`${folder} is already encrypted`);
			}
			keys = await this.unlock(existing.keyFile, password, folder);
		} else {
			await this.validateMove(folder, listing, null, true);
			const created = await createKeyFile(password, {
				iterations: this.opts.iterations,
				rotation: { fromKeyId: "plaintext" },
			});
			keys = created.keys;
			await this.ensureRemoteFolder(folder, listing);
			await this.writeKeyFile(folder, created.keyFile, null);
			listing = await this.provider.listAllFiles();
			existing = await this.readKeyFile(folder, listing);
		}

		await this.move(folder, listing, null, keys);
		await this.writeKeyFile(folder, { ...existing!.keyFile, rotation: null }, existing!.info);
		await this.stateStore.save();
	}

	async changePassword(folder: string, oldPassword: string, newPassword: string): Promise<void> {
		this.checkFolder(folder);
		let listing = await this.provider.listAllFiles();
		let existing = await this.readKeyFile(folder, listing);
		if (!existing) throw new EncryptionAdminError(`${folder} is not encrypted (no key file)`);
		this.checkTransit(folder, existing.keyFile);

		let oldKeys: FolderKeys;
		let newKeys: FolderKeys;
		const rotation = existing.keyFile.rotation;
		if (rotation?.previous && !rotation.toPlaintext) {
			// Resume: the key file already holds the new generation
			oldKeys = await this.unlock(rotation.previous, oldPassword, folder);
			newKeys = await this.unlock(existing.keyFile, newPassword, folder);
		} else if (rotation) {
			throw new EncryptionAdminError(`Another change is in progress for ${folder}`);
		} else {
			oldKeys = await this.unlock(existing.keyFile, oldPassword, folder);
			await this.validateMove(folder, listing, oldKeys, true);
			const { format, version, keyId, kdf, check } = existing.keyFile;
			const previous = { format, version, keyId, kdf, check };
			const created = await createKeyFile(newPassword, {
				iterations: this.opts.iterations,
				rotation: { fromKeyId: existing.keyFile.keyId, previous },
			});
			newKeys = created.keys;
			await this.writeKeyFile(folder, created.keyFile, existing.info);
			listing = await this.provider.listAllFiles();
			existing = await this.readKeyFile(folder, listing);
		}

		await this.move(folder, listing, oldKeys, newKeys);
		await this.writeKeyFile(folder, { ...existing!.keyFile, rotation: null }, existing!.info);
		await this.stateStore.save();
	}

	async remove(folder: string, password: string): Promise<void> {
		this.checkFolder(folder);
		let listing = await this.provider.listAllFiles();
		let existing = await this.readKeyFile(folder, listing);
		if (!existing) throw new EncryptionAdminError(`${folder} is not encrypted (no key file)`);
		this.checkTransit(folder, existing.keyFile);

		const rotation = existing.keyFile.rotation;
		if (rotation && !rotation.toPlaintext) {
			throw new EncryptionAdminError(`Another change is in progress for ${folder}`);
		}
		const keys = await this.unlock(existing.keyFile, password, folder);
		if (!rotation) {
			await this.validateMove(folder, listing, keys, false);
			await this.writeKeyFile(
				folder,
				{ ...existing.keyFile, rotation: { fromKeyId: existing.keyFile.keyId, toPlaintext: true } },
				existing.info,
			);
			listing = await this.provider.listAllFiles();
			existing = await this.readKeyFile(folder, listing);
		}

		await this.move(folder, listing, keys, null);
		await this.provider.deleteFile(existing!.info.id);
		await this.stateStore.save();
	}

	// ---------- raw key file / object helpers (at-rest operations) ----------

	async putKeyFile(folder: string, keyFile: FolderKeyFile): Promise<void> {
		this.checkFolder(folder);
		const listing = await this.provider.listAllFiles();
		const info = listing.find((f) => !f.isFolder && f.path === `${folder}/${KEY_FILE_NAME}`) ?? null;
		if (!info) await this.ensureRemoteFolder(folder, listing);
		await this.writeKeyFile(folder, keyFile, info);
	}

	async deleteKeyFile(folder: string): Promise<void> {
		this.checkFolder(folder);
		const info = (await this.provider.listAllFiles()).find((f) => !f.isFolder && f.path === `${folder}/${KEY_FILE_NAME}`);
		if (info) await this.provider.deleteFile(info.id);
	}

	async deleteObjectsUnder(folder: string): Promise<void> {
		this.checkFolder(folder);
		const listing = await this.provider.listAllFiles();
		for (const f of this.objectsUnder(folder, listing)) {
			if (!f.isFolder) await this.provider.deleteFile(f.id);
		}
		for (const f of this.objectsUnder(folder, listing).filter((x) => x.isFolder).sort((a, b) => depth(b.path) - depth(a.path))) {
			await this.provider.deleteFile(f.id);
		}
	}

	// ---------- checks ----------

	private checkFolder(folder: string): void {
		if (!folder || folder.startsWith("/") || folder.endsWith("/") || isDotPath(folder)) {
			throw new EncryptionAdminError(`Invalid folder: ${folder || "(vault root)"}`);
		}
	}

	// These operations rewrite objects on the server in the transit layout. An
	// at-rest folder's layout is owned by its devices (DEV-396).
	private checkTransit(folder: string, keyFile: FolderKeyFile): void {
		if (folderMode(keyFile) !== "transit") {
			throw new EncryptionAdminError(`${folder} is an encrypted-at-rest folder; use its own settings`);
		}
	}

	private checkNotNested(folder: string, listing: RemoteFileInfo[]): void {
		for (const f of listing) {
			if (f.isFolder || f.name !== KEY_FILE_NAME) continue;
			const other = f.path.slice(0, -(KEY_FILE_NAME.length + 1));
			if (other === folder) continue;
			if (folder.startsWith(other + "/") || other.startsWith(folder + "/")) {
				throw new EncryptionAdminError(`${folder} overlaps encrypted folder ${other}`);
			}
		}
	}

	private async unlock(
		keyFile: Omit<FolderKeyFile, "rotation">,
		password: string,
		folder: string,
	): Promise<FolderKeys> {
		try {
			return await unlockKeyFile(keyFile, password);
		} catch {
			throw new EncryptionAdminError(`Wrong password for ${folder}`);
		}
	}

	// Before writing anything: every object must be readable in its current
	// generation, fit the encrypted size cap and (when encrypting) the name
	// length limit.
	private async validateMove(folder: string, listing: RemoteFileInfo[], from: Gen, encrypting: boolean): Promise<void> {
		const utf8 = new TextEncoder();
		for (const f of this.objectsUnder(folder, listing)) {
			const plain = await this.decodePath(from, folder, f.path);
			if (plain === null) {
				throw new EncryptionAdminError(`Unreadable file ${f.path} in ${folder}; remove it and try again`);
			}
			if (!encrypting) continue;
			for (const seg of plain.slice(folder.length + 1).split("/")) {
				if (utf8.encode(seg).length > MAX_NAME_BYTES) throw new NameTooLongError(seg);
			}
		}
		if (!encrypting) return;
		for (const f of this.objectsUnder(folder, listing)) {
			if (f.isFolder) continue;
			// Size isn't in RemoteFileInfo; check what we can see now and let
			// the move re-check the real bytes.
			if (isMultipartEtag(f.md5Checksum)) {
				throw new EncryptionAdminError(`${f.path} is too large for an encrypted folder`);
			}
		}
	}

	// ---------- the move ----------

	private objectsUnder(folder: string, listing: RemoteFileInfo[]): RemoteFileInfo[] {
		return listing.filter((f) => f.path.startsWith(folder + "/") && !isDotPath(f.path.slice(folder.length + 1)));
	}

	private async move(folder: string, listing: RemoteFileInfo[], from: Gen, to: Gen): Promise<void> {
		// Classify: already in the target generation (done), in the source
		// generation (to move), or neither (junk → stop before damage).
		const todoFiles: { info: RemoteFileInfo; plain: string }[] = [];
		const todoFolders: { info: RemoteFileInfo; plain: string }[] = [];
		const doneFolders = new Set<string>(); // plain paths already present in target
		for (const f of this.objectsUnder(folder, listing)) {
			if (to) {
				const inTarget = await this.decodePath(to, folder, f.path);
				if (inTarget !== null) {
					if (f.isFolder) doneFolders.add(inTarget);
					continue;
				}
			}
			const plain = await this.decodePath(from, folder, f.path);
			if (plain === null) {
				if (!to) {
					// Removal: not decryptable = already plaintext
					if (f.isFolder) doneFolders.add(f.path);
					continue;
				}
				throw new EncryptionAdminError(`Unreadable file ${f.path} in ${folder}; remove it and try again`);
			}
			(f.isFolder ? todoFolders : todoFiles).push({ info: f, plain });
		}

		const total = todoFiles.length;
		this.progress(`${folder}: ${total} file${total === 1 ? "" : "s"} to re-encrypt`);

		// New folders, parents first
		const created = new Set(doneFolders);
		const ensureFolder = async (plain: string): Promise<void> => {
			if (plain === folder || created.has(plain)) return;
			await ensureFolder(getParentPath(plain));
			const remote = await this.encodePath(to, folder, plain);
			const parentId = await this.provider.getRemoteFolderId(getParentPath(remote));
			const id = await this.provider.createFolder(parentId, lastSegment(remote));
			created.add(plain);
			const rec = this.stateStore.getRecord(plain);
			if (rec && rec.contentHash === "__folder__") {
				rec.remoteId = id;
				rec.remoteFolderId = parentId;
				this.stateStore.setRecord(plain, rec);
			}
		};
		for (const f of [...todoFolders].sort((a, b) => depth(a.plain) - depth(b.plain))) {
			await ensureFolder(f.plain);
		}

		// Files: new copy first, then delete the old one
		let n = 0;
		for (const f of todoFiles) {
			await ensureFolder(getParentPath(f.plain));
			const raw = await this.provider.downloadFile(f.info.id);
			const etag = f.info.md5Checksum;
			if (etag && !isMultipartEtag(etag) && computeMD5(raw) !== etag) {
				throw new EncryptionAdminError(`Downloaded ${f.info.path} does not match the listing (stale response); try again`);
			}
			const plainBytes = from ? await decryptContent(from, f.plain, new Uint8Array(raw)) : new Uint8Array(raw);
			if (to && plainBytes.byteLength + CONTENT_OVERHEAD_BYTES >= MULTIPART_THRESHOLD_BYTES) {
				throw new EncryptionAdminError(`${f.plain} is too large for an encrypted folder`);
			}
			const outBytes = to ? await encryptContent(to, f.plain, plainBytes) : plainBytes;
			const remote = await this.encodePath(to, folder, f.plain);
			const parentId = await this.provider.getRemoteFolderId(getParentPath(remote));
			const newId = await this.provider.uploadFile(
				parentId,
				lastSegment(remote),
				toArrayBuffer(outBytes),
				"application/octet-stream",
			);
			if (newId !== f.info.id) await this.provider.deleteFile(f.info.id);

			// Keep this device quiet on its next sync: if its record matches the
			// content just moved, point it at the new object.
			const rec = this.stateStore.getRecord(f.plain);
			if (rec && rec.contentHash === computeMD5(toArrayBuffer(plainBytes))) {
				rec.remoteId = newId;
				rec.remoteFolderId = parentId;
				rec.remoteModTime = Date.now();
				rec.remoteHash = to ? computeMD5(toArrayBuffer(outBytes)) : undefined;
				this.stateStore.setRecord(f.plain, rec);
			}
			n++;
			if (n % 20 === 0) {
				this.progress(`${folder}: ${n}/${total}`);
				await this.stateStore.save();
			}
		}

		// Old folder markers, deepest first
		for (const f of [...todoFolders].sort((a, b) => depth(b.plain) - depth(a.plain))) {
			const remote = await this.encodePath(to, folder, f.plain);
			if (remote !== f.info.path) await this.provider.deleteFile(f.info.id);
		}
	}

	// ---------- paths ----------

	private async encodePath(gen: Gen, folder: string, plain: string): Promise<string> {
		if (!gen || plain === folder) return plain;
		let plainPrefix = folder;
		let remote = folder;
		for (const seg of plain.slice(folder.length + 1).split("/")) {
			remote = `${remote}/${await encryptName(gen, plainPrefix, seg)}`;
			plainPrefix = `${plainPrefix}/${seg}`;
		}
		return remote;
	}

	// null when the path isn't readable in this generation
	private async decodePath(gen: Gen, folder: string, remote: string): Promise<string | null> {
		if (!gen || remote === folder) return remote;
		let plain = folder;
		try {
			for (const seg of remote.slice(folder.length + 1).split("/")) {
				plain = `${plain}/${await decryptName(gen, plain, seg)}`;
			}
		} catch {
			return null;
		}
		return plain;
	}

	// ---------- key file ----------

	private async readKeyFile(folder: string, listing: RemoteFileInfo[]): Promise<KeyFileOnRemote | null> {
		const info = listing.find((f) => !f.isFolder && f.path === `${folder}/${KEY_FILE_NAME}`);
		if (!info) return null;
		const bytes = await this.provider.downloadFile(info.id);
		if (info.md5Checksum && computeMD5(bytes) !== info.md5Checksum) {
			throw new EncryptionAdminError(`Key file for ${folder} is stale; try again`);
		}
		return { info, keyFile: parseKeyFile(new TextDecoder().decode(bytes)) };
	}

	private async writeKeyFile(folder: string, keyFile: FolderKeyFile, existing: RemoteFileInfo | null): Promise<void> {
		const body = toArrayBuffer(new TextEncoder().encode(serializeKeyFile(keyFile)));
		if (existing) {
			await this.provider.updateFile(existing.id, body, "application/json");
		} else {
			const parentId = await this.provider.getRemoteFolderId(folder);
			await this.provider.uploadFile(parentId, KEY_FILE_NAME, body, "application/json");
		}
	}

	private async ensureRemoteFolder(folder: string, listing: RemoteFileInfo[]): Promise<void> {
		if (listing.some((f) => f.isFolder && f.path === folder)) return;
		const parent = getParentPath(folder);
		if (parent) await this.ensureRemoteFolder(parent, listing);
		const parentId = await this.provider.getRemoteFolderId(parent);
		await this.provider.createFolder(parentId, lastSegment(folder));
	}
}
