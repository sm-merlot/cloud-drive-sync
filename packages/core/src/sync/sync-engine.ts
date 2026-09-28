import { RemoteNotFoundError } from "../providers/cloud-provider";
import type { CloudProvider } from "../providers/cloud-provider";
import type { SyncStateStore } from "./sync-state";
import type { ConflictStrategy, RemoteFileInfo, SyncAction } from "../types";
import type { LocalFileEntry, LocalFileSystem } from "../fs/local-file-system";
import type { FirstSyncStrategy, SyncIssue, SyncIssueResolution, SyncUIPort } from "./sync-ui-port";
import { computeMD5 } from "../util/hash";
import { getFileName, getParentPath, guessMimeType, isDotPath, shouldExclude } from "../util/path";
import { merge2way } from "../util/merge";
import { isProbablyText } from "../util/binary-guard";
import { HASH_VERIFY_THRESHOLD_BYTES } from "../util/constants";

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
}

export interface SyncEngineSettings {
	conflictStrategy: ConflictStrategy;
	excludePatterns: string[];
	debugMode?: boolean;
}

export class SyncEngine {
	private syncing = false;
	private firstSyncStrategy: FirstSyncStrategy | null = null;
	onProgress?: (message: string) => void;
	// User-visible notices (toasts in Obsidian, status line in Tauri)
	onNotice?: (message: string) => void;

	constructor(
		private fs: LocalFileSystem,
		private root: string,
		private provider: CloudProvider,
		private stateStore: SyncStateStore,
		private ui: SyncUIPort,
		private settings: SyncEngineSettings,
	) {}

	getProvider(): CloudProvider { return this.provider; }

	private progress(message: string): void {
		this.onProgress?.(message);
	}

