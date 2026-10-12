import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { S3Api } from "../src/providers/s3/s3-api";
import type { HttpClient, HttpRequest, HttpResponse } from "../src/http/http-client";

class FakeHttpClient implements HttpClient {
	requests: HttpRequest[] = [];
	async request(req: HttpRequest): Promise<HttpResponse> {
		this.requests.push(req);
		return { status: 200, headers: { etag: '"e"' }, bytes: new Uint8Array(0) };
	}
}

const CFG = { endpoint: "https://h.example", bucket: "Drive", accessKey: "AK", secretKey: "SK", region: "us-east-1" };
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// ---- Reference SigV4, encoding the path the way a strict server does ----
// This is deliberately independent of the implementation: it mirrors how
// rclone's `serve s3` rebuilds the canonical URI from the decoded path, so a
// mismatch here is exactly the 403 seen against a live endpoint.

function strictEncode(s: string): string {
	return Array.from(new TextEncoder().encode(s))
		.map((b) => {
			const c = String.fromCharCode(b);
			return /[A-Za-z0-9\-_.~]/.test(c) ? c : "%" + b.toString(16).toUpperCase().padStart(2, "0");
		})
		.join("");
}

async function sha256Hex(data: string | Uint8Array): Promise<string> {
	const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
	return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
		.map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
	const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data));
}

async function referenceAuthHeader(
	method: string, signedPath: string, query: Record<string, string>, datetime: string,
): Promise<string> {
	const date = datetime.slice(0, 8);
	const canonicalUri = "/" + signedPath.split("/").map(strictEncode).join("/");
	const canonicalQS = Object.entries(query)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([k, v]) => `${strictEncode(k)}=${strictEncode(v)}`)
		.join("&");
	const canonicalRequest = [
		method, canonicalUri, canonicalQS,
		`host:h.example\nx-amz-content-sha256:${EMPTY_SHA256}\nx-amz-date:${datetime}\n`,
		"host;x-amz-content-sha256;x-amz-date", EMPTY_SHA256,
	].join("\n");
	const scope = `${date}/${CFG.region}/s3/aws4_request`;
	const stringToSign = `AWS4-HMAC-SHA256\n${datetime}\n${scope}\n${await sha256Hex(canonicalRequest)}`;
	const k1 = await hmac(new TextEncoder().encode("AWS4" + CFG.secretKey), date);
	const k2 = await hmac(k1, CFG.region);
	const k3 = await hmac(k2, "s3");
	const key = await hmac(k3, "aws4_request");
	const sig = Array.from(new Uint8Array(await hmac(key, stringToSign)))
		.map((b) => b.toString(16).padStart(2, "0")).join("");
	return `AWS4-HMAC-SHA256 Credential=${CFG.accessKey}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${sig}`;
}

const DATETIME = "20260101T000000Z";

describe("S3 key encoding (RFC 3986)", () => {
	let http: FakeHttpClient;
	let api: S3Api;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
		http = new FakeHttpClient();
		api = new S3Api(CFG, http);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("percent-encodes sub-delims that encodeURIComponent leaves literal", async () => {
		const key = "tax/04 Australian ETFs (CMC)/CMC statement FY2023-24.pdf";
		await api.getObject(key);
		expect(http.requests[0]!.url).toBe(
			"https://h.example/Drive/tax/04%20Australian%20ETFs%20%28CMC%29/CMC%20statement%20FY2023-24.pdf",
		);
	});

	it("encodes the full !'()* set, and leaves unreserved characters alone", async () => {
		await api.getObject("a!b'c(d)e*f/g-h_i.j~k.pdf");
		expect(http.requests[0]!.url).toBe(
			"https://h.example/Drive/a%21b%27c%28d%29e%2Af/g-h_i.j~k.pdf",
		);
	});

	it("signs a parenthesised key the way a strict server verifies it", async () => {
		const key = "04 Australian ETFs (CMC)/statement.pdf";
		await api.getObject(key);
		expect(http.requests[0]!.headers!["authorization"])
			.toBe(await referenceAuthHeader("GET", `${CFG.bucket}/${key}`, {}, DATETIME));
	});

	it("keeps slashes as path separators rather than encoding them", async () => {
		await api.getObject("a/b/c.md");
		expect(http.requests[0]!.url).toBe("https://h.example/Drive/a/b/c.md");
	});

	it("query values use %20, not + — URL and signature must agree", async () => {
		await api.uploadPart("big (1).wav", "up load/id+2", 3, new Uint8Array(0));
		const req = http.requests[0]!;
		expect(req.url).toBe(
			"https://h.example/Drive/big%20%281%29.wav?partNumber=3&uploadId=up%20load%2Fid%2B2",
		);
		expect(req.headers!["authorization"]).toBe(
			await referenceAuthHeader(
				"PUT", `${CFG.bucket}/big (1).wav`,
				{ partNumber: "3", uploadId: "up load/id+2" }, DATETIME,
			),
		);
	});
});
