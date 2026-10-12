import { RemoteNotFoundError } from "../cloud-provider";
import type { HttpClient } from "../../http/http-client";
import { bytesToArrayBuffer, bytesToText } from "../../http/http-client";

export interface S3Config {
	endpoint: string;
	bucket: string;
	accessKey: string;
	secretKey: string;
	region: string;
}

export interface S3Object {
	key: string;
	lastModified: number;
	etag: string;
}

// ---------- SigV4 utilities ----------

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(data: string | Uint8Array): Promise<string> {
	const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
	return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
	const k = await crypto.subtle.importKey(
		"raw", key,
		{ name: "HMAC", hash: "SHA-256" },
		false, ["sign"]
	);
	return crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data));
}

async function signingKey(secret: string, date: string, region: string): Promise<ArrayBuffer> {
	const k1 = await hmac(new TextEncoder().encode("AWS4" + secret), date);
	const k2 = await hmac(k1, region);
	const k3 = await hmac(k2, "s3");
	return hmac(k3, "aws4_request");
}

// SigV4 demands RFC 3986 encoding, which `encodeURIComponent` does not give:
// it leaves !'()* literal. rclone's `serve s3` percent-decodes the request path
// and re-encodes it strictly before verifying, so a literal "(" in the URL is
// signed as "(" by us and as "%28" by the server — SignatureDoesNotMatch, which
// surfaces as a 403 on every key holding one of those characters.
function rfc3986(s: string): string {
	return encodeURIComponent(s).replace(
		/[!'()*]/g,
		(c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
	);
}

function encodePath(path: string): string {
	return path.split("/").map(rfc3986).join("/");
}

// The signed query string and the one on the wire must match byte for byte.
// `URLSearchParams` encodes a space as "+" where SigV4 requires "%20", so both
// sides go through this instead.
function encodeQuery(query: Record<string, string>): string {
	return Object.entries(query)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
		.join("&");
}

async function buildAuthHeaders(
	method: string,
	host: string,
	path: string,
	query: Record<string, string>,
	body: Uint8Array,
	accessKey: string,
	secretKey: string,
	region: string,
): Promise<Record<string, string>> {
	const now = new Date();
	const date = now.toISOString().slice(0, 10).replace(/-/g, "");
	const datetime = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

	const payloadHash = body.length === 0 ? EMPTY_SHA256 : await sha256Hex(body);

	const canonicalUri = "/" + encodePath(path);
	const canonicalQS = encodeQuery(query);

	const canonicalHeaders =
		`host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${datetime}\n`;
	const signedHeaders = "host;x-amz-content-sha256;x-amz-date";

	const canonicalRequest = [method, canonicalUri, canonicalQS, canonicalHeaders, signedHeaders, payloadHash].join("\n");

	const scope = `${date}/${region}/s3/aws4_request`;
	const stringToSign = `AWS4-HMAC-SHA256\n${datetime}\n${scope}\n${await sha256Hex(canonicalRequest)}`;

	const key = await signingKey(secretKey, date, region);
	const sig = toHex(new Uint8Array(await hmac(key, stringToSign)));

	return {
		"x-amz-content-sha256": payloadHash,
		"x-amz-date": datetime,
		"authorization": `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`,
	};
}

// ---------- S3 API class ----------

export class S3Api {
	constructor(private cfg: S3Config, private http: HttpClient) {
		// A trailing slash would put "//" in request URLs while the signed path
		// has "/" — instant signature mismatch. Normalize once here.
		this.cfg = { ...cfg, endpoint: cfg.endpoint.replace(/\/+$/, "") };
	}

	private get host(): string {
		return new URL(this.cfg.endpoint).host;
	}

	// The endpoint may carry a routing path (e.g. https://s3.example.com/alice).
	// That prefix stays in the request URL (for the ingress) but is NOT signed:
	// rclone's `serve s3 --baseurl /alice` strips the prefix before verifying
	// SigV4, so the signature must cover only {bucket}/{key}. Verified against a
	// live rclone-with-baseurl endpoint — signing the prefix gives
	// SignatureDoesNotMatch.
	private signedBucketPath(): string {
		return this.cfg.bucket;
	}

	private signedObjectPath(key: string): string {
		return `${this.cfg.bucket}/${key}`;
	}

	private objectUrl(key: string, query?: Record<string, string>): string {
		const base = `${this.cfg.endpoint}/${this.cfg.bucket}/${encodePath(key)}`;
		if (!query || Object.keys(query).length === 0) return base;
		return `${base}?${encodeQuery(query)}`;
	}

	private bucketUrl(query: Record<string, string>): string {
		return `${this.cfg.endpoint}/${this.cfg.bucket}?${encodeQuery(query)}`;
	}

	private rootUrl(): string {
		// The served root (ListBuckets / CreateBucket target). Endpoint may carry
		// a routing prefix; rclone --baseurl strips it before verifying, so the
		// signed path for these is "/" (empty).
		return `${this.cfg.endpoint}/`;
	}

	// ListBuckets — top-level dirs served as buckets. Signed path is "/".
	async listBuckets(): Promise<string[]> {
		const headers = await buildAuthHeaders(
			"GET", this.host, "", {},
			new Uint8Array(0), this.cfg.accessKey, this.cfg.secretKey, this.cfg.region,
		);
		const resp = await this.http.request({ url: this.rootUrl(), method: "GET", headers });
		if (resp.status !== 200) {
			throw new Error(`S3 list buckets failed (${resp.status}): ${bytesToText(resp.bytes).slice(0, 200)}`);
		}
		const text = bytesToText(resp.bytes);
		// DOM-free parse so this stays usable outside a webview
		const names: string[] = [];
		const re = /<Bucket>\s*<Name>([^<]+)<\/Name>/g;
		let m: RegExpExecArray | null;
		while ((m = re.exec(text)) !== null) names.push(m[1]!);
		return names;
	}

	// CreateBucket — PUT /{name}. rclone enforces S3 naming: lowercase letters,
	// digits, hyphens only. Uppercase names must be created as dirs server-side.
	async createBucket(name: string): Promise<void> {
		const headers = await buildAuthHeaders(
			"PUT", this.host, name, {},
			new Uint8Array(0), this.cfg.accessKey, this.cfg.secretKey, this.cfg.region,
		);
		const resp = await this.http.request({ url: `${this.cfg.endpoint}/${encodePath(name)}`, method: "PUT", headers });
		if (resp.status < 200 || resp.status >= 300) {
			throw new Error(`S3 create bucket failed (${resp.status}): ${bytesToText(resp.bytes).slice(0, 200)}`);
		}
	}

	async testConnection(): Promise<boolean> {
		const query = { "list-type": "2", "max-keys": "1" };
		const headers = await buildAuthHeaders(
			"GET", this.host, this.signedBucketPath(), query,
			new Uint8Array(0), this.cfg.accessKey, this.cfg.secretKey, this.cfg.region,
		);
		const resp = await this.http.request({ url: this.bucketUrl(query), method: "GET", headers });
		if (resp.status === 200) return true;
		throw new Error(`HTTP ${resp.status}: ${bytesToText(resp.bytes).slice(0, 300)}`);
	}

	async listAllObjects(): Promise<S3Object[]> {
		const results: S3Object[] = [];
		let continuationToken: string | undefined;

		do {
			const query: Record<string, string> = { "list-type": "2" };
			if (continuationToken) query["continuation-token"] = continuationToken;

			const headers = await buildAuthHeaders(
				"GET", this.host, this.signedBucketPath(), query,
				new Uint8Array(0), this.cfg.accessKey, this.cfg.secretKey, this.cfg.region,
			);

			const resp = await this.http.request({ url: this.bucketUrl(query), method: "GET", headers });

			if (resp.status !== 200) {
				throw new Error(`S3 list failed (${resp.status}): ${bytesToText(resp.bytes).slice(0, 200)}`);
			}

			const doc = new DOMParser().parseFromString(bytesToText(resp.bytes), "text/xml");
			for (const el of Array.from(doc.querySelectorAll("Contents"))) {
				const key = el.querySelector("Key")?.textContent ?? "";
				const lm = el.querySelector("LastModified")?.textContent ?? "";
				const etag = (el.querySelector("ETag")?.textContent ?? "").replace(/"/g, "");
				if (key) results.push({ key, lastModified: new Date(lm).getTime(), etag });
			}

			const truncated = doc.querySelector("IsTruncated")?.textContent === "true";
			continuationToken = truncated
				? (doc.querySelector("NextContinuationToken")?.textContent ?? undefined)
				: undefined;
		} while (continuationToken);

		return results;
	}

	async getObject(key: string): Promise<ArrayBuffer> {
		const headers = await buildAuthHeaders(
			"GET", this.host, this.signedObjectPath(key), {},
			new Uint8Array(0), this.cfg.accessKey, this.cfg.secretKey, this.cfg.region,
		);
		const resp = await this.http.request({ url: this.objectUrl(key), method: "GET", headers });
		if (resp.status === 404) {
			throw new RemoteNotFoundError(key);
		}
		if (resp.status !== 200) {
			throw new Error(`S3 get failed (${resp.status}): ${key}`);
		}
		return bytesToArrayBuffer(resp.bytes);
	}

	async putObject(key: string, content: ArrayBuffer, _mimeType: string): Promise<void> {
		const body = new Uint8Array(content);
		const headers = await buildAuthHeaders(
			"PUT", this.host, this.signedObjectPath(key), {},
			body, this.cfg.accessKey, this.cfg.secretKey, this.cfg.region,
		);
		const resp = await this.http.request({ url: this.objectUrl(key), method: "PUT", headers, body });
		if (resp.status < 200 || resp.status >= 300) {
			throw new Error(`S3 put failed (${resp.status}): ${key}`);
		}
	}

	async deleteObject(key: string): Promise<void> {
		const headers = await buildAuthHeaders(
			"DELETE", this.host, this.signedObjectPath(key), {},
			new Uint8Array(0), this.cfg.accessKey, this.cfg.secretKey, this.cfg.region,
		);
		const resp = await this.http.request({ url: this.objectUrl(key), method: "DELETE", headers });
		if (resp.status !== 204 && resp.status !== 200 && resp.status !== 404) {
			throw new Error(`S3 delete failed (${resp.status}): ${key}`);
		}
	}

	// ---------- Multipart upload ----------
	// Needed above the Cloudflare request-body limit; see MULTIPART_* constants.
	// UploadId is parsed by regex rather than DOMParser so this file stays
	// usable in non-DOM runtimes (vitest under node).

	async createMultipartUpload(key: string): Promise<string> {
		const query = { uploads: "" };
		const headers = await buildAuthHeaders(
			"POST", this.host, this.signedObjectPath(key), query,
			new Uint8Array(0), this.cfg.accessKey, this.cfg.secretKey, this.cfg.region,
		);
		const resp = await this.http.request({ url: this.objectUrl(key, query), method: "POST", headers });
		if (resp.status !== 200) {
			throw new Error(`S3 create multipart failed (${resp.status}): ${key}`);
		}
		const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(bytesToText(resp.bytes))?.[1];
		if (!uploadId) {
			throw new Error(`S3 create multipart returned no UploadId: ${key}`);
		}
		return uploadId;
	}

	async uploadPart(key: string, uploadId: string, partNumber: number, body: Uint8Array): Promise<string> {
		const query = { partNumber: String(partNumber), uploadId };
		const headers = await buildAuthHeaders(
			"PUT", this.host, this.signedObjectPath(key), query,
			body, this.cfg.accessKey, this.cfg.secretKey, this.cfg.region,
		);
		const resp = await this.http.request({ url: this.objectUrl(key, query), method: "PUT", headers, body });
		if (resp.status < 200 || resp.status >= 300) {
			throw new Error(`S3 upload part ${partNumber} failed (${resp.status}): ${key}`);
		}
		const etag = (resp.headers["etag"] ?? "").replace(/"/g, "");
		if (!etag) {
			throw new Error(`S3 upload part ${partNumber} returned no ETag: ${key}`);
		}
		return etag;
	}

	async completeMultipartUpload(
		key: string,
		uploadId: string,
		parts: { partNumber: number; etag: string }[],
	): Promise<void> {
		const manifest = [...parts]
			.sort((a, b) => a.partNumber - b.partNumber)
			.map((p) => `<Part><PartNumber>${p.partNumber}</PartNumber><ETag>"${p.etag}"</ETag></Part>`)
			.join("");
		const body = new TextEncoder().encode(`<CompleteMultipartUpload>${manifest}</CompleteMultipartUpload>`);
		const query = { uploadId };
		const headers = await buildAuthHeaders(
			"POST", this.host, this.signedObjectPath(key), query,
			body, this.cfg.accessKey, this.cfg.secretKey, this.cfg.region,
		);
		const resp = await this.http.request({ url: this.objectUrl(key, query), method: "POST", headers, body });
		const text = bytesToText(resp.bytes);
		// S3 can return 200 with an <Error> body for CompleteMultipartUpload
		if (resp.status !== 200 || text.includes("<Error>")) {
			throw new Error(`S3 complete multipart failed (${resp.status}): ${key}: ${text.slice(0, 200)}`);
		}
	}

	async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
		const query = { uploadId };
		const headers = await buildAuthHeaders(
			"DELETE", this.host, this.signedObjectPath(key), query,
			new Uint8Array(0), this.cfg.accessKey, this.cfg.secretKey, this.cfg.region,
		);
		const resp = await this.http.request({ url: this.objectUrl(key, query), method: "DELETE", headers });
		if (resp.status !== 204 && resp.status !== 200 && resp.status !== 404) {
			throw new Error(`S3 abort multipart failed (${resp.status}): ${key}`);
		}
	}
}
