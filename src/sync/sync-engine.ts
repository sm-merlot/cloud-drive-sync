import { App, Notice, Platform, TFile, TFolder } from "obsidian";
import type { CloudProvider } from "../providers/cloud-provider";
import type { SyncStateStore } from "./sync-state";
import type { PluginSettings, RemoteFileInfo, SyncAction } from "../types";
import { FirstSyncModal, type FirstSyncStrategy } from "./first-sync-modal";
import { SyncResultsModal, type SyncIssue, type SyncIssueResolution } from "./sync-results-modal";
import { computeMD5 } from "../util/hash";
import { getFileName, getParentPath, guessMimeType, isDotPath, shouldExclude } from "../util/path";

const FOLDER_SENTINEL = "__folder__";

export interface SyncResult {
	uploaded: number;
	downloaded: number;
	deleted: number;
	conflicts: number;
	errors: number;
}

export class SyncEngine {
	private app: App;
	private provider: CloudProvider;
	private stateStore: SyncStateStore;
	private settings: PluginSettings;
	private syncing = false;
	private firstSyncStrategy: FirstSyncStrategy | null = null;

	constructor(
		app: App,
		provider: CloudProvider,
		stateStore: SyncStateStore,
		settings: PluginSettings
	) {
		this.app = app;
		this.provider = provider;
		this.stateStore = stateStore;
		this.settings = settings;
	}

	async sync(): Promise<SyncResult> {
		if (this.syncing) {
			new Notice("Sync already in progress");
			return { uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0, errors: 0 };
		}

		this.syncing = true;
		const result: SyncResult = {
			uploaded: 0,
			downloaded: 0,
			deleted: 0,
			conflicts: 0,
			errors: 0,
		};

		try {
			// 0. First sync — ask user for strategy
			const isFirstSync = this.stateStore.lastSyncTime === 0;
			if (isFirstSync) {
				const modal = new FirstSyncModal(this.app);
				this.firstSyncStrategy = await modal.openAndWait();
			} else {
				this.firstSyncStrategy = null;
			}

			// 1. Gather local files and folders
			const localFiles = this.getLocalFiles();
			const localMap = new Map<string, TFile>();
			for (const f of localFiles) {
				localMap.set(f.path, f);
			}
			const localFolderPaths = this.getLocalFolderPaths();

			// 2. Gather remote files and folders
			const allRemote = await this.provider.listAllFiles();
			const remoteMap = new Map<string, RemoteFileInfo>();
			const remoteFolderMap = new Map<string, RemoteFileInfo>();
			for (const f of allRemote) {
				if (f.isFolder) {
					remoteFolderMap.set(f.path, f);
				} else {
					remoteMap.set(f.path, f);
				}
			}

			// 3. Compute actions
			const actions = this.computeActions(localMap, remoteMap);
			const folderActions = this.computeFolderActions(localFolderPaths, remoteFolderMap);

			// 4. Phase 1: folder creates (depth ascending — parents first)
			const issues: SyncIssue[] = [];
			const folderCreates = folderActions
				.filter(a => a.type === "create-folder-remote" || a.type === "create-folder-local")
				.sort((a, b) => a.vaultPath.split("/").length - b.vaultPath.split("/").length);

			for (const action of folderCreates) {
				try {
					await this.executeFolderAction(action);
					this.countAction(action, result);
				} catch (e) {
					console.error(`Sync error on ${action.type} ${action.vaultPath}:`, e);
					result.errors++;
				}
			}

			// 5. Phase 2: file actions (non-conflict)
			for (const action of actions) {
				if (action.type === "conflict") continue;
				try {
					await this.executeAction(action, localMap, remoteMap);
					this.countAction(action, result);
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					console.error(`Sync error on ${action.type} ${action.vaultPath}:`, e);
					issues.push({
						vaultPath: action.vaultPath,
						type: "error",
						remoteId: "remoteId" in action ? action.remoteId : undefined,
						errorMessage: msg,
					});
					result.errors++;
				}
			}

			// 6. Phase 3: folder deletes (depth descending — children first)
			const folderDeletes = folderActions
				.filter(a => a.type === "delete-folder-remote" || a.type === "delete-folder-local")
				.sort((a, b) => b.vaultPath.split("/").length - a.vaultPath.split("/").length);

			for (const action of folderDeletes) {
				try {
					await this.executeFolderAction(action);
					this.countAction(action, result);
				} catch (e) {
					console.error(`Sync error on ${action.type} ${action.vaultPath}:`, e);
					result.errors++;
				}
			}

			// 5. Collect conflicts (check hashes first to filter false conflicts)
			for (const action of actions) {
				if (action.type !== "conflict") continue;

				const file = localMap.get(action.vaultPath);
				const remote = remoteMap.get(action.vaultPath);
				if (!file || !remote) continue;

				const localContent = await this.app.vault.readBinary(file);
				const localHash = computeMD5(localContent);

				if (localHash === remote.md5Checksum) {
					// Content identical — auto-resolve
					this.stateStore.setRecord(action.vaultPath, {
						vaultPath: action.vaultPath,
						remoteId: remote.id,
						remoteFolderId: remote.parentId,
						localModTime: file.stat.mtime,
						remoteModTime: remote.modifiedTime,
						contentHash: localHash,
					});
				} else {
					issues.push({
						vaultPath: action.vaultPath,
						type: "conflict",
						remoteId: remote.id,
						localModTime: file.stat.mtime,
						remoteModTime: remote.modifiedTime,
					});
				}
			}

			// 6. Show results modal if there are issues
			if (issues.length > 0) {
				const resolutions = await this.showResultsModal(issues);
				await this.applyResolutions(resolutions, localMap, remoteMap, result);
			}

			// 7. Finalize
			this.stateStore.lastSyncTime = Date.now();
			await this.stateStore.save();
		} finally {
			this.syncing = false;
		}

		return result;
	}

