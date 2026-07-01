import type { CloudProvider } from "../cloud-provider";
import type { RemoteFileInfo } from "../../types";
import { guessMimeType } from "../../util/path";
import { S3Api, type S3Config } from "./s3-api";

export class S3Provider implements CloudProvider {
	readonly name = "S3";
	private api: S3Api;

	constructor(config: S3Config) {
		this.api = new S3Api(config);
	}

	async testConnection(): Promise<boolean> {
		return this.api.testConnection();
	}

	async listAllFiles(): Promise<RemoteFileInfo[]> {
		const objects = await this.api.listAllObjects();
		const files: RemoteFileInfo[] = [];
		const seenFolders = new Set<string>();

		for (const obj of objects) {
			const key = obj.key;
			const lastSlash = key.lastIndexOf("/");
			const name = lastSlash >= 0 ? key.slice(lastSlash + 1) : key;
			const parentPath = lastSlash >= 0 ? key.slice(0, lastSlash) : "";

			// Always synthesize folders (including from .keep placeholders)
			this.addSyntheticFolders(key, seenFolders, files);

			// Skip .keep placeholders — they exist only to anchor empty folders in S3
			if (name === ".keep") continue;

			files.push({
				id: key,
				name,
				path: key,
				modifiedTime: obj.lastModified,
				md5Checksum: obj.etag,
				mimeType: guessMimeType(name),
				isFolder: false,
				parentId: parentPath,
			});
		}

		return files;
	}

	private addSyntheticFolders(key: string, seen: Set<string>, out: RemoteFileInfo[]): void {
		const parts = key.split("/");
		// iterate all ancestor prefixes (not the file itself)
		for (let i = 1; i < parts.length; i++) {
			const folderPath = parts.slice(0, i).join("/");
			if (seen.has(folderPath)) continue;
			seen.add(folderPath);

			const lastSlash = folderPath.lastIndexOf("/");
			const name = lastSlash >= 0 ? folderPath.slice(lastSlash + 1) : folderPath;
			const parentPath = lastSlash >= 0 ? folderPath.slice(0, lastSlash) : "";

			out.push({
				id: `${folderPath}/.keep`,
				name,
				path: folderPath,
				modifiedTime: 0,
				md5Checksum: "",
				mimeType: "application/x-directory",
				isFolder: true,
				parentId: parentPath,
			});
		}
	}

	async downloadFile(remoteId: string): Promise<ArrayBuffer> {
		return this.api.getObject(remoteId);
	}

	async uploadFile(
		parentFolderId: string,
		name: string,
		content: ArrayBuffer,
		mimeType: string,
	): Promise<string> {
		const key = parentFolderId ? `${parentFolderId}/${name}` : name;
		await this.api.putObject(key, content, mimeType);
		return key;
	}

	async updateFile(remoteId: string, content: ArrayBuffer, mimeType: string): Promise<void> {
		await this.api.putObject(remoteId, content, mimeType);
	}

	async deleteFile(remoteId: string): Promise<void> {
		await this.api.deleteObject(remoteId);
	}

	// Upload a .keep placeholder so the folder has a real S3 presence
	async createFolder(parentFolderId: string, name: string): Promise<string> {
		const folderPath = parentFolderId ? `${parentFolderId}/${name}` : name;
		await this.api.putObject(`${folderPath}/.keep`, new ArrayBuffer(0), "application/octet-stream");
		return folderPath;
	}

	async getRemoteFolderId(relativePath: string): Promise<string> {
		return relativePath;
	}
}
