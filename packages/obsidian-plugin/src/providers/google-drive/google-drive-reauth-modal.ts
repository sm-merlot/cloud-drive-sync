import { App, Modal, Notice, Setting } from "obsidian";
import { GoogleDriveAuth } from "./google-drive-auth";

/**
 * Shown when Google rejects the stored refresh token. Walks the user through
 * signing in again without the Disconnect step, so the chosen sync folder and
 * the sync state survive and the next sync carries on where it stopped.
 */
export class GoogleDriveReauthModal extends Modal {
	private clientId: string;
	private onCode: (code: string) => Promise<void>;
	private onClosed: () => void;

	constructor(
		app: App,
		clientId: string,
		onCode: (code: string) => Promise<void>,
		onClosed: () => void
	) {
		super(app);
		this.clientId = clientId;
		this.onCode = onCode;
		this.onClosed = onClosed;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "Google Drive disconnected" });
		contentEl.createEl("p", {
			text: "Google expired this vault's sign-in, so syncing has paused. Sign in again to resume. Your sync folder and sync history are kept.",
		});

		new Setting(contentEl)
			.setName("1. Sign in")
			.setDesc("Opens Google in your browser")
			.addButton((btn) =>
				btn
					.setButtonText("Open Google sign-in")
					.setCta()
					.onClick(() => window.open(GoogleDriveAuth.getAuthUrl(this.clientId)))
			);

		let code = "";
		new Setting(contentEl)
			.setName("2. Paste the code")
			.setDesc("From the page Google redirects to")
			.addText((text) =>
				text.setPlaceholder("Paste auth code here").onChange((value) => {
					code = value.trim();
				})
			)
			.addButton((btn) =>
				btn.setButtonText("Reconnect").onClick(async () => {
					if (!code) {
						new Notice("Paste the auth code first");
						return;
					}
					btn.setButtonText("Reconnecting...").setDisabled(true);
					try {
						await this.onCode(code);
						this.close();
					} catch (e) {
						new Notice(`Reconnect failed: ${e instanceof Error ? e.message : String(e)}`);
						btn.setButtonText("Reconnect").setDisabled(false);
					}
				})
			);

		new Setting(contentEl).addButton((btn) =>
			btn.setButtonText("Later").onClick(() => this.close())
		);
	}

	onClose(): void {
		this.contentEl.empty();
		this.onClosed();
	}
}
