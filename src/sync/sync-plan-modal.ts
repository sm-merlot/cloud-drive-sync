import { App, Modal, Platform, Setting, setIcon } from "obsidian";
import type { ConflictResolution, SyncAction } from "../types";
import type { SyncIssue } from "./sync-results-modal";

export interface SyncPlanResult {
	selectedActions: SyncAction[];
	conflictResolutions: Map<string, ConflictResolution>;
	cancelled: boolean;
}

const ACTION_LABELS: Record<string, { label: string; icon: string }> = {
	upload:              { label: "Upload",          icon: "upload" },
	"update-remote":     { label: "Upload (update)", icon: "upload" },
	download:            { label: "Download",        icon: "download" },
	"update-local":      { label: "Download (update)", icon: "download" },
	"delete-remote":     { label: "Delete remote",   icon: "trash" },
	"delete-local":      { label: "Delete local",    icon: "trash" },
	"create-folder-remote": { label: "Create folder", icon: "folder-plus" },
	"create-folder-local":  { label: "Create folder", icon: "folder-plus" },
	"delete-folder-remote": { label: "Delete folder", icon: "folder-minus" },
	"delete-folder-local":  { label: "Delete folder", icon: "folder-minus" },
};

export class SyncPlanModal extends Modal {
	private selected: Set<string>;
	private conflictResolutions: Map<string, ConflictResolution>;
	private resolvePromise: ((value: SyncPlanResult) => void) | null = null;

	constructor(
		app: App,
		private fileActions: SyncAction[],
		private conflicts: SyncIssue[],
		defaultConflictResolution: ConflictResolution = "skip",
		private hasMergeTool = false,
	) {
		super(app);
		this.selected = new Set(fileActions.map((a) => a.vaultPath));
		this.conflictResolutions = new Map(
			conflicts.map((c) => [c.vaultPath, defaultConflictResolution])
		);
	}

	onOpen(): void {
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("cloud-sync-plan-modal");

		const totalSelected = this.selected.size + this.resolvedConflicts();

		contentEl.createEl("h2", { text: "Sync Plan" });

		if (this.fileActions.length === 0 && this.conflicts.length === 0) {
			contentEl.createEl("p", { text: "Everything is up to date." });
			new Setting(contentEl).addButton((btn) =>
				btn.setButtonText("Close").setCta().onClick(() => this.cancel())
			);
			return;
		}

		// Summary line
		const groups = this.groupActions();
		const parts: string[] = [];
		if (groups.uploads.length)   parts.push(`${groups.uploads.length} upload${groups.uploads.length !== 1 ? "s" : ""}`);
		if (groups.downloads.length) parts.push(`${groups.downloads.length} download${groups.downloads.length !== 1 ? "s" : ""}`);
		if (groups.deletes.length)   parts.push(`${groups.deletes.length} delete${groups.deletes.length !== 1 ? "s" : ""}`);
		if (this.conflicts.length)   parts.push(`${this.conflicts.length} conflict${this.conflicts.length !== 1 ? "s" : ""}`);
		contentEl.createEl("p", {
			text: parts.join(" · "),
			cls: "cloud-sync-plan-summary",
		});

		// File action groups
		if (groups.uploads.length > 0)   this.renderGroup(contentEl, "Uploads",   groups.uploads);
		if (groups.downloads.length > 0) this.renderGroup(contentEl, "Downloads", groups.downloads);
		if (groups.deletes.length > 0)   this.renderGroup(contentEl, "Deletes",   groups.deletes);
		if (this.conflicts.length > 0)   this.renderConflicts(contentEl);

		// Footer
		contentEl.createEl("div", { cls: "cloud-sync-plan-footer" }, (footer) => {
			new Setting(footer)
				.addButton((btn) =>
					btn.setButtonText("Cancel").onClick(() => this.cancel())
				)
				.addButton((btn) => {
					const label = totalSelected > 0
						? `Sync ${totalSelected} item${totalSelected !== 1 ? "s" : ""}`
						: "Nothing selected";
					btn
						.setButtonText(label)
						.setCta()
						.setDisabled(totalSelected === 0)
						.onClick(() => this.confirm());
				});
		});
	}

	private groupActions() {
		const uploads: SyncAction[] = [];
		const downloads: SyncAction[] = [];
		const deletes: SyncAction[] = [];

		for (const a of this.fileActions) {
			if (a.type === "upload" || a.type === "update-remote" || a.type === "create-folder-remote") {
				uploads.push(a);
			} else if (a.type === "download" || a.type === "update-local" || a.type === "create-folder-local") {
				downloads.push(a);
			} else if (
				a.type === "delete-local" || a.type === "delete-remote" ||
				a.type === "delete-folder-local" || a.type === "delete-folder-remote"
			) {
				deletes.push(a);
			}
		}

		return { uploads, downloads, deletes };
	}

	private resolvedConflicts(): number {
		let count = 0;
		for (const res of this.conflictResolutions.values()) {
			if (res !== "skip") count++;
		}
		return count;
	}

