import { describe, it, expect } from "vitest";
import { getParentPath, getFileName, shouldExclude, guessMimeType } from "../src/util/path";

describe("getParentPath", () => {
	it("top-level file", () => {
		expect(getParentPath("file.md")).toBe("");
	});

	it("nested file", () => {
		expect(getParentPath("folder/sub/file.md")).toBe("folder/sub");
	});

	it("one level deep", () => {
		expect(getParentPath("folder/file.md")).toBe("folder");
	});
});

describe("getFileName", () => {
	it("top-level file", () => {
		expect(getFileName("file.md")).toBe("file.md");
	});

	it("nested file", () => {
		expect(getFileName("folder/sub/file.md")).toBe("file.md");
	});
});

describe("shouldExclude", () => {
	it("excludes .obsidian/**", () => {
		expect(shouldExclude(".obsidian/plugins/foo/main.js", [".obsidian/**"])).toBe(true);
	});

	it("excludes .obsidian itself", () => {
		expect(shouldExclude(".obsidian", [".obsidian/**"])).toBe(true);
	});

	it("does not exclude normal files", () => {
		expect(shouldExclude("notes/daily.md", [".obsidian/**"])).toBe(false);
	});

	it("excludes by extension", () => {
		expect(shouldExclude("image.tmp", ["*.tmp"])).toBe(true);
	});

	it("does not false-positive extension match", () => {
		expect(shouldExclude("notes.md", ["*.tmp"])).toBe(false);
	});

	it("handles multiple patterns", () => {
		expect(shouldExclude(".trash/old.md", [".obsidian/**", ".trash/**"])).toBe(true);
	});

	it("exact match", () => {
		expect(shouldExclude("secret.env", ["secret.env"])).toBe(true);
	});
});

describe("guessMimeType", () => {
	it("markdown", () => {
		expect(guessMimeType("note.md")).toBe("text/markdown");
	});

	it("png", () => {
		expect(guessMimeType("image.png")).toBe("image/png");
	});

	it("unknown extension", () => {
		expect(guessMimeType("file.xyz")).toBe("application/octet-stream");
	});

	it("no extension", () => {
		expect(guessMimeType("README")).toBe("application/octet-stream");
	});

	it("nested path", () => {
		expect(guessMimeType("attachments/photo.jpg")).toBe("image/jpeg");
	});
});
