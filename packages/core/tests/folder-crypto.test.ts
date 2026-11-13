import { describe, it, expect } from "vitest";
import {
	CONTENT_OVERHEAD_BYTES,
	DEFAULT_PBKDF2_ITERATIONS,
	DecryptError,
	KeyFileFormatError,
	KeyIdMismatchError,
	MAX_ENCRYPTED_SEGMENT_CHARS,
	MAX_NAME_BYTES,
	NameTooLongError,
	WrongPasswordError,
	base32Decode,
	base32Encode,
	contentKeyId,
	createKeyFile,
	decryptContent,
	decryptName,
	encryptContent,
	encryptName,
	hasKeyTag,
	parseKeyFile,
	serializeKeyFile,
	unlockKeyFile,
} from "../src/crypto/folder-crypto";

// Low iteration count keeps the suite fast; the default is covered separately.
const FAST = { iterations: 1000 };

const text = (s: string) => new TextEncoder().encode(s);

describe("key file", () => {
	it("defaults to 600k PBKDF2 iterations", async () => {
		expect(DEFAULT_PBKDF2_ITERATIONS).toBe(600_000);
	});

	it("round-trips through JSON and unlocks with the right password", async () => {
		const { keyFile, keys } = await createKeyFile("correct horse", FAST);
		const parsed = parseKeyFile(serializeKeyFile(keyFile));
		expect(parsed).toEqual(keyFile);
		const unlocked = await unlockKeyFile(parsed, "correct horse");
		// Same keys: content encrypted by one decrypts with the other
		const ct = await encryptContent(keys, "Journal/a.md", text("hi"));
		expect(new TextDecoder().decode(await decryptContent(unlocked, "Journal/a.md", ct))).toBe("hi");
	});

	it("wrong password fails the check value", async () => {
		const { keyFile } = await createKeyFile("right", FAST);
		await expect(unlockKeyFile(keyFile, "wrong")).rejects.toBeInstanceOf(WrongPasswordError);
	});

	it("old password fails against a new key file (password change)", async () => {
		const { keyFile: oldFile } = await createKeyFile("old-pw", FAST);
		const { keyFile: newFile } = await createKeyFile("new-pw", FAST);
		expect(newFile.keyId).not.toBe(oldFile.keyId);
		await expect(unlockKeyFile(newFile, "old-pw")).rejects.toBeInstanceOf(WrongPasswordError);
	});

	it("check value swapped in from another key file fails", async () => {
		const { keyFile: a } = await createKeyFile("pw", FAST);
		const { keyFile: b } = await createKeyFile("pw", FAST);
		await expect(unlockKeyFile({ ...a, check: b.check }, "pw")).rejects.toBeInstanceOf(WrongPasswordError);
	});

	it("rejects empty passwords", async () => {
		await expect(createKeyFile("", FAST)).rejects.toThrow();
	});

	it("records a rotation marker", async () => {
		const { keyFile } = await createKeyFile("pw", { ...FAST, rotation: { fromKeyId: "plaintext" } });
		expect(parseKeyFile(serializeKeyFile(keyFile)).rotation).toEqual({ fromKeyId: "plaintext" });
	});

	it.each([
		["not json", "{"],
		["wrong format", JSON.stringify({ format: "x" })],
		["future version", JSON.stringify({ format: "cds-folder-key", version: 2 })],
	])("rejects malformed key files: %s", (_label, body) => {
		expect(() => parseKeyFile(body)).toThrow(KeyFileFormatError);
	});

	it("rejects an unsupported KDF", async () => {
		const { keyFile } = await createKeyFile("pw", FAST);
		const bad = JSON.stringify({ ...keyFile, kdf: { ...keyFile.kdf, name: "MD5" } });
		expect(() => parseKeyFile(bad)).toThrow(KeyFileFormatError);
	});
});