	private renderGroup(containerEl: HTMLElement, title: string, actions: SyncAction[]): void {
		const section = containerEl.createEl("div", { cls: "cloud-sync-plan-section" });
		const header = section.createEl("div", { cls: "cloud-sync-plan-section-header" });
		header.createEl("span", { text: `${title} (${actions.length})`, cls: "cloud-sync-plan-section-title" });

		const allSelected = actions.every((a) => this.selected.has(a.vaultPath));
		const headerBtn = header.createEl("button", {
			text: allSelected ? "Deselect all" : "Select all",
			cls: "cloud-sync-plan-bulk-btn",
		});
		headerBtn.addEventListener("click", () => {
			if (allSelected) {
				actions.forEach((a) => this.selected.delete(a.vaultPath));
			} else {
				actions.forEach((a) => this.selected.add(a.vaultPath));
			}
			this.render();
		});

		for (const action of actions) {
			const row = section.createEl("div", { cls: "cloud-sync-plan-row" });

			const checkbox = row.createEl("input", { type: "checkbox" } as DomElementInfo & { type: string });
			(checkbox as HTMLInputElement).checked = this.selected.has(action.vaultPath);
			(checkbox as HTMLInputElement).addEventListener("change", () => {
				if ((checkbox as HTMLInputElement).checked) {
					this.selected.add(action.vaultPath);
				} else {
					this.selected.delete(action.vaultPath);
				}
				this.render();
			});

			const iconEl = row.createEl("span", { cls: "cloud-sync-plan-icon" });
			const info = ACTION_LABELS[action.type];
			if (info) setIcon(iconEl, info.icon);

			row.createEl("span", { text: action.vaultPath, cls: "cloud-sync-plan-path" });
		}
	}

	private renderConflicts(containerEl: HTMLElement): void {
		const section = containerEl.createEl("div", { cls: "cloud-sync-plan-section cloud-sync-plan-conflicts" });
		const header = section.createEl("div", { cls: "cloud-sync-plan-section-header" });
		header.createEl("span", {
			text: `Conflicts (${this.conflicts.length}) — modified on both sides`,
			cls: "cloud-sync-plan-section-title",
		});

		// Bulk resolvers
		const bulkRow = section.createEl("div", { cls: "cloud-sync-plan-bulk-row" });
		bulkRow.createEl("span", { text: "Resolve all: ", cls: "cloud-sync-plan-bulk-label" });
		const bulkOptions: ConflictResolution[] = ["local", "remote", "merge"];
		if (Platform.isDesktop && this.hasMergeTool) bulkOptions.push("external");
		bulkOptions.push("skip");
		for (const res of bulkOptions) {
			const btn = bulkRow.createEl("button", {
				text: res.charAt(0).toUpperCase() + res.slice(1),
				cls: "cloud-sync-plan-bulk-btn",
			});
			btn.addEventListener("click", () => {
				for (const c of this.conflicts) this.conflictResolutions.set(c.vaultPath, res);
				this.render();
			});
		}

		for (const issue of this.conflicts) {
			const current = this.conflictResolutions.get(issue.vaultPath) ?? "skip";
			const row = section.createEl("div", { cls: "cloud-sync-plan-row cloud-sync-plan-conflict-row" });

			const iconEl = row.createEl("span", { cls: "cloud-sync-plan-icon cloud-sync-conflict-icon" });
			setIcon(iconEl, "alert-triangle");

			const info = row.createEl("div", { cls: "cloud-sync-plan-conflict-info" });
			info.createEl("span", { text: issue.vaultPath, cls: "cloud-sync-plan-path" });
			if (issue.localModTime && issue.remoteModTime) {
				info.createEl("span", {
					text: `Local: ${new Date(issue.localModTime).toLocaleString()} · Remote: ${new Date(issue.remoteModTime).toLocaleString()}`,
					cls: "cloud-sync-plan-timestamps",
				});
			}

			const btns = row.createEl("div", { cls: "cloud-sync-plan-conflict-btns" });
			const options: Array<[ConflictResolution, string]> = [
				["local", "Local"],
				["remote", "Remote"],
				["merge", "Smart Merge"],
			];
			if (Platform.isDesktop && this.hasMergeTool) options.push(["external", "External"]);
			options.push(["skip", "Skip"]);

			for (const [res, label] of options) {
				const btn = btns.createEl("button", {
					text: label,
					cls: current === res ? "cloud-sync-plan-res-btn mod-cta" : "cloud-sync-plan-res-btn",
				});
				btn.addEventListener("click", () => {
					this.conflictResolutions.set(issue.vaultPath, res);
					this.render();
				});
			}
		}
	}

	private confirm(): void {
		const selectedActions = this.fileActions.filter((a) => this.selected.has(a.vaultPath));
		if (this.resolvePromise) {
			this.resolvePromise({ selectedActions, conflictResolutions: this.conflictResolutions, cancelled: false });
			this.resolvePromise = null;
		}
		this.close();
	}

	private cancel(): void {
		if (this.resolvePromise) {
			this.resolvePromise({ selectedActions: [], conflictResolutions: new Map(), cancelled: true });
			this.resolvePromise = null;
		}
		this.close();
	}

	onClose(): void {
		if (this.resolvePromise) {
			this.resolvePromise({ selectedActions: [], conflictResolutions: new Map(), cancelled: true });
			this.resolvePromise = null;
		}
		this.contentEl.empty();
	}

	openAndWait(): Promise<SyncPlanResult> {
		return new Promise((resolve) => {
			this.resolvePromise = resolve;
			this.open();
		});
	}
}
