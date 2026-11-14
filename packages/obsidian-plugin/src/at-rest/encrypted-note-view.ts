import { FileView, MarkdownRenderer, Notice, TFile, setIcon, type WorkspaceLeaf } from "obsidian";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdownEditing } from "./markdown-editor";
import type { AtRestSession } from "@cloud-drive-sync/core";
import type CloudSyncPlugin from "../main";
import { ENCRYPTED_NOTE_VIEW } from "./at-rest-manager";

const SAVE_DELAY_MS = 2000;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
const MIME: Record<string, string> = {
	png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
	webp: "image/webp", svg: "image/svg+xml", bmp: "image/bmp", avif: "image/avif",
};

// Opens a .cdse file from an encrypted-at-rest folder. The file on disk stays
// ciphertext; the note is decrypted into memory, edited in a CodeMirror
// editor or shown in a reading view, and encrypted again before every save.
// Nothing plaintext goes into view state (the path in getState() is the
// encrypted one).
export class EncryptedNoteView extends FileView {
	private session: AtRestSession | null = null;
	private plainPath: string | null = null;
	private text = "";
	private mode: "read" | "edit" = "read";
	private editor: EditorView | null = null;
	private dirty = false;
	private saveTimer: number | null = null;
	private removeFlusher: (() => void) | null = null;
	private blobUrls: string[] = [];
	private modeAction: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: CloudSyncPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return ENCRYPTED_NOTE_VIEW;
	}

	getDisplayText(): string {
		if (!this.plainPath) return "Encrypted note";
		return this.plainPath.slice(this.plainPath.lastIndexOf("/") + 1).replace(/\.md$/i, "");
	}

	getIcon(): string {
		return "lock";
	}

	async onOpen(): Promise<void> {
		// Any use of the note counts as activity for the idle lock
		this.registerDomEvent(this.contentEl, "keydown", () => this.session?.touch());
		this.registerDomEvent(this.contentEl, "pointerdown", () => this.session?.touch());
	}

	canAcceptExtension(extension: string): boolean {
		return extension === "cdse";
	}

	async onLoadFile(file: TFile): Promise<void> {
		this.session = this.plugin.atRest.sessionFor(file.path);
		if (!this.session) {
			this.renderMessage("This file isn't in an encrypted-at-rest folder known to this device.");
			return;
		}
		if (!this.session.unlocked) {
			this.renderLocked(file);
			return;
		}
		try {
			this.plainPath = await this.session.plainPathOf(file.path);
			this.text = new TextDecoder().decode(await this.session.read(this.plainPath));
		} catch (e) {
			this.renderMessage(`Can't decrypt this note: ${e instanceof Error ? e.message : String(e)}`);
			return;
		}
		this.removeFlusher = this.session.addFlusher(() => this.flushSave());
		this.mode = this.plugin.atRest.consumeEditRequest(file.path) ? "edit" : "read";
		if (!this.modeAction) {
			this.modeAction = this.addAction("pencil", "Edit / read", () => this.toggleMode());
		}
		// Header title shows the real name (only while unlocked, in memory)
		(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
		await this.renderNote();
	}

	async onUnloadFile(_file: TFile): Promise<void> {
		await this.flushSave();
		this.teardown();
	}

	async onClose(): Promise<void> {
		await this.flushSave();
		this.teardown();
	}

	private teardown(): void {
		this.removeFlusher?.();
		this.removeFlusher = null;
		this.editor?.destroy();
		this.editor = null;
		for (const url of this.blobUrls) URL.revokeObjectURL(url);
		this.blobUrls = [];
		this.text = "";
		this.plainPath = null;
		this.contentEl.empty();
	}

	private async toggleMode(): Promise<void> {
		if (!this.session?.unlocked || !this.plainPath) return;
		if (this.mode === "edit" && this.editor) this.text = this.editor.state.doc.toString();
		await this.flushSave();
		this.mode = this.mode === "edit" ? "read" : "edit";
		await this.renderNote();
	}

	private async renderNote(): Promise<void> {
		this.editor?.destroy();
		this.editor = null;
		this.contentEl.empty();
		if (this.modeAction) setIcon(this.modeAction, this.mode === "edit" ? "book-open" : "pencil");
		if (this.mode === "edit") this.renderEditor();
		else await this.renderReading();
	}

	private renderEditor(): void {
		const host = this.contentEl.createDiv({ cls: "cds-encrypted-editor" });
		this.editor = new EditorView({
			parent: host,
			state: EditorState.create({
				doc: this.text,
				extensions: [
					history(),
					markdownEditing(), // before the default keymap, so Enter continues lists
					keymap.of([...defaultKeymap, ...historyKeymap]),
					EditorView.lineWrapping,
					EditorView.updateListener.of((u) => {
						if (!u.docChanged) return;
						this.dirty = true;
						this.session?.touch();
						this.scheduleSave();
					}),
				],
			}),
		});
		this.editor.focus();
	}

	private async renderReading(): Promise<void> {
		const el = this.contentEl.createDiv({ cls: "markdown-preview-view markdown-rendered cds-encrypted-reading" });
		await MarkdownRenderer.render(this.app, this.text, el, this.file?.path ?? "", this);
		this.guardLinks(el);
		await this.resolveImages(el);
	}

	// Obsidian would resolve [[links]] against the normal vault, and clicking
	// an unresolved one creates a new plaintext note. Intercept every link,
	// tag and hover before Obsidian sees it, and resolve within the folder.
	private guardLinks(el: HTMLElement): void {
		const stop = (e: Event) => {
			const target = (e.target as HTMLElement).closest("a.internal-link, a.tag, .internal-embed");
			if (!target) return;
			e.preventDefault();
			e.stopPropagation();
			if (e.type === "click" && target.matches("a.internal-link")) {
				void this.followLink(target.getAttribute("data-href") ?? target.textContent ?? "");
			}
		};
		el.addEventListener("click", stop, true);
		el.addEventListener("auxclick", stop, true);
		el.addEventListener("mouseover", stop, true);
	}

	private async followLink(href: string): Promise<void> {
		if (!this.session) return;
		const title = href.split("#")[0]!.split("|")[0]!.trim();
		const plain = await this.session.resolveLink(title, this.plainPath ?? undefined);
		if (!plain) {
			new Notice(`No private note named "${title}" in ${this.session.folder}`);
			return;
		}
		const disk = await this.session.diskPathOf(plain, true);
		const file = this.app.vault.getAbstractFileByPath(disk);
		if (file instanceof TFile) await this.leaf.openFile(file);
	}

	// ![[image.png]] embeds of images stored (encrypted) in the same folder:
	// decrypt into memory and show via blob: URLs, revoked on close and lock.
	private async resolveImages(el: HTMLElement): Promise<void> {
		if (!this.session) return;
		for (const embed of Array.from(el.querySelectorAll<HTMLElement>(".internal-embed"))) {
			const src = embed.getAttribute("src") ?? "";
			if (!IMAGE_EXT.test(src)) continue;
			const plain = await this.session.resolveLink(src, this.plainPath ?? undefined);
			if (!plain) continue;
			try {
				const bytes = await this.session.read(plain);
				const ext = plain.slice(plain.lastIndexOf(".") + 1).toLowerCase();
				const url = URL.createObjectURL(new Blob([bytes], { type: MIME[ext] ?? "application/octet-stream" }));
				this.blobUrls.push(url);
				embed.empty();
				embed.createEl("img", { attr: { src: url, alt: src } });
			} catch (e) {
				console.error(`Can't show ${src}:`, e);
			}
		}
	}

	private scheduleSave(): void {
		if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => void this.flushSave(), SAVE_DELAY_MS);
	}

	private async flushSave(): Promise<void> {
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		if (!this.dirty || !this.session?.unlocked || !this.plainPath) return;
		if (this.editor) this.text = this.editor.state.doc.toString();
		this.dirty = false;
		try {
			await this.session.write(this.plainPath, new TextEncoder().encode(this.text));
		} catch (e) {
			this.dirty = true;
			new Notice(`Couldn't save ${this.getDisplayText()}: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	private renderLocked(file: TFile): void {
		this.contentEl.empty();
		const box = this.contentEl.createDiv({ cls: "cds-encrypted-locked" });
		box.createEl("p", { text: `${this.session!.folder} is locked.` });
		const btn = box.createEl("button", { text: "Unlock", cls: "mod-cta" });
		btn.addEventListener("click", async () => {
			if (await this.plugin.unlockAtRest(this.session!.folder)) await this.onLoadFile(file);
		});
	}

	private renderMessage(text: string): void {
		this.contentEl.empty();
		this.contentEl.createEl("p", { text, cls: "cds-encrypted-locked" });
	}
}
