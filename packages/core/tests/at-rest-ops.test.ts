import { describe, it, expect, beforeEach } from "vitest";
import { convertFolderToAtRest, convertFolderToPlaintext, reencryptAtRestFolder } from "../src/sync/at-rest-ops";
import { AtRestBusyError, AtRestSession } from "../src/sync/at-rest-session";
import { createKeyFile, type FolderKeyFile, type FolderKeys } from "../src/crypto/folder-crypto";
import { FakeLocalFs } from "./helpers/fakes";

const F = "Journal";
const FAST = { iterations: 1000, mode: "at-rest" as const };
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

function plainVault(): FakeLocalFs {
	const fs = new FakeLocalFs();
	fs.folders.add(F);
	fs.folders.add(`${F}/Health`);
	fs.setFile(`${F}/a.md`, "SECRET a", 1);
	fs.setFile(`${F}/Health/b.md`, "SECRET b", 1);
	fs.setFile("outside.md", "public", 1);
	return fs;
}

async function readAll(fs: FakeLocalFs, keyFile: FolderKeyFile, pw: string): Promise<Record<string, string>> {
	const s = new AtRestSession(fs, "", F, keyFile);
	await s.unlock(pw);
	const out: Record<string, string> = {};
	for (const n of (await s.list()).nodes) if (n.isFile) out[n.plainPath] = dec(await s.read(n.plainPath));
	return out;
}

const EXPECTED = { "Journal/a.md": "SECRET a", "Journal/Health/b.md": "SECRET b" };

describe("convertFolderToAtRest", () => {
	let keyFile: FolderKeyFile;
	let keys: FolderKeys;
	beforeEach(async () => ({ keyFile, keys } = await createKeyFile("pw1", FAST)));

	it("encrypts every file and folder in place; nothing plaintext is left", async () => {
		const fs = plainVault();
		const removed: string[] = [];
		const r = await convertFolderToAtRest(fs, "", F, keys, {
			removePlaintext: async (p) => {
				removed.push(p);
				fs.files.delete(p);
			},
		});
		expect(r.converted).toBe(2);
		expect(removed.sort()).toEqual(["Journal/Health/b.md", "Journal/a.md"]);
		const names = [...fs.files.keys(), ...fs.folders].join("\n");
		expect(names).not.toMatch(/a\.md|b\.md|Health/);
		expect([...fs.files.values()].map((f) => dec(f.bytes)).join()).not.toContain("SECRET");
		expect(fs.files.has("outside.md")).toBe(true);
		expect(await readAll(fs, keyFile, "pw1")).toEqual(EXPECTED);
	});

	it("resumes after a crash: already-encrypted files are left alone", async () => {
		const fs = plainVault();
		let calls = 0;
		await expect(convertFolderToAtRest(fs, "", F, keys, {
			removePlaintext: async (p) => {
				if (++calls === 2) throw new Error("crash");
				fs.files.delete(p);
			},
		})).rejects.toThrow("crash");
		await convertFolderToAtRest(fs, "", F, keys);
		expect(await readAll(fs, keyFile, "pw1")).toEqual(EXPECTED);
		expect([...fs.files.keys()].filter((p) => p.endsWith(".md"))).toEqual(["outside.md"]);
	});
});

describe("convertFolderToPlaintext", () => {
	it("restores the plain tree", async () => {
		const { keys } = await createKeyFile("pw1", FAST);
		const fs = plainVault();
		await convertFolderToAtRest(fs, "", F, keys);
		const r = await convertFolderToPlaintext(fs, "", F, keys);
		expect(r).toEqual({ converted: 2, skipped: [] });
		expect(dec(fs.files.get("Journal/a.md")!.bytes)).toBe("SECRET a");
		expect(dec(fs.files.get("Journal/Health/b.md")!.bytes)).toBe("SECRET b");
		expect([...fs.files.keys()].some((p) => p.endsWith(".cdse"))).toBe(false);
		expect(fs.folders.has("Journal/Health")).toBe(true);
	});
});

describe("reencryptAtRestFolder", () => {
	it("moves everything to the new generation, resumably", async () => {
		const old = await createKeyFile("pw1", FAST);
		const next = await createKeyFile("pw2", FAST);
		const fs = plainVault();
		await convertFolderToAtRest(fs, "", F, old.keys);

		// crash after the first file
		const realDelete = fs.deleteFile.bind(fs);
		let n = 0;
		fs.deleteFile = async (root, p) => {
			if (++n === 2) throw new Error("crash");
			return realDelete(root, p);
		};
		await expect(reencryptAtRestFolder(fs, "", F, old.keys, next.keys)).rejects.toThrow("crash");
		fs.deleteFile = realDelete;

		const r = await reencryptAtRestFolder(fs, "", F, old.keys, next.keys);
		expect(r.skipped).toEqual([]);
		expect(await readAll(fs, next.keyFile, "pw2")).toEqual(EXPECTED);
		const leftovers = new AtRestSession(fs, "", F, next.keyFile);
		await leftovers.unlock("pw2");
		expect((await leftovers.list()).unreadable).toEqual([]);
	});

	it("reports files neither generation can read", async () => {
		const old = await createKeyFile("pw1", FAST);
		const next = await createKeyFile("pw2", FAST);
		const fs = plainVault();
		await convertFolderToAtRest(fs, "", F, old.keys);
		fs.setFile("Journal/zzzzzz.cdse", "junk", 1);
		const r = await reencryptAtRestFolder(fs, "", F, old.keys, next.keys);
		expect(r.skipped).toEqual(["Journal/zzzzzz.cdse"]);
	});
});

describe("unlock during a password change", () => {
	it("is refused while the key file carries a rotation marker", async () => {
		const { keyFile } = await createKeyFile("pw1", { ...FAST, rotation: { fromKeyId: "x" } });
		const s = new AtRestSession(new FakeLocalFs(), "", F, keyFile);
		await expect(s.unlock("pw1")).rejects.toBeInstanceOf(AtRestBusyError);
	});
});
