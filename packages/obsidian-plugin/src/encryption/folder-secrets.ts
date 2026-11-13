import type { App } from "obsidian";
import { computeMD5 } from "@cloud-drive-sync/core";

// Encrypted-folder passwords in Obsidian's secretStorage (the OS keychain,
// Obsidian 1.11.4+). Never in data.json. secretStorage has no delete, so a
// cleared secret is stored as "" and read back as null.
export class FolderSecrets {
	constructor(private app: App) {}

	private id(folder: string, slot: "current" | "old"): string {
		// ids must be lowercase alphanumeric with dashes; folder names aren't
		const hash = computeMD5(new TextEncoder().encode(folder).buffer as ArrayBuffer);
		return slot === "current" ? `cds-folder-${hash}` : `cds-folder-${hash}-old`;
	}

	get(folder: string): string | null {
		return this.app.secretStorage.getSecret(this.id(folder, "current")) || null;
	}

	set(folder: string, password: string): void {
		this.app.secretStorage.setSecret(this.id(folder, "current"), password);
	}

	// The previous password, kept only while a password change is running so
	// it can resume after a restart
	getOld(folder: string): string | null {
		return this.app.secretStorage.getSecret(this.id(folder, "old")) || null;
	}

	setOld(folder: string, password: string): void {
		this.app.secretStorage.setSecret(this.id(folder, "old"), password);
	}

	clear(folder: string): void {
		this.app.secretStorage.setSecret(this.id(folder, "current"), "");
		this.app.secretStorage.setSecret(this.id(folder, "old"), "");
	}

	clearOld(folder: string): void {
		this.app.secretStorage.setSecret(this.id(folder, "old"), "");
	}
}
