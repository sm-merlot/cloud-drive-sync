// Whole-folder operations for encrypted-at-rest folders (DEV-396): convert a
// plaintext folder to at rest, convert back, and re-encrypt under a new key
// generation (password change).
//
// These run on the device's own files; the normal sync then carries the
// result to the server and other devices. Each one is resumable: it
// classifies every file by what it can decrypt, so running it again after a
// crash just finishes the remainder. New copies are always written before
// the old ones are removed.

import type { LocalFileSystem } from "../fs/local-file-system";
import { isDotPath } from "../util/path";
import { decryptAtRest, encryptAtRest, fromAtRestPath, isAtRestFile, toAtRestPath } from "../crypto/at-rest";
import type { FolderKeys } from "../crypto/folder-crypto";

export interface AtRestOpsOptions {
	// How to remove a file whose content was plaintext. Hosts should delete it
	// outright rather than move it to a trash, where the plaintext would
	// survive. Defaults to fs.deleteFile.
	removePlaintext?: (path: string) => Promise<void>;
	onProgress?: (done: number, total: number) => void;
}

export interface AtRestOpResult {
	converted: number;
	// Files left alone because they couldn't be read (another generation, junk)
	skipped: string[];
}

function under(folder: string, path: string): boolean {
	return path.startsWith(folder + "/") && !isDotPath(path.slice(folder.length + 1));
}

function depth(p: string): number {
	return p.split("/").length;
}

// Plaintext folder → at rest. Every non-.cdse file becomes an encrypted file
// under its encrypted name; plain subfolders become encrypted subfolders.
// Existing .cdse files (a resumed run) are left alone.
export async function convertFolderToAtRest(
	fs: LocalFileSystem,
	root: string,
	folder: string,
	keys: FolderKeys,
	opts: AtRestOpsOptions = {},
): Promise<AtRestOpResult> {
	const remove = opts.removePlaintext ?? ((p) => fs.deleteFile(root, p));
	const files = (await fs.listFiles(root)).filter((f) => under(folder, f.path) && !isAtRestFile(f.path));
	const folders = (await fs.listFolders(root)).filter((d) => under(folder, d));
	const result: AtRestOpResult = { converted: 0, skipped: [] };

	// Plain subfolders are those whose names aren't ours
	const plainFolders: string[] = [];
	for (const d of folders) {
		try {
			await fromAtRestPath(keys, folder, d);
		} catch {
			plainFolders.push(d);
		}
	}
	for (const d of plainFolders.sort((a, b) => depth(a) - depth(b))) {
		await fs.createFolder(root, await toAtRestPath(keys, folder, d, false));
	}

	let n = 0;
	for (const f of files) {
		const plain = await fs.readFile(root, f.path);
		await fs.writeFile(root, await toAtRestPath(keys, folder, f.path, true), await encryptAtRest(keys, f.path, plain));
		await remove(f.path);
		result.converted++;
		opts.onProgress?.(++n, files.length);
	}

	for (const d of plainFolders.sort((a, b) => depth(b) - depth(a))) await fs.deleteFolder(root, d);
	return result;
}

// At rest → plaintext: decrypt every file back to its plain name.
export async function convertFolderToPlaintext(
	fs: LocalFileSystem,
	root: string,
	folder: string,
	keys: FolderKeys,
	opts: AtRestOpsOptions = {},
): Promise<AtRestOpResult> {
	const files = (await fs.listFiles(root)).filter((f) => under(folder, f.path) && isAtRestFile(f.path));
	const folders = (await fs.listFolders(root)).filter((d) => under(folder, d));
	const result: AtRestOpResult = { converted: 0, skipped: [] };

	const encFolders: { disk: string; plain: string }[] = [];
	for (const d of folders) {
		try {
			encFolders.push({ disk: d, plain: (await fromAtRestPath(keys, folder, d)).plainPath });
		} catch {
			// a plain folder already (resumed run) or not ours
		}
	}
	for (const d of [...encFolders].sort((a, b) => depth(a.plain) - depth(b.plain))) await fs.createFolder(root, d.plain);

	let n = 0;
	for (const f of files) {
		let plainPath: string;
		try {
			plainPath = (await fromAtRestPath(keys, folder, f.path)).plainPath;
		} catch {
			result.skipped.push(f.path);
			continue;
		}
		const plain = await decryptAtRest(keys, plainPath, await fs.readFile(root, f.path));
		await fs.writeFile(root, plainPath, plain);
		await fs.deleteFile(root, f.path);
		result.converted++;
		opts.onProgress?.(++n, files.length);
	}
	for (const d of [...encFolders].sort((a, b) => depth(b.plain) - depth(a.plain))) await fs.deleteFolder(root, d.disk);
	return result;
}

// Password change: move every file and folder from the old key generation
// to the new one. Files already readable with the new keys are done; files
// readable with neither are reported as skipped.
export async function reencryptAtRestFolder(
	fs: LocalFileSystem,
	root: string,
	folder: string,
	oldKeys: FolderKeys,
	newKeys: FolderKeys,
	opts: AtRestOpsOptions = {},
): Promise<AtRestOpResult> {
	const files = (await fs.listFiles(root)).filter((f) => under(folder, f.path) && isAtRestFile(f.path));
	const folders = (await fs.listFolders(root)).filter((d) => under(folder, d));
	const result: AtRestOpResult = { converted: 0, skipped: [] };

	const oldFolders: { disk: string; plain: string }[] = [];
	for (const d of folders) {
		try {
			await fromAtRestPath(newKeys, folder, d);
			continue; // already new
		} catch {
			// fall through
		}
		try {
			oldFolders.push({ disk: d, plain: (await fromAtRestPath(oldKeys, folder, d)).plainPath });
		} catch {
			// neither generation: leave it
		}
	}
	for (const d of [...oldFolders].sort((a, b) => depth(a.plain) - depth(b.plain))) {
		await fs.createFolder(root, await toAtRestPath(newKeys, folder, d.plain, false));
	}

	const todo: { disk: string; plain: string }[] = [];
	for (const f of files) {
		try {
			await fromAtRestPath(newKeys, folder, f.path);
			continue; // already new
		} catch {
			// fall through
		}
		try {
			todo.push({ disk: f.path, plain: (await fromAtRestPath(oldKeys, folder, f.path)).plainPath });
		} catch {
			result.skipped.push(f.path);
		}
	}
	let n = 0;
	for (const t of todo) {
		const plain = await decryptAtRest(oldKeys, t.plain, await fs.readFile(root, t.disk));
		await fs.writeFile(root, await toAtRestPath(newKeys, folder, t.plain, true), await encryptAtRest(newKeys, t.plain, plain));
		await fs.deleteFile(root, t.disk);
		result.converted++;
		opts.onProgress?.(++n, todo.length);
	}
	for (const d of [...oldFolders].sort((a, b) => depth(b.plain) - depth(a.plain))) await fs.deleteFolder(root, d.disk);
	return result;
}