describe("content", () => {
	it("round-trips, with 49 bytes of overhead", async () => {
		const { keys } = await createKeyFile("pw", FAST);
		const pt = text("# Secret note\n\nbody");
		const ct = await encryptContent(keys, "Journal/note.md", pt);
		expect(ct.length).toBe(pt.length + CONTENT_OVERHEAD_BYTES);
		expect(CONTENT_OVERHEAD_BYTES).toBe(49);
		expect(await decryptContent(keys, "Journal/note.md", ct)).toEqual(pt);
	});

	it("round-trips empty files", async () => {
		const { keys } = await createKeyFile("pw", FAST);
		const ct = await encryptContent(keys, "J/empty.md", new Uint8Array(0));
		expect((await decryptContent(keys, "J/empty.md", ct)).length).toBe(0);
	});

	it("uses a fresh nonce per encryption", async () => {
		const { keys } = await createKeyFile("pw", FAST);
		const a = await encryptContent(keys, "J/x.md", text("same"));
		const b = await encryptContent(keys, "J/x.md", text("same"));
		expect(a).not.toEqual(b);
	});

	it("header carries the key id", async () => {
		const { keyFile, keys } = await createKeyFile("pw", FAST);
		const ct = await encryptContent(keys, "J/x.md", text("x"));
		expect(contentKeyId(ct)).toBe(keyFile.keyId);
		expect(contentKeyId(text("plain text, not ours at all, long enough to pass length check..."))).toBeNull();
	});

	it("a flipped ciphertext byte fails the tag", async () => {
		const { keys } = await createKeyFile("pw", FAST);
		const ct = await encryptContent(keys, "J/x.md", text("hello world"));
		ct[ct.length - 5]! ^= 0x01;
		await expect(decryptContent(keys, "J/x.md", ct)).rejects.toBeInstanceOf(DecryptError);
	});

	it("a flipped nonce byte fails the tag", async () => {
		const { keys } = await createKeyFile("pw", FAST);
		const ct = await encryptContent(keys, "J/x.md", text("hello world"));
		ct[25]! ^= 0x01;
		await expect(decryptContent(keys, "J/x.md", ct)).rejects.toBeInstanceOf(DecryptError);
	});

	it("a file moved to another path fails (path is AAD)", async () => {
		const { keys } = await createKeyFile("pw", FAST);
		const ct = await encryptContent(keys, "J/a.md", text("for a"));
		await expect(decryptContent(keys, "J/b.md", ct)).rejects.toBeInstanceOf(DecryptError);
	});

	it("a file from another key generation reports a key id mismatch", async () => {
		const { keys: oldKeys } = await createKeyFile("pw", FAST);
		const { keys: newKeys } = await createKeyFile("pw", FAST);
		const ct = await encryptContent(oldKeys, "J/a.md", text("old"));
		await expect(decryptContent(newKeys, "J/a.md", ct)).rejects.toBeInstanceOf(KeyIdMismatchError);
	});

	it("plaintext input is rejected, not returned", async () => {
		const { keys } = await createKeyFile("pw", FAST);
		await expect(decryptContent(keys, "J/a.md", text("x".repeat(100)))).rejects.toBeInstanceOf(DecryptError);
	});
});

