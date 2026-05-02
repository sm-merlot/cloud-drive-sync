import { Notice, Plugin } from "obsidian";
import { CloudSyncSettingTab } from "./settings";
import { DEFAULT_SETTINGS, type PluginSettings } from "./types";
import { FolderPickerModal } from "./sync/folder-picker-modal";
import { GoogleDriveApi } from "./providers/google-drive/google-drive-api";
import { GoogleDriveAuth } from "./providers/google-drive/google-drive-auth";
import { GoogleDriveProvider } from "./providers/google-drive/google-drive-provider";
import { SyncEngine } from "./sync/sync-engine";
import { SyncStateStore } from "./sync/sync-state";

export default class CloudSyncPlugin extends Plugin {
	settings: PluginSettings = DEFAULT_SETTINGS;
	private syncIntervalId: number | null = null;
	private statusBarEl: HTMLElement | null = null;
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
