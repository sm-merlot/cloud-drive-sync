import { RemoteNotFoundError } from "../providers/cloud-provider";
import type { CloudProvider } from "../providers/cloud-provider";
import type { SyncStateStore } from "./sync-state";
import type { ConflictStrategy, RemoteFileInfo, SyncAction } from "../types";
import type { LocalFileEntry, LocalFileSystem } from "../fs/local-file-system";
import type { FirstSyncStrategy, SyncIssue, SyncIssueResolution, SyncUIPort } from "./sync-ui-port";
import { computeMD5 } from "../util/hash";
import { getFileName, getParentPath, guessMimeType, isDotPath, shouldExclude } from "../util/path";
import { merge2way } from "../util/merge";
import { isLineMergeable } from "../util/binary-guard";
import { HASH_VERIFY_THRESHOLD_BYTES, MULTIPART_THRESHOLD_BYTES } from "../util/constants";
import { CONTENT_OVERHEAD_BYTES } from "../crypto/folder-crypto";
import { EncryptionAdmin, EncryptionAdminError, type EncryptionAdminOptions, type EncryptionProbe } from "./encryption-admin";
import { FolderEncryption, type EncryptionSettings, type LockedFolder } from "./folder-encryption";

const FOLDER_SENTINEL = "__folder__";