	private emptyResult(): SyncResult {
		return { uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0, errors: 0, failures: [] };
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

			// 1. Gather local state
			this.progress("Listing local files...");
			const localMap = new Map<string, LocalFileEntry>();
			for (const f of await this.fs.listFiles(this.root)) {
				if (!this.shouldSkip(f.path)) localMap.set(f.path, f);
			}
			const localFolderPaths = new Set<string>();
			for (const p of await this.fs.listFolders(this.root)) {
				if (!this.shouldSkip(p)) localFolderPaths.add(p);
			}

			// 2. Gather remote state
			this.progress("Listing remote...");
			const allRemote = await this.provider.listAllFiles();
			const remoteMap = new Map<string, RemoteFileInfo>();
			const remoteFolderMap = new Map<string, RemoteFileInfo>();
			for (const f of allRemote) {
				if (f.isFolder) remoteFolderMap.set(f.path, f);
				else remoteMap.set(f.path, f);
			}

			// 3. Compute actions
			this.progress("Planning...");
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
					result.failures.push({ vaultPath: action.vaultPath, type: "error", errorMessage: msg });
					result.errors++;
				}
			}

			// 7. Execute file actions
			for (const action of nonConflictActions) {
				try {
					await this.executeAction(action, localMap, remoteMap);
					this.countAction(action, result);
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
					result.failures.push({ vaultPath: action.vaultPath, type: "error", errorMessage: msg });
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
			const allRemote = await this.provider.listAllFiles();
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
					result.failures.push({ vaultPath: action.vaultPath, type: "error", errorMessage: msg });
					result.errors++;
				}
			}

			// Phase 2: file actions
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

			const issues: SyncIssue[] = [...preIssues];

			for (const action of actions) {
				if (action.type === "conflict") continue;
				try {
					await this.executeAction(action, localMap, remoteMap);
					this.countAction(action, result);
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
					result.failures.push({ vaultPath: action.vaultPath, type: "error", errorMessage: msg });
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

	// ---------- classification ----------

	private localChanged(local: LocalFileEntry, record: { localModTime: number; size?: number }): boolean {
		const mtimeChanged = local.mtimeMs > record.localModTime;
		const sizeChanged = record.size !== undefined && local.size !== record.size;
		return mtimeChanged || sizeChanged;
	}

	private remoteChanged(remote: RemoteFileInfo, record: { remoteModTime: number; contentHash: string }): boolean {
		return remote.modifiedTime > record.remoteModTime
			&& (isMultipartEtag(remote.md5Checksum) || remote.md5Checksum !== record.contentHash);
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

		// Large files: skip the verification-only read entirely. Multipart
		// ETags aren't whole-file MD5s, so equality checks are meaningless.
		if (local.size >= HASH_VERIFY_THRESHOLD_BYTES || isMultipartEtag(remote.md5Checksum)) {
			return conflictIssue;
		}

		const localBytes = await this.fs.readFile(this.root, path);
		const localContent = toArrayBuffer(localBytes);
		const localHash = computeMD5(localContent);

		if (localHash === remote.md5Checksum) {
			// Identical content — auto-resolve silently
			this.stateStore.setRecord(path, {
				vaultPath: path,
				remoteId: remote.id,
				remoteFolderId: remote.parentId,
				localModTime: local.mtimeMs,
				remoteModTime: remote.modifiedTime,
				contentHash: localHash,
				size: local.size,
			});
			return null;
		}

		if (this.settings.conflictStrategy === "smart-merge") {
			const mimeType = guessMimeType(path);
			const remoteContent = await this.downloadVerified(remote);
			if (!isProbablyText(localContent, mimeType) || !isProbablyText(remoteContent, mimeType)) {
				// Binary content — a line merge would corrupt it
				return conflictIssue;
			}
			const localText = new TextDecoder().decode(localContent);
			const remoteText = new TextDecoder().decode(remoteContent);
			const { text: merged, conflicts } = merge2way(localText, remoteText);
			if (conflicts === 0) {
				// Clean — apply now, never surface to user
				const mergedBin = new TextEncoder().encode(merged);
				await this.fs.writeFile(this.root, path, mergedBin);
				await this.provider.updateFile(remote.id, toArrayBuffer(mergedBin), mimeType);
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
						if (res.remoteId && this.ui.externalMerge) {
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
		const remoteContent = await this.downloadVerified(remote);
		if (!isProbablyText(localContent, mimeType) || !isProbablyText(remoteContent, mimeType)) {
			this.onNotice?.(`Cannot merge binary file: ${vaultPath}`);
			return;
		}

		const localText = new TextDecoder().decode(localContent);
		const remoteText = new TextDecoder().decode(remoteContent);
		const { text: merged, conflicts } = merge2way(localText, remoteText);

		const mergedBin = new TextEncoder().encode(merged);
		await this.fs.writeFile(this.root, vaultPath, mergedBin);

		if (conflicts === 0) {
			await this.provider.updateFile(remoteId, toArrayBuffer(mergedBin), mimeType);
			const hash = computeMD5(toArrayBuffer(mergedBin));
			const fresh = await this.fs.statFile(this.root, vaultPath);
			this.stateStore.setRecord(vaultPath, {
				vaultPath, remoteId,
				remoteFolderId: remote.parentId,
				localModTime: fresh?.mtimeMs ?? Date.now(),
				remoteModTime: Date.now(),
				contentHash: hash,
				size: mergedBin.byteLength,
			});
			this.onNotice?.(`Auto-merged: ${vaultPath}`);
			return;
		}

		// Conflicts remain — markers written locally; hand to external tool or leave for user
		if (this.ui.externalMerge) {
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
				const folderId = await this.provider.createFolder(parentPath, folderName);
				this.stateStore.setRecord(action.vaultPath, {
					vaultPath: action.vaultPath,
					remoteId: folderId,
					remoteFolderId: parentPath,
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

	private async executeAction(
		action: SyncAction,
		localMap: Map<string, LocalFileEntry>,
		remoteMap: Map<string, RemoteFileInfo>
	): Promise<void> {
		switch (action.type) {
			case "upload": {
				const entry = localMap.get(action.vaultPath)!;
				const bytes = await this.fs.readFile(this.root, action.vaultPath);
				const content = toArrayBuffer(bytes);
				const parentPath = getParentPath(action.vaultPath);
				const folderId = await this.provider.getRemoteFolderId(parentPath);
				const fileName = getFileName(action.vaultPath);
				const mimeType = guessMimeType(action.vaultPath);
				const remoteId = await this.provider.uploadFile(folderId, fileName, content, mimeType);
				const hash = computeMD5(content);

				this.stateStore.setRecord(action.vaultPath, {
					vaultPath: action.vaultPath,
					remoteId,
					remoteFolderId: folderId,
					localModTime: entry.mtimeMs,
					remoteModTime: Date.now(),
					contentHash: hash,
					size: bytes.byteLength,
				});
				break;
			}

			case "download": {
				const remote = remoteMap.get(action.vaultPath)!;
				const content = await this.downloadVerified(remote);
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
				});
				break;
			}

			case "update-remote": {
				const bytes = await this.fs.readFile(this.root, action.vaultPath);
				const content = toArrayBuffer(bytes);
				const mimeType = guessMimeType(action.vaultPath);
				await this.provider.updateFile(action.remoteId, content, mimeType);
				const hash = computeMD5(content);
				const fresh = await this.fs.statFile(this.root, action.vaultPath);

				const record = this.stateStore.getRecord(action.vaultPath)!;
				record.localModTime = fresh?.mtimeMs ?? localMap.get(action.vaultPath)?.mtimeMs ?? Date.now();
				record.remoteModTime = Date.now();
				record.contentHash = hash;
				record.size = bytes.byteLength;
				this.stateStore.setRecord(action.vaultPath, record);
				break;
			}

			case "update-local": {
				const remote = remoteMap.get(action.vaultPath)!;
				const content = await this.downloadVerified(remote);
				await this.fs.writeFile(this.root, action.vaultPath, new Uint8Array(content));

				const hash = computeMD5(content);
				const fresh = await this.fs.statFile(this.root, action.vaultPath);

				const record = this.stateStore.getRecord(action.vaultPath)!;
				record.localModTime = fresh?.mtimeMs ?? Date.now();
				record.remoteModTime = remote.modifiedTime;
				record.contentHash = hash;
				record.size = content.byteLength;
				this.stateStore.setRecord(action.vaultPath, record);
				break;
			}

			case "delete-local": {
				await this.fs.deleteFile(this.root, action.vaultPath);
				this.stateStore.removeRecord(action.vaultPath);
				break;
			}

			case "delete-remote": {
				await this.provider.deleteFile(action.remoteId);
				this.stateStore.removeRecord(action.vaultPath);
				break;
			}
		}
	}

	// ---------- helpers ----------

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

	private shouldSkip(path: string): boolean {
		return isDotPath(path) || shouldExclude(path, this.settings.excludePatterns);
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