describe("names", () => {
	it("round-trips, including unicode", async () => {
		const { keys } = await createKeyFile("pw", FAST);
		for (const name of ["2026-03-04 talk with doctor.md", "日記 🌙.md", "a", ".keep"]) {
			const seg = await encryptName(keys, "Journal/Health", name);
			expect(await decryptName(keys, "Journal/Health", seg)).toBe(name);
		}
	});

	it("is deterministic across key instances (other devices)", async () => {
		const { keyFile, keys } = await createKeyFile("pw", FAST);
		const other = await unlockKeyFile(parseKeyFile(serializeKeyFile(keyFile)), "pw");
		expect(await encryptName(keys, "Journal", "note.md")).toBe(await encryptName(other, "Journal", "note.md"));
	});

	it("differs per parent folder", async () => {
		const { keys } = await createKeyFile("pw", FAST);
		expect(await encryptName(keys, "Journal/a", "x.md")).not.toBe(await encryptName(keys, "Journal/b", "x.md"));
	});

	it("uses only lowercase base32 characters", async () => {
		const { keys } = await createKeyFile("pw", FAST);
		const seg = await encryptName(keys, "Journal", "Weird name (copy) #1 & ü?.md");
		expect(seg).toMatch(/^[a-z2-7]+$/);
	});

	it("a segment moved to another parent fails authentication", async () => {
		const { keys } = await createKeyFile("pw", FAST);
		const seg = await encryptName(keys, "Journal/a", "x.md");
		await expect(decryptName(keys, "Journal/b", seg)).rejects.toBeInstanceOf(DecryptError);
	});

	it("a tampered segment fails authentication", async () => {
		const { keys } = await createKeyFile("pw", FAST);
		const seg = await encryptName(keys, "Journal", "note.md");
		const last = seg[seg.length - 1] === "a" ? "b" : "a";
		const tampered = seg.slice(0, -2) + last + seg.slice(-1);
		await expect(decryptName(keys, "Journal", tampered)).rejects.toThrow();
	});

	it("junk names fail", async () => {
		const { keys } = await createKeyFile("pw", FAST);
		await expect(decryptName(keys, "Journal", "Plain Note.md")).rejects.toBeInstanceOf(DecryptError);
		await expect(decryptName(keys, "Journal", "abc")).rejects.toBeInstanceOf(DecryptError);
	});

	it("key tag identifies the generation", async () => {
		const { keys: a } = await createKeyFile("pw", FAST);
		let b = (await createKeyFile("pw", FAST)).keys;
		// 1-in-65536 chance two random key ids share a tag; regenerate if so
		while (b.keyId[0] === a.keyId[0] && b.keyId[1] === a.keyId[1]) b = (await createKeyFile("pw", FAST)).keys;
		const seg = await encryptName(a, "J", "x.md");
		expect(hasKeyTag(a, seg)).toBe(true);
		expect(hasKeyTag(b, seg)).toBe(false);
		expect(hasKeyTag(a, "Plain.md")).toBe(false);
		await expect(decryptName(b, "J", seg)).rejects.toBeInstanceOf(KeyIdMismatchError);
	});

	it("accepts names up to the limit and rejects longer ones", async () => {
		const { keys } = await createKeyFile("pw", FAST);
		const longest = "a".repeat(MAX_NAME_BYTES);
		const seg = await encryptName(keys, "J", longest);
		expect(seg.length).toBeLessThanOrEqual(MAX_ENCRYPTED_SEGMENT_CHARS);
		await expect(encryptName(keys, "J", longest + "a")).rejects.toBeInstanceOf(NameTooLongError);
		// limit is in bytes: 3-byte characters hit it sooner
		await expect(encryptName(keys, "J", "日".repeat(48))).rejects.toBeInstanceOf(NameTooLongError);
	});

	it("rejects empty segments and slashes", async () => {
		const { keys } = await createKeyFile("pw", FAST);
		await expect(encryptName(keys, "J", "")).rejects.toThrow();
		await expect(encryptName(keys, "J", "a/b")).rejects.toThrow();
	});
});

describe("base32", () => {
	it("round-trips all lengths", () => {
		for (let n = 0; n < 40; n++) {
			const bytes = new Uint8Array(n).map((_, i) => (i * 37 + n) & 0xff);
			expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
		}
	});

	it("matches RFC 4648 vectors (lowercased, unpadded)", () => {
		const enc = (s: string) => base32Encode(new TextEncoder().encode(s));
		expect(enc("f")).toBe("my");
		expect(enc("fo")).toBe("mzxq");
		expect(enc("foo")).toBe("mzxw6");
		expect(enc("foob")).toBe("mzxw6yq");
		expect(enc("fooba")).toBe("mzxw6ytb");
		expect(enc("foobar")).toBe("mzxw6ytboi");
	});

	it("rejects non-alphabet and non-canonical input", () => {
		expect(() => base32Decode("MZXQ")).toThrow();
		expect(() => base32Decode("mzxr")).toThrow(); // nonzero padding bits
		expect(() => base32Decode("m")).toThrow(); // dangling char
	});
});
