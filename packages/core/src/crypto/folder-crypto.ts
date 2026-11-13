// Per-folder encryption primitives (design: docs/design/per-folder-encryption.md).
//
// WebCrypto only, so it runs unchanged on Obsidian desktop (Electron), Obsidian
// mobile (iOS/Android WebViews), Tauri and Node 20+. Nothing here touches the
// sync engine; it turns a password + key file into keys, and keys into
// encrypted bytes and encrypted path segments.

type Bytes = Uint8Array<ArrayBuffer>;

export const KEY_FILE_NAME = ".cds-folder-key.json";
export const KEY_FILE_FORMAT = "cds-folder-key";
export const KEY_FILE_VERSION = 1;
export const DEFAULT_PBKDF2_ITERATIONS = 600_000;

// Content header: magic(4) | version(1) | keyId(16) | nonce(12)
const MAGIC = new Uint8Array([0x43, 0x44, 0x53, 0x45]); // "CDSE"
const CONTENT_VERSION = 1;
const KEY_ID_BYTES = 16;
const NONCE_BYTES = 12;
const SALT_BYTES = 16;
const TAG_BYTES = 16;
export const CONTENT_HEADER_BYTES = MAGIC.length + 1 + KEY_ID_BYTES + NONCE_BYTES; // 33
export const CONTENT_OVERHEAD_BYTES = CONTENT_HEADER_BYTES + TAG_BYTES; // 49

// Encrypted name: keyTag(2) | iv(16) | ct(n), base32 lowercase, unpadded
const KEY_TAG_BYTES = 2;
const NAME_IV_BYTES = 16;
const NAME_OVERHEAD_BYTES = KEY_TAG_BYTES + NAME_IV_BYTES;
// Most filesystems (ZFS, ext4, APFS) cap one path segment at 255 bytes.
export const MAX_ENCRYPTED_SEGMENT_CHARS = 255;
// Largest plaintext name (UTF-8 bytes) whose encrypted segment still fits.
export const MAX_NAME_BYTES = Math.floor((MAX_ENCRYPTED_SEGMENT_CHARS * 5) / 8) - NAME_OVERHEAD_BYTES; // 141

const CHECK_PREFIX = "cds-check-v1:";

// ---------- errors ----------

export class WrongPasswordError extends Error {
	constructor() {
		super("Wrong password");
		this.name = "WrongPasswordError";
	}
}

export class KeyFileFormatError extends Error {
	constructor(detail: string) {
		super(`Invalid folder key file: ${detail}`);
		this.name = "KeyFileFormatError";
	}
}

// File was encrypted under a different key generation (mid-rotation leftover).
export class KeyIdMismatchError extends Error {
	constructor() {
		super("File is encrypted with a different key id");
		this.name = "KeyIdMismatchError";
	}
}

// Authentication failed with the right key: tampered, corrupt, or moved to a
// different path.
export class DecryptError extends Error {
	constructor(what: string) {
		super(`Cannot decrypt ${what}: authentication failed`);
		this.name = "DecryptError";
	}
}

export class NameTooLongError extends Error {
	constructor(name: string) {
		super(`Name too long for an encrypted folder (max ${MAX_NAME_BYTES} bytes): ${name}`);
		this.name = "NameTooLongError";
	}
}

// ---------- key file ----------

// Present while an enable / password change / removal is in progress. Every
// device except the one running it treats the folder as locked.
export interface KeyFileRotation {
	// keyId of the generation being replaced, or "plaintext" when enabling
	// encryption on an existing folder
	fromKeyId: string;
	// Password change: the replaced key file (minus its own rotation), so the
	// rotating device can still derive the old keys after a restart. Holds
	// nothing secret, same as any key file.
	previous?: Omit<FolderKeyFile, "rotation">;
	// Removal: decrypting back to plaintext; the key file is deleted at the end
	toPlaintext?: boolean;
}

export interface FolderKeyFile {
	format: typeof KEY_FILE_FORMAT;
	version: number;
	keyId: string; // base32
	kdf: { name: "PBKDF2-SHA256"; iterations: number; salt: string }; // salt base64
	check: { nonce: string; ciphertext: string }; // base64
	rotation: KeyFileRotation | null;
}

export interface FolderKeys {
	keyId: Bytes;
	content: CryptoKey;
	nameMac: CryptoKey;
	nameEnc: CryptoKey;
	check: CryptoKey;
}

function subtle(): SubtleCrypto {
	const c = globalThis.crypto;
	if (!c?.subtle) throw new Error("WebCrypto (crypto.subtle) is not available");
	return c.subtle;
}

