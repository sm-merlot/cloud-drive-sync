import { App, ButtonComponent, Notice, Platform, PluginSettingTab, Setting } from "obsidian";
import { S3Provider } from "@cloud-drive-sync/core";
import type CloudSyncPlugin from "./main";
import { GoogleDriveAuth } from "./providers/google-drive/google-drive-auth";
import { KEEP_PASSWORD_WARNING, PasswordFormModal, TextPromptModal } from "./encryption/encryption-modals";
import { ObsidianHttpClient } from "./http/obsidian-http-client";

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

		this.displayEncryptionSettings(containerEl);
		this.displayAtRestSettings(containerEl);

		// --- Debug ---
		containerEl.createEl("h3", { text: "Debug" });

		new Setting(containerEl)
			.setName("Debug mode")
			.setDesc("Show all planned changes before every sync — useful for diagnosing unexpected uploads/downloads")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.debugMode ?? false)
					.onChange(async (value) => {
						this.plugin.settings.debugMode = value;
						await this.plugin.saveSettings();
					})
			);

		// --- Status ---
		containerEl.createEl("h3", { text: "Status" });
		const lastSync = this.plugin.settings.syncState.lastSyncTime;
		const statusText = lastSync
			? `Last sync: ${new Date(lastSync).toLocaleString()}`
			: "Never synced";
		containerEl.createEl("p", { text: statusText });
		containerEl.createEl("p", {
			text: `Version: ${this.plugin.manifest.version}`,
			cls: "setting-item-description",
		});
	}

	private displayAtRestSettings(containerEl: HTMLElement): void {
		containerEl.createEl("h3", { text: "Encrypted-at-rest folders" });
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: "Stricter than encrypted folders: notes and their names stay encrypted on this device too, and open only in Private notes after you type the password. The password is never stored, and the folder locks itself when you leave the app. You give up Obsidian's search, backlinks, graph and Live Preview for these notes.",
		});
		containerEl.createEl("p", { cls: "setting-item-description mod-warning", text: KEEP_PASSWORD_WARNING });
		const plugin = this.plugin;

		const report = (e: unknown) => new Notice(e instanceof Error ? e.message : String(e), 10_000);
		const pending = plugin.settings.pendingEncryptionOp;

		for (const session of plugin.atRest.sessions.values()) {
			const folder = session.folder;
			const row = new Setting(containerEl).setName(folder).setDesc(session.unlocked ? "Unlocked" : "Locked");
			if (pending?.folder === folder && pending.kind.startsWith("at-rest")) {
				row.setDesc("A change to this folder didn't finish. Resume it with the same password(s).");
				row.addButton((b) => b.setButtonText("Resume").setCta().onClick(() => void this.resumeAtRest(pending.kind, folder)));
				continue;
			}
			row.addButton((b) => b.setButtonText("Open").onClick(() => void plugin.openPrivateNotes()));
			row.addButton((b) => b.setButtonText("Change password").onClick(() => void this.changeAtRestPassword(folder)));
			row.addButton((b) =>
				b.setButtonText("Decrypt").setWarning().setTooltip("Turn back into a plain folder").onClick(async () => {
					const r = await new PasswordFormModal(this.app, {
						title: `Turn ${folder} back into a plain folder?`,
						intro: ["Every note is decrypted and stored as plaintext again, on this device and on the server. Other devices follow at their next sync."],
						fields: [{ key: "password", label: "Password" }],
						submitText: "Decrypt",
						danger: true,
					}).openAndWait();
					if (!r) return;
					try {
						await plugin.convertAtRestToPlaintext(folder, r.values.password!);
					} catch (e) {
						report(e);
					}
					this.display();
				}),
			);
		}
		if (pending?.kind === "at-rest-convert" && !plugin.atRest.sessions.has(pending.folder)) {
			new Setting(containerEl)
				.setName(pending.folder)
				.setDesc("Encrypting this folder at rest didn't finish. Resume it with the same password.")
				.addButton((b) => b.setButtonText("Resume").setCta().onClick(() => void this.resumeAtRest(pending.kind, pending.folder)));
		} else if (pending?.kind === "at-rest-plain" && !plugin.atRest.sessions.has(pending.folder)) {
			// Decrypted locally and unregistered; only the final sync was missed
			new Setting(containerEl)
				.setName(pending.folder)
				.setDesc("Decrypting this folder almost finished; one sync is left.")
				.addButton((b) => b.setButtonText("Finish").setCta().onClick(async () => {
					delete plugin.settings.pendingEncryptionOp;
					await plugin.saveSettings();
					await plugin.runSync(true);
					this.display();
				}));
		}
		new Setting(containerEl)
			.setName("Encrypt an existing folder at rest")
			.setDesc("Converts a plain folder you already have. For a folder that's already in Encrypted folders above, use its Make at-rest button.")
			.addButton((b) =>
				b.setButtonText("Choose folder").onClick(async () => {
					const r = await new PasswordFormModal(this.app, {
						title: "Encrypt an existing folder at rest",
						intro: [
							"Every note in the folder is encrypted on this device and on the server, names included, and from then on opens only in Private notes.",
							"Update the plugin on every device first. Afterwards, on every device: empty the system trash, and clear Settings → File recovery history. Older plaintext copies can linger there.",
							"Server snapshots and backups taken before now still contain the plaintext.",
						],
						warning: KEEP_PASSWORD_WARNING,
						folderPicker: true,
						fields: [{ key: "password", label: "Password", confirm: true }],
						submitText: "Encrypt at rest",
						danger: true,
					}).openAndWait();
					if (!r?.folder) return;
					try {
						await plugin.convertToAtRest(r.folder, r.values.password!);
					} catch (e) {
						report(e);
					}
					this.display();
				}),
			);
		new Setting(containerEl)
			.setName("Create encrypted-at-rest folder")
			.setDesc("A new, empty folder. Other devices pick it up at their next sync; unlock it there with the same password.")
			.addButton((b) =>
				b.setButtonText("Create").onClick(async () => {
					const name = await new TextPromptModal(this.app, "New encrypted-at-rest folder name", "Private").openAndWait();
					if (!name) return;
					const r = await new PasswordFormModal(this.app, {
						title: `Password for ${name}`,
						warning: KEEP_PASSWORD_WARNING,
						fields: [{ key: "password", label: "Password", confirm: true }],
						submitText: "Create",
					}).openAndWait();
					if (!r) return;
					try {
						await plugin.createAtRestFolder(name.replace(/^\/+|\/+$/g, ""), r.values.password!);
					} catch (e) {
						new Notice(e instanceof Error ? e.message : String(e), 10_000);
					}
					this.display();
				}),
			);
		new Setting(containerEl)
			.setName("Auto-lock after (minutes)")
			.setDesc("Locks after this long without using Private notes. Leaving the app always locks.")
			.addText((t) =>
				t.setPlaceholder("5")
					.setValue(String(plugin.settings.atRestIdleMinutes ?? 5))
					.onChange(async (v) => {
						const n = parseInt(v, 10);
						if (!isNaN(n) && n > 0) {
							plugin.settings.atRestIdleMinutes = n;
							await plugin.saveSettings();
						}
					}),
			);
	}

	private async changeAtRestPassword(folder: string): Promise<void> {
		const r = await new PasswordFormModal(this.app, {
			title: `Change the password for ${folder}`,
			intro: ["Every note is re-encrypted. Other devices lock the folder until you unlock it there with the new password."],
			warning: KEEP_PASSWORD_WARNING,
			fields: [
				{ key: "old", label: "Current password" },
				{ key: "new", label: "New password", confirm: true },
			],
			submitText: "Change password",
		}).openAndWait();
		if (!r) return;
		try {
			await this.plugin.changeAtRestPassword(folder, r.values.old!, r.values.new!);
		} catch (e) {
			new Notice(e instanceof Error ? e.message : String(e), 10_000);
		}
		this.display();
	}

	private async resumeAtRest(kind: string, folder: string): Promise<void> {
		try {
			if (kind === "at-rest-change") {
				await this.changeAtRestPassword(folder);
				return;
			}
			const r = await new PasswordFormModal(this.app, {
				title: `Resume: ${folder}`,
				fields: [{ key: "password", label: "Password" }],
				submitText: "Resume",
			}).openAndWait();
			if (!r) return;
			if (kind === "at-rest-convert") await this.plugin.convertToAtRest(folder, r.values.password!);
			else await this.plugin.convertAtRestToPlaintext(folder, r.values.password!);
		} catch (e) {
			new Notice(e instanceof Error ? e.message : String(e), 10_000);
		}
		this.display();
	}

	private displayEncryptionSettings(containerEl: HTMLElement): void {
		containerEl.createEl("h3", { text: "Encrypted folders" });
		containerEl.createEl("p", {
			cls: "setting-item-description",
			text: "Files in these folders are encrypted on this device before upload, so the server only ever holds ciphertext. A device without the password doesn't sync the folder at all.",
		});
		containerEl.createEl("p", { cls: "setting-item-description mod-warning", text: KEEP_PASSWORD_WARNING });

		const plugin = this.plugin;
		const report = (e: unknown) => new Notice(e instanceof Error ? e.message : String(e), 10_000);

		for (const folder of plugin.settings.encryptedFolders ?? []) {
			const locked = plugin.lockedFolders.find((l) => l.path === folder);
			const hasPassword = plugin.secrets.get(folder) !== null;
			const status = locked ? `Locked: ${locked.reason}` : hasPassword ? "Unlocked on this device" : "No password on this device";
			const row = new Setting(containerEl).setName(folder).setDesc(status);

			if (plugin.settings.pendingEncryptionOp?.folder === folder) {
				row.setDesc("An encryption change for this folder didn't finish. It stays locked on every device until it does.");
				row.addButton((b) =>
					b.setButtonText("Resume").setCta().onClick(async () => {
						await plugin.resumeEncryptionOp();
						this.display();
					}),
				);
				continue;
			}

			row.addButton((b) =>
				b.setButtonText(hasPassword ? "Re-enter password" : "Enter password").onClick(async () => {
					const r = await new PasswordFormModal(this.app, {
						title: `Password for ${folder}`,
						fields: [{ key: "password", label: "Password" }],
						submitText: "Unlock",
					}).openAndWait();
					if (!r) return;
					try {
						await plugin.setFolderPassword(folder, r.values.password!);
						this.display();
					} catch (e) {
						report(e);
					}
				}),
			);
			row.addButton((b) =>
				b.setButtonText("Change password").onClick(async () => {
					const r = await new PasswordFormModal(this.app, {
						title: `Change the password for ${folder}`,
						intro: [
							"Every file in the folder is re-encrypted. Other devices stop syncing it until you enter the new password there.",
						],
						warning: KEEP_PASSWORD_WARNING,
						fields: [
							{ key: "old", label: "Current password" },
							{ key: "new", label: "New password", confirm: true },
						],
						submitText: "Change password",
					}).openAndWait();
					if (!r) return;
					try {
						await plugin.changeFolderPassword(folder, r.values.old!, r.values.new!);
					} catch (e) {
						report(e);
					}
					this.display();
				}),
			);
			row.addButton((b) =>
				b.setButtonText("Make at-rest").setTooltip("Encrypt on this device too (Private notes)").onClick(async () => {
					const r = await new PasswordFormModal(this.app, {
						title: `Encrypt ${folder} at rest?`,
						intro: [
							"Every note in the folder is encrypted on this device and on the server, names included, and from then on opens only in Private notes.",
							"Update the plugin on every device first. Afterwards, on every device: empty the system trash, and clear Settings → File recovery history. Older plaintext copies can linger there.",
							"Server snapshots and backups taken before now still contain the plaintext.",
						],
						warning: KEEP_PASSWORD_WARNING,
						fields: [{ key: "password", label: "Password for Private notes", confirm: true }],
						submitText: "Encrypt at rest",
						danger: true,
					}).openAndWait();
					if (!r) return;
					try {
						await plugin.convertToAtRest(folder, r.values.password!);
					} catch (e) {
						report(e);
					}
					this.display();
				}),
			);
			row.addExtraButton((b) =>
				b.setIcon("x").setTooltip("Forget on this device (server unchanged)").onClick(async () => {
					await plugin.forgetEncryptedFolder(folder);
					this.display();
				}),
			);
			row.addButton((b) =>
				b.setButtonText("Remove encryption").setWarning().onClick(async () => {
					const r = await new PasswordFormModal(this.app, {
						title: `Remove encryption from ${folder}?`,
						intro: [
							"Every file in the folder is decrypted and stored on the server as plaintext again, readable by anything with access to the server.",
							"Other devices keep the folder locked until you remove it from their settings too.",
						],
						fields: [{ key: "password", label: "Password" }],
						submitText: "Decrypt on server",
						danger: true,
					}).openAndWait();
					if (!r) return;
					try {
						await plugin.removeFolderEncryption(folder, r.values.password!);
					} catch (e) {
						report(e);
					}
					this.display();
				}),
			);
		}

		new Setting(containerEl)
			.setName("Add encrypted folder")
			.setDesc("Encrypt a folder, or unlock one that another device already encrypted")
			.addButton((b) =>
				b.setButtonText("Add").onClick(async () => {
					const r = await new PasswordFormModal(this.app, {
						title: "Add encrypted folder",
						intro: [
							"If another device already encrypted this folder, enter the same password. Otherwise this sets its password.",
						],
						warning: KEEP_PASSWORD_WARNING,
						folderPicker: true,
						fields: [{ key: "password", label: "Password", confirm: true }],
						submitText: "Continue",
					}).openAndWait();
					if (!r?.folder) return;
					try {
						await plugin.addEncryptedFolder(r.folder, r.values.password!);
					} catch (e) {
						report(e);
					}
					this.display();
				}),
			);
	}

	private displayS3Settings(containerEl: HTMLElement): void {
		containerEl.createEl("h3", { text: "S3 / rclone" });

		const s3 = this.plugin.settings.s3;

		let testBtn: ButtonComponent;
		const updateTestBtn = () => {
			const s = this.plugin.settings.s3;
			testBtn?.setDisabled(!(s.endpoint && s.bucket && s.accessKey && s.secretKey));
		};

		new Setting(containerEl)
			.setName("Endpoint")
			.setDesc("Base URL of your rclone serve s3 instance, e.g. https://s3.example.com")
			.addText((text) =>
				text
					.setPlaceholder("https://notes.example.com")
					.setValue(s3.endpoint)
					.onChange(async (value) => {
						this.plugin.settings.s3.endpoint = value.replace(/\/$/, "");
						await this.plugin.saveSettings();
						updateTestBtn();
					})
			);

		new Setting(containerEl)
			.setName("Bucket")
			.setDesc("S3 bucket name — for rclone this is the first-level directory served")
			.addText((text) => {
				text
					.setPlaceholder("notes")
					.setValue(s3.bucket)
					.onChange(async (value) => {
						this.plugin.settings.s3.bucket = value;
						await this.plugin.saveSettings();
						updateTestBtn();
					});
				// On blur, tidy the typed value: lowercase and turn spaces into
				// hyphens — bucket dirs on the server are lowercase-only. Mirrors
				// the tauri app's bucket-field normalization.
				text.inputEl.addEventListener("blur", async () => {
					const tidied = text.inputEl.value.trim().toLowerCase().replace(/\s+/g, "-");
					if (tidied === text.inputEl.value) return;
					text.setValue(tidied);
					this.plugin.settings.s3.bucket = tidied;
					await this.plugin.saveSettings();
					updateTestBtn();
				});
				return text;
			});

		new Setting(containerEl)
			.setName("Access key")
			.addText((text) =>
				text
					.setPlaceholder("access key")
					.setValue(s3.accessKey)
					.onChange(async (value) => {
						this.plugin.settings.s3.accessKey = value;
						await this.plugin.saveSettings();
						updateTestBtn();
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
						updateTestBtn();
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

		new Setting(containerEl)
			.setName("Test connection")
			.addButton((btn) => {
				testBtn = btn;
				return btn
					.setButtonText("Test")
					.setDisabled(!(s3.endpoint && s3.bucket && s3.accessKey && s3.secretKey))
					.onClick(async () => {
						btn.setButtonText("Testing...").setDisabled(true);
						try {
							const provider = new S3Provider({
								endpoint: s3.endpoint,
								bucket: s3.bucket,
								accessKey: s3.accessKey,
								secretKey: s3.secretKey,
								region: s3.region,
							}, new ObsidianHttpClient());
							await provider.testConnection();
							new Notice("S3 connection successful");
						} catch (e) {
							new Notice(`S3 connection error: ${e instanceof Error ? e.message : String(e)}`);
						} finally {
							btn.setButtonText("Test").setDisabled(false);
						}
					})
				});
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
							await this.plugin.completeGoogleAuth(code);
							new Notice("Authenticated successfully!");
							this.display();
						} catch (e) {
							new Notice(`Auth failed: ${e instanceof Error ? e.message : String(e)}`);
						}
					})
				);
		} else {
			const authSetting = new Setting(containerEl)
				.setName("Authentication")
				.setDesc(
					this.plugin.googleAuthExpired
						? "Sign-in expired. Reconnect to resume syncing."
						: "Connected to Google Drive"
				);
			if (this.plugin.googleAuthExpired) {
				authSetting.addButton((btn) =>
					btn
						.setButtonText("Reconnect")
						.setCta()
						.onClick(() => this.plugin.promptGoogleReauth())
				);
			}
			authSetting.addButton((btn) =>
				btn.setButtonText("Disconnect").onClick(async () => {
					this.plugin.settings.googleDrive.accessToken = "";
					this.plugin.settings.googleDrive.refreshToken = "";
					this.plugin.settings.googleDrive.tokenExpiry = 0;
					this.plugin.settings.googleDrive.rootFolderId = "";
					this.plugin.settings.googleDrive.rootFolderName = "";
					this.plugin.googleAuthExpired = false;
					await this.plugin.saveSettings();
					new Notice("Disconnected from Google Drive");
					this.display();
				})
			);

			// Folder selection
			const folderDesc = gd.rootFolderId
				? `Current: ${gd.rootFolderName || gd.rootFolderId}`
				: "No folder selected. Choose creates one for this vault.";

			new Setting(containerEl)
				.setName("Sync folder")
				.setDesc(folderDesc)
				.addButton((btn) =>
					btn.setButtonText("Choose").onClick(async () => {
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
