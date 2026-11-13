import { describe, it, expect } from "vitest";
import {
	AT_REST_EXTENSION,
	decryptAtRest,
	encryptAtRest,
	fromAtRestPath,
	isAtRestFile,
	toAtRestPath,
} from "../src/crypto/at-rest";
import { DecryptError, NameTooLongError, createKeyFile } from "../src/crypto/folder-crypto";

const FAST = { iterations: 1000, mode: "at-rest" as const };

describe("at-rest paths", () => {
	it("encrypts every segment, adds .cdse to files, and round-trips", async () => {
		const { keys } = await createKeyFile("pw", FAST);
		const file = await toAtRestPath(keys, "Journal", "Journal/Health/2026-03-04 doctor.md", true);
		expect(file).toMatch(/^Journal\/[a-z2-7]+\/[a-z2-7]+\.cdse$/);
		expect(file).not.toMatch(/Health|doctor/);
		expect(await fromAtRestPath(keys, "Journal", file)).toEqual({ plainPath: "Journal/Health/2026-03-04 doctor.md", isFile: true });

		const dir = await toAtRestPath(keys, "Journal", "Journal/Health", false);
		expect(file.startsWith(dir + "/")).toBe(true);
		expect(await fromAtRestPath(keys, "Journal", dir)).toEqual({ plainPath: "Journal/Health", isFile: false });
		expect(AT_REST_EXTENSION).toBe("cdse");
		expect(isAtRestFile(file)).toBe(true);
		expect(isAtRestFile(dir)).toBe(false);
	});

	it("is deterministic across devices", async () => {
		const a = await createKeyFile("pw", FAST);
		const { unlockKeyFile } = await import("../src/crypto/folder-crypto");
		const b = await unlockKeyFile(a.keyFile, "pw");
		expect(await toAtRestPath(a.keys, "J", "J/x.md", true)).toBe(await toAtRestPath(b, "J", "J/x.md", true));
	});

	it("rejects paths outside the folder, junk, and other key generations", async () => {
		const { keys } = await createKeyFile("pw", FAST);
		const { keys: other } = await createKeyFile("pw", FAST);
		await expect(toAtRestPath(keys, "Journal", "Other/x.md", true)).rejects.toThrow("not inside");
		await expect(fromAtRestPath(keys, "Journal", "Journal/plain note.md")).rejects.toBeInstanceOf(DecryptError);
		const p = await toAtRestPath(keys, "Journal", "Journal/x.md", true);
		await expect(fromAtRestPath(other, "Journal", p)).rejects.toThrow();
	});

	it("counts the .cdse suffix against the segment limit", async () => {
		const { keys } = await createKeyFile("pw", FAST);
		// 141 bytes fits as a folder name but not as a file name with ".cdse"
		const name = "a".repeat(141);
		await expect(toAtRestPath(keys, "J", `J/${name}`, false)).resolves.toBeTruthy();
		await expect(toAtRestPath(keys, "J", `J/${name}`, true)).rejects.toBeInstanceOf(NameTooLongError);
		const ok = await toAtRestPath(keys, "J", `J/${"a".repeat(138)}`, true);
		expect(ok.split("/").pop()!.length).toBeLessThanOrEqual(255);
	});
});

describe("at-rest content", () => {
	it("round-trips and binds to the plaintext path", async () => {
		const { keys } = await createKeyFile("pw", FAST);
		const ct = await encryptAtRest(keys, "J/a.md", new TextEncoder().encode("secret"));
		expect(new TextDecoder().decode(await decryptAtRest(keys, "J/a.md", ct))).toBe("secret");
		await expect(decryptAtRest(keys, "J/b.md", ct)).rejects.toBeInstanceOf(DecryptError);
	});
});