function randomBytes(n: number): Bytes {
	const out = new Uint8Array(n);
	globalThis.crypto.getRandomValues(out);
	return out;
}

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

function utf8(s: string): Bytes {
	return new Uint8Array(enc.encode(s));
}

function concat(...parts: Uint8Array[]): Bytes {
	let len = 0;
	for (const p of parts) len += p.length;
	const out = new Uint8Array(len);
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
	return diff === 0;
}

export async function deriveFolderKeys(
	password: string,
	keyId: Uint8Array,
	kdf: { iterations: number; salt: Uint8Array },
): Promise<FolderKeys> {
	const s = subtle();
	const pwKey = await s.importKey("raw", utf8(password), "PBKDF2", false, ["deriveBits"]);
	const master = await s.deriveBits(
		{ name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(kdf.salt), iterations: kdf.iterations },
		pwKey,
		256,
	);
	const hkdf = await s.importKey("raw", master, "HKDF", false, ["deriveKey"]);
	const sub = (info: string, alg: AesKeyGenParams | HmacKeyGenParams, usages: KeyUsage[]) =>
		s.deriveKey(
			{ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: utf8(info) },
			hkdf,
			alg,
			false,
			usages,
		);
	const [content, nameMac, nameEnc, check] = await Promise.all([
		sub("cds/content/v1", { name: "AES-GCM", length: 256 }, ["encrypt", "decrypt"]),
		sub("cds/name-mac/v1", { name: "HMAC", hash: "SHA-256", length: 256 }, ["sign"]),
		sub("cds/name-enc/v1", { name: "AES-CTR", length: 256 }, ["encrypt", "decrypt"]),
		sub("cds/check/v1", { name: "AES-GCM", length: 256 }, ["encrypt", "decrypt"]),
	]);
	return { keyId: new Uint8Array(keyId), content, nameMac, nameEnc, check };
}

function checkPlaintext(keyId: string): Bytes {
	return utf8(CHECK_PREFIX + keyId);
}

export async function createKeyFile(
	password: string,
	opts: { iterations?: number; rotation?: KeyFileRotation | null } = {},
): Promise<{ keyFile: FolderKeyFile; keys: FolderKeys }> {
	if (!password) throw new Error("Password must not be empty");
	const iterations = opts.iterations ?? DEFAULT_PBKDF2_ITERATIONS;
	const keyIdBytes = randomBytes(KEY_ID_BYTES);
	const salt = randomBytes(SALT_BYTES);
	const keyId = base32Encode(keyIdBytes);
	const keys = await deriveFolderKeys(password, keyIdBytes, { iterations, salt });

	const nonce = randomBytes(NONCE_BYTES);
	const ct = await subtle().encrypt(
		{ name: "AES-GCM", iv: nonce, additionalData: utf8(KEY_FILE_FORMAT) },
		keys.check,
		checkPlaintext(keyId),
	);

	const keyFile: FolderKeyFile = {
		format: KEY_FILE_FORMAT,
		version: KEY_FILE_VERSION,
		keyId,
		kdf: { name: "PBKDF2-SHA256", iterations, salt: base64Encode(salt) },
		check: { nonce: base64Encode(nonce), ciphertext: base64Encode(new Uint8Array(ct)) },
		rotation: opts.rotation ?? null,
	};
	return { keyFile, keys };
}

export function serializeKeyFile(keyFile: FolderKeyFile): string {
	return JSON.stringify(keyFile, null, "\t") + "\n";
}

export function parseKeyFile(text: string): FolderKeyFile {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		throw new KeyFileFormatError("not JSON");
	}
	return parseKeyFileObject(raw, true) as FolderKeyFile;
}

