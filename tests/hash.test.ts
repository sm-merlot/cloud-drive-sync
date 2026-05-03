import { describe, it, expect } from "vitest";
import { computeMD5 } from "../src/util/hash";

function md5str(s: string): string {
	return computeMD5(new TextEncoder().encode(s).buffer);
}

describe("computeMD5", () => {
	it("empty string", () => {
		expect(computeMD5(new ArrayBuffer(0))).toBe("d41d8cd98f00b204e9800998ecf8427e");
	});

	it("hello", () => {
		expect(md5str("hello")).toBe("5d41402abc4b2a76b9719d911017c592");
	});

	it("hello world", () => {
		expect(md5str("hello world")).toBe("5eb63bbbe01eeed093cb22bb8f5acdc3");
	});

	it("single character", () => {
		expect(md5str("a")).toBe("0cc175b9c0f1b6a831c399e269772661");
	});

	it("exactly 55 bytes (edge case: one padding byte before length)", () => {
		const s = "a".repeat(55);
		expect(md5str(s)).toBe("ef1772b6dff9a122358552954ad0df65");
	});

	it("exactly 56 bytes (edge case: needs extra block)", () => {
		const s = "a".repeat(56);
		expect(md5str(s)).toBe("3b0c8ac703f828b04c6c197006d17218");
	});

	it("exactly 64 bytes (one full block before padding)", () => {
		const s = "a".repeat(64);
		expect(md5str(s)).toBe("014842d480b571495a4a0363793f7367");
	});

	it("binary content", () => {
		const buf = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd]);
		expect(computeMD5(buf.buffer)).toBe("a7ade6f11cc9c0580eca571bef517069");
	});

	it("large content (10KB)", () => {
		const buf = new Uint8Array(10240).fill(65);
		const hash = computeMD5(buf.buffer);
		expect(hash).toMatch(/^[0-9a-f]{32}$/);
		// Deterministic
		expect(computeMD5(buf.buffer)).toBe(hash);
	});
});
