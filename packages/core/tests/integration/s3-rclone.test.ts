// Integration tests against a real `rclone serve s3` (scripts/integration-s3.sh).
// Skipped unless CDS_IT_S3_ENDPOINT is set, so plain `npm test` stays fast.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { S3Provider } from "../../src/providers/s3/s3-provider";
import { SyncEngine } from "../../src/sync/sync-engine";
import type { SyncStateStore } from "../../src/sync/sync-state";
import { MULTIPART_THRESHOLD_BYTES } from "../../src/util/constants";
import { isEncryptedContent } from "../../src/crypto/folder-crypto";
import { FakeLocalFs, FakeUI, makeState } from "../helpers/fakes";
import { NodeHttpClient } from "./node-http-client";
import { DOMParser as LinkedomDOMParser } from "linkedom";

// S3Api parses listings with DOMParser, which browsers and Obsidian provide
// and Node doesn't.
(globalThis as { DOMParser?: unknown }).DOMParser ??= LinkedomDOMParser;

const ENDPOINT = process.env.CDS_IT_S3_ENDPOINT;
const ROOT = process.env.CDS_IT_S3_ROOT;
const CREDS = { accessKey: "it-access", secretKey: "it-secret", region: "us-east-1" };
const FAST = { iterations: 1000 };
const http = new NodeHttpClient();
const text = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : undefined);

// Like a real vault: a file's parent folders exist as folders too. (The unit
// fakes skip this; real S3 synthesizes folders from keys, so without it every
// pass would "download" the missing folders.)
class VaultLikeFs extends FakeLocalFs {
	private addParents(path: string): void {
		const parts = path.split("/");
		for (let i = 1; i < parts.length; i++) this.folders.add(parts.slice(0, i).join("/"));
	}
	override setFile(path: string, body: string, mtimeMs: number): void {
		this.addParents(path);
		super.setFile(path, body, mtimeMs);
	}
	override async writeFile(root: string, relPath: string, content: Uint8Array): Promise<void> {
		this.addParents(relPath);
		await super.writeFile(root, relPath, content);
	}
}

let seq = 0;
async function newBucket(): Promise<string> {
	const name = `cds-it-${process.pid}-${seq++}`;
	await new S3Provider({ endpoint: ENDPOINT!, bucket: name, ...CREDS }, http).createBucket(name);
	return name;
}

interface Device {
	fs: FakeLocalFs;
	store: SyncStateStore;
	ui: FakeUI;
	engine: SyncEngine;
	password: string | null;
	// Read by the engine on every pass, like the plugin's settings list
	folders: string[];
}

function device(bucket: string, opts: { password?: string | null; folders?: string[]; firstSync?: boolean } = {}): Device {
	const fs = new VaultLikeFs();
	const { store } = makeState([], opts.firstSync === false ? 1000 : 0);
	const ui = new FakeUI();
	const provider = new S3Provider({ endpoint: ENDPOINT!, bucket, ...CREDS }, http);
	const dev: Device = {
		fs, store, ui,
		password: opts.password ?? null,
		folders: [...(opts.folders ?? [])],
		engine: undefined as unknown as SyncEngine,
	};
	dev.engine = new SyncEngine(fs, "", provider, store, ui, {
		conflictStrategy: "prompt",
		excludePatterns: [],
		encryption: { folders: dev.folders, passwordFor: () => dev.password },
	});
	return dev;
}

// Files as rclone stored them on disk: path relative to the bucket → bytes
function onDisk(bucket: string): Map<string, Buffer> {
	const out = new Map<string, Buffer>();
	const walk = (dir: string, rel: string) => {
		for (const name of readdirSync(dir)) {
			const abs = join(dir, name);
			const r = rel ? `${rel}/${name}` : name;
			if (statSync(abs).isDirectory()) walk(abs, r);
			else out.set(r, readFileSync(abs));
		}
	};
	walk(join(ROOT!, bucket), "");
	return out;
}

const quiet = (r: { uploaded: number; downloaded: number; deleted: number; errors: number }) =>
	[r.uploaded, r.downloaded, r.deleted, r.errors];

