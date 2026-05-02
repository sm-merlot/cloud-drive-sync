import { App, Modal, Setting } from "obsidian";
import type { ConflictResolution } from "../types";

export class ConflictModal extends Modal {
	private vaultPath: string;
	private localModTime: number;
	private remoteModTime: number;
	private resolvePromise: ((value: ConflictResolution) => void) | null = null;

	constructor(
		app: App,
		vaultPath: string,
		localModTime: number,
		remoteModTime: number
	) {
		super(app);
		this.vaultPath = vaultPath;
		this.localModTime = localModTime;
		this.remoteModTime = remoteModTime;
	}

	onOpen(): void {
		const { contentEl } = this;

		contentEl.createEl("h2", { text: "Sync Conflict" });
		contentEl.createEl("p", {
			text: `File: ${this.vaultPath}`,
			cls: "cloud-sync-conflict-path",
		});

		const infoEl = contentEl.createDiv("cloud-sync-conflict-info");
		infoEl.createEl("p", {
			text: `Local modified: ${new Date(this.localModTime).toLocaleString()}`,
		});
		infoEl.createEl("p", {
			text: `Remote modified: ${new Date(this.remoteModTime).toLocaleString()}`,
		});

		contentEl.createEl("p", {
			text: "Both versions have been modified since last sync. Which version do you want to keep?",
		});

		new Setting(contentEl)
			.addButton((btn) =>
				btn
					.setButtonText("Keep Local")
					.setCta()
					.onClick(() => this.resolve("local"))
			)
			.addButton((btn) =>
				btn
					.setButtonText("Keep Remote")
					.onClick(() => this.resolve("remote"))
			)
			.addButton((btn) =>
				btn
					.setButtonText("Skip")
					.onClick(() => this.resolve("skip"))
			);
	}

	onClose(): void {
		// If closed without choosing, treat as skip
		if (this.resolvePromise) {
			this.resolvePromise("skip");
			this.resolvePromise = null;
		}
		this.contentEl.empty();
	}

	private resolve(resolution: ConflictResolution): void {
		if (this.resolvePromise) {
			this.resolvePromise(resolution);
			this.resolvePromise = null;
		}
		this.close();
	}

	openAndWait(): Promise<ConflictResolution> {
		return new Promise((resolve) => {
			this.resolvePromise = resolve;
			this.open();
		});
	}
}
