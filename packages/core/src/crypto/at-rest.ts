// Path and content helpers for encrypted-at-rest folders (DEV-390; design:
// docs/design/at-rest-encryption.md).
//
// An at-rest folder has the same layout on the device as on the server:
//   Journal/                       folder name stays plaintext
//     .cds-folder-key.json         key file, mode "at-rest"
//     <base32>.cdse                a file: encrypted name + ".cdse"
//     <base32>/                    a subfolder: encrypted name
// Names use the same SIV-style scheme as transit folders and content the same
// CDSE format, both bound to the plaintext path.

import {
	MAX_ENCRYPTED_SEGMENT_CHARS,
	NameTooLongError,
	decryptContent,
	decryptName,
	encryptContent,
	encryptName,
	type FolderKeys,
} from "./folder-crypto";

export const AT_REST_EXTENSION = "cdse";
const SUFFIX = `.${AT_REST_EXTENSION}`;

export interface AtRestEntry {
	// Vault-relative plaintext path, e.g. "Journal/Health/meds.md"
	plainPath: string;
	isFile: boolean;
}

function checkFolder(folder: string, path: string): string {
	if (!path.startsWith(folder + "/")) throw new Error(`${path} is not inside ${folder}`);
	return path.slice(folder.length + 1);
}

// Plain path → path on disk (and on the server). Files get ".cdse".
export async function toAtRestPath(
	keys: FolderKeys,
	folder: string,
	plainPath: string,
	isFile: boolean,
): Promise<string> {
	const segments = checkFolder(folder, plainPath).split("/");
	let plainPrefix = folder;
	let out = folder;
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i]!;
		let enc = await encryptName(keys, plainPrefix, seg);
		if (isFile && i === segments.length - 1) {
			enc += SUFFIX;
			// The suffix eats into the 255-char segment limit
			if (enc.length > MAX_ENCRYPTED_SEGMENT_CHARS) throw new NameTooLongError(seg);
		}
		out = `${out}/${enc}`;
		plainPrefix = `${plainPrefix}/${seg}`;
	}
	return out;
}

// Path on disk → plain path. Throws on anything that isn't a valid encrypted
// path for these keys (wrong generation, junk, tampering).
export async function fromAtRestPath(keys: FolderKeys, folder: string, atRestPath: string): Promise<AtRestEntry> {
	const segments = checkFolder(folder, atRestPath).split("/");
	const last = segments[segments.length - 1]!;
	const isFile = last.endsWith(SUFFIX);
	if (isFile) segments[segments.length - 1] = last.slice(0, -SUFFIX.length);
	let plain = folder;
	for (const seg of segments) {
		plain = `${plain}/${await decryptName(keys, plain, seg)}`;
	}
	return { plainPath: plain, isFile };
}

export function isAtRestFile(path: string): boolean {
	return path.endsWith(SUFFIX);
}

// Content is bound to the plaintext path, so a rename or move re-encrypts it.
export function encryptAtRest(keys: FolderKeys, plainPath: string, plaintext: Uint8Array): Promise<Uint8Array> {
	return encryptContent(keys, plainPath, plaintext);
}

export function decryptAtRest(keys: FolderKeys, plainPath: string, data: Uint8Array): Promise<Uint8Array> {
	return decryptContent(keys, plainPath, data);
}
