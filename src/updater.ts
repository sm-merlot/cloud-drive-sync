import { App, Notice } from "obsidian";
import { computeMD5 } from "./util/hash";
import type { GoogleDriveApi } from "./providers/google-drive/google-drive-api";
import type { RemoteFileInfo } from "./types";

const UPDATE_FOLDER_NAME = ".cloud-drive-sync";
const PLUGIN_FILES = ["main.js", "manifest.json", "styles.css"];

export class PluginUpdater {
	private app: App;
	private pluginId: string;
	private api: GoogleDriveApi;
	private rootFolderId: string;

	constructor(app: App, pluginId: string, api: GoogleDriveApi, rootFolderId: string) {
		this.app = app;
		this.pluginId = pluginId;
		this.api = api;
		this.rootFolderId = rootFolderId;
	}

	private async findUpdateFolder(): Promise<string | null> {
		const folders = await this.api.listFolders(this.rootFolderId);
		const folder = folders.find((f) => f.name === UPDATE_FOLDER_NAME);
		return folder?.id ?? null;
	}

	private async getRemoteFiles(folderId: string): Promise<RemoteFileInfo[]> {
		const files = await this.api.listAllFilesRecursive(folderId);
		return files.filter((f) => PLUGIN_FILES.includes(f.name));
	}

	private async getInstalledHash(fileName: string): Promise<string | null> {
		const pluginDir = this.app.vault.configDir + `/plugins/${this.pluginId}`;
		try {
			const content = await this.app.vault.adapter.readBinary(`${pluginDir}/${fileName}`);
			return computeMD5(content);
		} catch {
			return null;
		}
	}

	async checkForUpdate(): Promise<boolean> {
		const folderId = await this.findUpdateFolder();
		if (!folderId) return false;

		const remoteFiles = await this.getRemoteFiles(folderId);
		if (remoteFiles.length === 0) return false;

		for (const remote of remoteFiles) {
			const localHash = await this.getInstalledHash(remote.name);
			if (!localHash || localHash !== remote.md5Checksum) {
				return true;
			}
		}

		return false;
	}

	async applyUpdate(): Promise<boolean> {
		const folderId = await this.findUpdateFolder();
		if (!folderId) return false;

		const remoteFiles = await this.getRemoteFiles(folderId);
		if (remoteFiles.length === 0) return false;

		const pluginDir = this.app.vault.configDir + `/plugins/${this.pluginId}`;
		let updated = false;

		for (const remote of remoteFiles) {
			const content = await this.api.downloadFile(remote.id);
			await this.app.vault.adapter.writeBinary(`${pluginDir}/${remote.name}`, content);
			updated = true;
		}

		return updated;
	}

	async checkAndPrompt(): Promise<void> {
		try {
			const hasUpdate = await this.checkForUpdate();
			if (!hasUpdate) return;

			new Notice(
				"Cloud Drive Sync: plugin update found. Updating and reloading...",
				5000
			);

			const applied = await this.applyUpdate();
			if (!applied) return;

			// Reload the plugin
			// @ts-expect-error — Obsidian internal API for reloading plugins
			const plugins = this.app.plugins;
			if (plugins?.disablePlugin && plugins?.enablePlugin) {
				await plugins.disablePlugin(this.pluginId);
				await plugins.enablePlugin(this.pluginId);
				new Notice("Cloud Drive Sync: updated and reloaded!");
			} else {
				new Notice(
					"Cloud Drive Sync: updated! Restart Obsidian to apply.",
					10000
				);
			}
		} catch (e) {
			console.error("Plugin self-update failed:", e);
		}
	}
}
