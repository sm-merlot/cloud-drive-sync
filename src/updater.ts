import { App, Notice } from "obsidian";
import { computeMD5 } from "./util/hash";
import type { CloudProvider } from "./providers/cloud-provider";

const UPDATE_FOLDER = ".cloud-drive-sync";
const PLUGIN_FILES = ["main.js", "manifest.json", "styles.css"];

export class PluginUpdater {
	constructor(
		private app: App,
		private pluginId: string,
		private provider: CloudProvider,
	) {}

	private async getInstalledHash(fileName: string): Promise<string | null> {
		const path = `${this.app.vault.configDir}/plugins/${this.pluginId}/${fileName}`;
		try {
			const content = await this.app.vault.adapter.readBinary(path);
			return computeMD5(content);
		} catch {
			return null;
		}
	}

	async checkForUpdate(): Promise<boolean> {
		const all = await this.provider.listAllFiles();
		const updateFiles = all.filter(
			(f) => !f.isFolder && f.path.startsWith(`${UPDATE_FOLDER}/`) && PLUGIN_FILES.includes(f.name)
		);
		if (updateFiles.length === 0) return false;

		for (const remote of updateFiles) {
			const localHash = await this.getInstalledHash(remote.name);
			if (!localHash || localHash !== remote.md5Checksum) return true;
		}
		return false;
	}

	async checkAndPrompt(): Promise<void> {
		try {
			const all = await this.provider.listAllFiles();
			const updateFiles = all.filter(
				(f) => !f.isFolder && f.path.startsWith(`${UPDATE_FOLDER}/`) && PLUGIN_FILES.includes(f.name)
			);
			if (updateFiles.length === 0) return;

			let needsUpdate = false;
			for (const remote of updateFiles) {
				const localHash = await this.getInstalledHash(remote.name);
				if (!localHash || localHash !== remote.md5Checksum) { needsUpdate = true; break; }
			}
			if (!needsUpdate) return;

			new Notice("Cloud Sync: plugin update found. Updating and reloading...", 5000);

			const pluginDir = `${this.app.vault.configDir}/plugins/${this.pluginId}`;
			for (const remote of updateFiles) {
				const content = await this.provider.downloadFile(remote.id);
				await this.app.vault.adapter.writeBinary(`${pluginDir}/${remote.name}`, content);
			}

			// @ts-expect-error — Obsidian internal API
			const plugins = this.app.plugins;
			if (plugins?.disablePlugin && plugins?.enablePlugin) {
				await plugins.disablePlugin(this.pluginId);
				await plugins.enablePlugin(this.pluginId);
				new Notice("Cloud Sync: updated and reloaded!");
			} else {
				new Notice("Cloud Sync: updated! Restart Obsidian to apply.", 10000);
			}
		} catch (e) {
			console.error("Plugin self-update failed:", e);
		}
	}
}
