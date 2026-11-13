import { ItemView, Menu, Notice, TFile, setIcon, type WorkspaceLeaf } from "obsidian";
import type { AtRestNode, AtRestSession } from "@cloud-drive-sync/core";
import type CloudSyncPlugin from "../main";
import { PRIVATE_NOTES_VIEW } from "./at-rest-manager";
import { ConfirmModal, TextPromptModal } from "../encryption/encryption-modals";

// Side panel: the decrypted tree of every encrypted-at-rest folder while it's
// unlocked, an Unlock button while it's locked. All names shown here exist only
// in this DOM, which is cleared on lock.
export class PrivateNotesView extends ItemView {
	private unsubscribe: (() => void) | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: CloudSyncPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return PRIVATE_NOTES_VIEW;
	}

	getDisplayText(): string {
		return "Private notes";
	}

	getIcon(): string {
		return "lock";
	}

	async onOpen(): Promise<void> {
		this.unsubscribe = this.plugin.atRest.onChange(() => void this.render());
		this.registerEvent(this.app.vault.on("create", () => this.refreshSoon()));
		this.registerEvent(this.app.vault.on("delete", () => this.refreshSoon()));
		this.registerEvent(this.app.vault.on("rename", () => this.refreshSoon()));
		await this.render();
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.contentEl.empty();
	}

	private refreshTimer: number | null = null;
	private refreshSoon(): void {
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => void this.render(), 300);
	}

	async render(): Promise<void> {
		const el = this.contentEl;
		el.empty();
		el.addClass("cds-private-notes");
		const sessions = [...this.plugin.atRest.sessions.values()];
		if (sessions.length === 0) {
			el.createEl("p", {
				cls: "cds-private-empty",
				text: "No encrypted-at-rest folders yet. Create one in Settings → Cloud Drive Sync.",
			});
			return;
		}
		for (const session of sessions) await this.renderFolder(el, session);
	}

	private async renderFolder(parent: HTMLElement, session: AtRestSession): Promise<void> {
		const box = parent.createDiv({ cls: "cds-private-folder" });
		const head = box.createDiv({ cls: "cds-private-head" });
		const icon = head.createSpan();
		setIcon(icon, session.unlocked ? "unlock" : "lock");
		head.createSpan({ text: session.folder, cls: "cds-private-title" });

		if (!session.unlocked) {
			const btn = head.createEl("button", { text: "Unlock", cls: "mod-cta" });
			btn.addEventListener("click", () => void this.plugin.unlockAtRest(session.folder));
			return;
		}

		const actions = head.createDiv({ cls: "cds-private-actions" });
		this.iconButton(actions, "file-plus", "New note", () => this.newNote(session, session.folder));
		this.iconButton(actions, "folder-plus", "New folder", () => this.newFolder(session, session.folder));
		this.iconButton(actions, "lock", "Lock now", () => void session.lock("manual"));

		let listing;
		try {
			listing = await session.list();
		} catch (e) {
			box.createEl("p", { text: `Can't list ${session.folder}: ${e instanceof Error ? e.message : String(e)}` });
			return;
		}

		if (listing.plaintext.length > 0) {
			const warn = box.createDiv({ cls: "cds-private-warning mod-warning" });
			warn.createSpan({
				text: `${listing.plaintext.length} unencrypted file${listing.plaintext.length === 1 ? "" : "s"} in this folder (not synced). `,
			});
			const fix = warn.createEl("button", { text: "Encrypt" });
			fix.addEventListener("click", () => void this.encryptStrays(session, listing!.plaintext));
		}
		if (listing.unreadable.length > 0) {
			box.createDiv({
				cls: "cds-private-note",
				text: `${listing.unreadable.length} file${listing.unreadable.length === 1 ? "" : "s"} from another password generation (ignored).`,
			});
		}

		const tree = box.createDiv({ cls: "cds-private-tree" });
		this.renderChildren(tree, session, listing.nodes, session.folder, 0);
		if (listing.nodes.length === 0) tree.createDiv({ cls: "cds-private-note", text: "Empty. Use + to add a note." });
	}

	private renderChildren(el: HTMLElement, session: AtRestSession, nodes: AtRestNode[], dir: string, depth: number): void {
		const children = nodes
			.filter((n) => n.plainPath.slice(0, n.plainPath.lastIndexOf("/")) === dir)
			.sort((a, b) => Number(a.isFile) - Number(b.isFile) || a.plainPath.localeCompare(b.plainPath));
		for (const node of children) {
			const name = node.plainPath.slice(node.plainPath.lastIndexOf("/") + 1);
			const row = el.createDiv({ cls: `cds-private-row ${node.isFile ? "is-file" : "is-folder"}` });
			row.style.paddingLeft = `${8 + depth * 14}px`;
			const ic = row.createSpan();
			setIcon(ic, node.isFile ? "file-text" : "folder");
			row.createSpan({ text: node.isFile ? name.replace(/\.md$/i, "") : name });
			row.addEventListener("click", () => {
				session.touch();
				if (node.isFile) void this.open(node.diskPath);
			});
			row.addEventListener("contextmenu", (e) => this.menu(e, session, node));
			if (!node.isFile) this.renderChildren(el, session, nodes, node.plainPath, depth + 1);
		}
	}

	private menu(e: MouseEvent, session: AtRestSession, node: AtRestNode): void {
		session.touch();
		const m = new Menu();
		if (!node.isFile) {
			m.addItem((i) => i.setTitle("New note here").setIcon("file-plus").onClick(() => this.newNote(session, node.plainPath)));
			m.addItem((i) => i.setTitle("New folder here").setIcon("folder-plus").onClick(() => this.newFolder(session, node.plainPath)));
		}
		m.addItem((i) => i.setTitle("Rename / move").setIcon("pencil").onClick(() => this.rename(session, node)));
		m.addItem((i) => i.setTitle("Delete").setIcon("trash").onClick(() => this.remove(session, node)));
		m.showAtMouseEvent(e);
	}

	private iconButton(el: HTMLElement, icon: string, label: string, onClick: () => void): void {
		const b = el.createEl("button", { cls: "clickable-icon", attr: { "aria-label": label } });
		setIcon(b, icon);
		b.addEventListener("click", onClick);
	}

	private async open(diskPath: string): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(diskPath);
		if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
	}

	private async newNote(session: AtRestSession, dir: string): Promise<void> {
		const name = await new TextPromptModal(this.app, "New private note", "Untitled").openAndWait();
		if (!name) return;
		const plain = `${dir}/${/\.[a-z0-9]+$/i.test(name) ? name : `${name}.md`}`;
		await this.run(async () => {
			await session.createNote(plain);
			const disk = await session.diskPathOf(plain, true);
			this.plugin.atRest.requestEdit(disk);
			await this.open(disk);
		});
	}

	private async newFolder(session: AtRestSession, dir: string): Promise<void> {
		const name = await new TextPromptModal(this.app, "New folder", "").openAndWait();
		if (!name) return;
		await this.run(() => session.createFolder(`${dir}/${name}`));
	}

	private async rename(session: AtRestSession, node: AtRestNode): Promise<void> {
		const rel = node.plainPath.slice(session.folder.length + 1);
		const next = await new TextPromptModal(
			this.app,
			"Rename or move (path inside the folder)",
			rel,
		).openAndWait();
		if (!next || next === rel) return;
		await this.run(() => session.rename(node.plainPath, `${session.folder}/${next.replace(/^\/+|\/+$/g, "")}`));
	}

	private async remove(session: AtRestSession, node: AtRestNode): Promise<void> {
		const name = node.plainPath.slice(session.folder.length + 1);
		const ok = await new ConfirmModal(this.app, `Delete ${name}?`, [
			node.isFile ? "The note goes to the system trash, still encrypted." : "The folder and everything in it go to the system trash, still encrypted.",
			"It's deleted on other devices at their next sync.",
		], "Delete").openAndWait();
		if (!ok) return;
		await this.run(() => session.delete(node.plainPath));
	}

	// Plaintext files that ended up inside the folder: encrypt each into a
	// private note of the same name, then delete the plaintext.
	private async encryptStrays(session: AtRestSession, paths: string[]): Promise<void> {
		await this.run(async () => {
			for (const p of paths) {
				const file = this.app.vault.getAbstractFileByPath(p);
				if (!(file instanceof TFile)) continue;
				const bytes = new Uint8Array(await this.app.vault.readBinary(file));
				await session.write(p, bytes);
				await this.app.vault.delete(file);
			}
			new Notice(`Encrypted ${paths.length} file${paths.length === 1 ? "" : "s"}`);
		});
	}

	private async run(fn: () => Promise<void>): Promise<void> {
		try {
			await fn();
		} catch (e) {
			new Notice(e instanceof Error ? e.message : String(e));
		}
		await this.render();
	}
}
