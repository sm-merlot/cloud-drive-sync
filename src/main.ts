import { Notice, Plugin, TFile, TAbstractFile } from "obsidian";
import { CloudSyncSettingTab } from "./settings";
import { DEFAULT_SETTINGS, type PluginSettings } from "./types";
import { FolderPickerModal } from "./sync/folder-picker-modal";
import { GoogleDriveApi } from "./providers/google-drive/google-drive-api";
import { GoogleDriveAuth } from "./providers/google-drive/google-drive-auth";
import { GoogleDriveProvider } from "./providers/google-drive/google-drive-provider";
import { SyncEngine } from "./sync/sync-engine";
import { SyncStateStore } from "./sync/sync-state";
import { shouldExclude } from "./util/path";

const DEBOUNCE_MS = 5000;

export default class CloudSyncPlugin extends Plugin {
	settings: PluginSettings = DEFAULT_SETTINGS;
	private syncIntervalId: number | null = null;
	private statusBarEl: HTMLElement | null = null;
	private pendingPaths: Set<string> = new Set();
	private debounceTimer: number | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.addSettingTab(new CloudSyncSettingTab(this.app, this));

		this.addRibbonIcon("cloud", "Cloud Sync: Sync now", () => {
			this.runSync();
		});

		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => {
				this.runSync();
			},
		});

		this.statusBarEl = this.addStatusBarItem();
		this.updateStatusBar("idle");

		this.setupSyncInterval();
		this.setupFileWatcher();

		if (this.settings.syncOnStartup) {
			this.app.workspace.onLayoutReady(() => {
				this.runSync();
			});
		}
	}

	onunload(): void {
		if (this.syncIntervalId !== null) {
			window.clearInterval(this.syncIntervalId);
		}
		if (this.debounceTimer !== null) {
			window.clearTimeout(this.debounceTimer);
		}
	}

	private setupFileWatcher(): void {
		this.registerEvent(
			this.app.vault.on("create", (file: TAbstractFile) => {
				if (file instanceof TFile) this.queuePath(file.path);
			})
		);
		this.registerEvent(
			this.app.vault.on("modify", (file: TAbstractFile) => {
				if (file instanceof TFile) this.queuePath(file.path);
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (file: TAbstractFile) => {
				if (file instanceof TFile) this.queuePath(file.path);
			})
		);
		this.registerEvent(
			this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
				if (file instanceof TFile) {
					this.queuePath(oldPath);
					this.queuePath(file.path);
				}
			})
		);
	}

	private queuePath(path: string): void {
		if (shouldExclude(path, this.settings.excludePatterns)) return;
		// Don't queue if not configured
		const gd = this.settings.googleDrive;
		if (!gd.refreshToken || !gd.rootFolderId) return;
		// Don't queue before first sync
		if (this.settings.syncState.lastSyncTime === 0) return;

		this.pendingPaths.add(path);

		if (this.debounceTimer !== null) {
			window.clearTimeout(this.debounceTimer);
		}
		this.debounceTimer = window.setTimeout(() => {
			this.debounceTimer = null;
			this.flushPendingSync();
		}, DEBOUNCE_MS);
	}

	private async flushPendingSync(): Promise<void> {
		if (this.pendingPaths.size === 0) return;

		const paths = new Set(this.pendingPaths);
		this.pendingPaths.clear();

		const engine = this.getSyncEngine();
		if (!engine) return;

		this.updateStatusBar("syncing");
		try {
			const result = await engine.syncPaths(paths);
			this.updateStatusBar("idle");
			const total = result.uploaded + result.downloaded + result.deleted + result.conflicts;
			if (total > 0 || result.errors > 0) {
				const parts: string[] = [];
				if (result.uploaded > 0) parts.push(`${result.uploaded} uploaded`);
				if (result.downloaded > 0) parts.push(`${result.downloaded} downloaded`);
				if (result.deleted > 0) parts.push(`${result.deleted} deleted`);
				if (result.conflicts > 0) parts.push(`${result.conflicts} conflicts`);
				if (result.errors > 0) parts.push(`${result.errors} errors`);
				new Notice(`Sync: ${parts.join(", ")}`);
			}
		} catch (e) {
			this.updateStatusBar("error");
			console.error("File watcher sync failed:", e);
		}
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		// Ensure nested objects are merged properly
		this.settings.googleDrive = Object.assign(
			{},
			DEFAULT_SETTINGS.googleDrive,
			this.settings.googleDrive
		);
		this.settings.syncState = Object.assign(
			{},
			DEFAULT_SETTINGS.syncState,
			this.settings.syncState
		);
		if (!this.settings.syncState.files) {
			this.settings.syncState.files = {};
		}
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	setupSyncInterval(): void {
		if (this.syncIntervalId !== null) {
			window.clearInterval(this.syncIntervalId);
			this.syncIntervalId = null;
		}

		const minutes = this.settings.syncIntervalMinutes;
		if (minutes > 0) {
			this.syncIntervalId = window.setInterval(
				() => this.runSync(),
				minutes * 60 * 1000
			);
			this.registerInterval(this.syncIntervalId);
		}
	}

	private getSyncEngine(): SyncEngine | null {
		if (this.settings.provider !== "google-drive") {
			new Notice("Only Google Drive is supported currently");
			return null;
		}

		const gd = this.settings.googleDrive;
		if (!gd.refreshToken || !gd.clientId || !gd.clientSecret || !gd.rootFolderId) {
			new Notice("Configure Google Drive in plugin settings first");
			return null;
		}

		const auth = new GoogleDriveAuth(gd, (updates) => {
			Object.assign(this.settings.googleDrive, updates);
			this.saveSettings();
		});

		const api = new GoogleDriveApi(() => auth.ensureValidToken());
		const provider = new GoogleDriveProvider(api, gd.rootFolderId);
		const stateStore = new SyncStateStore(this.settings.syncState, () =>
			this.saveSettings()
		);

		return new SyncEngine(this.app, provider, stateStore, this.settings);
	}

	async runSync(): Promise<void> {
		const engine = this.getSyncEngine();
		if (!engine) return;

		this.updateStatusBar("syncing");
		try {
			const result = await engine.sync();
			this.updateStatusBar("idle");
			const parts: string[] = [];
			if (result.uploaded > 0) parts.push(`${result.uploaded} uploaded`);
			if (result.downloaded > 0) parts.push(`${result.downloaded} downloaded`);
			if (result.deleted > 0) parts.push(`${result.deleted} deleted`);
			if (result.conflicts > 0) parts.push(`${result.conflicts} conflicts resolved`);
			if (result.errors > 0) parts.push(`${result.errors} errors`);
			if (parts.length === 0) parts.push("everything up to date");
			new Notice(`Sync complete: ${parts.join(", ")}`);
		} catch (e) {
			this.updateStatusBar("error");
			new Notice(
				`Sync failed: ${e instanceof Error ? e.message : String(e)}`
			);
		}
	}

	async showFolderPicker(): Promise<void> {
		const gd = this.settings.googleDrive;
		const auth = new GoogleDriveAuth(gd, (updates) => {
			Object.assign(this.settings.googleDrive, updates);
			this.saveSettings();
		});
		const api = new GoogleDriveApi(() => auth.ensureValidToken());

		const folders = await api.listFolders("root");
		const modal = new FolderPickerModal(this.app, api, folders);
		const chosen = await modal.openAndWait();

		if (chosen) {
			this.settings.googleDrive.rootFolderId = chosen.id;
			this.settings.googleDrive.rootFolderName = chosen.name;
			await this.saveSettings();
			new Notice(`Sync folder set to: ${chosen.name}`);
		}
	}

	private updateStatusBar(state: "idle" | "syncing" | "error"): void {
		if (!this.statusBarEl) return;
		switch (state) {
			case "idle": {
				const last = this.settings.syncState.lastSyncTime;
				this.statusBarEl.setText(
					last ? `Synced ${new Date(last).toLocaleTimeString()}` : "Cloud Sync"
				);
				break;
			}
			case "syncing":
				this.statusBarEl.setText("Syncing...");
				break;
			case "error":
				this.statusBarEl.setText("Sync error");
				break;
		}
	}
}
