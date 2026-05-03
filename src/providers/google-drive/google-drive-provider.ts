import type { CloudProvider } from "../cloud-provider";
import type { RemoteFileInfo } from "../../types";
import type { GoogleDriveApi } from "./google-drive-api";

export class GoogleDriveProvider implements CloudProvider {
	readonly name = "Google Drive";
	private api: GoogleDriveApi;
	private rootFolderId: string;
	private folderIdCache: Map<string, string> = new Map();

	constructor(api: GoogleDriveApi, rootFolderId: string) {
		this.api = api;
		this.rootFolderId = rootFolderId;
	}

	async testConnection(): Promise<boolean> {
		try {
			await this.api.listFiles(this.rootFolderId);
			return true;
		} catch {
			return false;
		}
	}

	async listAllFiles(): Promise<RemoteFileInfo[]> {
		this.folderIdCache.clear();
		const files = await this.api.listAllFilesRecursive(this.rootFolderId);
		// Build folder cache from folder entries and file parent paths
		for (const f of files) {
			if (f.isFolder) {
				this.folderIdCache.set(f.path, f.id);
			} else {
				const dir = f.path.includes("/") ? f.path.substring(0, f.path.lastIndexOf("/")) : "";
				if (dir && f.parentId) {
					this.folderIdCache.set(dir, f.parentId);
				}
			}
		}
		return files;
	}

	async downloadFile(remoteId: string): Promise<ArrayBuffer> {
		return this.api.downloadFile(remoteId);
	}

	async uploadFile(
		parentFolderId: string,
		name: string,
		content: ArrayBuffer,
		mimeType: string
	): Promise<string> {
		return this.api.uploadFile(parentFolderId, name, content, mimeType);
	}

	async updateFile(
		remoteId: string,
		content: ArrayBuffer,
		mimeType: string
	): Promise<void> {
		return this.api.updateFile(remoteId, content, mimeType);
	}

	async deleteFile(remoteId: string): Promise<void> {
		return this.api.deleteFile(remoteId);
	}

	async createFolder(parentFolderId: string, name: string): Promise<string> {
		const id = await this.api.createFolder(parentFolderId, name);
		return id;
	}

	async getRemoteFolderId(relativePath: string): Promise<string> {
		if (!relativePath || relativePath === "") {
			return this.rootFolderId;
		}

		const cached = this.folderIdCache.get(relativePath);
		if (cached) return cached;

		// Create folder chain
		const parts = relativePath.split("/");
		let currentParentId = this.rootFolderId;
		let currentPath = "";

		for (const part of parts) {
			currentPath = currentPath ? `${currentPath}/${part}` : part;

			const cachedPart = this.folderIdCache.get(currentPath);
			if (cachedPart) {
				currentParentId = cachedPart;
				continue;
			}

			// Check if folder exists
			const existing = await this.api.listFolders(currentParentId);
			const found = existing.find((f) => f.name === part);

			if (found) {
				this.folderIdCache.set(currentPath, found.id);
				currentParentId = found.id;
			} else {
				const newId = await this.api.createFolder(currentParentId, part);
				this.folderIdCache.set(currentPath, newId);
				currentParentId = newId;
			}
		}

		return currentParentId;
	}
}
