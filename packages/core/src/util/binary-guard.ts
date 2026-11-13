const TEXT_MIME_ALLOWLIST = new Set([
	"application/json",
	"application/xml",
	"application/javascript",
	"application/typescript",
]);

// Text files whose content is ciphertext: Meld Encrypt's whole-note .mdenc
// (a JSON envelope around base64) and our own at-rest .cdse. They pass a text
// sniff, but a line merge of two versions splices two ciphertexts into a note
// neither side can decrypt.
const NEVER_LINE_MERGE_EXTENSIONS = new Set(["mdenc", "cdse"]);

// Whether merge2way may touch this file at all
export function isLineMergeable(path: string, content: ArrayBuffer, mimeType: string): boolean {
	const ext = path.split("/").pop()!.split(".").pop()!.toLowerCase();
	if (NEVER_LINE_MERGE_EXTENSIONS.has(ext)) return false;
	return isProbablyText(content, mimeType);
}

// Guards merge2way (line-based LCS text merge) from ever touching binary
// content, which it would corrupt. NUL-byte sniff over the first 8KB is the
// same heuristic git/grep -I use — catches binary data behind unknown or
// lying extensions that guessMimeType() can't classify.
export function isProbablyText(content: ArrayBuffer, mimeType: string): boolean {
	if (mimeType.startsWith("text/") || TEXT_MIME_ALLOWLIST.has(mimeType)) return true;
	const bytes = new Uint8Array(content, 0, Math.min(content.byteLength, 8192));
	return !bytes.includes(0);
}