	async syncPaths(paths: Set<string>): Promise<SyncResult> {
		if (this.syncing) {
			return { uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0, errors: 0 };
		}

		this.syncing = true;
		const result: SyncResult = {
			uploaded: 0,
			downloaded: 0,
			deleted: 0,
			conflicts: 0,
			errors: 0,
		};

		try {
			const allRemote = await this.provider.listAllFiles();
			const remoteMap = new Map<string, RemoteFileInfo>();
			const remoteFolderMap = new Map<string, RemoteFileInfo>();
			for (const f of allRemote) {
				if (f.isFolder) {
					remoteFolderMap.set(f.path, f);
				} else {
					remoteMap.set(f.path, f);
				}
			}

			const localMap = new Map<string, TFile>();
			const localFolderPaths = new Set<string>();
			const folderPaths = new Set<string>();

			for (const path of paths) {
				if (this.shouldSkip(path)) continue;
				const abstract = this.app.vault.getAbstractFileByPath(path);
				if (abstract instanceof TFile) {
					localMap.set(path, abstract);
				} else if (abstract instanceof TFolder) {
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
					console.error(`Sync error on ${action.type} ${action.vaultPath}:`, e);
					result.errors++;
				}
			}

			// Phase 2: file actions
			const actions: SyncAction[] = [];
			for (const path of paths) {
				if (this.shouldSkip(path)) continue;
				if (folderPaths.has(path)) continue;

				const local = localMap.get(path);
				const remote = remoteMap.get(path);
				const record = this.stateStore.getRecord(path);

				if (local && remote && record) {
					const localChanged = local.stat.mtime > record.localModTime;
					const remoteChanged = remote.modifiedTime > record.remoteModTime;
					if (localChanged && remoteChanged) {
						actions.push({ type: "conflict", vaultPath: path, remoteId: remote.id });
					} else if (localChanged) {
						actions.push({ type: "update-remote", vaultPath: path, remoteId: remote.id });
					} else if (remoteChanged) {
						actions.push({ type: "update-local", vaultPath: path, remoteId: remote.id });
					}
				} else if (local && remote && !record) {
					actions.push({ type: "conflict", vaultPath: path, remoteId: remote.id });
				} else if (local && !remote && record) {
					actions.push({ type: "delete-local", vaultPath: path });
				} else if (local && !remote && !record) {
					actions.push({ type: "upload", vaultPath: path });
				} else if (!local && remote && record) {
					actions.push({ type: "delete-remote", remoteId: remote.id, vaultPath: path });
				} else if (!local && remote && !record) {
					actions.push({ type: "download", vaultPath: path, remoteId: remote.id });
				} else if (!local && !remote && record) {
					this.stateStore.removeRecord(path);
				}
			}

			const issues: SyncIssue[] = [];

			for (const action of actions) {
				if (action.type === "conflict") continue;
				try {
					await this.executeAction(action, localMap, remoteMap);
					this.countAction(action, result);
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					console.error(`Sync error on ${action.type} ${action.vaultPath}:`, e);
					issues.push({
						vaultPath: action.vaultPath,
						type: "error",
						remoteId: "remoteId" in action ? action.remoteId : undefined,
						errorMessage: msg,
					});
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
					console.error(`Sync error on ${action.type} ${action.vaultPath}:`, e);
					result.errors++;
				}
			}

			for (const action of actions) {
				if (action.type !== "conflict") continue;
				const file = localMap.get(action.vaultPath);
				const remote = remoteMap.get(action.vaultPath);
				if (!file || !remote) continue;

				const localContent = await this.app.vault.readBinary(file);
				const localHash = computeMD5(localContent);

				if (localHash === remote.md5Checksum) {
					this.stateStore.setRecord(action.vaultPath, {
						vaultPath: action.vaultPath,
						remoteId: remote.id,
						remoteFolderId: remote.parentId,
						localModTime: file.stat.mtime,
						remoteModTime: remote.modifiedTime,
						contentHash: localHash,
					});
				} else {
					issues.push({
						vaultPath: action.vaultPath,
						type: "conflict",
						remoteId: remote.id,
						localModTime: file.stat.mtime,
						remoteModTime: remote.modifiedTime,
					});
				}
			}

			if (issues.length > 0) {
				const resolutions = await this.showResultsModal(issues);
				await this.applyResolutions(resolutions, localMap, remoteMap, result);
			}

			this.stateStore.lastSyncTime = Date.now();
			await this.stateStore.save();
		} finally {
			this.syncing = false;
		}

		return result;
	}