function parseKeyFileObject(raw: unknown, allowRotation: boolean): FolderKeyFile | Omit<FolderKeyFile, "rotation"> {
	if (!raw || typeof raw !== "object") throw new KeyFileFormatError("not an object");
	const o = raw as Record<string, unknown>;
	if (o.format !== KEY_FILE_FORMAT) throw new KeyFileFormatError("wrong format marker");
	if (o.version !== KEY_FILE_VERSION) {
		throw new KeyFileFormatError(`unsupported version ${String(o.version)}; update the plugin`);
	}
	if (typeof o.keyId !== "string") throw new KeyFileFormatError("missing keyId");
	const keyIdBytes = base32Decode(o.keyId);
	if (keyIdBytes.length !== KEY_ID_BYTES) throw new KeyFileFormatError("bad keyId length");

	const kdf = o.kdf as Record<string, unknown> | undefined;
	if (!kdf || kdf.name !== "PBKDF2-SHA256") throw new KeyFileFormatError("unsupported KDF");
	if (typeof kdf.iterations !== "number" || !Number.isInteger(kdf.iterations) || kdf.iterations < 1) {
		throw new KeyFileFormatError("bad iterations");
	}
	if (typeof kdf.salt !== "string") throw new KeyFileFormatError("missing salt");

	const check = o.check as Record<string, unknown> | undefined;
	if (!check || typeof check.nonce !== "string" || typeof check.ciphertext !== "string") {
		throw new KeyFileFormatError("missing check value");
	}

	const base = {
		format: KEY_FILE_FORMAT as typeof KEY_FILE_FORMAT,
		version: KEY_FILE_VERSION,
		keyId: o.keyId,
		kdf: { name: "PBKDF2-SHA256" as const, iterations: kdf.iterations, salt: kdf.salt },
		check: { nonce: check.nonce, ciphertext: check.ciphertext },
	};
	if (!allowRotation) return base;

	let rotation: KeyFileRotation | null = null;
	if (o.rotation !== null && o.rotation !== undefined) {
		const r = o.rotation as Record<string, unknown>;
		if (typeof r.fromKeyId !== "string") throw new KeyFileFormatError("bad rotation");
		rotation = { fromKeyId: r.fromKeyId };
		if (r.previous !== undefined) rotation.previous = parseKeyFileObject(r.previous, false);
		if (r.toPlaintext === true) rotation.toPlaintext = true;
	}
	return { ...base, rotation };
}

// Derive keys from the password and verify them against the key file's check
// value. A wrong password fails the GCM tag → WrongPasswordError.
export async function unlockKeyFile(keyFile: Omit<FolderKeyFile, "rotation">, password: string): Promise<FolderKeys> {
	const keys = await deriveFolderKeys(password, base32Decode(keyFile.keyId), {
		iterations: keyFile.kdf.iterations,
		salt: base64Decode(keyFile.kdf.salt),
	});
	let pt: ArrayBuffer;
	try {
		pt = await subtle().decrypt(
			{ name: "AES-GCM", iv: base64Decode(keyFile.check.nonce), additionalData: utf8(KEY_FILE_FORMAT) },
			keys.check,
			base64Decode(keyFile.check.ciphertext),
		);
	} catch {
		throw new WrongPasswordError();
	}
	if (!equalBytes(new Uint8Array(pt), checkPlaintext(keyFile.keyId))) throw new WrongPasswordError();
	return keys;
}

// ---------- content ----------

function contentAad(header: Uint8Array, plainPath: string): Bytes {
	return concat(header, utf8(plainPath));
}

export async function encryptContent(keys: FolderKeys, plainPath: string, plaintext: Uint8Array): Promise<Bytes> {
	const nonce = randomBytes(NONCE_BYTES);
	const header = concat(MAGIC, new Uint8Array([CONTENT_VERSION]), keys.keyId, nonce);
	const ct = await subtle().encrypt(
		{ name: "AES-GCM", iv: nonce, additionalData: contentAad(header, plainPath) },
		keys.content,
		new Uint8Array(plaintext),
	);
	return concat(header, new Uint8Array(ct));
}

export function isEncryptedContent(data: Uint8Array): boolean {
	return data.length >= CONTENT_OVERHEAD_BYTES && equalBytes(data.subarray(0, MAGIC.length), MAGIC);
}

// keyId of an encrypted blob (base32), or null if the header is not ours.
export function contentKeyId(data: Uint8Array): string | null {
	if (!isEncryptedContent(data)) return null;
	return base32Encode(data.subarray(MAGIC.length + 1, MAGIC.length + 1 + KEY_ID_BYTES));
}

export async function decryptContent(keys: FolderKeys, plainPath: string, data: Uint8Array): Promise<Bytes> {
	if (!isEncryptedContent(data)) throw new DecryptError(plainPath);
	const version = data[MAGIC.length];
	if (version !== CONTENT_VERSION) {
		throw new Error(`Unsupported encrypted file version ${String(version)} for ${plainPath}; update the plugin`);
	}
	const keyId = data.subarray(MAGIC.length + 1, MAGIC.length + 1 + KEY_ID_BYTES);
	if (!equalBytes(keyId, keys.keyId)) throw new KeyIdMismatchError();
	const header = data.subarray(0, CONTENT_HEADER_BYTES);
	const nonce = data.subarray(MAGIC.length + 1 + KEY_ID_BYTES, CONTENT_HEADER_BYTES);
	try {
		const pt = await subtle().decrypt(
			{ name: "AES-GCM", iv: new Uint8Array(nonce), additionalData: contentAad(header, plainPath) },
			keys.content,
			new Uint8Array(data.subarray(CONTENT_HEADER_BYTES)),
		);
		return new Uint8Array(pt);
	} catch {
		throw new DecryptError(plainPath);
	}
}

