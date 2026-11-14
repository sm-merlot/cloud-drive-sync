import { Notice, TFile, type WorkspaceLeaf } from "obsidian";
import {
	AtRestSession,
	DEFAULT_IDLE_LOCK_MS,
	folderMode,
	parseKeyFile,
	serializeKeyFile,
	type FolderKeyFile,
	type LockReason,
	type UnlockCache,
} from "@cloud-drive-sync/core";
import type CloudSyncPlugin from "../main";
import { ObsidianLocalFileSystem } from "../fs/obsidian-local-fs";

export const PRIVATE_NOTES_VIEW = "cds-private-notes";
export const ENCRYPTED_NOTE_VIEW = "cds-encrypted-note";

// All encrypted-at-rest folders on this device, one AtRestSession each.
// Folders are discovered from key files the sync engine sees (no password is
// needed to know a folder is at rest), and their key files are cached in
// plugin data so they can be unlocked offline.
export class AtRestManager {
	readonly sessions = new Map<string, AtRestSession>();
	private styleEl: HTMLStyleElement | null = null;
	private listeners = new Set<() => void>();

	constructor(private plugin: CloudSyncPlugin) {}

	load(): void {
		for (const [folder, json] of Object.entries(this.plugin.settings.atRestFolders ?? {})) {
			try {
				this.addSession(folder, parseKeyFile(json));
			} catch (e) {
				console.error(`Cached key file for ${folder} is unreadable:`, e);
			}
		}
		this.applyHiding();
	}

	onChange(fn: () => void): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private changed(): void {
		for (const fn of this.listeners) fn();
	}

	notifyChanged(): void {
		this.changed();
	}

	private idleMs(): number {
		const minutes = this.plugin.settings.atRestIdleMinutes;
		return minutes && minutes > 0 ? minutes * 60_000 : DEFAULT_IDLE_LOCK_MS;
	}

	private addSession(folder: string, keyFile: FolderKeyFile): AtRestSession {
		const session = new AtRestSession(new ObsidianLocalFileSystem(this.plugin.app), "", folder, keyFile, {
			idleMs: this.idleMs(),
			onLock: (reason) => this.onLocked(folder, reason),
		});
		this.sessions.set(folder, session);
		return session;
	}

	async unregister(folder: string): Promise<void> {
		await this.sessions.get(folder)?.lock("manual");
		this.sessions.delete(folder);
		const rest = { ...(this.plugin.settings.atRestFolders ?? {}) };
		delete rest[folder];
		this.plugin.settings.atRestFolders = rest;
		await this.plugin.saveSettings();
		this.applyHiding();
		this.changed();
	}

	// After each sync: pick up at-rest folders created on other devices, and
	// key file changes (a password change elsewhere locks the folder). A
	// folder whose key file is gone (converted back to plaintext elsewhere) is
	// dropped once none of its encrypted files are left here.
	async onSynced(cache: UnlockCache, seenAtRest?: string[]): Promise<void> {
		let dirty = false;
		if (seenAtRest) {
			const local = this.plugin.app.vault.getFiles().map((f) => f.path);
			for (const folder of [...this.sessions.keys()]) {
				if (seenAtRest.includes(folder) || this.plugin.settings.pendingEncryptionOp?.folder === folder) continue;
				if (local.some((p) => p.startsWith(folder + "/") && p.endsWith(".cdse"))) continue;
				await this.unregister(folder);
			}
			// A folder converted from transit to at rest on another device
			for (const folder of seenAtRest) {
				if (this.plugin.isEncryptedFolder(folder)) await this.plugin.forgetEncryptedFolder(folder, false);
			}
		}
		for (const [folder, { keyFile }] of cache.keyFiles) {
			if (folderMode(keyFile) !== "at-rest") continue;
			// Only key files this sync actually saw on the server
			if (seenAtRest && !seenAtRest.includes(folder)) continue;
			const json = serializeKeyFile(keyFile);
			if (this.plugin.settings.atRestFolders?.[folder] === json) continue;
			this.plugin.settings.atRestFolders = { ...(this.plugin.settings.atRestFolders ?? {}), [folder]: json };
			dirty = true;
			const existing = this.sessions.get(folder);
			if (existing) await existing.updateKeyFile(keyFile);
			else this.addSession(folder, keyFile);
		}
		if (dirty) {
			await this.plugin.saveSettings();
			this.applyHiding();
			this.changed();
		}
	}

	async register(folder: string, keyFile: FolderKeyFile): Promise<AtRestSession> {
		this.plugin.settings.atRestFolders = {
			...(this.plugin.settings.atRestFolders ?? {}),
			[folder]: serializeKeyFile(keyFile),
		};
		await this.plugin.saveSettings();
		const existing = this.sessions.get(folder);
		if (existing) await existing.updateKeyFile(keyFile);
		const session = existing ?? this.addSession(folder, keyFile);
		this.applyHiding();
		this.changed();
		return session;
	}

	// The next time this file opens, open it in edit mode (new notes)
	private editRequests = new Set<string>();
	requestEdit(diskPath: string): void {
		this.editRequests.add(diskPath);
	}
	consumeEditRequest(diskPath: string): boolean {
		return this.editRequests.delete(diskPath);
	}

	sessionFor(path: string): AtRestSession | null {
		for (const [folder, s] of this.sessions) if (path.startsWith(folder + "/")) return s;
		return null;
	}

	isInAtRestFolder(path: string): boolean {
		for (const folder of this.sessions.keys()) if (path === folder || path.startsWith(folder + "/")) return true;
		return false;
	}

	async lockAll(reason: LockReason): Promise<void> {
		for (const s of this.sessions.values()) await s.lock(reason);
	}

	get anyUnlocked(): boolean {
		for (const s of this.sessions.values()) if (s.unlocked) return true;
		return false;
	}

	private onLocked(folder: string, reason: LockReason): void {
		// Drop every open view of this folder, so no plaintext stays in the DOM
		const leaves: WorkspaceLeaf[] = [];
		this.plugin.app.workspace.iterateAllLeaves((leaf) => {
			const file = (leaf.view as { file?: TFile | null }).file;
			if (leaf.view.getViewType() === ENCRYPTED_NOTE_VIEW && file && file.path.startsWith(folder + "/")) {
				leaves.push(leaf);
			}
		});
		for (const leaf of leaves) leaf.detach();
		if (reason === "key-changed") {
			new Notice(`${folder}: the password was changed on another device. Unlock with the new password.`, 10_000);
		}
		this.changed();
	}

	// Hide at-rest folders from Obsidian's file explorer; their encrypted names
	// mean nothing there. The Private notes panel is the way in.
	applyHiding(): void {
		if (!this.styleEl) {
			this.styleEl = document.head.createEl("style", { attr: { id: "cds-at-rest-hiding" } });
			this.plugin.register(() => this.styleEl?.remove());
		}
		const rules = [...this.sessions.keys()].map((folder) => {
			const sel = CSS.escape(folder);
			return `.nav-folder:has(> .nav-folder-title[data-path="${sel}"]) { display: none; }`;
		});
		this.styleEl.textContent = rules.join("\n");
	}
}
