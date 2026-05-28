import { Notice, Plugin, TFile, TFolder, TAbstractFile, setIcon } from "obsidian";
import { CloudSyncSettingTab } from "./settings";
import { DEFAULT_SETTINGS, type PluginSettings } from "./types";
import { FolderPickerModal } from "./sync/folder-picker-modal";
import { GoogleDriveApi } from "./providers/google-drive/google-drive-api";
import { GoogleDriveAuth } from "./providers/google-drive/google-drive-auth";
import { GoogleDriveProvider } from "./providers/google-drive/google-drive-provider";
import { S3Provider } from "./providers/s3/s3-provider";
import { SyncEngine } from "./sync/sync-engine";
import { SyncStateStore } from "./sync/sync-state";
import { PluginUpdater } from "./updater";
import { isDotPath, shouldExclude } from "./util/path";

const DEBOUNCE_MS = 5000;
const STATUS_REFRESH_MS = 10_000;

function relativeTime(ms: number): string {
	const diff = Date.now() - ms;
	if (diff < 60_000) return "< 1m ago";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
	return new Date(ms).toLocaleDateString();
}

export default class CloudSyncPlugin extends Plugin {
	settings: PluginSettings = DEFAULT_SETTINGS;
	private syncIntervalId: number | null = null;
	private statusRefreshId: number | null = null;
	private statusBarEl: HTMLElement | null = null;
	private ribbonEl: HTMLElement | null = null;
	private syncFloatEl: HTMLElement | null = null;
	private pendingPaths: Set<string> = new Set();
	private debounceTimer: number | null = null;
	private currentStage = "";

