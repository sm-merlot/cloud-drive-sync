import type { CloudProvider } from "../cloud-provider";
import type { RemoteFileInfo } from "../../types";
import { guessMimeType } from "../../util/path";
import { MULTIPART_PART_SIZE_BYTES, MULTIPART_THRESHOLD_BYTES } from "../../util/constants";
import type { HttpClient } from "../../http/http-client";
import { S3Api, type S3Config } from "./s3-api";

export class S3Provider implements CloudProvider {
	readonly name = "S3";
	private api: S3Api;

	constructor(config: S3Config, http: HttpClient) {
		this.api = new S3Api(config, http);
	}

	async testConnection(): Promise<boolean> {
		return this.api.testConnection();
	}

	// Instance-level (not bucket-scoped) — the configured bucket is ignored.
	async listBuckets(): Promise<string[]> {
		return this.api.listBuckets();
	}

	async createBucket(name: string): Promise<void> {
		return this.api.createBucket(name);
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

			// Keys ending in "/" are directory markers (rclone `serve s3` lists
			// every empty directory this way). The folder itself was synthesized
			// above; treating the marker as a file makes the engine try to
			// download a nameless file onto the folder path on every sync.
			if (key.endsWith("/")) {
				const folderPath = key.replace(/\/+$/, "");
				if (folderPath) this.addSyntheticFolders(`${folderPath}/.keep`, seenFolders, files);
				continue;
			}

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
		await this.putAnySize(key, content, mimeType);
		return key;
	}

	async updateFile(remoteId: string, content: ArrayBuffer, mimeType: string): Promise<void> {
		await this.putAnySize(remoteId, content, mimeType);
	}

	private async putAnySize(key: string, content: ArrayBuffer, mimeType: string): Promise<void> {
		if (content.byteLength < MULTIPART_THRESHOLD_BYTES) {
			await this.api.putObject(key, content, mimeType);
			return;
		}
		await this.uploadLarge(key, content);
	}

	// Sequential multipart upload with abort-on-failure so incomplete uploads
	// never accumulate on the backend. No part concurrency: the buffer is fully
	// resident either way, so parallelism buys nothing and complicates aborts.
	private async uploadLarge(key: string, content: ArrayBuffer): Promise<void> {
		const uploadId = await this.api.createMultipartUpload(key);
		const totalParts = Math.ceil(content.byteLength / MULTIPART_PART_SIZE_BYTES);
		const parts: { partNumber: number; etag: string }[] = [];
		try {
			for (let i = 0; i < totalParts; i++) {
				const start = i * MULTIPART_PART_SIZE_BYTES;
				const end = Math.min(start + MULTIPART_PART_SIZE_BYTES, content.byteLength);
				const etag = await this.api.uploadPart(key, uploadId, i + 1, new Uint8Array(content, start, end - start));
				parts.push({ partNumber: i + 1, etag });
			}
		} catch (e) {
			await this.api.abortMultipartUpload(key, uploadId).catch(() => {});
			throw new Error(
				`multipart upload failed at part ${parts.length + 1}/${totalParts} for ${key}: ${e instanceof Error ? e.message : String(e)}`
			);
		}
		await this.api.completeMultipartUpload(key, uploadId, parts);
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
