import { App, Modal, Setting } from "obsidian";
import { APP_FOLDER_NAME } from "../providers/google-drive/google-drive-api";

interface FolderItem {
	id: string;
	name: string;
}

export type FolderChoice = FolderItem | { create: string };

// Picks a vault folder inside the plugin's app folder. drive.file only shows
// the plugin folders it created itself, so there is nothing else to browse.
export class FolderPickerModal extends Modal {
	private folders: FolderItem[];
	private newName: string;
	private resolvePromise: ((value: FolderChoice | null) => void) | null = null;

	constructor(app: App, folders: FolderItem[], newName: string) {
		super(app);
		this.folders = folders;
		this.newName = newName;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "Select Sync Folder" });
		contentEl.createEl("p", {
			text: `Vaults sync to folders inside "${APP_FOLDER_NAME}" in My Drive. Files added there outside this plugin are not synced.`,
			cls: "cloud-sync-folder-path",
		});

		for (const folder of this.folders) {
			new Setting(contentEl).setName(folder.name).addButton((btn) =>
				btn.setButtonText("Select").onClick(() => this.resolve(folder))
			);
		}

		let name = this.newName;
		const createSetting = new Setting(contentEl)
			.setName("New folder")
			.setDesc("Defaults to this vault's name")
			.addText((text) =>
				text.setValue(name).onChange((value) => {
					name = value.trim();
				})
			)
			.addButton((btn) =>
				btn
					.setButtonText("Create")
					.setCta()
					.onClick(() => {
						if (!name || /[/\\]/.test(name)) {
							createSetting.setDesc("Enter a folder name without slashes");
							return;
						}
						// Two vaults sharing a folder merge their files on first
						// sync, so a taken name has to be a deliberate Select.
						if (this.folders.some((f) => f.name === name)) {
							createSetting.setDesc(`"${name}" already exists. Select it above to join it, or pick another name.`);
							return;
						}
						this.resolve({ create: name });
					})
			);

		new Setting(contentEl).addButton((btn) =>
			btn.setButtonText("Cancel").onClick(() => this.resolve(null))
		);
	}

	onClose(): void {
		if (this.resolvePromise) {
			this.resolvePromise(null);
			this.resolvePromise = null;
		}
		this.contentEl.empty();
	}

	private resolve(choice: FolderChoice | null): void {
		if (this.resolvePromise) {
			this.resolvePromise(choice);
			this.resolvePromise = null;
		}
		this.close();
	}

	openAndWait(): Promise<FolderChoice | null> {
		return new Promise((resolve) => {
			this.resolvePromise = resolve;
			this.open();
		});
	}
}