	private async showResultsModal(issues: SyncIssue[]): Promise<SyncIssueResolution[]> {
		const modal = new SyncResultsModal(this.app, issues);
		return modal.openAndWait();
	}

	private async applyResolutions(
		resolutions: SyncIssueResolution[],
		localMap: Map<string, TFile>,
		remoteMap: Map<string, RemoteFileInfo>,
		result: SyncResult
	): Promise<void> {
		for (const res of resolutions) {
			try {
				switch (res.resolution) {
					case "local":
						if (res.remoteId) {
							await this.executeAction(
								{ type: "update-remote", vaultPath: res.vaultPath, remoteId: res.remoteId },
								localMap,
								remoteMap
							);
							result.conflicts++;
						}
						break;

					case "remote":
						if (res.remoteId) {
							await this.executeAction(
								{ type: "update-local", vaultPath: res.vaultPath, remoteId: res.remoteId },
								localMap,
								remoteMap
							);
							result.conflicts++;
						}
						break;

					case "merge":
						if (res.remoteId && Platform.isDesktop) {
							await this.mergeWithExternalTool(res.vaultPath, res.remoteId, localMap, remoteMap);
							result.conflicts++;
						}
						break;

					case "retry":
						// Re-attempt: figure out what action to take
						await this.retryFile(res.vaultPath, localMap, remoteMap, result);
						break;

					case "skip":
						break;
				}
			} catch (e) {
				console.error(`Resolution error on ${res.vaultPath}:`, e);
				result.errors++;
			}
		}
	}

	private async mergeWithExternalTool(
		vaultPath: string,
		remoteId: string,
		localMap: Map<string, TFile>,
		remoteMap: Map<string, RemoteFileInfo>
	): Promise<void> {
		const file = localMap.get(vaultPath);
		if (!file) return;

		const remoteContent = await this.provider.downloadFile(remoteId);
		const remote = remoteMap.get(vaultPath)!;

		// Write remote version to a temp file next to the local file
		const tempPath = vaultPath.replace(/(\.[^.]+)$/, `.remote$1`);
		const existing = this.app.vault.getAbstractFileByPath(tempPath);
		if (existing instanceof TFile) {
			await this.app.vault.modifyBinary(existing, remoteContent);
		} else {
			const parentPath = getParentPath(tempPath);
			if (parentPath) {
				await this.ensureLocalFolder(parentPath);
			}
			await this.app.vault.createBinary(tempPath, remoteContent);
		}

		// Get absolute paths for external tool
		const adapter = this.app.vault.adapter;
		const localAbsPath = (adapter as { getFullPath?: (p: string) => string }).getFullPath?.(vaultPath);
		const remoteAbsPath = (adapter as { getFullPath?: (p: string) => string }).getFullPath?.(tempPath);

		if (localAbsPath && remoteAbsPath && this.settings.mergeToolCommand) {
			const cmd = this.settings.mergeToolCommand
				.replace("{local}", `"${localAbsPath}"`)
				.replace("{remote}", `"${remoteAbsPath}"`);

			const { exec } = require("child_process") as typeof import("child_process");
			await new Promise<void>((resolve, reject) => {
				exec(cmd, (error: Error | null) => {
					if (error) reject(error);
					else resolve();
				});
			});
		} else {
			new Notice(
				`Remote version saved as ${tempPath}. Merge manually, then delete the .remote file.`
			);
		}

		// After merge, upload the local version (user edited it) and update tracking
		const mergedContent = await this.app.vault.readBinary(file);
		const mimeType = guessMimeType(vaultPath);
		await this.provider.updateFile(remoteId, mergedContent, mimeType);
		const hash = computeMD5(mergedContent);

		this.stateStore.setRecord(vaultPath, {
			vaultPath,
			remoteId,
			remoteFolderId: remote.parentId,
			localModTime: file.stat.mtime,
			remoteModTime: Date.now(),
			contentHash: hash,
		});

		// Clean up temp file
		const tempFile = this.app.vault.getAbstractFileByPath(tempPath);
		if (tempFile instanceof TFile) {
			await this.app.vault.delete(tempFile);
		}
	}

