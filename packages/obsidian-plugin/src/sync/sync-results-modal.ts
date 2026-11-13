import { App, Modal, Platform, Setting } from "obsidian";
import type { ConflictResolution, SyncIssue, SyncIssueResolution } from "@cloud-drive-sync/core";

export type { SyncIssue, SyncIssueResolution };

function formatSize(bytes: number): string {
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export class SyncResultsModal extends Modal {
	private issues: SyncIssue[];
	private resolutions: Map<string, SyncIssueResolution> = new Map();
	private resolvePromise: ((value: SyncIssueResolution[]) => void) | null = null;

	// Display names for paths that differ from what's on disk: private notes
	// (encrypted names) show their real title while their folder is unlocked
	private labels: Map<string, string>;

	constructor(app: App, issues: SyncIssue[], labels: Map<string, string> = new Map()) {
		super(app);
		this.issues = issues;
		this.labels = labels;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("cloud-sync-results-modal");

		const conflicts = this.issues.filter((i) => i.type === "conflict");
		const deleteConflicts = this.issues.filter((i) => i.type === "delete-conflict");
		const errors = this.issues.filter((i) => i.type === "error");
		const tooBig = this.issues.filter((i) => i.type === "too-big");
		const actionable = conflicts.length + deleteConflicts.length + errors.length;

		contentEl.createEl("h2", { text: "Sync Results" });
		contentEl.createEl("p", {
			text: actionable > 0
				? `${actionable} file(s) need attention`
				: `${tooBig.length} file(s) not synced on this device`,
			cls: "cloud-sync-results-subtitle",
		});

		if (deleteConflicts.length > 0) {
			contentEl.createEl("h3", { text: `Delete conflicts (${deleteConflicts.length})` });
			contentEl.createEl("p", {
				text: "Deleted here, but changed on Drive since your last sync. Local = delete from Drive, Remote = restore the file.",
				cls: "cloud-sync-results-desc",
			});
			for (const issue of deleteConflicts) {
				this.renderConflictRow(contentEl, issue, false);
			}
		}

		if (conflicts.length > 0) {
			contentEl.createEl("h3", { text: `Conflicts (${conflicts.length})` });
			contentEl.createEl("p", {
				text: "These files were modified both locally and on Drive.",
				cls: "cloud-sync-results-desc",
			});

			// Bulk actions for conflicts
			new Setting(contentEl)
				.setName("Resolve all conflicts")
				.addButton((btn) =>
					btn.setButtonText("All Local").onClick(() => {
						this.bulkResolveConflicts(conflicts, "local");
						this.render();
					})
				)
				.addButton((btn) =>
					btn.setButtonText("All Remote").onClick(() => {
						this.bulkResolveConflicts(conflicts, "remote");
						this.render();
					})
				);

			for (const issue of conflicts) {
				this.renderConflictRow(contentEl, issue);
			}
		}

		if (errors.length > 0) {
			contentEl.createEl("h3", { text: `Errors (${errors.length})` });

			// Bulk retry
			new Setting(contentEl)
				.addButton((btn) =>
					btn.setButtonText("Retry All").onClick(() => {
						for (const issue of errors) {
							this.resolutions.set(issue.vaultPath, {
								vaultPath: issue.vaultPath,
								resolution: "retry",
								remoteId: issue.remoteId,
							});
						}
						this.render();
					})
				);

			for (const issue of errors) {
				this.renderErrorRow(contentEl, issue);
			}
		}

		if (tooBig.length > 0) {
			contentEl.createEl("h3", { text: `Too big for this device (${tooBig.length})` });
			contentEl.createEl("p", {
				text: "Over the mobile file size limit in Cloud Sync settings, so not downloaded or uploaded here. They stay as they are on both sides; sync them from a desktop.",
				cls: "cloud-sync-results-desc",
			});
			for (const issue of tooBig) {
				new Setting(contentEl)
					.setName(issue.vaultPath)
					.setDesc(issue.size !== undefined ? formatSize(issue.size) : "");
			}
		}

		if (actionable === 0) {
			contentEl.createEl("div", { cls: "cloud-sync-results-footer" }, (el) => {
				new Setting(el).addButton((btn) =>
					btn.setButtonText("Close").setCta().onClick(() => this.finish())
				);
			});
			return;
		}

		// Done button
		contentEl.createEl("div", { cls: "cloud-sync-results-footer" }, (el) => {
			new Setting(el)
				.addButton((btn) =>
					btn
						.setButtonText("Apply & Close")
						.setCta()
						.onClick(() => this.finish())
				)
				.addButton((btn) =>
					btn.setButtonText("Skip All").onClick(() => {
						this.resolutions.clear();
						this.finish();
					})
				);
		});
	}

	private render(): void {
		// Re-render by clearing and calling onOpen
		this.contentEl.empty();
		this.onOpen();
	}

	private renderConflictRow(containerEl: HTMLElement, issue: SyncIssue, allowMerge = true): void {
		const current = this.resolutions.get(issue.vaultPath);
		const resolved = current?.resolution;

		const setting = new Setting(containerEl).setName(this.labels.get(issue.vaultPath) ?? issue.vaultPath);

		if (issue.localModTime && issue.remoteModTime) {
			setting.setDesc(
				`Local: ${new Date(issue.localModTime).toLocaleString()} | Drive: ${new Date(issue.remoteModTime).toLocaleString()}`
			);
		}

		setting
			.addButton((btn) => {
				btn.setButtonText("Local");
				if (resolved === "local") btn.setCta();
				btn.onClick(() => {
					this.resolutions.set(issue.vaultPath, {
						vaultPath: issue.vaultPath,
						resolution: "local",
						remoteId: issue.remoteId,
					});
					this.render();
				});
			})
			.addButton((btn) => {
				btn.setButtonText("Remote");
				if (resolved === "remote") btn.setCta();
				btn.onClick(() => {
					this.resolutions.set(issue.vaultPath, {
						vaultPath: issue.vaultPath,
						resolution: "remote",
						remoteId: issue.remoteId,
					});
					this.render();
				});
			});

		// In-app merge works everywhere for private notes (decrypted in memory);
		// for other files Merge can hand off to a desktop merge tool
		if ((Platform.isDesktop || issue.vaultPath.endsWith(".cdse")) && allowMerge) {
			setting.addButton((btn) => {
				btn.setButtonText("Merge");
				if (resolved === "merge") btn.setCta();
				btn.onClick(() => {
					this.resolutions.set(issue.vaultPath, {
						vaultPath: issue.vaultPath,
						resolution: "merge",
						remoteId: issue.remoteId,
					});
					this.render();
				});
			});
		}

		setting.addButton((btn) => {
				btn.setButtonText("Skip");
				if (resolved === "skip") btn.setCta();
				btn.onClick(() => {
					this.resolutions.set(issue.vaultPath, {
						vaultPath: issue.vaultPath,
						resolution: "skip",
						remoteId: issue.remoteId,
					});
					this.render();
				});
			});
	}

	private renderErrorRow(containerEl: HTMLElement, issue: SyncIssue): void {
		const current = this.resolutions.get(issue.vaultPath);
		const isRetrying = current?.resolution === "retry";

		new Setting(containerEl)
			.setName(this.labels.get(issue.vaultPath) ?? issue.vaultPath)
			.setDesc(issue.errorMessage || "Unknown error")
			.addButton((btn) => {
				btn.setButtonText("Retry");
				if (isRetrying) btn.setCta();
				btn.onClick(() => {
					this.resolutions.set(issue.vaultPath, {
						vaultPath: issue.vaultPath,
						resolution: "retry",
						remoteId: issue.remoteId,
					});
					this.render();
				});
			})
			.addButton((btn) => {
				btn.setButtonText("Skip");
				if (!isRetrying && current) btn.setCta();
				btn.onClick(() => {
					this.resolutions.delete(issue.vaultPath);
					this.render();
				});
			});
	}

	private bulkResolveConflicts(
		conflicts: SyncIssue[],
		resolution: ConflictResolution
	): void {
		for (const issue of conflicts) {
			this.resolutions.set(issue.vaultPath, {
				vaultPath: issue.vaultPath,
				resolution,
				remoteId: issue.remoteId,
			});
		}
	}

	private finish(): void {
		if (this.resolvePromise) {
			this.resolvePromise(Array.from(this.resolutions.values()));
			this.resolvePromise = null;
		}
		this.close();
	}

	onClose(): void {
		// If closed without clicking Apply, return empty
		if (this.resolvePromise) {
			this.resolvePromise([]);
			this.resolvePromise = null;
		}
		this.contentEl.empty();
	}

	openAndWait(): Promise<SyncIssueResolution[]> {
		return new Promise((resolve) => {
			this.resolvePromise = resolve;
			this.open();
		});
	}
}
