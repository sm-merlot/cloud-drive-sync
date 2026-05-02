import { App, Modal, Setting } from "obsidian";
import type { GoogleDriveApi } from "../providers/google-drive/google-drive-api";

interface FolderItem {
	id: string;
	name: string;
}

export class FolderPickerModal extends Modal {
	private api: GoogleDriveApi;
	private folders: FolderItem[];
	private resolvePromise: ((value: FolderItem | null) => void) | null = null;

	constructor(app: App, api: GoogleDriveApi, folders: FolderItem[]) {
		super(app);
		this.api = api;
		this.folders = folders;
	}

	onOpen(): void {
		this.renderFolders(this.folders, "My Drive");
	}

	private renderFolders(folders: FolderItem[], title: string): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: `Select Sync Folder` });
		contentEl.createEl("p", {
			text: `Browsing: ${title}`,
			cls: "cloud-sync-folder-path",
		});

		if (folders.length === 0) {
			contentEl.createEl("p", { text: "No folders found" });
		}

		for (const folder of folders) {
			new Setting(contentEl)
				.setName(folder.name)
				.addButton((btn) =>
					btn.setButtonText("Select").setCta().onClick(() => {
						this.resolve(folder);
					})
				)
				.addButton((btn) =>
					btn.setButtonText("Browse").onClick(async () => {
						try {
							const subfolders = await this.api.listFolders(folder.id);
							this.renderFolders(subfolders, folder.name);
						} catch (e) {
							contentEl.createEl("p", {
								text: `Error: ${e instanceof Error ? e.message : String(e)}`,
							});
						}
					})
				);
		}

		new Setting(contentEl).addButton((btn) =>
			btn.setButtonText("Cancel").onClick(() => {
				this.resolve(null);
			})
		);
	}

	onClose(): void {
		if (this.resolvePromise) {
			this.resolvePromise(null);
			this.resolvePromise = null;
		}
		this.contentEl.empty();
	}

	private resolve(folder: FolderItem | null): void {
		if (this.resolvePromise) {
			this.resolvePromise(folder);
			this.resolvePromise = null;
		}
		this.close();
	}

	openAndWait(): Promise<FolderItem | null> {
		return new Promise((resolve) => {
			this.resolvePromise = resolve;
			this.open();
		});
	}
}
