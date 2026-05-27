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

export interface S3Settings {
	endpoint: string;
	bucket: string;
	accessKey: string;
	secretKey: string;
	region: string;
}

export type ConflictStrategy = "prompt" | "smart-merge" | "latest-wins" | "use-local" | "use-remote";

export interface PluginSettings {
	provider: "google-drive" | "s3" | "proton-drive";
	googleDrive: GoogleDriveSettings;
	s3: S3Settings;
	syncIntervalMinutes: number;
	syncOnStartup: boolean;
	excludePatterns: string[];
	mergeToolCommand: string;
	conflictStrategy: ConflictStrategy;
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
	s3: {
		endpoint: "",
		bucket: "",
		accessKey: "",
		secretKey: "",
		region: "us-east-1",
	},
	conflictStrategy: "prompt",
	syncIntervalMinutes: 15,
	syncOnStartup: false,
	excludePatterns: [],
	mergeToolCommand: "",
	syncState: {
		files: {},
		lastSyncTime: 0,
	},
};

export type ConflictResolution = "local" | "remote" | "merge" | "skip";

export type SyncAction =
	| { type: "upload"; vaultPath: string }
	| { type: "download"; vaultPath: string; remoteId: string }
	| { type: "update-remote"; vaultPath: string; remoteId: string }
	| { type: "update-local"; vaultPath: string; remoteId: string }
	| { type: "delete-remote"; remoteId: string; vaultPath: string }
	| { type: "delete-local"; vaultPath: string }
	| { type: "conflict"; vaultPath: string; remoteId: string }
	| { type: "create-folder-remote"; vaultPath: string }
	| { type: "create-folder-local"; vaultPath: string; remoteId: string }
	| { type: "delete-folder-remote"; remoteId: string; vaultPath: string }
	| { type: "delete-folder-local"; vaultPath: string };

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
