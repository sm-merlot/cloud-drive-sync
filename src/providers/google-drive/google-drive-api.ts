import { requestUrl } from "obsidian";
import type { RemoteFileInfo } from "../../types";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";

interface DriveFile {
	id: string;
	name: string;
	mimeType: string;
	modifiedTime: string;
	md5Checksum?: string;
	parents?: string[];
}

interface DriveListResponse {
	files: DriveFile[];
	nextPageToken?: string;
}

export class GoogleDriveApi {
	private getToken: () => Promise<string>;

	constructor(getToken: () => Promise<string>) {
		this.getToken = getToken;
	}

	private async headers(): Promise<Record<string, string>> {
		const token = await this.getToken();
		return { Authorization: `Bearer ${token}` };
	}

	async listFiles(folderId: string): Promise<DriveFile[]> {
		const allFiles: DriveFile[] = [];
		let pageToken: string | undefined;

		do {
			const params = new URLSearchParams({
				q: `'${folderId}' in parents and trashed=false`,
				fields: "nextPageToken,files(id,name,mimeType,modifiedTime,md5Checksum,parents)",
				pageSize: "1000",
			});
			if (pageToken) params.set("pageToken", pageToken);

			const resp = await requestUrl({
				url: `${DRIVE_API}/files?${params.toString()}`,
				headers: await this.headers(),
			});

			if (resp.status !== 200) {
				throw new Error(`Drive list failed (${resp.status}): ${resp.text}`);
			}

			const data: DriveListResponse = resp.json;
			allFiles.push(...data.files);
			pageToken = data.nextPageToken;
		} while (pageToken);

		return allFiles;
	}

	async listFolders(parentId: string): Promise<{ id: string; name: string }[]> {
		const params = new URLSearchParams({
			q: `'${parentId}' in parents and mimeType='${FOLDER_MIME}' and trashed=false`,
			fields: "files(id,name)",
			pageSize: "1000",
		});

		const resp = await requestUrl({
			url: `${DRIVE_API}/files?${params.toString()}`,
			headers: await this.headers(),
		});

		if (resp.status !== 200) {
			throw new Error(`Drive list folders failed (${resp.status}): ${resp.text}`);
		}

		return resp.json.files;
	}

	async listAllFilesRecursive(rootFolderId: string): Promise<RemoteFileInfo[]> {
		const result: RemoteFileInfo[] = [];
		const queue: { folderId: string; pathPrefix: string }[] = [
			{ folderId: rootFolderId, pathPrefix: "" },
		];

		while (queue.length > 0) {
			const item = queue.shift()!;
			const files = await this.listFiles(item.folderId);

			for (const f of files) {
				const filePath = item.pathPrefix ? `${item.pathPrefix}/${f.name}` : f.name;
				const isFolder = f.mimeType === FOLDER_MIME;

				if (isFolder) {
					queue.push({ folderId: f.id, pathPrefix: filePath });
				} else {
					result.push({
						id: f.id,
						name: f.name,
						path: filePath,
						modifiedTime: new Date(f.modifiedTime).getTime(),
						md5Checksum: f.md5Checksum || "",
						mimeType: f.mimeType,
						isFolder: false,
						parentId: f.parents?.[0] || item.folderId,
					});
				}
			}
		}

		return result;
	}

	async downloadFile(fileId: string): Promise<ArrayBuffer> {
		const resp = await requestUrl({
			url: `${DRIVE_API}/files/${fileId}?alt=media`,
			headers: await this.headers(),
		});

		if (resp.status !== 200) {
			throw new Error(`Drive download failed (${resp.status})`);
		}

		return resp.arrayBuffer;
	}

	async uploadFile(
		parentId: string,
		name: string,
		content: ArrayBuffer,
		mimeType: string
	): Promise<string> {
		const metadata = JSON.stringify({
			name,
			parents: [parentId],
		});

		const body = buildMultipartBody(metadata, content, mimeType);

		const resp = await requestUrl({
			url: `${UPLOAD_API}/files?uploadType=multipart`,
			method: "POST",
			headers: {
				...(await this.headers()),
				"Content-Type": `multipart/related; boundary=${BOUNDARY}`,
			},
			body: body,
		});

		if (resp.status !== 200) {
			throw new Error(`Drive upload failed (${resp.status}): ${resp.text}`);
		}

		return resp.json.id;
	}

	async updateFile(
		fileId: string,
		content: ArrayBuffer,
		mimeType: string
	): Promise<void> {
		const resp = await requestUrl({
			url: `${UPLOAD_API}/files/${fileId}?uploadType=media`,
			method: "PATCH",
			headers: {
				...(await this.headers()),
				"Content-Type": mimeType,
			},
			body: content,
		});

		if (resp.status !== 200) {
			throw new Error(`Drive update failed (${resp.status}): ${resp.text}`);
		}
	}

	async deleteFile(fileId: string): Promise<void> {
		const resp = await requestUrl({
			url: `${DRIVE_API}/files/${fileId}`,
			method: "DELETE",
			headers: await this.headers(),
		});

		if (resp.status !== 204 && resp.status !== 200) {
			throw new Error(`Drive delete failed (${resp.status})`);
		}
	}

	async createFolder(parentId: string, name: string): Promise<string> {
		const resp = await requestUrl({
			url: `${DRIVE_API}/files`,
			method: "POST",
			headers: {
				...(await this.headers()),
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				name,
				mimeType: FOLDER_MIME,
				parents: [parentId],
			}),
		});

		if (resp.status !== 200) {
			throw new Error(`Drive create folder failed (${resp.status}): ${resp.text}`);
		}

		return resp.json.id;
	}

	async getStartPageToken(): Promise<string> {
		const resp = await requestUrl({
			url: `${DRIVE_API}/changes/startPageToken`,
			headers: await this.headers(),
		});
		return resp.json.startPageToken;
	}
}

// --- Multipart body builder ---

const BOUNDARY = "CloudSyncBoundary";

function buildMultipartBody(
	metadataJson: string,
	content: ArrayBuffer,
	contentType: string
): ArrayBuffer {
	const encoder = new TextEncoder();

	const preamble = encoder.encode(
		`--${BOUNDARY}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadataJson}\r\n--${BOUNDARY}\r\nContent-Type: ${contentType}\r\n\r\n`
	);
	const epilogue = encoder.encode(`\r\n--${BOUNDARY}--`);

	const body = new Uint8Array(preamble.length + content.byteLength + epilogue.length);
	body.set(preamble, 0);
	body.set(new Uint8Array(content), preamble.length);
	body.set(epilogue, preamble.length + content.byteLength);

	return body.buffer;
}
