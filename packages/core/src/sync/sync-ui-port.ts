import type { ConflictResolution, SyncAction } from "../types";

export type FirstSyncStrategy = "download" | "upload" | "merge";

export interface SyncIssue {
	vaultPath: string;
	// "delete-conflict": deleted on this device but changed remotely since this
	// device's last sync — a safe default (re-download) has already been applied
	// by the engine for auto strategies; prompt-style UIs surface it for override.
	// "too-big": over the engine's maxFileSize, so not transferred. Reported in
	// SyncResult.tooBig only, never passed to resolveSyncIssues.
	type: "conflict" | "delete-conflict" | "error" | "too-big";
	remoteId?: string;
	localModTime?: number;
	remoteModTime?: number;
	errorMessage?: string;
	// bytes; set on "too-big" issues
	size?: number;
}

export interface SyncIssueResolution {
	vaultPath: string;
	resolution: ConflictResolution | "retry";
	remoteId?: string;
}

// The engine's only interaction seam with a host UI. Obsidian implements these
// with its modals; the Tauri shell resolves headlessly from settings.
export interface SyncUIPort {
	chooseFirstSyncStrategy(): Promise<FirstSyncStrategy>;
	// Paths omitted from the returned array are treated as "skip".
	resolveSyncIssues(issues: SyncIssue[]): Promise<SyncIssueResolution[]>;
	// Optional debug preview of planned actions before execution; return
	// cancelled=true to abort the pass. Engine skips the call when undefined.
	reviewPlan?(actions: SyncAction[], issues: SyncIssue[]): Promise<{ cancelled: boolean }>;
	// Optional external merge tool hook (Obsidian desktop only). Resolution
	// "external" degrades to skip when this is undefined.
	externalMerge?(vaultPath: string, remoteId: string): Promise<void>;
}