// Multipart-uploaded objects carry an ETag of the form "<hex>-<partCount>",
// which is NOT a whole-file MD5 — never hash-compare against those.
function isMultipartEtag(etag: string): boolean {
	return /-\d+$/.test(etag);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export interface SyncResult {
	uploaded: number;
	downloaded: number;
	deleted: number;
	conflicts: number;
	errors: number;
	failures: SyncIssue[];
	// Encrypted folders this device could not read this pass (no password,
	// wrong password, ...). Nothing inside them was touched.
	lockedFolders: LockedFolder[];
}

export interface SyncEngineSettings {
	conflictStrategy: ConflictStrategy;
	excludePatterns: string[];
	debugMode?: boolean;
	// Per-folder encryption. Absent = no folders configured; remote key files
	// are still detected and their folders locked.
	encryption?: EncryptionSettings;
}

export class SyncEngine {
	private syncing = false;
	private firstSyncStrategy: FirstSyncStrategy | null = null;
	private encryption: FolderEncryption;
	onProgress?: (message: string) => void;
	// User-visible notices (toasts in Obsidian, status line in Tauri)
	onNotice?: (message: string) => void;
	// Locked encrypted folder found this pass. When unset, the reason goes
	// to onNotice; hosts that sync often set this to de-duplicate.
	onLocked?: (locked: LockedFolder) => void;

	constructor(
		private fs: LocalFileSystem,
		private root: string,
		private provider: CloudProvider,
		private stateStore: SyncStateStore,
		private ui: SyncUIPort,
		private settings: SyncEngineSettings,
	) {
		// Always on, even with no folders configured: a device that knows
		// nothing about a folder's password must still see its key file and
		// lock it, never sync its ciphertext as ordinary files.
		this.encryption = new FolderEncryption(
			provider,
			settings.encryption ?? { folders: [], passwordFor: () => null },
		);
	}

	getProvider(): CloudProvider { return this.provider; }

	private progress(message: string): void {
		this.onProgress?.(message);
	}

	private emptyResult(): SyncResult {
		return { uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0, errors: 0, failures: [], lockedFolders: [] };
	}

	// Remote listing with encrypted folders resolved: locked folders removed,
	// encrypted names translated to plaintext vault paths.
	private async listRemote(result: SyncResult): Promise<RemoteFileInfo[]> {
		const raw = await this.provider.listAllFiles();
		const listing = await this.encryption.prepare(raw);
		for (const locked of this.encryption.lockedFolders) {
			result.lockedFolders.push(locked);
			if (this.onLocked) this.onLocked(locked);
			else this.onNotice?.(locked.reason);
		}
		return listing;
	}

	private isEncrypted(path: string): boolean {
		return this.encryption.isEncryptedPath(path);
	}

	async sync(): Promise<SyncResult> {
		if (this.syncing) {
			this.onNotice?.("Sync already in progress");
			return this.emptyResult();
		}

		this.syncing = true;
		const result = this.emptyResult();

		try {
			// 0. First sync — ask user for strategy
			const isFirstSync = this.stateStore.lastSyncTime === 0;
			this.firstSyncStrategy = isFirstSync ? await this.ui.chooseFirstSyncStrategy() : null;

			// 1. Gather remote state. This comes first: it decides which encrypted
			// folders are locked, and the local filter below (shouldSkip) depends on
			// that. Filtering local paths with the previous pass's lock state makes a
			// just-unlocked folder look locally deleted.
			this.progress("Listing remote...");
			const allRemote = await this.listRemote(result);
			const remoteMap = new Map<string, RemoteFileInfo>();
			const remoteFolderMap = new Map<string, RemoteFileInfo>();
			for (const f of allRemote) {
				if (f.isFolder) remoteFolderMap.set(f.path, f);
				else remoteMap.set(f.path, f);
			}

			// 2. Gather local state
			this.progress("Listing local files...");
			const localMap = new Map<string, LocalFileEntry>();
			for (const f of await this.fs.listFiles(this.root)) {
				if (!this.shouldSkip(f.path)) localMap.set(f.path, f);
			}
			const localFolderPaths = new Set<string>();
			for (const p of await this.fs.listFolders(this.root)) {
				if (!this.shouldSkip(p)) localFolderPaths.add(p);
			}

			// 3. Compute actions
			this.progress("Planning...");
			await this.healStaleLocalModTimes(localMap);
			const preIssues: SyncIssue[] = [];
			const actions = this.computeActions(localMap, remoteMap, preIssues);
			const folderActions = this.computeFolderActions(localFolderPaths, remoteFolderMap);

			// 4. Hash-check conflict actions; auto-smart-merge clean cases immediately
			const conflictIssues: SyncIssue[] = [...preIssues];
			for (const action of actions) {
				if (action.type !== "conflict") continue;
				const local = localMap.get(action.vaultPath);
				const remote = remoteMap.get(action.vaultPath);
				if (!local || !remote) continue;
				const resolvedIssue = await this.verifyOrMergeConflict(action.vaultPath, local, remote, result);
				if (resolvedIssue) conflictIssues.push(resolvedIssue);
			}

			// 5. Debug mode — preview the plan before executing
			const nonConflictActions = actions.filter((a) => a.type !== "conflict");
			if (this.settings.debugMode && this.ui.reviewPlan) {
				const plan = await this.ui.reviewPlan([...nonConflictActions, ...folderActions], conflictIssues);
				if (plan.cancelled) return result;
			}

			// 6. Execute folder creates (parents first)
			this.progress("Syncing...");
			const issues: SyncIssue[] = [];
			const folderCreates = folderActions
				.filter(a => a.type === "create-folder-remote" || a.type === "create-folder-local")
				.sort((a, b) => a.vaultPath.split("/").length - b.vaultPath.split("/").length);

			for (const action of folderCreates) {
				try {
					await this.executeFolderAction(action);
					this.countAction(action, result);
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					console.error(`Sync error on ${action.type} ${action.vaultPath}:`, e);
					const issue: SyncIssue = { vaultPath: action.vaultPath, type: "error", errorMessage: msg };
					issues.push(issue);
					result.failures.push(issue);
					result.errors++;
				}
			}

			// 7. Execute file actions
			for (const action of nonConflictActions) {
				try {
					if (await this.executeAction(action, localMap, remoteMap)) this.countAction(action, result);
				} catch (e) {
					if (e instanceof RemoteNotFoundError) {
						// Remote file vanished between listing and fetch (deleted or
						// moved server-side, or a stale listing from the backend).
						// Skip quietly: the next sync gets a fresh listing and
						// classifies it correctly (e.g. delete-local).
						console.info(`Remote gone, skipping ${action.type} ${action.vaultPath}; next sync will reconcile`);
						continue;
					}
					const msg = e instanceof Error ? e.message : String(e);
					console.error(`Sync error on ${action.type} ${action.vaultPath}:`, e);
					const issue: SyncIssue = {
						vaultPath: action.vaultPath,
						type: "error",
						remoteId: "remoteId" in action ? action.remoteId : undefined,
						errorMessage: msg,
					};
					issues.push(issue);
					result.failures.push(issue);
					result.errors++;
				}
			}

			// 8. Execute folder deletes (children first)
			const folderDeletes = folderActions
				.filter(a => a.type === "delete-folder-remote" || a.type === "delete-folder-local")
				.sort((a, b) => b.vaultPath.split("/").length - a.vaultPath.split("/").length);

			for (const action of folderDeletes) {
				try {
					await this.executeFolderAction(action);
					this.countAction(action, result);
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					console.error(`Sync error on ${action.type} ${action.vaultPath}:`, e);
					const issue: SyncIssue = { vaultPath: action.vaultPath, type: "error", errorMessage: msg };
					issues.push(issue);
					result.failures.push(issue);
					result.errors++;
				}
			}

			// 9. Surface remaining conflicts/errors for resolution
			const allIssues = [...conflictIssues, ...issues];
			if (allIssues.length > 0) {
				const resolutions = await this.ui.resolveSyncIssues(allIssues);
				await this.applyResolutions(resolutions, localMap, remoteMap, result);
			}

			// 10. Finalize
			this.stateStore.lastSyncTime = Date.now();
			await this.stateStore.save();
		} finally {
			this.syncing = false;
		}

		return result;
	}

	async syncPaths(paths: Set<string>): Promise<SyncResult> {
		if (this.syncing) {
			return this.emptyResult();
		}

		this.syncing = true;
		const result = this.emptyResult();

		try {
			const allRemote = await this.listRemote(result);
			const remoteMap = new Map<string, RemoteFileInfo>();
			const remoteFolderMap = new Map<string, RemoteFileInfo>();
			for (const f of allRemote) {
				if (f.isFolder) remoteFolderMap.set(f.path, f);
				else remoteMap.set(f.path, f);
			}

			const localFolderSet = new Set(await this.fs.listFolders(this.root));
			const localMap = new Map<string, LocalFileEntry>();
			const localFolderPaths = new Set<string>();
			const folderPaths = new Set<string>();

			for (const path of paths) {
				if (this.shouldSkip(path)) continue;
				const entry = await this.fs.statFile(this.root, path);
				if (entry) {
					localMap.set(path, entry);
				} else if (localFolderSet.has(path)) {
					localFolderPaths.add(path);
					folderPaths.add(path);
				} else {
					// Deleted — check if it was a folder record
					const record = this.stateStore.getRecord(path);
					if (record?.contentHash === FOLDER_SENTINEL) {
						folderPaths.add(path);
					}
				}
			}

			// Compute folder actions for folder paths
			const folderActions = this.computeFolderActions(localFolderPaths, remoteFolderMap);
			const relevantFolderActions = folderActions.filter(a => folderPaths.has(a.vaultPath));

			const issues: SyncIssue[] = [];

			// Phase 1: folder creates
			const folderCreates = relevantFolderActions
				.filter(a => a.type === "create-folder-remote" || a.type === "create-folder-local")
				.sort((a, b) => a.vaultPath.split("/").length - b.vaultPath.split("/").length);

			for (const action of folderCreates) {
				try {
					await this.executeFolderAction(action);
					this.countAction(action, result);
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					console.error(`Sync error on ${action.type} ${action.vaultPath}:`, e);
					const issue: SyncIssue = { vaultPath: action.vaultPath, type: "error", errorMessage: msg };
					issues.push(issue);
					result.failures.push(issue);
					result.errors++;
				}
			}

			// Phase 2: file actions
			await this.healStaleLocalModTimes(localMap);
			const actions: SyncAction[] = [];
			const preIssues: SyncIssue[] = [];
			for (const path of paths) {
				if (this.shouldSkip(path)) continue;
				if (folderPaths.has(path)) continue;
				this.classifyPath(
					path,
					localMap.get(path),
					remoteMap.get(path),
					null,
					actions,
					preIssues,
				);
			}

			issues.push(...preIssues);

			for (const action of actions) {
				if (action.type === "conflict") continue;
				try {
					if (await this.executeAction(action, localMap, remoteMap)) this.countAction(action, result);
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					console.error(`Sync error on ${action.type} ${action.vaultPath}:`, e);
					const issue: SyncIssue = {
						vaultPath: action.vaultPath,
						type: "error",
						remoteId: "remoteId" in action ? action.remoteId : undefined,
						errorMessage: msg,
					};
					issues.push(issue);
					result.failures.push(issue);
					result.errors++;
				}
			}

			// Phase 3: folder deletes
			const folderDeletes = relevantFolderActions
				.filter(a => a.type === "delete-folder-remote" || a.type === "delete-folder-local")
				.sort((a, b) => b.vaultPath.split("/").length - a.vaultPath.split("/").length);

			for (const action of folderDeletes) {
				try {
					await this.executeFolderAction(action);
					this.countAction(action, result);
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					console.error(`Sync error on ${action.type} ${action.vaultPath}:`, e);
					const issue: SyncIssue = { vaultPath: action.vaultPath, type: "error", errorMessage: msg };
					issues.push(issue);
					result.failures.push(issue);
					result.errors++;
				}
			}

			for (const action of actions) {
				if (action.type !== "conflict") continue;
				const local = localMap.get(action.vaultPath);
				const remote = remoteMap.get(action.vaultPath);
				if (!local || !remote) continue;
				const resolvedIssue = await this.verifyOrMergeConflict(action.vaultPath, local, remote, result);
				if (resolvedIssue) issues.push(resolvedIssue);
			}

			if (issues.length > 0) {
				const resolutions = await this.ui.resolveSyncIssues(issues);
				await this.applyResolutions(resolutions, localMap, remoteMap, result);
			}

			this.stateStore.lastSyncTime = Date.now();
			await this.stateStore.save();
		} finally {
			this.syncing = false;
		}

		return result;
	}

	// ---------- encrypted folder changes (DEV-382) ----------

	// What the remote says about a folder, and whether a password fits it.
	// Read-only; used by settings UIs before choosing enable vs. join.
	probeEncryption(folder: string, password: string): Promise<EncryptionProbe> {
		return new EncryptionAdmin(this.provider, this.stateStore).probe(folder, password);
	}

	// Encrypt an existing folder in place. Calling it again with the same
	// password resumes an interrupted run.
	enableEncryption(folder: string, password: string, opts: EncryptionAdminOptions = {}): Promise<void> {
		return this.exclusive((admin) => admin.enable(folder, password), opts);
	}

	// Re-encrypt the folder under a new password; other devices lock until
	// they get it. Resumable with the same pair of passwords.
	changeEncryptionPassword(
		folder: string,
		oldPassword: string,
		newPassword: string,
		opts: EncryptionAdminOptions = {},
	): Promise<void> {
		return this.exclusive((admin) => admin.changePassword(folder, oldPassword, newPassword), opts);
	}

	// Decrypt the folder back to plaintext and delete its key file. Resumable.
	removeEncryption(folder: string, password: string, opts: EncryptionAdminOptions = {}): Promise<void> {
		return this.exclusive((admin) => admin.remove(folder, password), opts);
	}

	private async exclusive(
		run: (admin: EncryptionAdmin) => Promise<void>,
		opts: EncryptionAdminOptions,
	): Promise<void> {
		if (this.syncing) throw new EncryptionAdminError("A sync is in progress; try again when it finishes");
		this.syncing = true;
		try {
			await run(new EncryptionAdmin(this.provider, this.stateStore, {
				...opts,
				onProgress: opts.onProgress ?? ((m) => this.progress(m)),
			}));
		} finally {
			this.syncing = false;
		}
	}

	// ---------- classification ----------

	private localChanged(local: LocalFileEntry, record: { localModTime: number; size?: number }): boolean {
		const mtimeChanged = local.mtimeMs > record.localModTime;
		const sizeChanged = record.size !== undefined && local.size !== record.size;
		return mtimeChanged || sizeChanged;
	}

	// A local mtime newer than the record does not prove an edit. Obsidian's
	// cached TFile.stat can refresh after we stamp the record, and a file
	// moved or rewritten outside Obsidian can get a new mtime with the same
	// bytes. Trusting mtime alone re-uploads unchanged files forever, and
	// brings back files deleted or moved on the server (the "edited here,
	// deleted there" branch). When the size matches, hash the file. If the
	// bytes match the record, move the record's mtime forward so every
	// branch of classifyPath sees the file as unchanged.
	private async healStaleLocalModTimes(localMap: Map<string, LocalFileEntry>): Promise<void> {
		for (const [path, local] of localMap) {
			const record = this.stateStore.getRecord(path);
			if (!record || record.contentHash === FOLDER_SENTINEL) continue;
			if (local.mtimeMs <= record.localModTime) continue;
			if (record.size !== undefined && local.size !== record.size) continue;
			// Encrypted files are always verified: a spurious re-upload of one
			// produces new ciphertext, which every other device then downloads
			// and rewrites, so a missed heal turns into a cross-device loop.
			if (local.size >= HASH_VERIFY_THRESHOLD_BYTES && !this.isEncrypted(path)) continue;

			const bytes = await this.fs.readFile(this.root, path);
			if (computeMD5(toArrayBuffer(bytes)) !== record.contentHash) continue;

			record.localModTime = local.mtimeMs;
			record.size = bytes.byteLength;
			this.stateStore.setRecord(path, record);
		}
	}

	// Encrypted files: contentHash is the plaintext MD5 and the ETag is the
	// ciphertext's, so compare against remoteHash (the ciphertext MD5 seen at
	// last sync) or every encrypted file looks remotely changed on every pass.
	private remoteChanged(
		remote: RemoteFileInfo,
		record: { remoteModTime: number; contentHash: string; remoteHash?: string },
	): boolean {
		return remote.modifiedTime > record.remoteModTime
			&& (isMultipartEtag(remote.md5Checksum) || remote.md5Checksum !== (record.remoteHash ?? record.contentHash));
	}

	private classifyPath(
		path: string,
		local: LocalFileEntry | undefined,
		remote: RemoteFileInfo | undefined,
		firstSyncStrategy: FirstSyncStrategy | null,
		actions: SyncAction[],
		issues: SyncIssue[],
	): void {
		let record = this.stateStore.getRecord(path);
		if (record?.contentHash === FOLDER_SENTINEL) {
			// Folder lifecycle belongs to computeFolderActions — classifying a
			// sentinel here would drop the record as "stale" before the folder
			// pass can see it (e.g. locally-deleted folder → delete-folder-remote).
			if (!local) return;
			// A file now exists where a folder was tracked: classify it fresh.
			record = undefined;
		}

		if (local && remote && record) {
			const localChanged = this.localChanged(local, record);
			const remoteChanged = this.remoteChanged(remote, record);

			if (localChanged && remoteChanged) {
				this.pushConflictOrResolve(actions, path, local, remote);
			} else if (localChanged) {
				actions.push({ type: "update-remote", vaultPath: path, remoteId: remote.id });
			} else if (remoteChanged) {
				actions.push({ type: "update-local", vaultPath: path, remoteId: remote.id });
			}
		} else if (local && remote && !record) {
			if (firstSyncStrategy === "download") {
				actions.push({ type: "update-local", vaultPath: path, remoteId: remote.id });
			} else if (firstSyncStrategy === "upload") {
				actions.push({ type: "update-remote", vaultPath: path, remoteId: remote.id });
			} else {
				this.pushConflictOrResolve(actions, path, local, remote);
			}
		} else if (local && !remote && record) {
			if (this.localChanged(local, record)) {
				// Symmetric to the delete-conflict below: edited here since last
				// sync but deleted remotely — keep the edit, re-upload it.
				actions.push({ type: "upload", vaultPath: path });
			} else {
				actions.push({ type: "delete-local", vaultPath: path });
			}
		} else if (local && !remote && !record) {
			actions.push({ type: "upload", vaultPath: path });
		} else if (!local && remote && record) {
			if (this.remoteChanged(remote, record)) {
				// Ambiguous: deleted here vs edited elsewhere since this device's
				// last sync. Deleting would silently destroy the newer remote
				// content, so never do that by default.
				this.pushDeleteConflictOrResolve(actions, issues, path, remote, record);
			} else {
				// Safe: remote unchanged since this device last saw it
				actions.push({ type: "delete-remote", remoteId: remote.id, vaultPath: path });
			}
		} else if (!local && remote && !record) {
			actions.push({ type: "download", vaultPath: path, remoteId: remote.id });
		} else if (!local && !remote && record) {
			this.stateStore.removeRecord(path);
		}
	}

	private computeActions(
		localMap: Map<string, LocalFileEntry>,
		remoteMap: Map<string, RemoteFileInfo>,
		issues: SyncIssue[],
	): SyncAction[] {
		const actions: SyncAction[] = [];
		const allPaths = new Set<string>();

		for (const path of localMap.keys()) allPaths.add(path);
		for (const path of remoteMap.keys()) allPaths.add(path);
		for (const path of this.stateStore.getAllTrackedPaths()) allPaths.add(path);

		for (const path of allPaths) {
			if (this.shouldSkip(path)) continue;
			this.classifyPath(path, localMap.get(path), remoteMap.get(path), this.firstSyncStrategy, actions, issues);
		}

		return actions;
	}

	private pushConflictOrResolve(
		actions: SyncAction[],
		path: string,
		local: LocalFileEntry,
		remote: RemoteFileInfo,
	): void {
		switch (this.settings.conflictStrategy) {
			case "smart-merge":
				// Queued as conflict; verifyOrMergeConflict handles the merge attempt
				actions.push({ type: "conflict", vaultPath: path, remoteId: remote.id });
				break;
			case "latest-wins":
				if (local.mtimeMs >= remote.modifiedTime) {
					actions.push({ type: "update-remote", vaultPath: path, remoteId: remote.id });
				} else {
					actions.push({ type: "update-local", vaultPath: path, remoteId: remote.id });
				}
				break;
			case "use-local":
				actions.push({ type: "update-remote", vaultPath: path, remoteId: remote.id });
				break;
			case "use-remote":
				actions.push({ type: "update-local", vaultPath: path, remoteId: remote.id });
				break;
			default:
				actions.push({ type: "conflict", vaultPath: path, remoteId: remote.id });
		}
	}

	// Local file deleted on this device, but remote changed since this device's
	// last sync. "local"/delete means honor the deletion; everything without a
	// clear answer biases to re-downloading — a resurrected file is recoverable,
	// a destroyed newer version is not. (No timestamp exists for a local delete,
	// so latest-wins has nothing to compare.)
	private pushDeleteConflictOrResolve(
		actions: SyncAction[],
		issues: SyncIssue[],
		path: string,
		remote: RemoteFileInfo,
		record: { localModTime: number },
	): void {
		switch (this.settings.conflictStrategy) {
			case "use-local":
				actions.push({ type: "delete-remote", remoteId: remote.id, vaultPath: path });
				break;
			case "use-remote":
			case "latest-wins":
			case "smart-merge":
				actions.push({ type: "download", vaultPath: path, remoteId: remote.id });
				break;
			default:
				issues.push({
					vaultPath: path,
					type: "delete-conflict",
					remoteId: remote.id,
					localModTime: record.localModTime,
					remoteModTime: remote.modifiedTime,
				});
		}
	}

	// For a queued conflict: below the hash-verify threshold, read + hash the
	// local file to silently absorb touched-but-identical files; attempt a
	// smart-merge when configured. Returns an issue if the conflict still needs
	// user resolution, null if fully handled here.
	private async verifyOrMergeConflict(
		path: string,
		local: LocalFileEntry,
		remote: RemoteFileInfo,
		result: SyncResult,
	): Promise<SyncIssue | null> {
		const conflictIssue: SyncIssue = {
			vaultPath: path,
			type: "conflict",
			remoteId: remote.id,
			localModTime: local.mtimeMs,
			remoteModTime: remote.modifiedTime,
		};

		const encrypted = this.isEncrypted(path);

		// Large files: skip the verification-only read entirely. Multipart
		// ETags aren't whole-file MD5s, so equality checks are meaningless.
		// Encrypted files are capped below the multipart size and always
		// compared on decrypted content.
		if (!encrypted && (local.size >= HASH_VERIFY_THRESHOLD_BYTES || isMultipartEtag(remote.md5Checksum))) {
			return conflictIssue;
		}

		const localBytes = await this.fs.readFile(this.root, path);
		const localContent = toArrayBuffer(localBytes);
		const localHash = computeMD5(localContent);

		// Ciphertext never matches the local plaintext hash, so an encrypted
		// file has to be downloaded and decrypted to compare.
		let remoteContent: ArrayBuffer | null = encrypted ? await this.downloadPlain(remote) : null;
		const identical = remoteContent ? computeMD5(remoteContent) === localHash : localHash === remote.md5Checksum;

		if (identical) {
			// Identical content — auto-resolve silently
			this.stateStore.setRecord(path, {
				vaultPath: path,
				remoteId: remote.id,
				remoteFolderId: remote.parentId,
				localModTime: local.mtimeMs,
				remoteModTime: remote.modifiedTime,
				contentHash: localHash,
				size: local.size,
				remoteHash: encrypted ? remote.md5Checksum : undefined,
			});
			return null;
		}

		if (this.settings.conflictStrategy === "smart-merge") {
			const mimeType = guessMimeType(path);
			remoteContent ??= await this.downloadPlain(remote);
			if (!isLineMergeable(path, localContent, mimeType) || !isLineMergeable(path, remoteContent, mimeType)) {
				// Binary or encrypted content — a line merge would corrupt it
				return conflictIssue;
			}
			const localText = new TextDecoder().decode(localContent);
			const remoteText = new TextDecoder().decode(remoteContent);
			const { text: merged, conflicts } = merge2way(localText, remoteText);
			if (conflicts === 0) {
				// Clean — apply now, never surface to user
				const mergedBin = new TextEncoder().encode(merged);
				await this.fs.writeFile(this.root, path, mergedBin);
				const out = await this.prepareUpload(path, mergedBin);
				await this.provider.updateFile(remote.id, out.content, mimeType);
				const hash = computeMD5(toArrayBuffer(mergedBin));
				const fresh = await this.fs.statFile(this.root, path);
				this.stateStore.setRecord(path, {
					vaultPath: path,
					remoteId: remote.id,
					remoteFolderId: remote.parentId,
					localModTime: fresh?.mtimeMs ?? Date.now(),
					remoteModTime: Date.now(),
					contentHash: hash,
					size: mergedBin.byteLength,
					remoteHash: out.remoteHash,
				});
				result.conflicts++;
				return null;
			}
		}

		return conflictIssue;
	}

	// ---------- resolutions ----------

	private async applyResolutions(
		resolutions: SyncIssueResolution[],
		localMap: Map<string, LocalFileEntry>,
		remoteMap: Map<string, RemoteFileInfo>,
		result: SyncResult
	): Promise<void> {
		for (const res of resolutions) {
			try {
				// Delete-conflicts have no local file: "local" honors the local
				// deletion, "remote" re-downloads. Detected by local absence.
				const hasLocal = localMap.has(res.vaultPath)
					|| (await this.fs.statFile(this.root, res.vaultPath)) !== null;

				switch (res.resolution) {
					case "local":
						if (res.remoteId && hasLocal) {
							await this.executeAction(
								{ type: "update-remote", vaultPath: res.vaultPath, remoteId: res.remoteId },
								localMap,
								remoteMap
							);
							result.conflicts++;
						} else if (res.remoteId) {
							await this.executeAction(
								{ type: "delete-remote", vaultPath: res.vaultPath, remoteId: res.remoteId },
								localMap,
								remoteMap
							);
							result.deleted++;
						}
						break;

					case "remote":
						if (res.remoteId && hasLocal) {
							await this.executeAction(
								{ type: "update-local", vaultPath: res.vaultPath, remoteId: res.remoteId },
								localMap,
								remoteMap
							);
							result.conflicts++;
						} else if (res.remoteId) {
							await this.executeAction(
								{ type: "download", vaultPath: res.vaultPath, remoteId: res.remoteId },
								localMap,
								remoteMap
							);
							result.downloaded++;
						}
						break;

					case "merge":
						if (res.remoteId) {
							await this.mergeFiles(res.vaultPath, res.remoteId, localMap, remoteMap);
							result.conflicts++;
						}
						break;

					case "external":
						if (res.remoteId && this.isEncrypted(res.vaultPath)) {
							// The external tool reads and uploads raw remote bytes,
							// which would leak plaintext / write ciphertext into the
							// vault. Fall back to the built-in merge.
							this.onNotice?.(`External merge is not available in encrypted folders; merging ${res.vaultPath} in place`);
							await this.mergeFiles(res.vaultPath, res.remoteId, localMap, remoteMap);
							result.conflicts++;
						} else if (res.remoteId && this.ui.externalMerge) {
							await this.ui.externalMerge(res.vaultPath, res.remoteId);
							result.conflicts++;
						}
						break;

					case "retry":
						await this.retryFile(res.vaultPath, localMap, remoteMap, result);
						break;

					case "skip":
						break;
				}
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				console.error(`Resolution error on ${res.vaultPath}:`, e);
				result.failures.push({ vaultPath: res.vaultPath, type: "error", remoteId: res.remoteId, errorMessage: msg });
				result.errors++;
			}
		}
	}

	private async mergeFiles(
		vaultPath: string,
		remoteId: string,
		localMap: Map<string, LocalFileEntry>,
		remoteMap: Map<string, RemoteFileInfo>
	): Promise<void> {
		const local = localMap.get(vaultPath);
		if (!local) return;
		const remote = remoteMap.get(vaultPath)!;
		const mimeType = guessMimeType(vaultPath);

		const localBytes = await this.fs.readFile(this.root, vaultPath);
		const localContent = toArrayBuffer(localBytes);
		const remoteContent = await this.downloadPlain(remote);
		if (!isLineMergeable(vaultPath, localContent, mimeType) || !isLineMergeable(vaultPath, remoteContent, mimeType)) {
			this.onNotice?.(`Cannot merge ${vaultPath}: binary or encrypted file. Choose Local or Remote instead.`);
			return;
		}

		const localText = new TextDecoder().decode(localContent);
		const remoteText = new TextDecoder().decode(remoteContent);
		const { text: merged, conflicts } = merge2way(localText, remoteText);

		const mergedBin = new TextEncoder().encode(merged);
		await this.fs.writeFile(this.root, vaultPath, mergedBin);

		if (conflicts === 0) {
			const out = await this.prepareUpload(vaultPath, mergedBin);
			await this.provider.updateFile(remoteId, out.content, mimeType);
			const hash = computeMD5(toArrayBuffer(mergedBin));
			const fresh = await this.fs.statFile(this.root, vaultPath);
			this.stateStore.setRecord(vaultPath, {
				vaultPath, remoteId,
				remoteFolderId: remote.parentId,
				localModTime: fresh?.mtimeMs ?? Date.now(),
				remoteModTime: Date.now(),
				contentHash: hash,
				size: mergedBin.byteLength,
				remoteHash: out.remoteHash,
			});
			this.onNotice?.(`Auto-merged: ${vaultPath}`);
			return;
		}

		// Conflicts remain — markers written locally; hand to external tool or leave for user
		if (this.ui.externalMerge && !this.isEncrypted(vaultPath)) {
			await this.ui.externalMerge(vaultPath, remoteId);
		} else {
			this.onNotice?.(
				`${conflicts} conflict${conflicts !== 1 ? "s" : ""} in ${vaultPath} — conflict markers added, resolve and sync again`
			);
			const record = this.stateStore.getRecord(vaultPath);
			const fresh = await this.fs.statFile(this.root, vaultPath);
			if (record && fresh) {
				record.localModTime = fresh.mtimeMs;
				record.size = fresh.size;
				this.stateStore.setRecord(vaultPath, record);
			}
		}
	}

	private async retryFile(
		vaultPath: string,
		localMap: Map<string, LocalFileEntry>,
		remoteMap: Map<string, RemoteFileInfo>,
		result: SyncResult
	): Promise<void> {
		const local = await this.fs.statFile(this.root, vaultPath);
		const remote = remoteMap.get(vaultPath);
		const record = this.stateStore.getRecord(vaultPath);

		// Re-populate localMap if file exists now
		if (local) {
			localMap.set(vaultPath, local);
		}

		if (local && remote && record) {
			await this.executeAction(
				{ type: "update-remote", vaultPath, remoteId: remote.id },
				localMap,
				remoteMap
			);
			result.uploaded++;
		} else if (local && !remote) {
			await this.executeAction({ type: "upload", vaultPath }, localMap, remoteMap);
			result.uploaded++;
		} else if (!local && remote && record) {
			await this.executeAction(
				{ type: "delete-remote", vaultPath, remoteId: remote.id },
				localMap,
				remoteMap
			);
			result.deleted++;
		} else if (local && remote) {
			await this.executeAction(
				{ type: "update-remote", vaultPath, remoteId: remote.id },
				localMap,
				remoteMap
			);
			result.uploaded++;
		}
	}

	// ---------- folders ----------

	private folderContainsTrackedFiles(folderPath: string): boolean {
		const prefix = folderPath + "/";
		for (const tracked of this.stateStore.getAllTrackedPaths()) {
			if (tracked.startsWith(prefix)) {
				const rec = this.stateStore.getRecord(tracked);
				if (rec && rec.contentHash !== FOLDER_SENTINEL) return true;
			}
		}
		return false;
	}

	private computeFolderActions(
		localFolderPaths: Set<string>,
		remoteFolderMap: Map<string, RemoteFileInfo>
	): SyncAction[] {
		const actions: SyncAction[] = [];
		const allPaths = new Set<string>();

		for (const p of localFolderPaths) allPaths.add(p);
		for (const p of remoteFolderMap.keys()) allPaths.add(p);
		for (const p of this.stateStore.getAllTrackedPaths()) {
			const rec = this.stateStore.getRecord(p);
			if (rec && rec.contentHash === FOLDER_SENTINEL) allPaths.add(p);
		}

		for (const path of allPaths) {
			if (this.shouldSkip(path)) continue;

			const localExists = localFolderPaths.has(path);
			const remote = remoteFolderMap.get(path);
			const record = this.stateStore.getRecord(path);
			const isTracked = record && record.contentHash === FOLDER_SENTINEL;

			if (localExists && remote && !isTracked) {
				// Both exist, not tracked → start tracking
				this.stateStore.setRecord(path, {
					vaultPath: path,
					remoteId: remote.id,
					remoteFolderId: remote.parentId,
					localModTime: Date.now(),
					remoteModTime: remote.modifiedTime,
					contentHash: FOLDER_SENTINEL,
				});
			} else if (localExists && remote && isTracked) {
				// Both exist, tracked → nothing to do
			} else if (localExists && !remote && isTracked) {
				// Was tracked, gone from remote → delete local
				actions.push({ type: "delete-folder-local", vaultPath: path });
			} else if (localExists && !remote && !isTracked) {
				if (this.folderContainsTrackedFiles(path)) {
					// Folder has tracked files but no folder record → pre-folder-tracking era
					// Remote folder gone → delete locally
					actions.push({ type: "delete-folder-local", vaultPath: path });
				} else {
					// No tracking record and not on remote → treat as new.
					// This covers genuinely new folders AND renamed folders (rename
					// preserves ctime so the old timestamp heuristic mis-identified
					// renamed folders as "deleted remotely").  Re-creating an empty
					// folder on the remote is harmless; deleting user data is not.
					actions.push({ type: "create-folder-remote", vaultPath: path });
				}
			} else if (!localExists && remote && isTracked) {
				// Was tracked, gone locally → delete remote
				actions.push({ type: "delete-folder-remote", remoteId: remote.id, vaultPath: path });
			} else if (!localExists && remote && !isTracked) {
				// New remote folder → create local
				actions.push({ type: "create-folder-local", vaultPath: path, remoteId: remote.id });
			} else if (!localExists && !remote && isTracked) {
				// Gone from both → clean up record
				this.stateStore.removeRecord(path);
			}
		}

		return actions;
	}

	private async executeFolderAction(action: SyncAction): Promise<void> {
		switch (action.type) {
			case "create-folder-remote": {
				const parentPath = getParentPath(action.vaultPath);
				const folderName = getFileName(action.vaultPath);
				// Providers take a folder id, not a path. They coincide on S3; on
				// Google Drive passing the path made every folder create fail.
				const parentId = await this.provider.getRemoteFolderId(await this.remotePath(parentPath));
				const remoteName = this.isEncrypted(action.vaultPath)
					? await this.encryption.remoteName(action.vaultPath)
					: folderName;
				const folderId = await this.provider.createFolder(parentId, remoteName);
				this.stateStore.setRecord(action.vaultPath, {
					vaultPath: action.vaultPath,
					remoteId: folderId,
					remoteFolderId: parentId,
					localModTime: Date.now(),
					remoteModTime: Date.now(),
					contentHash: FOLDER_SENTINEL,
				});
				break;
			}
			case "create-folder-local": {
				await this.fs.createFolder(this.root, action.vaultPath);
				this.stateStore.setRecord(action.vaultPath, {
					vaultPath: action.vaultPath,
					remoteId: action.remoteId,
					remoteFolderId: "",
					localModTime: Date.now(),
					remoteModTime: Date.now(),
					contentHash: FOLDER_SENTINEL,
				});
				break;
			}
			case "delete-folder-local": {
				await this.fs.deleteFolder(this.root, action.vaultPath);
				this.stateStore.removeRecord(action.vaultPath);
				break;
			}
			case "delete-folder-remote": {
				await this.provider.deleteFile(action.remoteId);
				this.stateStore.removeRecord(action.vaultPath);
				break;
			}
		}
	}

	// ---------- file actions ----------

	// Returns false when the action turned out to be a no-op (nothing
	// transferred), so the caller doesn't count it.
	private async executeAction(
		action: SyncAction,
		localMap: Map<string, LocalFileEntry>,
		remoteMap: Map<string, RemoteFileInfo>
	): Promise<boolean> {
		switch (action.type) {
			case "upload": {
				const entry = localMap.get(action.vaultPath)!;
				const bytes = await this.fs.readFile(this.root, action.vaultPath);
				const out = await this.prepareUpload(action.vaultPath, bytes);
				const parentPath = getParentPath(action.vaultPath);
				const folderId = await this.provider.getRemoteFolderId(await this.remotePath(parentPath));
				const fileName = this.isEncrypted(action.vaultPath)
					? await this.encryption.remoteName(action.vaultPath)
					: getFileName(action.vaultPath);
				const mimeType = guessMimeType(action.vaultPath);
				const remoteId = await this.provider.uploadFile(folderId, fileName, out.content, mimeType);
				const hash = computeMD5(toArrayBuffer(bytes));

				this.stateStore.setRecord(action.vaultPath, {
					vaultPath: action.vaultPath,
					remoteId,
					remoteFolderId: folderId,
					localModTime: entry.mtimeMs,
					remoteModTime: Date.now(),
					contentHash: hash,
					size: bytes.byteLength,
					remoteHash: out.remoteHash,
				});
				return true;
			}

			case "download": {
				const remote = remoteMap.get(action.vaultPath)!;
				const content = await this.downloadPlain(remote);
				await this.fs.writeFile(this.root, action.vaultPath, new Uint8Array(content));

				const hash = computeMD5(content);
				const fresh = await this.fs.statFile(this.root, action.vaultPath);

				this.stateStore.setRecord(action.vaultPath, {
					vaultPath: action.vaultPath,
					remoteId: action.remoteId,
					remoteFolderId: remote.parentId,
					localModTime: fresh?.mtimeMs ?? Date.now(),
					remoteModTime: remote.modifiedTime,
					contentHash: hash,
					size: content.byteLength,
					remoteHash: this.isEncrypted(action.vaultPath) ? remote.md5Checksum : undefined,
				});
				return true;
			}

			case "update-remote": {
				const bytes = await this.fs.readFile(this.root, action.vaultPath);
				const out = await this.prepareUpload(action.vaultPath, bytes);
				const mimeType = guessMimeType(action.vaultPath);
				await this.provider.updateFile(action.remoteId, out.content, mimeType);
				const hash = computeMD5(toArrayBuffer(bytes));
				const fresh = await this.fs.statFile(this.root, action.vaultPath);

				const record = this.stateStore.getRecord(action.vaultPath)!;
				record.localModTime = fresh?.mtimeMs ?? localMap.get(action.vaultPath)?.mtimeMs ?? Date.now();
				record.remoteModTime = Date.now();
				record.contentHash = hash;
				record.size = bytes.byteLength;
				record.remoteHash = out.remoteHash;
				this.stateStore.setRecord(action.vaultPath, record);
				return true;
			}

			case "update-local": {
				const remote = remoteMap.get(action.vaultPath)!;
				const content = await this.downloadPlain(remote);
				const hash = computeMD5(content);
				const record = this.stateStore.getRecord(action.vaultPath)!;
				const encrypted = this.isEncrypted(action.vaultPath);

				// Another device re-uploaded identical plaintext (new nonce,
				// new ETag). Rewriting it would bump the local mtime and can
				// start a cross-device loop; just note the new ciphertext.
				if (encrypted && hash === record.contentHash) {
					record.remoteModTime = remote.modifiedTime;
					record.remoteHash = remote.md5Checksum;
					this.stateStore.setRecord(action.vaultPath, record);
					return false;
				}

				await this.fs.writeFile(this.root, action.vaultPath, new Uint8Array(content));
				const fresh = await this.fs.statFile(this.root, action.vaultPath);

				record.localModTime = fresh?.mtimeMs ?? Date.now();
				record.remoteModTime = remote.modifiedTime;
				record.contentHash = hash;
				record.size = content.byteLength;
				record.remoteHash = encrypted ? remote.md5Checksum : undefined;
				this.stateStore.setRecord(action.vaultPath, record);
				return true;
			}

			case "delete-local": {
				await this.fs.deleteFile(this.root, action.vaultPath);
				this.stateStore.removeRecord(action.vaultPath);
				return true;
			}

			case "delete-remote": {
				await this.provider.deleteFile(action.remoteId);
				this.stateStore.removeRecord(action.vaultPath);
				return true;
			}
		}
		return true;
	}

	// ---------- helpers ----------

	private async remotePath(plainPath: string): Promise<string> {
		return this.encryption.toRemotePath(plainPath);
	}

	// Bytes to send for a local file: ciphertext in an encrypted folder (with
	// its MD5, which is what the remote ETag will be), the bytes as-is
	// otherwise.
	private async prepareUpload(
		vaultPath: string,
		plaintext: Uint8Array,
	): Promise<{ content: ArrayBuffer; remoteHash?: string }> {
		if (!this.isEncrypted(vaultPath)) return { content: toArrayBuffer(plaintext) };
		if (plaintext.byteLength + CONTENT_OVERHEAD_BYTES >= MULTIPART_THRESHOLD_BYTES) {
			throw new Error(
				`${vaultPath} is too large for an encrypted folder (limit ${Math.floor(MULTIPART_THRESHOLD_BYTES / 1024 / 1024)} MB)`
			);
		}
		const content = toArrayBuffer(await this.encryption.encrypt(vaultPath, plaintext));
		return { content, remoteHash: computeMD5(content) };
	}

	// A download whose bytes don't match the listing's ETag is stale: iOS's
	// native HTTP stack can serve a cached GET body for the same object URL.
	// Writing it locally would record the old content as in sync, so the
	// newer remote copy never comes down and the next local edit overwrites
	// it. Refuse it and let the next sync retry.
	private async downloadVerified(remote: RemoteFileInfo): Promise<ArrayBuffer> {
		const content = await this.provider.downloadFile(remote.id);
		const etag = remote.md5Checksum;
		if (etag && !isMultipartEtag(etag) && computeMD5(content) !== etag) {
			throw new Error(`Downloaded ${remote.path} does not match the remote listing (stale response); skipped, next sync retries`);
		}
		return content;
	}

	// Verified download, decrypted when the path is in an encrypted folder.
	// The ETag check runs on the ciphertext, before decryption.
	private async downloadPlain(remote: RemoteFileInfo): Promise<ArrayBuffer> {
		const content = await this.downloadVerified(remote);
		if (!this.isEncrypted(remote.path)) return content;
		return toArrayBuffer(await this.encryption.decrypt(remote.path, new Uint8Array(content)));
	}

	private shouldSkip(path: string): boolean {
		return isDotPath(path)
			|| shouldExclude(path, this.settings.excludePatterns)
			// Locked encrypted folder: invisible to planning, so neither its
			// files nor its tracked records can produce any action.
			|| this.encryption.isLocked(path);
	}

	private countAction(action: SyncAction, result: SyncResult): void {
		switch (action.type) {
			case "upload":
			case "update-remote":
			case "create-folder-remote":
				result.uploaded++;
				break;
			case "download":
			case "update-local":
			case "create-folder-local":
				result.downloaded++;
				break;
			case "delete-local":
			case "delete-remote":
			case "delete-folder-local":
			case "delete-folder-remote":
				result.deleted++;
				break;
		}
	}
}
