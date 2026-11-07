import { describe, it, expect, beforeEach, vi } from "vitest";
import { S3Api } from "../src/providers/s3/s3-api";
import { S3Provider } from "../src/providers/s3/s3-provider";
import { MULTIPART_PART_SIZE_BYTES, MULTIPART_THRESHOLD_BYTES } from "../src/util/constants";
import type { HttpClient, HttpRequest, HttpResponse } from "../src/http/http-client";

interface Recorded {
	req: HttpRequest;
}

class FakeHttpClient implements HttpClient {
	requests: Recorded[] = [];
	// queue of responders consulted in order; last one sticks
	private responders: ((req: HttpRequest) => HttpResponse)[] = [];

	respondWith(fn: (req: HttpRequest) => HttpResponse): void {
		this.responders.push(fn);
	}

	async request(req: HttpRequest): Promise<HttpResponse> {
		this.requests.push({ req });
		const fn = this.responders.length > 1 ? this.responders.shift()! : this.responders[0];
		if (!fn) throw new Error("no responder configured");
		return fn(req);
	}
}

function ok(body = "", headers: Record<string, string> = {}): HttpResponse {
	return { status: 200, headers, bytes: new TextEncoder().encode(body) };
}

const CFG = { bucket: "Drive", accessKey: "AK", secretKey: "SK", region: "us-east-1" };

describe("SigV4 path-prefix endpoints", () => {
	let http: FakeHttpClient;

	beforeEach(() => {
		http = new FakeHttpClient();
		http.respondWith(() => ok());
	});

	it("request URL includes the endpoint path prefix (for routing)", async () => {
		const api = new S3Api({ ...CFG, endpoint: "https://h.example/alice" }, http);
		await api.putObject("Notes/a.md", new TextEncoder().encode("x").buffer, "text/markdown");
		const req = http.requests[0]!.req;
		expect(req.url).toBe("https://h.example/alice/Drive/Notes/a.md");
	});

	it("path prefix is NOT signed — rclone --baseurl strips it before verifying", async () => {
		// Same host + bucket + key + fixed clock ⇒ identical signature whether or
		// not the endpoint carries a routing prefix (the prefix is URL-only).
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		try {
			const httpA = new FakeHttpClient(); httpA.respondWith(() => ok());
			const httpB = new FakeHttpClient(); httpB.respondWith(() => ok());
			await new S3Api({ ...CFG, endpoint: "https://h.example" }, httpA)
				.putObject("a.md", new ArrayBuffer(0), "text/markdown");
			await new S3Api({ ...CFG, endpoint: "https://h.example/alice" }, httpB)
				.putObject("a.md", new ArrayBuffer(0), "text/markdown");
			expect(httpA.requests[0]!.req.headers!["authorization"])
				.toBe(httpB.requests[0]!.req.headers!["authorization"]);
			// ...but the URLs differ (prefix present only in the request URL)
			expect(httpA.requests[0]!.req.url).toBe("https://h.example/Drive/a.md");
			expect(httpB.requests[0]!.req.url).toBe("https://h.example/alice/Drive/a.md");
		} finally {
			vi.useRealTimers();
		}
	});

	it("unprefixed endpoint behaves exactly as before (regression guard)", async () => {
		const api = new S3Api({ ...CFG, endpoint: "https://h.example" }, http);
		await api.putObject("Notes/a.md", new ArrayBuffer(0), "text/markdown");
		expect(http.requests[0]!.req.url).toBe("https://h.example/Drive/Notes/a.md");
	});

	it("trailing slash on the endpoint path is normalized away", async () => {
		const api = new S3Api({ ...CFG, endpoint: "https://h.example/alice/" }, http);
		await api.getObject("a.md").catch(() => {});
		expect(http.requests[0]!.req.url).toBe("https://h.example/alice/Drive/a.md");
	});
});

