import { App, Modal, Setting, TFolder } from "obsidian";

export const KEEP_PASSWORD_WARNING =
	"Keep this password in 1Password. If you lose it, the copies of these notes on the server can't be decrypted, and there is no recovery key.";

export interface PasswordField {
	key: string;
	label: string;
	// Second field that must match this one
	confirm?: boolean;
}

export interface PasswordFormOptions {
	title: string;
	intro?: string[];
	warning?: string;
	folderPicker?: boolean; // first field: choose a vault folder
	fields: PasswordField[];
	submitText: string;
	danger?: boolean;
}

export type PasswordFormResult = { folder?: string; values: Record<string, string> } | null;

// Generic form: optional folder dropdown plus password fields, with
// confirmation matching. Resolves null on cancel.
export class PasswordFormModal extends Modal {
	private resolvePromise: ((v: PasswordFormResult) => void) | null = null;
	private values: Record<string, string> = {};
	private confirms: Record<string, string> = {};
	private folder = "";

	constructor(app: App, private opts: PasswordFormOptions) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: this.opts.title });
		for (const p of this.opts.intro ?? []) contentEl.createEl("p", { text: p });
		if (this.opts.warning) {
			contentEl.createEl("p", { text: this.opts.warning, cls: "mod-warning cloud-sync-encryption-warning" });
		}

		if (this.opts.folderPicker) {
			const folders = this.app.vault
				.getAllLoadedFiles()
				.filter((f): f is TFolder => f instanceof TFolder && f.path !== "/" && !f.path.startsWith("."))
				.map((f) => f.path)
				.sort();
			this.folder = folders[0] ?? "";
			new Setting(contentEl).setName("Folder").addDropdown((d) => {
				for (const f of folders) d.addOption(f, f);
				d.setValue(this.folder).onChange((v) => (this.folder = v));
			});
		}

		for (const field of this.opts.fields) {
			new Setting(contentEl).setName(field.label).addText((t) => {
				t.inputEl.type = "password";
				t.inputEl.autocomplete = "new-password";
				t.onChange((v) => (this.values[field.key] = v));
			});
			if (field.confirm) {
				new Setting(contentEl).setName(`Confirm ${field.label.toLowerCase()}`).addText((t) => {
					t.inputEl.type = "password";
					t.inputEl.autocomplete = "new-password";
					t.onChange((v) => (this.confirms[field.key] = v));
				});
			}
		}

		const error = contentEl.createEl("p", { cls: "mod-warning" });
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.finish(null)))
			.addButton((b) => {
				b.setButtonText(this.opts.submitText);
				if (this.opts.danger) b.setWarning();
				else b.setCta();
				b.onClick(() => {
					const problem = this.validate();
					if (problem) {
						error.setText(problem);
						return;
					}
					this.finish({ folder: this.opts.folderPicker ? this.folder : undefined, values: { ...this.values } });
				});
			});
	}

	private validate(): string | null {
		if (this.opts.folderPicker && !this.folder) return "Choose a folder";
		for (const field of this.opts.fields) {
			if (!this.values[field.key]) return `${field.label} is required`;
			if (field.confirm && this.values[field.key] !== this.confirms[field.key]) {
				return `${field.label} and its confirmation don't match`;
			}
		}
		return null;
	}

	private finish(v: PasswordFormResult): void {
		this.resolvePromise?.(v);
		this.resolvePromise = null;
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		this.resolvePromise?.(null);
		this.resolvePromise = null;
	}

	openAndWait(): Promise<PasswordFormResult> {
		return new Promise((resolve) => {
			this.resolvePromise = resolve;
			this.open();
		});
	}
}

export class ConfirmModal extends Modal {
	private resolvePromise: ((v: boolean) => void) | null = null;

	constructor(app: App, private title: string, private paragraphs: string[], private confirmText: string) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: this.title });
		for (const p of this.paragraphs) contentEl.createEl("p", { text: p });
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.finish(false)))
			.addButton((b) => b.setButtonText(this.confirmText).setWarning().onClick(() => this.finish(true)));
	}

	private finish(v: boolean): void {
		this.resolvePromise?.(v);
		this.resolvePromise = null;
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		this.resolvePromise?.(false);
		this.resolvePromise = null;
	}

	openAndWait(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolvePromise = resolve;
			this.open();
		});
	}
}

// Single text field; resolves the trimmed value, or null on cancel/empty
export class TextPromptModal extends Modal {
	private resolvePromise: ((v: string | null) => void) | null = null;
	private value: string;

	constructor(app: App, private title: string, initial: string) {
		super(app);
		this.value = initial;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h2", { text: this.title });
		new Setting(contentEl).addText((t) => {
			t.setValue(this.value).onChange((v) => (this.value = v));
			t.inputEl.style.width = "100%";
			t.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter") this.finish(this.value.trim() || null);
			});
			window.setTimeout(() => t.inputEl.select(), 0);
		});
		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.finish(null)))
			.addButton((b) => b.setButtonText("OK").setCta().onClick(() => this.finish(this.value.trim() || null)));
	}

	private finish(v: string | null): void {
		this.resolvePromise?.(v);
		this.resolvePromise = null;
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		this.resolvePromise?.(null);
		this.resolvePromise = null;
	}

	openAndWait(): Promise<string | null> {
		return new Promise((resolve) => {
			this.resolvePromise = resolve;
			this.open();
		});
	}
}
