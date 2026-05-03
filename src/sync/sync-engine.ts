import { App, Notice, TFile } from "obsidian";
import type { CloudProvider } from "../providers/cloud-provider";
import type { SyncStateStore } from "./sync-state";
import type { PluginSettings, RemoteFileInfo, SyncAction } from "../types";
import { ConflictModal } from "./conflict-modal";
import { FirstSyncModal, type FirstSyncStrategy } from "./first-sync-modal";
import { computeMD5 } from "../util/hash";
import { getFileName, getParentPath, guessMimeType, shouldExclude } from "../util/path";

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

			// 1. Gather local files
			const localFiles = this.getLocalFiles();
			const localMap = new Map<string, TFile>();
			for (const f of localFiles) {
				localMap.set(f.path, f);
			}

			// 2. Gather remote files
			const remoteFiles = await this.provider.listAllFiles();
			const remoteMap = new Map<string, RemoteFileInfo>();
			for (const f of remoteFiles) {
				remoteMap.set(f.path, f);
			}

			// 3. Compute actions
			const actions = this.computeActions(localMap, remoteMap);

			// 4. Execute non-conflict actions first
			for (const action of actions) {
				if (action.type === "conflict") continue;
				try {
					await this.executeAction(action, localMap, remoteMap);
					this.countAction(action, result);
				} catch (e) {
					console.error(`Sync error on ${action.type} ${action.vaultPath}:`, e);
					result.errors++;
				}
			}

			// 5. Handle conflicts
			for (const action of actions) {
				if (action.type !== "conflict") continue;
				try {
					const resolved = await this.handleConflict(action, localMap, remoteMap);
					if (resolved) result.conflicts++;
				} catch (e) {
					console.error(`Conflict error on ${action.vaultPath}:`, e);
					result.errors++;
				}
			}

			// 6. Finalize
			this.stateStore.lastSyncTime = Date.now();
			await this.stateStore.save();
		} finally {
			this.syncing = false;
		}

		return result;
	}

	private getLocalFiles(): TFile[] {
		return this.app.vault
			.getFiles()
			.filter((f) => !shouldExclude(f.path, this.settings.excludePatterns));
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
			if (shouldExclude(path, this.settings.excludePatterns)) continue;

			const local = localMap.get(path);
			const remote = remoteMap.get(path);
			const record = this.stateStore.getRecord(path);

			if (local && remote && record) {
				// Both exist and tracked — check for changes
				const localChanged = local.stat.mtime > record.localModTime;
				const remoteChanged = remote.modifiedTime > record.remoteModTime;

				if (localChanged && remoteChanged) {
					actions.push({ type: "conflict", vaultPath: path, remoteId: remote.id });
				} else if (localChanged) {
					actions.push({ type: "update-remote", vaultPath: path, remoteId: remote.id });
				} else if (remoteChanged) {
					actions.push({ type: "update-local", vaultPath: path, remoteId: remote.id });
				}
				// Neither changed → skip
			} else if (local && remote && !record) {
				// Both exist but not tracked (first sync)
				if (this.firstSyncStrategy === "download") {
					actions.push({ type: "update-local", vaultPath: path, remoteId: remote.id });
				} else if (this.firstSyncStrategy === "upload") {
					actions.push({ type: "update-remote", vaultPath: path, remoteId: remote.id });
				} else {
					// merge or normal — treat as conflict
					actions.push({ type: "conflict", vaultPath: path, remoteId: remote.id });
				}
			} else if (local && !remote && record) {
				// Was tracked, remote deleted → delete local
				actions.push({ type: "delete-local", vaultPath: path });
			} else if (local && !remote && !record) {
				// New local file → upload
				actions.push({ type: "upload", vaultPath: path });
			} else if (!local && remote && record) {
				// Was tracked, local deleted → delete remote
				actions.push({ type: "delete-remote", remoteId: remote.id, vaultPath: path });
			} else if (!local && remote && !record) {
				// New remote file → download
				actions.push({ type: "download", vaultPath: path, remoteId: remote.id });
			}
			// !local && !remote → stale record, clean up
			else if (!local && !remote && record) {
				this.stateStore.removeRecord(path);
			}
		}

		return actions;
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
					// Ensure parent folder exists locally
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

	private async handleConflict(
		action: SyncAction & { type: "conflict" },
		localMap: Map<string, TFile>,
		remoteMap: Map<string, RemoteFileInfo>
	): Promise<boolean> {
		const file = localMap.get(action.vaultPath);
		const remote = remoteMap.get(action.vaultPath);
		if (!file || !remote) return false;

		// Check if content is actually the same
		const localContent = await this.app.vault.readBinary(file);
		const localHash = computeMD5(localContent);

		if (localHash === remote.md5Checksum) {
			// Content identical — just update tracking, no conflict
			this.stateStore.setRecord(action.vaultPath, {
				vaultPath: action.vaultPath,
				remoteId: remote.id,
				remoteFolderId: remote.parentId,
				localModTime: file.stat.mtime,
				remoteModTime: remote.modifiedTime,
				contentHash: localHash,
			});
			return false;
		}

		// Actual conflict — prompt user
		const modal = new ConflictModal(
			this.app,
			action.vaultPath,
			file.stat.mtime,
			remote.modifiedTime
		);
		const resolution = await modal.openAndWait();

		switch (resolution) {
			case "local":
				await this.executeAction(
					{ type: "update-remote", vaultPath: action.vaultPath, remoteId: action.remoteId },
					localMap,
					remoteMap
				);
				return true;

			case "remote":
				await this.executeAction(
					{ type: "update-local", vaultPath: action.vaultPath, remoteId: action.remoteId },
					localMap,
					remoteMap
				);
				return true;

			case "skip":
				return false;
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
				result.uploaded++;
				break;
			case "download":
			case "update-local":
				result.downloaded++;
				break;
			case "delete-local":
			case "delete-remote":
				result.deleted++;
				break;
		}
	}
}
