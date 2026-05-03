import { App, Modal, Platform, Setting } from "obsidian";
import type { ConflictResolution } from "../types";

export interface SyncIssue {
	vaultPath: string;
	type: "conflict" | "error";
	remoteId?: string;
	localModTime?: number;
	remoteModTime?: number;
	errorMessage?: string;
}

export interface SyncIssueResolution {
	vaultPath: string;
	resolution: ConflictResolution | "retry";
	remoteId?: string;
}

export class SyncResultsModal extends Modal {
	private issues: SyncIssue[];
	private resolutions: Map<string, SyncIssueResolution> = new Map();
	private resolvePromise: ((value: SyncIssueResolution[]) => void) | null = null;

	constructor(app: App, issues: SyncIssue[]) {
		super(app);
		this.issues = issues;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("cloud-sync-results-modal");

		contentEl.createEl("h2", { text: "Sync Results" });
		contentEl.createEl("p", {
			text: `${this.issues.length} file(s) need attention`,
			cls: "cloud-sync-results-subtitle",
		});

		const conflicts = this.issues.filter((i) => i.type === "conflict");
		const errors = this.issues.filter((i) => i.type === "error");

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

	private renderConflictRow(containerEl: HTMLElement, issue: SyncIssue): void {
		const current = this.resolutions.get(issue.vaultPath);
		const resolved = current?.resolution;

		const setting = new Setting(containerEl).setName(issue.vaultPath);

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

		if (Platform.isDesktop) {
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
			.setName(issue.vaultPath)
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