describe.skipIf(!ENDPOINT || !ROOT)("rclone serve s3 integration", () => {
	it("round-trips awkward key names between two devices", async () => {
		const bucket = await newBucket();
		const names = [
			"plain.md",
			"with space.md",
			"Ünïcødé 日本語 🌙.md",
			"reserved (1) [2] {3} !'*&+=,;@#$%.md",
			"deep/nested/folder name/x.md",
		];
		const a = device(bucket);
		for (const n of names) a.fs.setFile(n, `body of ${n}`, Date.now());
		const ra = await a.engine.sync();
		expect(ra.errors).toBe(0);
		expect(ra.uploaded).toBe(names.length + 3); // + deep, deep/nested, deep/nested/folder name

		const b = device(bucket);
		const rb = await b.engine.sync();
		expect(rb.failures).toEqual([]);
		for (const n of names) expect(text(b.fs.files.get(n)?.bytes)).toBe(`body of ${n}`);

		expect(quiet(await a.engine.sync())).toEqual([0, 0, 0, 0]);
		expect(quiet(await b.engine.sync())).toEqual([0, 0, 0, 0]);
	});

	it("propagates edits, deletes and empty folders", async () => {
		const bucket = await newBucket();
		const a = device(bucket);
		a.fs.setFile("n.md", "v1", Date.now());
		a.fs.setFile("gone.md", "bye", Date.now());
		a.fs.folders.add("Empty");
		await a.engine.sync();
		const b = device(bucket);
		await b.engine.sync();
		expect(b.fs.folders.has("Empty")).toBe(true);

		a.fs.setFile("n.md", "v2", Date.now() + 1000);
		a.fs.files.delete("gone.md");
		const ra = await a.engine.sync();
		expect([ra.uploaded, ra.deleted]).toEqual([1, 1]);

		const rb = await b.engine.sync();
		expect(rb.failures).toEqual([]);
		expect(text(b.fs.files.get("n.md")?.bytes)).toBe("v2");
		expect(b.fs.files.has("gone.md")).toBe(false);
	});

	it("uploads and downloads a multipart-sized file, then stays quiet", async () => {
		const bucket = await newBucket();
		const big = new Uint8Array(MULTIPART_THRESHOLD_BYTES + 1024 * 1024);
		for (let i = 0; i < big.length; i += 4096) big[i] = i & 0xff;
		const a = device(bucket);
		a.fs.files.set("big.bin", { bytes: big, mtimeMs: Date.now() }); // top level: no parents
		expect((await a.engine.sync()).errors).toBe(0);
		expect(onDisk(bucket).get("big.bin")?.length).toBe(big.length);

		const b = device(bucket);
		expect((await b.engine.sync()).errors).toBe(0);
		expect(b.fs.files.get("big.bin")?.bytes.length).toBe(big.length);
		expect(quiet(await a.engine.sync())).toEqual([0, 0, 0, 0]);
		expect(quiet(await b.engine.sync())).toEqual([0, 0, 0, 0]);
	}, 120_000);

	it("encrypted folder lifecycle: only ciphertext on disk, devices lock and converge", async () => {
		const bucket = await newBucket();
		const secret = "SECRET-MARKER-7f3a";
		const files: Record<string, string> = {
			"Journal/2026-03-04 talk with doctor.md": `${secret} one`,
			"Journal/Health/(meds) list.md": `${secret} two`,
		};

		// Plaintext first, as an existing vault would be
		const a = device(bucket);
		for (const [p, body] of Object.entries(files)) a.fs.setFile(p, body, Date.now());
		a.fs.setFile("public.md", "public", Date.now());
		await a.engine.sync();

		// What the plugin does: store the password, add the folder, enable
		a.password = "pw1";
		a.folders.push("Journal");
		await a.engine.enableEncryption("Journal", "pw1", FAST);
		const disk = onDisk(bucket);
		for (const [rel, bytes] of disk) {
			if (!rel.startsWith("Journal/")) continue;
			expect(rel).not.toMatch(/doctor|Health|meds/);
			expect(bytes.includes(secret)).toBe(false);
			if (!rel.endsWith(".cds-folder-key.json") && !rel.endsWith(".keep")) {
				expect(isEncryptedContent(new Uint8Array(bytes))).toBe(true);
			}
		}
		expect(text(disk.get("public.md"))).toBe("public");
		expect(quiet(await a.engine.sync())).toEqual([0, 0, 0, 0]);

		// A device without the password sees nothing of Journal
		const nopw = device(bucket);
		const rn = await nopw.engine.sync();
		expect(rn.lockedFolders.map((l) => l.reason)).toEqual(["No password for Journal"]);
		expect([...nopw.fs.files.keys()]).toEqual(["public.md"]);

		// A device with it gets plaintext
		const b = device(bucket, { folders: ["Journal"], password: "pw1" });
		expect((await b.engine.sync()).errors).toBe(0);
		for (const [p, body] of Object.entries(files)) expect(text(b.fs.files.get(p)?.bytes)).toBe(body);

		// Password change: b locks, then converges on the new one
		await a.engine.changeEncryptionPassword("Journal", "pw1", "pw2", FAST);
		a.password = "pw2";
		const locked = await b.engine.sync();
		expect(locked.lockedFolders.map((l) => l.reason)).toEqual(["Wrong password for Journal"]);
		b.password = "pw2";
		const rb = await b.engine.sync();
		expect([rb.deleted, rb.errors]).toEqual([0, 0]);
		for (const [p, body] of Object.entries(files)) expect(text(b.fs.files.get(p)?.bytes)).toBe(body);

		// An edit on b reaches a through the encrypted path
		b.fs.setFile("Journal/Health/(meds) list.md", `${secret} edited`, Date.now() + 5000);
		expect((await b.engine.sync()).uploaded).toBe(1);
		const ra = await a.engine.sync();
		expect(ra.failures).toEqual([]);
		expect(text(a.fs.files.get("Journal/Health/(meds) list.md")?.bytes)).toBe(`${secret} edited`);

		// Remove: plaintext is back on disk, key file gone
		await a.engine.removeEncryption("Journal", "pw2");
		const after = onDisk(bucket);
		expect(after.has("Journal/.cds-folder-key.json")).toBe(false);
		expect(text(after.get("Journal/2026-03-04 talk with doctor.md"))).toBe(`${secret} one`);
	}, 60_000);
});