describe("multipart upload API", () => {
	let http: FakeHttpClient;
	let api: S3Api;

	beforeEach(() => {
		http = new FakeHttpClient();
		api = new S3Api({ ...CFG, endpoint: "https://h.example/alice" }, http);
	});

	it("createMultipartUpload POSTs ?uploads and parses UploadId", async () => {
		http.respondWith(() => ok("<InitiateMultipartUploadResult><UploadId>UP123</UploadId></InitiateMultipartUploadResult>"));
		const id = await api.createMultipartUpload("big.wav");
		expect(id).toBe("UP123");
		const req = http.requests[0]!.req;
		expect(req.method).toBe("POST");
		expect(req.url).toBe("https://h.example/alice/Drive/big.wav?uploads=");
	});

	it("uploadPart PUTs with partNumber/uploadId and returns unquoted etag", async () => {
		http.respondWith(() => ok("", { etag: '"abc123"' }));
		const etag = await api.uploadPart("big.wav", "UP123", 3, new Uint8Array([1, 2, 3]));
		expect(etag).toBe("abc123");
		const req = http.requests[0]!.req;
		expect(req.method).toBe("PUT");
		expect(req.url).toContain("partNumber=3");
		expect(req.url).toContain("uploadId=UP123");
		expect(req.body).toEqual(new Uint8Array([1, 2, 3]));
	});

	it("completeMultipartUpload sends parts sorted ascending in XML", async () => {
		http.respondWith(() => ok("<CompleteMultipartUploadResult/>"));
		await api.completeMultipartUpload("big.wav", "UP123", [
			{ partNumber: 2, etag: "e2" },
			{ partNumber: 1, etag: "e1" },
		]);
		const req = http.requests[0]!.req;
		const xml = new TextDecoder().decode(req.body);
		expect(xml.indexOf("<PartNumber>1</PartNumber>")).toBeLessThan(xml.indexOf("<PartNumber>2</PartNumber>"));
		expect(xml).toContain('<ETag>"e1"</ETag>');
	});

	it("completeMultipartUpload throws on a 200-with-Error body", async () => {
		http.respondWith(() => ok("<Error><Code>InternalError</Code></Error>"));
		await expect(api.completeMultipartUpload("big.wav", "UP123", [{ partNumber: 1, etag: "e1" }]))
			.rejects.toThrow(/complete multipart failed/);
	});

	it("abortMultipartUpload tolerates 404", async () => {
		http.respondWith(() => ({ status: 404, headers: {}, bytes: new Uint8Array(0) }));
		await expect(api.abortMultipartUpload("big.wav", "UP123")).resolves.toBeUndefined();
	});
});

describe("S3Provider multipart orchestration", () => {
	let http: FakeHttpClient;
	let provider: S3Provider;

	beforeEach(() => {
		http = new FakeHttpClient();
		provider = new S3Provider({ ...CFG, endpoint: "https://h.example" }, http);
	});

	it("routes small files through single PUT", async () => {
		http.respondWith(() => ok());
		await provider.uploadFile("", "small.bin", new ArrayBuffer(1024), "application/octet-stream");
		expect(http.requests).toHaveLength(1);
		expect(http.requests[0]!.req.method).toBe("PUT");
		expect(http.requests[0]!.req.url).not.toContain("uploadId");
	});

	it("routes files at the threshold through multipart, sequentially", async () => {
		const size = MULTIPART_THRESHOLD_BYTES;
		const expectedParts = Math.ceil(size / MULTIPART_PART_SIZE_BYTES);
		http.respondWith((req) => {
			if (req.url.includes("?uploads=")) return ok("<r><UploadId>U1</UploadId></r>");
			if (req.method === "PUT") return ok("", { etag: '"pe"' });
			return ok("<CompleteMultipartUploadResult/>");
		});
		await provider.uploadFile("", "big.bin", new ArrayBuffer(size), "application/octet-stream");
		const methods = http.requests.map((r) => r.req.method);
		expect(methods[0]).toBe("POST");
		expect(methods.filter((m) => m === "PUT")).toHaveLength(expectedParts);
		expect(methods[methods.length - 1]).toBe("POST");
		// last part carries the remainder
		const putBodies = http.requests.filter((r) => r.req.method === "PUT").map((r) => r.req.body!.byteLength);
		expect(putBodies.reduce((a, b) => a + b, 0)).toBe(size);
	});

	it("aborts and rethrows with part context when a part fails", async () => {
		let putCount = 0;
		let abortCalled = false;
		http.respondWith((req) => {
			if (req.url.includes("?uploads=")) return ok("<r><UploadId>U1</UploadId></r>");
			if (req.method === "PUT") {
				putCount++;
				if (putCount === 2) return { status: 500, headers: {}, bytes: new Uint8Array(0) };
				return ok("", { etag: '"pe"' });
			}
			if (req.method === "DELETE") {
				abortCalled = true;
				expect(req.url).toContain("uploadId=U1");
				return { status: 204, headers: {}, bytes: new Uint8Array(0) };
			}
			return ok();
		});
		const size = MULTIPART_THRESHOLD_BYTES; // 5 parts at 16MB
		await expect(
			provider.uploadFile("", "big.bin", new ArrayBuffer(size), "application/octet-stream")
		).rejects.toThrow(/failed at part 2\/5/);
		expect(abortCalled).toBe(true);
	});
});

describe("S3Provider listing", () => {
	it("treats keys ending in '/' as folders, not files", async () => {
		const provider = new S3Provider({ ...CFG, endpoint: "https://h.example" }, new FakeHttpClient());
		(provider as unknown as { api: { listAllObjects: () => Promise<unknown[]> } }).api.listAllObjects = async () => [
			{ key: "Tax/2025/empty/", lastModified: 0, etag: "" },
			{ key: "Tax/2025/report.pdf", lastModified: 1, etag: "e" },
		];
		const all = await provider.listAllFiles();
		const files = all.filter((f) => !f.isFolder).map((f) => f.path);
		const folders = all.filter((f) => f.isFolder).map((f) => f.path).sort();
		expect(files).toEqual(["Tax/2025/report.pdf"]);
		expect(folders).toEqual(["Tax", "Tax/2025", "Tax/2025/empty"]);
		expect(all.some((f) => f.path.endsWith("/"))).toBe(false);
	});
});