	async onload(): Promise<void> {
		await this.loadSettings();

		this.addSettingTab(new CloudSyncSettingTab(this.app, this));

		this.ribbonEl = this.addRibbonIcon("cloud", "Cloud Sync", () => {
			this.runSync(true);
		});
		this.updateRibbon("idle");

		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => {
				this.runSync(true);
			},
		});

		this.addCommand({
			id: "check-plugin-update",
			name: "Check for plugin update",
			callback: () => this.checkForPluginUpdate(),
		});

		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass("mod-clickable");
		this.statusBarEl.addEventListener("click", () => this.runSync(true));
		this.statusBarEl.setAttribute("aria-label", "Click to sync");
		this.updateStatusBar("idle");

		this.syncFloatEl = document.body.createEl("div", { cls: "cloud-sync-float" });
		setIcon(this.syncFloatEl, "cloud");
		this.syncFloatEl.addEventListener("click", () => this.runSync(true));

		this.setupSyncInterval();
		this.setupStatusRefresh();
		this.setupFileWatcher();

		if (this.settings.syncOnStartup) {
			this.app.workspace.onLayoutReady(async () => {
				await this.runSync();
			});
		}
	}

	onunload(): void {
		if (this.syncIntervalId !== null) window.clearInterval(this.syncIntervalId);
		if (this.statusRefreshId !== null) window.clearInterval(this.statusRefreshId);
		if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
		this.syncFloatEl?.remove();
	}

	private setupFileWatcher(): void {
		this.registerEvent(
			this.app.vault.on("create", (file: TAbstractFile) => {
				if (file instanceof TFile || file instanceof TFolder) this.queuePath(file.path);
			})
		);
		this.registerEvent(
			this.app.vault.on("modify", (file: TAbstractFile) => {
				if (file instanceof TFile) this.queuePath(file.path);
			})
		);
		this.registerEvent(
			this.app.vault.on("delete", (file: TAbstractFile) => {
				if (file instanceof TFile || file instanceof TFolder) this.queuePath(file.path);
			})
		);
		this.registerEvent(
			this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
				if (file instanceof TFile || file instanceof TFolder) {
					this.queuePath(oldPath);
					this.queuePath(file.path);
				}
			})
		);
	}

	private isConfigured(): boolean {
		if (this.settings.provider === "s3") {
			const s3 = this.settings.s3;
			return !!(s3.endpoint && s3.bucket && s3.accessKey && s3.secretKey);
		}
		const gd = this.settings.googleDrive;
		return !!(gd.refreshToken && gd.rootFolderId);
	}

	private queuePath(path: string): void {
		if (isDotPath(path) || shouldExclude(path, this.settings.excludePatterns)) return;
		if (!this.isConfigured()) return;
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
		this.updateRibbon("syncing");
		try {
			await engine.syncPaths(paths);
			this.updateStatusBar("idle");
			this.updateRibbon("idle");
		} catch (e) {
			this.updateStatusBar("error");
			this.updateRibbon("error");
			console.error("File watcher sync failed:", e);
		}
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		this.settings.googleDrive = Object.assign(
			{},
			DEFAULT_SETTINGS.googleDrive,
			this.settings.googleDrive
		);
		this.settings.s3 = Object.assign(
			{},
			DEFAULT_SETTINGS.s3,
			this.settings.s3
		);
		if (!this.settings.conflictStrategy) {
			this.settings.conflictStrategy = DEFAULT_SETTINGS.conflictStrategy;
		}
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

	setupStatusRefresh(): void {
		if (this.statusRefreshId !== null) window.clearInterval(this.statusRefreshId);
		this.statusRefreshId = window.setInterval(() => {
			if (this.currentStage === "idle") {
				this.updateStatusBar("idle");
				this.updateRibbon("idle");
			}
		}, STATUS_REFRESH_MS);
		this.registerInterval(this.statusRefreshId);
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
		if (this.settings.provider === "s3") {
			const s3 = this.settings.s3;
			if (!s3.endpoint || !s3.bucket || !s3.accessKey || !s3.secretKey) {
				new Notice("Configure S3 in plugin settings first");
				return null;
			}
			const provider = new S3Provider({
				endpoint: s3.endpoint,
				bucket: s3.bucket,
				accessKey: s3.accessKey,
				secretKey: s3.secretKey,
				region: s3.region || "us-east-1",
			});
			const stateStore = new SyncStateStore(this.settings.syncState, () => this.saveSettings());
			return new SyncEngine(this.app, provider, stateStore, this.settings);
		}

		if (this.settings.provider !== "google-drive") {
			new Notice("Only Google Drive and S3 are supported currently");
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

	async runSync(manual = false): Promise<void> {
		const engine = this.getSyncEngine();
		if (!engine) return;

		engine.onProgress = () => {
			this.currentStage = "syncing";
			this.updateStatusBar("syncing");
			this.updateRibbon("syncing");
		};

		this.currentStage = "syncing";
		this.updateStatusBar("syncing", "Connecting...");
		this.updateRibbon("syncing");
		try {
			const result = await engine.sync();
			this.currentStage = "idle";
			this.updateStatusBar("idle");
			this.updateRibbon("idle");
			const parts: string[] = [];
			if (result.uploaded > 0) parts.push(`${result.uploaded} uploaded`);
			if (result.downloaded > 0) parts.push(`${result.downloaded} downloaded`);
			if (result.deleted > 0) parts.push(`${result.deleted} deleted`);
			if (result.conflicts > 0) parts.push(`${result.conflicts} conflicts resolved`);
			if (result.errors > 0) parts.push(`${result.errors} errors`);
			if (manual) {
				new Notice(parts.length > 0 ? `Sync: ${parts.join(", ")}` : "Everything up to date");
			}
			await this.checkForPluginUpdate();
		} catch (e) {
			this.currentStage = "idle";
			this.updateStatusBar("error");
			this.updateRibbon("error");
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

	private async checkForPluginUpdate(): Promise<void> {
		const provider = this.getSyncEngine()?.getProvider();
		if (!provider) return;
		const updater = new PluginUpdater(this.app, this.manifest.id, provider);
		await updater.checkAndPrompt();
	}

	private updateRibbon(state: "idle" | "syncing" | "error"): void {
		if (this.syncFloatEl) {
			if (state === "syncing") {
				setIcon(this.syncFloatEl, "refresh-cw");
				this.syncFloatEl.classList.add("cloud-sync-float-syncing");
			} else {
				setIcon(this.syncFloatEl, state === "error" ? "cloud-off" : "cloud");
				this.syncFloatEl.classList.remove("cloud-sync-float-syncing");
			}
		}
		if (!this.ribbonEl) return;
		const last = this.settings.syncState.lastSyncTime;
		switch (state) {
			case "idle":
				setIcon(this.ribbonEl, "cloud");
				this.ribbonEl.classList.remove("cloud-sync-ribbon-syncing");
				this.ribbonEl.setAttribute(
					"aria-label",
					last ? `Cloud Sync · ${relativeTime(last)}` : "Cloud Sync"
				);
				break;
			case "syncing":
				setIcon(this.ribbonEl, "refresh-cw");
				this.ribbonEl.classList.add("cloud-sync-ribbon-syncing");
				this.ribbonEl.setAttribute("aria-label", "Cloud Sync · syncing…");
				break;
			case "error":
				setIcon(this.ribbonEl, "cloud-off");
				this.ribbonEl.classList.remove("cloud-sync-ribbon-syncing");
				this.ribbonEl.setAttribute("aria-label", "Cloud Sync · error");
				break;
		}
	}

	private updateStatusBar(state: "idle" | "syncing" | "error", stageMsg?: string): void {
		if (!this.statusBarEl) return;
		this.statusBarEl.empty();

		const iconSpan = this.statusBarEl.createSpan({ cls: "cloud-sync-icon" });
		const textSpan = this.statusBarEl.createSpan();

		switch (state) {
			case "idle": {
				this.currentStage = "idle";
				setIcon(iconSpan, "cloud");
				const last = this.settings.syncState.lastSyncTime;
				textSpan.setText(last ? `Synced ${relativeTime(last)}` : "Cloud Sync");
				this.statusBarEl.classList.remove("cloud-sync-syncing", "cloud-sync-error");
				break;
			}
			case "syncing":
				setIcon(iconSpan, "refresh-cw");
				textSpan.setText(stageMsg ?? "Syncing...");
				this.statusBarEl.classList.add("cloud-sync-syncing");
				this.statusBarEl.classList.remove("cloud-sync-error");
				break;
			case "error":
				setIcon(iconSpan, "cloud-off");
				textSpan.setText("Sync error");
				this.statusBarEl.classList.remove("cloud-sync-syncing");
				this.statusBarEl.classList.add("cloud-sync-error");
				break;
		}
	}
}
