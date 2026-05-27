import { App, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import type CloudSyncPlugin from "./main";
import { GoogleDriveAuth } from "./providers/google-drive/google-drive-auth";
import { S3Provider } from "./providers/s3/s3-provider";

export class CloudSyncSettingTab extends PluginSettingTab {
	plugin: CloudSyncPlugin;

	constructor(app: App, plugin: CloudSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Cloud Sync Settings" });

		// --- Provider ---
		new Setting(containerEl)
			.setName("Provider")
			.setDesc("Cloud storage provider to sync with")
			.addDropdown((drop) =>
				drop
					.addOption("google-drive", "Google Drive")
					.addOption("s3", "S3 / rclone")
					.addOption("proton-drive", "Proton Drive (coming soon)")
					.setValue(this.plugin.settings.provider)
					.onChange(async (value) => {
						this.plugin.settings.provider = value as "google-drive" | "s3" | "proton-drive";
						await this.plugin.saveSettings();
						this.display();
					})
			);

		if (this.plugin.settings.provider === "google-drive") {
			this.displayGoogleDriveSettings(containerEl);
		} else if (this.plugin.settings.provider === "s3") {
			this.displayS3Settings(containerEl);
		}

		// --- Sync Settings ---
		containerEl.createEl("h3", { text: "Sync" });

		new Setting(containerEl)
			.setName("Conflict strategy")
			.setDesc("How to handle files modified on both sides since last sync")
			.addDropdown((drop) =>
				drop
					.addOption("prompt", "Prompt — review each conflict")
					.addOption("smart-merge", "Smart merge — auto-merge non-overlapping changes")
					.addOption("latest-wins", "Latest wins — newer timestamp takes priority")
					.addOption("use-local", "Always use local")
					.addOption("use-remote", "Always use remote")
					.setValue(this.plugin.settings.conflictStrategy ?? "prompt")
					.onChange(async (value) => {
						this.plugin.settings.conflictStrategy = value as "prompt" | "latest-wins" | "use-local" | "use-remote";
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Sync interval (minutes)")
			.setDesc("How often to auto-sync. 0 = disabled.")
			.addText((text) =>
				text
					.setPlaceholder("15")
					.setValue(String(this.plugin.settings.syncIntervalMinutes))
					.onChange(async (value) => {
						const num = parseInt(value, 10);
						if (!isNaN(num) && num >= 0) {
							this.plugin.settings.syncIntervalMinutes = num;
							await this.plugin.saveSettings();
							this.plugin.setupSyncInterval();
						}
					})
			);

		new Setting(containerEl)
			.setName("Sync on startup")
			.setDesc("Automatically sync when Obsidian opens")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.syncOnStartup)
					.onChange(async (value) => {
						this.plugin.settings.syncOnStartup = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Exclude patterns")
			.setDesc("Glob patterns to exclude from sync (one per line)")
			.addTextArea((text) =>
				text
					.setPlaceholder(".obsidian/**\n.trash/**")
					.setValue(this.plugin.settings.excludePatterns.join("\n"))
					.onChange(async (value) => {
						this.plugin.settings.excludePatterns = value
							.split("\n")
							.map((p) => p.trim())
							.filter((p) => p.length > 0);
						await this.plugin.saveSettings();
					})
			);

		if (Platform.isDesktop) {
			new Setting(containerEl)
				.setName("Merge tool command")
				.setDesc(
					'External merge tool for conflicts. Use {local} and {remote} as placeholders. E.g.: bcomp {local} {remote}'
				)
				.addText((text) =>
					text
						.setPlaceholder('bcomp {local} {remote}')
						.setValue(this.plugin.settings.mergeToolCommand)
						.onChange(async (value) => {
							this.plugin.settings.mergeToolCommand = value;
							await this.plugin.saveSettings();
						})
				);
		}

		// --- Status ---
		containerEl.createEl("h3", { text: "Status" });
		const lastSync = this.plugin.settings.syncState.lastSyncTime;
		const statusText = lastSync
			? `Last sync: ${new Date(lastSync).toLocaleString()}`
			: "Never synced";
		containerEl.createEl("p", { text: statusText });
		containerEl.createEl("p", {
			text: `Version: ${BUILD_COMMIT_SHA}`,
			cls: "setting-item-description",
		});
	}

	private displayS3Settings(containerEl: HTMLElement): void {
		containerEl.createEl("h3", { text: "S3 / rclone" });

		const s3 = this.plugin.settings.s3;

		new Setting(containerEl)
			.setName("Endpoint")
			.setDesc("Base URL of your rclone serve s3 instance, e.g. https://scott-notes.merlot.family")
			.addText((text) =>
				text
					.setPlaceholder("https://notes.example.com")
					.setValue(s3.endpoint)
					.onChange(async (value) => {
						this.plugin.settings.s3.endpoint = value.replace(/\/$/, "");
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Bucket")
			.setDesc("S3 bucket name — for rclone this is the first-level directory served")
			.addText((text) =>
				text
					.setPlaceholder("Notes")
					.setValue(s3.bucket)
					.onChange(async (value) => {
						this.plugin.settings.s3.bucket = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Access key")
			.addText((text) =>
				text
					.setPlaceholder("access key")
					.setValue(s3.accessKey)
					.onChange(async (value) => {
						this.plugin.settings.s3.accessKey = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Secret key")
			.addText((text) => {
				text
					.setPlaceholder("secret key")
					.setValue(s3.secretKey)
					.onChange(async (value) => {
						this.plugin.settings.s3.secretKey = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "password";
			});

		new Setting(containerEl)
			.setName("Region")
			.setDesc("Ignored by rclone but required by the S3 signing spec")
			.addText((text) =>
				text
					.setPlaceholder("us-east-1")
					.setValue(s3.region)
					.onChange(async (value) => {
						this.plugin.settings.s3.region = value || "us-east-1";
						await this.plugin.saveSettings();
					})
			);

		const isConfigured = s3.endpoint && s3.bucket && s3.accessKey && s3.secretKey;
		new Setting(containerEl)
			.setName("Test connection")
			.addButton((btn) =>
				btn
					.setButtonText("Test")
					.setDisabled(!isConfigured)
					.onClick(async () => {
						btn.setButtonText("Testing...").setDisabled(true);
						try {
							const provider = new S3Provider({
								endpoint: s3.endpoint,
								bucket: s3.bucket,
								accessKey: s3.accessKey,
								secretKey: s3.secretKey,
								region: s3.region,
							});
							const ok = await provider.testConnection();
							new Notice(ok ? "S3 connection successful" : "S3 connection failed — check endpoint and credentials");
						} catch (e) {
							new Notice(`S3 connection error: ${e instanceof Error ? e.message : String(e)}`);
						} finally {
							btn.setButtonText("Test").setDisabled(false);
						}
					})
			);
	}

	private displayGoogleDriveSettings(containerEl: HTMLElement): void {
		containerEl.createEl("h3", { text: "Google Drive" });

		const gd = this.plugin.settings.googleDrive;

		new Setting(containerEl)
			.setName("Client ID")
			.setDesc("From Google Cloud Console OAuth 2.0 credentials")
			.addText((text) =>
				text
					.setPlaceholder("your-client-id.apps.googleusercontent.com")
					.setValue(gd.clientId)
					.onChange(async (value) => {
						this.plugin.settings.googleDrive.clientId = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Client Secret")
			.setDesc("From Google Cloud Console OAuth 2.0 credentials")
			.addText((text) => {
				text
					.setPlaceholder("your-client-secret")
					.setValue(gd.clientSecret)
					.onChange(async (value) => {
						this.plugin.settings.googleDrive.clientSecret = value;
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "password";
			});

		// Auth status + buttons
		const isAuthed = gd.refreshToken.length > 0;

		if (!isAuthed) {
			new Setting(containerEl)
				.setName("Authenticate")
				.setDesc("Open Google OAuth in your browser, then paste the code below")
				.addButton((btn) =>
					btn
						.setButtonText("Open Google Auth")
						.setCta()
						.onClick(() => {
							if (!gd.clientId) {
								new Notice("Enter Client ID first");
								return;
							}
							const url = GoogleDriveAuth.getAuthUrl(gd.clientId);
							window.open(url);
						})
				);

			new Setting(containerEl)
				.setName("Auth code")
				.setDesc("Paste the code from the redirect page")
				.addText((text) =>
					text.setPlaceholder("Paste auth code here").onChange(() => {})
				)
				.addButton((btn) =>
					btn.setButtonText("Submit").onClick(async () => {
						const input = containerEl.querySelector<HTMLInputElement>(
							'input[placeholder="Paste auth code here"]'
						);
						const code = input?.value?.trim();
						if (!code) {
							new Notice("Enter the auth code first");
							return;
						}
						if (!gd.clientId || !gd.clientSecret) {
							new Notice("Enter Client ID and Secret first");
							return;
						}
						try {
							const tokens = await GoogleDriveAuth.exchangeCode(
								code,
								gd.clientId,
								gd.clientSecret
							);
							this.plugin.settings.googleDrive.accessToken = tokens.accessToken;
							this.plugin.settings.googleDrive.refreshToken = tokens.refreshToken;
							this.plugin.settings.googleDrive.tokenExpiry =
								Date.now() + tokens.expiresIn * 1000;
							await this.plugin.saveSettings();
							new Notice("Authenticated successfully!");
							this.display();
						} catch (e) {
							new Notice(`Auth failed: ${e instanceof Error ? e.message : String(e)}`);
						}
					})
				);
		} else {
			new Setting(containerEl)
				.setName("Authentication")
				.setDesc("Connected to Google Drive")
				.addButton((btn) =>
					btn.setButtonText("Disconnect").onClick(async () => {
						this.plugin.settings.googleDrive.accessToken = "";
						this.plugin.settings.googleDrive.refreshToken = "";
						this.plugin.settings.googleDrive.tokenExpiry = 0;
						this.plugin.settings.googleDrive.rootFolderId = "";
						this.plugin.settings.googleDrive.rootFolderName = "";
						await this.plugin.saveSettings();
						new Notice("Disconnected from Google Drive");
						this.display();
					})
				);

			// Folder selection
			const folderDesc = gd.rootFolderId
				? `Current: ${gd.rootFolderName || gd.rootFolderId}`
				: "No folder selected";

			new Setting(containerEl)
				.setName("Sync folder")
				.setDesc(folderDesc)
				.addButton((btn) =>
					btn.setButtonText("Choose Folder").onClick(async () => {
						try {
							await this.plugin.showFolderPicker();
							this.display();
						} catch (e) {
							new Notice(
								`Failed to load folders: ${e instanceof Error ? e.message : String(e)}`
							);
						}
					})
				);
		}
	}
}
