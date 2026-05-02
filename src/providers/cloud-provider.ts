import type { RemoteFileInfo } from "../types";

export interface CloudProvider {
	readonly name: string;

	testConnection(): Promise<boolean>;

	listAllFiles(): Promise<RemoteFileInfo[]>;

	downloadFile(remoteId: string): Promise<ArrayBuffer>;

	uploadFile(
		parentFolderId: string,
		name: string,
		content: ArrayBuffer,
		mimeType: string
	): Promise<string>;

	updateFile(
		remoteId: string,
		content: ArrayBuffer,
		mimeType: string
	): Promise<void>;

	deleteFile(remoteId: string): Promise<void>;

	createFolder(parentFolderId: string, name: string): Promise<string>;

	getRemoteFolderId(relativePath: string): Promise<string>;
}
