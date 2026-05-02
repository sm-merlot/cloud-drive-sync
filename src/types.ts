export interface SyncFileRecord {
	vaultPath: string;
	remoteId: string;
	remoteFolderId: string;
	localModTime: number;
	remoteModTime: number;
	contentHash: string;
}

export interface SyncState {
	files: Record<string, SyncFileRecord>;
	lastSyncTime: number;
	remoteChangeToken?: string;
}

export interface GoogleDriveSettings {
	clientId: string;
	clientSecret: string;
	rootFolderId: string;
	rootFolderName: string;
	accessToken: string;
	refreshToken: string;
	tokenExpiry: number;
}

export interface PluginSettings {
	provider: "google-drive" | "proton-drive";
	googleDrive: GoogleDriveSettings;
	syncIntervalMinutes: number;
	syncOnStartup: boolean;
	excludePatterns: string[];
	syncState: SyncState;
}

export const DEFAULT_SETTINGS: PluginSettings = {
	provider: "google-drive",
	googleDrive: {
		clientId: "",
		clientSecret: "",
		rootFolderId: "",
		rootFolderName: "",
		accessToken: "",
		refreshToken: "",
		tokenExpiry: 0,
	},
	syncIntervalMinutes: 15,
	syncOnStartup: false,
	excludePatterns: [".obsidian/**"],
	syncState: {
		files: {},
		lastSyncTime: 0,
	},
};

export type ConflictResolution = "local" | "remote" | "skip";

export type SyncAction =
	| { type: "upload"; vaultPath: string }
	| { type: "download"; vaultPath: string; remoteId: string }
	| { type: "update-remote"; vaultPath: string; remoteId: string }
	| { type: "update-local"; vaultPath: string; remoteId: string }
	| { type: "delete-remote"; remoteId: string; vaultPath: string }
	| { type: "delete-local"; vaultPath: string }
	| { type: "conflict"; vaultPath: string; remoteId: string };

export interface RemoteFileInfo {
	id: string;
	name: string;
	path: string;
	modifiedTime: number;
	md5Checksum: string;
	mimeType: string;
	isFolder: boolean;
	parentId: string;
}
