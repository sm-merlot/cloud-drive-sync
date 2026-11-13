import { App, Platform, TFile } from "obsidian";
import {
	computeMD5,
	getParentPath,
	guessMimeType,
	type CloudProvider,
	type FirstSyncStrategy,
	type SyncAction,
	type SyncIssue,
	type SyncIssueResolution,
	type SyncStateStore,
	type SyncUIPort,
} from "@cloud-drive-sync/core";
import { FirstSyncModal } from "./first-sync-modal";
import { SyncResultsModal } from "./sync-results-modal";
import { SyncPlanModal } from "./sync-plan-modal";

// Obsidian's SyncUIPort: modal-backed interaction plus the desktop-only
// external merge tool, which needs vault adapter absolute paths and Node's
// child_process — deliberately kept out of the shared engine.
export class ObsidianSyncUI implements SyncUIPort {
	externalMerge?: (vaultPath: string, remoteId: string) => Promise<void>;
	// Friendlier names for the conflict dialog (private notes' real titles)
	labelFor?: (vaultPath: string) => Promise<string | null>;

	constructor(
		private app: App,
		private provider: CloudProvider,
		private stateStore: SyncStateStore,
		private debugMode: boolean,
		mergeToolCommand: string,
	) {
		if (Platform.isDesktop && mergeToolCommand) {
			this.externalMerge = (vaultPath, remoteId) =>
				this.launchExternalMerge(vaultPath, remoteId, mergeToolCommand);
		}
	}

	async chooseFirstSyncStrategy(): Promise<FirstSyncStrategy> {
		return new FirstSyncModal(this.app).openAndWait();
	}

	async resolveSyncIssues(issues: SyncIssue[]): Promise<SyncIssueResolution[]> {
		const labels = new Map<string, string>();
		if (this.labelFor) {
			for (const issue of issues) {
				const label = await this.labelFor(issue.vaultPath);
				if (label) labels.set(issue.vaultPath, label);
			}
		}
		return new SyncResultsModal(this.app, issues, labels).openAndWait();
	}

	async reviewPlan(actions: SyncAction[], issues: SyncIssue[]): Promise<{ cancelled: boolean }> {
		if (!this.debugMode) return { cancelled: false };
		const modal = new SyncPlanModal(
			this.app, actions, issues, "skip",
			this.externalMerge !== undefined,
		);
		const plan = await modal.openAndWait();
		return { cancelled: plan.cancelled };
	}

	private async launchExternalMerge(
		vaultPath: string,
		remoteId: string,
		mergeToolCommand: string,
	): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(vaultPath);
		if (!(file instanceof TFile)) return;

		const content = await this.provider.downloadFile(remoteId);

		const tempPath = vaultPath.replace(/(\.[^.]+)$/, `.remote$1`);
		const tempExisting = this.app.vault.getAbstractFileByPath(tempPath);
		if (tempExisting instanceof TFile) {
			await this.app.vault.modifyBinary(tempExisting, content);
		} else {
			await this.app.vault.createBinary(tempPath, content);
		}

		const adapter = this.app.vault.adapter;
		const localAbsPath = (adapter as { getFullPath?: (p: string) => string }).getFullPath?.(vaultPath);
		const remoteAbsPath = (adapter as { getFullPath?: (p: string) => string }).getFullPath?.(tempPath);

		if (localAbsPath && remoteAbsPath) {
			const cmd = mergeToolCommand
				.replace("{local}", `"${localAbsPath}"`)
				.replace("{remote}", `"${remoteAbsPath}"`);
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const { exec } = require("child_process") as typeof import("child_process");
			await new Promise<void>((resolve, reject) => {
				exec(cmd, (error: Error | null) => {
					if (error) reject(error);
					else resolve();
				});
			});
		}

		const mergedBin = await this.app.vault.readBinary(file);
		await this.provider.updateFile(remoteId, mergedBin, guessMimeType(vaultPath));
		const hash = computeMD5(mergedBin);
		const updatedFile = this.app.vault.getAbstractFileByPath(vaultPath);
		const existing = this.stateStore.getRecord(vaultPath);
		this.stateStore.setRecord(vaultPath, {
			vaultPath, remoteId,
			remoteFolderId: existing?.remoteFolderId ?? getParentPath(vaultPath),
			localModTime: updatedFile instanceof TFile ? updatedFile.stat.mtime : Date.now(),
			remoteModTime: Date.now(),
			contentHash: hash,
			size: mergedBin.byteLength,
		});

		const tempFile = this.app.vault.getAbstractFileByPath(tempPath);
		if (tempFile instanceof TFile) await this.app.vault.delete(tempFile);
	}
}
