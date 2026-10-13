import { ItemView, Notice, Platform, Plugin, TFile, TFolder, TAbstractFile, setIcon } from "obsidian";
import {
	DEFAULT_SETTINGS,
	SyncEngine,
	S3Provider,
	SyncStateStore,
	isDotPath,
	shouldExclude,
	type CloudProvider,
	type PluginSettings,
} from "@cloud-drive-sync/core";
import { CloudSyncSettingTab } from "./settings";
import { FolderPickerModal } from "./sync/folder-picker-modal";
import { GoogleDriveApi } from "./providers/google-drive/google-drive-api";
import { GoogleAuthExpiredError, GoogleDriveAuth } from "./providers/google-drive/google-drive-auth";
import { GoogleDriveReauthModal } from "./providers/google-drive/google-drive-reauth-modal";
import { GoogleDriveProvider } from "./providers/google-drive/google-drive-provider";
import { ObsidianHttpClient } from "./http/obsidian-http-client";
import { ObsidianLocalFileSystem } from "./fs/obsidian-local-fs";
import { ObsidianSyncUI } from "./sync/obsidian-sync-ui";

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
	private mobileActionEl: HTMLElement | null = null;
	private pendingPaths: Set<string> = new Set();
	private debounceTimer: number | null = null;
	private currentStage = "";
	// Set when Google rejects the refresh token. Automatic syncs stop until the
	// user signs in again; a manual sync reopens the reconnect prompt.
	googleAuthExpired = false;
	private reauthModalOpen = false;
	// True for the whole of a sync, including while it waits on a conflict,
	// results or plan dialog. Without it the interval timer started another
	// sync every few minutes and stacked a new dialog over the unanswered one.
	private syncInFlight = false;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.addSettingTab(new CloudSyncSettingTab(this.app, this));

		// Ribbon icon only on desktop; phones use the native view-header
		// action button added in setupMobileAction().
		if (!Platform.isPhone) {
			this.ribbonEl = this.addRibbonIcon("cloud", "Cloud Sync", () => {
				this.runSync(true);
			});
		}
		this.updateRibbon("idle");

		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => {
				this.runSync(true);
			},
		});

		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.addClass("mod-clickable");
		this.statusBarEl.addEventListener("click", () => this.runSync(true));
		this.statusBarEl.setAttribute("aria-label", "Click to sync");
		this.updateStatusBar("idle");

		this.setupSyncInterval();
		this.setupStatusRefresh();
		this.setupFileWatcher();

		this.app.workspace.onLayoutReady(() => {
			this.setupMobileAction();
			if (this.settings.syncOnStartup) this.runSync();
		});
	}

	onunload(): void {
		if (this.syncIntervalId !== null) window.clearInterval(this.syncIntervalId);
		if (this.statusRefreshId !== null) window.clearInterval(this.statusRefreshId);
		if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
		this.mobileActionEl?.remove();
		this.mobileActionEl = null;
	}

	// Phone only: add a "cloud" action to the active view's header using
	// Obsidian's native addAction API, which positions and styles the button
	// for us. Re-added on leaf change since each view has its own header.
	private setupMobileAction(): void {
		if (!Platform.isPhone) return;
		this.addMobileActionToLeaf();
		this.registerEvent(
			this.app.workspace.on("active-leaf-change", () => this.addMobileActionToLeaf())
		);
	}

	private addMobileActionToLeaf(): void {
		const leaf = this.app.workspace.getMostRecentLeaf();
		if (!leaf || !(leaf.view instanceof ItemView)) return;
		this.mobileActionEl?.remove();
		this.mobileActionEl = leaf.view.addAction("cloud", "Cloud Sync", () => this.runSync(true));
		this.updateRibbon(this.isGoogleAuthExpired() ? "error" : "idle");
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

		// Left queued; flushed when the running sync finishes.
		if (this.syncInFlight) return;

		const paths = new Set(this.pendingPaths);
		this.pendingPaths.clear();

		// The full sync after reconnecting picks up these paths.
		if (this.isGoogleAuthExpired()) return;

		const engine = this.getSyncEngine();
		if (!engine) return;

		this.syncInFlight = true;
		this.updateStatusBar("syncing");
		this.updateRibbon("syncing");
		try {
			await engine.syncPaths(paths);
			this.updateStatusBar("idle");
			this.updateRibbon("idle");
		} catch (e) {
			if (e instanceof GoogleAuthExpiredError) {
				this.handleGoogleAuthExpired(e);
				return;
			}
			this.updateStatusBar("error");
			this.updateRibbon("error");
			console.error("File watcher sync failed:", e);
		} finally {
			this.syncFinished();
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

	private buildEngine(provider: CloudProvider, stateStore: SyncStateStore): SyncEngine {
		const ui = new ObsidianSyncUI(
			this.app, provider, stateStore,
			this.settings.debugMode ?? false,
			this.settings.mergeToolCommand,
		);
		const engine = new SyncEngine(
			new ObsidianLocalFileSystem(this.app), "",
			provider, stateStore, ui,
			{
				conflictStrategy: this.settings.conflictStrategy,
				excludePatterns: this.settings.excludePatterns,
				debugMode: this.settings.debugMode,
			},
		);
		engine.onNotice = (msg) => new Notice(msg);
		return engine;
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
			}, new ObsidianHttpClient());
			const stateStore = new SyncStateStore(this.settings.syncState, () => this.saveSettings());
			return this.buildEngine(provider, stateStore);
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

		return this.buildEngine(provider, stateStore);
	}

	async runSync(manual = false): Promise<void> {
		if (this.isGoogleAuthExpired()) {
			if (manual) this.promptGoogleReauth();
			return;
		}

		if (this.syncInFlight) {
			if (manual) new Notice("Sync already running. Finish any open sync dialog first.");
			return;
		}

		const engine = this.getSyncEngine();
		if (!engine) return;

		this.syncInFlight = true;
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
		} catch (e) {
			if (e instanceof GoogleAuthExpiredError) {
				this.handleGoogleAuthExpired(e);
				return;
			}
			this.currentStage = "idle";
			this.updateStatusBar("error");
			this.updateRibbon("error");
			new Notice(
				`Sync failed: ${e instanceof Error ? e.message : String(e)}`
			);
		} finally {
			this.syncFinished();
		}
	}

	private syncFinished(): void {
		this.syncInFlight = false;
		// Edits made while a dialog was open
		if (this.pendingPaths.size > 0) this.flushPendingSync();
	}

	private isGoogleAuthExpired(): boolean {
		return this.googleAuthExpired && this.settings.provider === "google-drive";
	}

	private handleGoogleAuthExpired(e: GoogleAuthExpiredError): void {
		console.warn(e.message);
		this.googleAuthExpired = true;
		this.currentStage = "auth-expired";
		this.updateStatusBar("error", "Reconnect Google Drive");
		this.updateRibbon("error", "Cloud Sync · reconnect Google Drive");
		this.promptGoogleReauth();
	}

	promptGoogleReauth(): void {
		if (this.reauthModalOpen) return;
		const modal = new GoogleDriveReauthModal(
			this.app,
			this.settings.googleDrive.clientId,
			async (code) => {
				await this.completeGoogleAuth(code);
				new Notice("Reconnected to Google Drive");
				this.runSync(true);
			},
			() => {
				this.reauthModalOpen = false;
			},
		);
		this.reauthModalOpen = true;
		modal.open();
	}

	// Swaps in fresh tokens from an auth code. Leaves the sync folder and sync
	// state alone, so it serves both first sign-in and reconnecting.
	async completeGoogleAuth(code: string): Promise<void> {
		const gd = this.settings.googleDrive;
		const tokens = await GoogleDriveAuth.exchangeCode(code, gd.clientId, gd.clientSecret);
		gd.accessToken = tokens.accessToken;
		gd.refreshToken = tokens.refreshToken;
		gd.tokenExpiry = Date.now() + tokens.expiresIn * 1000;
		await this.saveSettings();
		this.googleAuthExpired = false;
		this.currentStage = "idle";
		this.updateStatusBar("idle");
		this.updateRibbon("idle");
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

	private updateRibbon(state: "idle" | "syncing" | "error", errorLabel?: string): void {
		if (this.mobileActionEl) {
			if (state === "syncing") {
				setIcon(this.mobileActionEl, "refresh-cw");
				this.mobileActionEl.classList.add("cloud-sync-float-syncing");
			} else {
				setIcon(this.mobileActionEl, state === "error" ? "cloud-off" : "cloud");
				this.mobileActionEl.classList.remove("cloud-sync-float-syncing");
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
				this.ribbonEl.setAttribute("aria-label", errorLabel ?? "Cloud Sync · error");
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
				textSpan.setText(stageMsg ?? "Sync error");
				this.statusBarEl.classList.remove("cloud-sync-syncing");
				this.statusBarEl.classList.add("cloud-sync-error");
				break;
		}
	}
}
