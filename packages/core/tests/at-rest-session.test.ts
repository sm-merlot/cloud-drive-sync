import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AtRestLockedError, AtRestSession, type LockReason } from "../src/sync/at-rest-session";
import { WrongPasswordError, createKeyFile, type FolderKeyFile } from "../src/crypto/folder-crypto";
import { FakeLocalFs } from "./helpers/fakes";

const FOLDER = "Journal";
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

// Everything on "disk": no plaintext may ever appear here
function diskText(fs: FakeLocalFs): string {
	return [...fs.files].map(([p, f]) => `${p}\n${dec(f.bytes)}`).join("\n") + [...fs.folders].join("\n");
}

describe("AtRestSession", () => {
	let fs: FakeLocalFs;
	let keyFile: FolderKeyFile;
	let locks: LockReason[];
	let session: AtRestSession;

	beforeEach(async () => {
		vi.useFakeTimers();
		fs = new FakeLocalFs();
		fs.folders.add(FOLDER);
		keyFile = (await createKeyFile("pw1", { iterations: 1000, mode: "at-rest" })).keyFile;
		locks = [];
		session = new AtRestSession(fs, "", FOLDER, keyFile, { idleMs: 60_000, onLock: (r) => locks.push(r) });
	});
	afterEach(() => vi.useRealTimers());

	it("refuses a transit key file", async () => {
		const transit = (await createKeyFile("pw1", { iterations: 1000 })).keyFile;
		expect(() => new AtRestSession(fs, "", FOLDER, transit)).toThrow("not an at-rest folder");
	});

	it("needs the right password, and everything throws while locked", async () => {
		await expect(session.unlock("nope")).rejects.toBeInstanceOf(WrongPasswordError);
		expect(session.unlocked).toBe(false);
		await expect(session.list()).rejects.toBeInstanceOf(AtRestLockedError);
		await expect(session.read("Journal/a.md")).rejects.toBeInstanceOf(AtRestLockedError);
		await expect(session.write("Journal/a.md", enc("x"))).rejects.toBeInstanceOf(AtRestLockedError);
		await session.unlock("pw1");
		expect(session.unlocked).toBe(true);
	});

	it("writes, lists and reads notes without plaintext ever reaching disk", async () => {
		await session.unlock("pw1");
		await session.createFolder("Journal/Health");
		await session.createNote("Journal/Health/2026-03-04 doctor.md", "SECRET body");
		await session.write("Journal/top.md", enc("SECRET top"));

		const { nodes, unreadable, plaintext } = await session.list();
		expect(nodes.map((n) => [n.plainPath, n.isFile])).toEqual([
			["Journal/Health", false],
			["Journal/Health/2026-03-04 doctor.md", true],
			["Journal/top.md", true],
		]);
		expect([unreadable, plaintext]).toEqual([[], []]);
		expect(dec(await session.read("Journal/Health/2026-03-04 doctor.md"))).toBe("SECRET body");

		const disk = diskText(fs);
		expect(disk).not.toMatch(/SECRET|doctor|Health|top\.md/);
		for (const p of fs.files.keys()) expect(p).toMatch(/^Journal\/([a-z2-7]+\/)*[a-z2-7]+\.cdse$/);
	});

	it("maps between disk and plain paths", async () => {
		await session.unlock("pw1");
		const disk = await session.diskPathOf("Journal/x.md", true);
		expect(disk).toMatch(/\.cdse$/);
		expect(await session.plainPathOf(disk)).toBe("Journal/x.md");
		await expect(session.plainPathOf("Journal/plain.md")).rejects.toThrow();
	});

	it("refuses to create over an existing note or folder", async () => {
		await session.unlock("pw1");
		await session.createNote("Journal/a.md");
		await expect(session.createNote("Journal/a.md")).rejects.toThrow("already exists");
		await session.createFolder("Journal/D");
		await expect(session.createFolder("Journal/D")).rejects.toThrow("already exists");
	});

	it("renames a note: new ciphertext under the new name, old file gone", async () => {
		await session.unlock("pw1");
		await session.write("Journal/old.md", enc("body"));
		const before = [...fs.files.keys()];
		await session.rename("Journal/old.md", "Journal/new name.md");
		expect([...fs.files.keys()]).toHaveLength(1);
		expect(fs.files.has(before[0]!)).toBe(false);
		expect(dec(await session.read("Journal/new name.md"))).toBe("body");
		await expect(session.read("Journal/old.md")).rejects.toThrow();
	});

	it("moves a folder with everything under it", async () => {
		await session.unlock("pw1");
		await session.createFolder("Journal/A");
		await session.createFolder("Journal/A/Deep");
		await session.write("Journal/A/x.md", enc("x"));
		await session.write("Journal/A/Deep/y.md", enc("y"));
		await session.createFolder("Journal/B");
		await session.rename("Journal/A", "Journal/B/A2");

		const { nodes } = await session.list();
		expect(nodes.map((n) => n.plainPath)).toEqual([
			"Journal/B", "Journal/B/A2", "Journal/B/A2/Deep", "Journal/B/A2/Deep/y.md", "Journal/B/A2/x.md",
		]);
		expect(dec(await session.read("Journal/B/A2/Deep/y.md"))).toBe("y");
	});

	it("rename refuses collisions and moving a folder into itself", async () => {
		await session.unlock("pw1");
		await session.write("Journal/a.md", enc("a"));
		await session.write("Journal/b.md", enc("b"));
		await expect(session.rename("Journal/a.md", "Journal/b.md")).rejects.toThrow("already exists");
		await session.createFolder("Journal/F");
		await expect(session.rename("Journal/F", "Journal/F/G")).rejects.toThrow("into itself");
	});

	it("deletes files and folders recursively", async () => {
		await session.unlock("pw1");
		await session.createFolder("Journal/F");
		await session.write("Journal/F/x.md", enc("x"));
		await session.write("Journal/keep.md", enc("k"));
		await session.delete("Journal/F");
		expect((await session.list()).nodes.map((n) => n.plainPath)).toEqual(["Journal/keep.md"]);
	});

	it("reports plaintext leaks and unreadable leftovers instead of hiding them", async () => {
		await session.unlock("pw1");
		await session.write("Journal/ok.md", enc("ok"));
		fs.setFile("Journal/Leaked plaintext.md", "oops", 1);
		fs.setFile("Journal/zzzz.cdse", "junk", 1);
		fs.setFile("Journal/.DS_Store", "x", 1);
		const { nodes, plaintext, unreadable } = await session.list();
		expect(nodes.map((n) => n.plainPath)).toEqual(["Journal/ok.md"]);
		expect(plaintext).toEqual(["Journal/Leaked plaintext.md"]);
		expect(unreadable).toEqual(["Journal/zzzz.cdse"]);
	});

	it("auto-locks after the idle time; touch() pushes it back", async () => {
		await session.unlock("pw1");
		vi.advanceTimersByTime(50_000);
		session.touch();
		vi.advanceTimersByTime(50_000);
		expect(session.unlocked).toBe(true);
		await vi.advanceTimersByTimeAsync(11_000);
		expect(session.unlocked).toBe(false);
		expect(locks).toEqual(["idle"]);
	});

	it("flushes pending saves before dropping the keys", async () => {
		await session.unlock("pw1");
		let saved = false;
		session.addFlusher(async () => {
			await session.write("Journal/draft.md", enc("unsaved edit"));
			saved = true;
		});
		await session.lock("background");
		expect(saved).toBe(true);
		expect(locks).toEqual(["background"]);
		await session.unlock("pw1");
		expect(dec(await session.read("Journal/draft.md"))).toBe("unsaved edit");
	});

	it("a failing flusher still locks", async () => {
		await session.unlock("pw1");
		session.addFlusher(async () => { throw new Error("disk full"); });
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		await session.lock("manual");
		expect(session.unlocked).toBe(false);
		err.mockRestore();
	});

	it("locks when the key file's generation changes (password changed elsewhere)", async () => {
		await session.unlock("pw1");
		await session.updateKeyFile({ ...keyFile }); // same generation: stays unlocked
		expect(session.unlocked).toBe(true);
		const newer = (await createKeyFile("pw2", { iterations: 1000, mode: "at-rest" })).keyFile;
		await session.updateKeyFile(newer);
		expect(session.unlocked).toBe(false);
		expect(locks).toEqual(["key-changed"]);
		await expect(session.unlock("pw1")).rejects.toBeInstanceOf(WrongPasswordError);
		await session.unlock("pw2");
	});

	it("resolves [[links]] by title, preferring the same folder", async () => {
		await session.unlock("pw1");
		await session.createFolder("Journal/A");
		await session.createFolder("Journal/B");
		await session.write("Journal/A/Meds.md", enc(""));
		await session.write("Journal/B/Meds.md", enc(""));
		await session.write("Journal/Plan.md", enc(""));
		expect(await session.resolveLink("Plan")).toBe("Journal/Plan.md");
		expect(await session.resolveLink("meds", "Journal/B/today.md")).toBe("Journal/B/Meds.md");
		expect(await session.resolveLink("Nope")).toBeNull();
	});
});
