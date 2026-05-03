import { App, Modal, Setting } from "obsidian";

export type FirstSyncStrategy = "download" | "upload" | "merge";

export class FirstSyncModal extends Modal {
	private resolvePromise: ((value: FirstSyncStrategy) => void) | null = null;

	constructor(app: App) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;

		contentEl.createEl("h2", { text: "First Sync" });
		contentEl.createEl("p", {
			text: "This is the first time syncing this vault. How should existing files be handled?",
		});

		new Setting(contentEl)
			.setName("Download from Drive")
			.setDesc(
				"Treat Google Drive as the source of truth. Remote files will be downloaded, and local-only files will be uploaded."
			)
			.addButton((btn) =>
				btn
					.setButtonText("Download")
					.setCta()
					.onClick(() => this.resolve("download"))
			);

		new Setting(contentEl)
			.setName("Upload to Drive")
			.setDesc(
				"Treat this vault as the source of truth. Local files will be uploaded, and remote-only files will be downloaded."
			)
			.addButton((btn) =>
				btn
					.setButtonText("Upload")
					.onClick(() => this.resolve("upload"))
			);

		new Setting(contentEl)
			.setName("Merge (prompt on conflicts)")
			.setDesc(
				"Keep both sides. Files that exist in both places with different content will prompt you to choose."
			)
			.addButton((btn) =>
				btn
					.setButtonText("Merge")
					.onClick(() => this.resolve("merge"))
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private resolve(strategy: FirstSyncStrategy): void {
		if (this.resolvePromise) {
			this.resolvePromise(strategy);
			this.resolvePromise = null;
		}
		this.close();
	}

	openAndWait(): Promise<FirstSyncStrategy> {
		return new Promise((resolve) => {
			this.resolvePromise = resolve;
			this.open();
		});
	}
}