// ---------- names ----------
//
// SIV-style deterministic encryption from WebCrypto primitives:
//   iv = HMAC-SHA256(k_mac, parentPath "/" name)[0..16]
//   ct = AES-256-CTR(k_enc, counter=iv, name)
//   segment = base32lower(keyTag ‖ iv ‖ ct)
// Same (parent, name) → same segment on every device; decrypt re-derives the
// MAC and compares it to iv, so a forged or moved segment fails.

function keyTag(keys: FolderKeys): Bytes {
	return keys.keyId.slice(0, KEY_TAG_BYTES);
}

async function nameIv(keys: FolderKeys, parentPlainPath: string, name: string): Promise<Bytes> {
	const mac = await subtle().sign("HMAC", keys.nameMac, utf8(`${parentPlainPath}/${name}`));
	return new Uint8Array(mac).slice(0, NAME_IV_BYTES);
}

export async function encryptName(keys: FolderKeys, parentPlainPath: string, name: string): Promise<string> {
	if (!name || name.includes("/")) throw new Error(`Invalid path segment: ${name}`);
	const nameBytes = utf8(name);
	if (nameBytes.length > MAX_NAME_BYTES) throw new NameTooLongError(name);
	const iv = await nameIv(keys, parentPlainPath, name);
	const ct = await subtle().encrypt({ name: "AES-CTR", counter: iv, length: 64 }, keys.nameEnc, nameBytes);
	return base32Encode(concat(keyTag(keys), iv, new Uint8Array(ct)));
}

// True when the segment carries this key generation's tag. Cheap pre-filter;
// decryptName still authenticates.
export function hasKeyTag(keys: FolderKeys, segment: string): boolean {
	let raw: Bytes;
	try {
		raw = base32Decode(segment);
	} catch {
		return false;
	}
	return raw.length > NAME_OVERHEAD_BYTES && equalBytes(raw.subarray(0, KEY_TAG_BYTES), keyTag(keys));
}

export async function decryptName(keys: FolderKeys, parentPlainPath: string, segment: string): Promise<string> {
	let raw: Bytes;
	try {
		raw = base32Decode(segment);
	} catch {
		throw new DecryptError(`name ${segment}`);
	}
	if (raw.length <= NAME_OVERHEAD_BYTES) throw new DecryptError(`name ${segment}`);
	if (!equalBytes(raw.subarray(0, KEY_TAG_BYTES), keyTag(keys))) throw new KeyIdMismatchError();
	const iv = raw.slice(KEY_TAG_BYTES, NAME_OVERHEAD_BYTES);
	const ct = raw.slice(NAME_OVERHEAD_BYTES);
	const pt = await subtle().decrypt({ name: "AES-CTR", counter: iv, length: 64 }, keys.nameEnc, ct);
	let name: string;
	try {
		name = dec.decode(pt);
	} catch {
		throw new DecryptError(`name ${segment}`);
	}
	const expected = await nameIv(keys, parentPlainPath, name);
	if (!equalBytes(expected, iv)) throw new DecryptError(`name ${segment}`);
	return name;
}

// ---------- encodings ----------

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

export function base32Encode(data: Uint8Array): string {
	let out = "";
	let bits = 0;
	let value = 0;
	for (const byte of data) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			out += B32[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += B32[(value << (5 - bits)) & 31];
	return out;
}

export function base32Decode(s: string): Bytes {
	const out: number[] = [];
	let bits = 0;
	let value = 0;
	for (const ch of s) {
		const idx = B32.indexOf(ch);
		if (idx === -1) throw new Error(`Invalid base32 character: ${ch}`);
		value = ((value << 5) | idx) & 0xffff;
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	// Leftover bits must be zero padding, otherwise the string isn't canonical
	if (bits >= 5 || (value & ((1 << bits) - 1)) !== 0) throw new Error("Non-canonical base32");
	return new Uint8Array(out);
}

export function base64Encode(data: Uint8Array): string {
	let s = "";
	for (const b of data) s += String.fromCharCode(b);
	return btoa(s);
}

export function base64Decode(s: string): Bytes {
	const bin = atob(s);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}