	private async retryFile(
		vaultPath: string,
		localMap: Map<string, TFile>,
		remoteMap: Map<string, RemoteFileInfo>,
		result: SyncResult
	): Promise<void> {
		const local = this.app.vault.getAbstractFileByPath(vaultPath);
		const remote = remoteMap.get(vaultPath);
		const record = this.stateStore.getRecord(vaultPath);

		// Re-populate localMap if file exists now
		if (local instanceof TFile) {
			localMap.set(vaultPath, local);
		}

		if (local instanceof TFile && remote && record) {
			await this.executeAction(
				{ type: "update-remote", vaultPath, remoteId: remote.id },
				localMap,
				remoteMap
			);
			result.uploaded++;
		} else if (local instanceof TFile && !remote) {
			await this.executeAction({ type: "upload", vaultPath }, localMap, remoteMap);
			result.uploaded++;
		} else if (!local && remote && record) {
			await this.executeAction(
				{ type: "delete-remote", vaultPath, remoteId: remote.id },
				localMap,
				remoteMap
			);
			result.deleted++;
		} else if (local instanceof TFile && remote) {
			await this.executeAction(
				{ type: "update-remote", vaultPath, remoteId: remote.id },
				localMap,
				remoteMap
			);
			result.uploaded++;
		}
	}

	private shouldSkip(path: string): boolean {
		return isDotPath(path) || shouldExclude(path, this.settings.excludePatterns);
	}

	private getLocalFiles(): TFile[] {
		return this.app.vault
			.getFiles()
			.filter((f) => !this.shouldSkip(f.path));
	}

	private getLocalFolderPaths(): Set<string> {
		const paths = new Set<string>();
		const walk = (folder: TFolder) => {
			for (const child of folder.children) {
				if (child instanceof TFolder) {
					if (!this.shouldSkip(child.path)) {
						paths.add(child.path);
					}
					walk(child);
				}
			}
		};
		walk(this.app.vault.getRoot());
		return paths;
	}

	private computeActions(
		localMap: Map<string, TFile>,
		remoteMap: Map<string, RemoteFileInfo>
	): SyncAction[] {
		const actions: SyncAction[] = [];
		const allPaths = new Set<string>();

		for (const path of localMap.keys()) allPaths.add(path);
		for (const path of remoteMap.keys()) allPaths.add(path);
		for (const path of this.stateStore.getAllTrackedPaths()) allPaths.add(path);

		for (const path of allPaths) {
			if (this.shouldSkip(path)) continue;

			const local = localMap.get(path);
			const remote = remoteMap.get(path);
			const record = this.stateStore.getRecord(path);

			if (local && remote && record) {
				const localChanged = local.stat.mtime > record.localModTime;
				const remoteChanged = remote.modifiedTime > record.remoteModTime;

				if (localChanged && remoteChanged) {
					actions.push({ type: "conflict", vaultPath: path, remoteId: remote.id });
				} else if (localChanged) {
					actions.push({ type: "update-remote", vaultPath: path, remoteId: remote.id });
				} else if (remoteChanged) {
					actions.push({ type: "update-local", vaultPath: path, remoteId: remote.id });
				}
			} else if (local && remote && !record) {
				if (this.firstSyncStrategy === "download") {
					actions.push({ type: "update-local", vaultPath: path, remoteId: remote.id });
				} else if (this.firstSyncStrategy === "upload") {
					actions.push({ type: "update-remote", vaultPath: path, remoteId: remote.id });
				} else {
					actions.push({ type: "conflict", vaultPath: path, remoteId: remote.id });
				}
			} else if (local && !remote && record) {
				actions.push({ type: "delete-local", vaultPath: path });
			} else if (local && !remote && !record) {
				actions.push({ type: "upload", vaultPath: path });
			} else if (!local && remote && record) {
				actions.push({ type: "delete-remote", remoteId: remote.id, vaultPath: path });
			} else if (!local && remote && !record) {
				actions.push({ type: "download", vaultPath: path, remoteId: remote.id });
			} else if (!local && !remote && record) {
				this.stateStore.removeRecord(path);
			}
		}

		return actions;
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
				// New local folder → create remote
				actions.push({ type: "create-folder-remote", vaultPath: path });
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
				const folderId = await this.provider.getRemoteFolderId(action.vaultPath);
				this.stateStore.setRecord(action.vaultPath, {
					vaultPath: action.vaultPath,
					remoteId: folderId,
					remoteFolderId: "",
					localModTime: Date.now(),
					remoteModTime: Date.now(),
					contentHash: FOLDER_SENTINEL,
				});
				break;
			}
			case "create-folder-local": {
				await this.ensureLocalFolder(action.vaultPath);
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
				const folder = this.app.vault.getAbstractFileByPath(action.vaultPath);
				if (folder instanceof TFolder) {
					await this.app.vault.trash(folder, true);
				}
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

	private async executeAction(
		action: SyncAction,
		localMap: Map<string, TFile>,
		remoteMap: Map<string, RemoteFileInfo>
	): Promise<void> {
		switch (action.type) {
			case "upload": {
				const file = localMap.get(action.vaultPath)!;
				const content = await this.app.vault.readBinary(file);
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
					localModTime: file.stat.mtime,
					remoteModTime: Date.now(),
					contentHash: hash,
				});
				break;
			}

			case "download": {
				const content = await this.provider.downloadFile(action.remoteId);
				const remote = remoteMap.get(action.vaultPath)!;
				const existing = this.app.vault.getAbstractFileByPath(action.vaultPath);

				if (existing instanceof TFile) {
					await this.app.vault.modifyBinary(existing, content);
				} else {
					const parentPath = getParentPath(action.vaultPath);
					if (parentPath) {
						await this.ensureLocalFolder(parentPath);
					}
					await this.app.vault.createBinary(action.vaultPath, content);
				}

				const hash = computeMD5(content);
				const newFile = this.app.vault.getAbstractFileByPath(action.vaultPath);

				this.stateStore.setRecord(action.vaultPath, {
					vaultPath: action.vaultPath,
					remoteId: action.remoteId,
					remoteFolderId: remote.parentId,
					localModTime: newFile instanceof TFile ? newFile.stat.mtime : Date.now(),
					remoteModTime: remote.modifiedTime,
					contentHash: hash,
				});
				break;
			}

			case "update-remote": {
				const file = localMap.get(action.vaultPath)!;
				const content = await this.app.vault.readBinary(file);
				const mimeType = guessMimeType(action.vaultPath);
				await this.provider.updateFile(action.remoteId, content, mimeType);
				const hash = computeMD5(content);

				const record = this.stateStore.getRecord(action.vaultPath)!;
				record.localModTime = file.stat.mtime;
				record.remoteModTime = Date.now();
				record.contentHash = hash;
				this.stateStore.setRecord(action.vaultPath, record);
				break;
			}

			case "update-local": {
				const content = await this.provider.downloadFile(action.remoteId);
				const file = localMap.get(action.vaultPath);
				const remote = remoteMap.get(action.vaultPath)!;

				if (file) {
					await this.app.vault.modifyBinary(file, content);
				}

				const hash = computeMD5(content);
				const updatedFile = this.app.vault.getAbstractFileByPath(action.vaultPath);

				const record = this.stateStore.getRecord(action.vaultPath)!;
				record.localModTime = updatedFile instanceof TFile ? updatedFile.stat.mtime : Date.now();
				record.remoteModTime = remote.modifiedTime;
				record.contentHash = hash;
				this.stateStore.setRecord(action.vaultPath, record);
				break;
			}

			case "delete-local": {
				const file = localMap.get(action.vaultPath);
				if (file) {
					await this.app.vault.trash(file, true);
				}
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

	private async ensureLocalFolder(path: string): Promise<void> {
		const existing = this.app.vault.getAbstractFileByPath(path);
		if (existing) return;

		const parent = getParentPath(path);
		if (parent) {
			await this.ensureLocalFolder(parent);
		}
		await this.app.vault.createFolder(path);
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
