// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeHttps = require("https") as typeof import("https");

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

function encodePath(path: string): string {
	return path.split("/").map((s) => encodeURIComponent(s)).join("/");
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
	const canonicalQS = Object.entries(query)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
		.join("&");

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

// ---------- Node https wrapper — bypasses Electron/Chromium ECH+QUIC ----------

interface NodeResponse {
	status: number;
	text: string;
	arrayBuffer: ArrayBuffer;
}

function nodeRequest(
	url: string,
	method: string,
	headers: Record<string, string>,
	body?: Uint8Array,
): Promise<NodeResponse> {
	return new Promise((resolve, reject) => {
		const parsed = new URL(url);
		const options: import("https").RequestOptions = {
			hostname: parsed.hostname,
			port: parsed.port || 443,
			path: parsed.pathname + parsed.search,
			method,
			headers: {
				...headers,
				...(body && body.length > 0 ? { "content-length": String(body.length) } : {}),
			},
		};

		const req = nodeHttps.request(options, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => {
				const buf = Buffer.concat(chunks);
				const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
				resolve({
					status: res.statusCode ?? 0,
					text: buf.toString("utf-8"),
					arrayBuffer,
				});
			});
			res.on("error", reject);
		});

		req.on("error", reject);
		if (body && body.length > 0) req.write(body);
		req.end();
	});
}

// ---------- S3 API class ----------

export class S3Api {
	constructor(private cfg: S3Config) {}

	private get host(): string {
		return new URL(this.cfg.endpoint).host;
	}

	private objectPath(key: string): string {
		return `${this.cfg.bucket}/${key}`;
	}

	private objectUrl(key: string, query?: Record<string, string>): string {
		const base = `${this.cfg.endpoint}/${this.cfg.bucket}/${encodePath(key)}`;
		if (!query || Object.keys(query).length === 0) return base;
		return `${base}?${new URLSearchParams(query).toString()}`;
	}

	private bucketUrl(query: Record<string, string>): string {
		return `${this.cfg.endpoint}/${this.cfg.bucket}?${new URLSearchParams(query).toString()}`;
	}

	async testConnection(): Promise<boolean> {
		const query = { "list-type": "2", "max-keys": "1" };
		const headers = await buildAuthHeaders(
			"GET", this.host, this.cfg.bucket, query,
			new Uint8Array(0), this.cfg.accessKey, this.cfg.secretKey, this.cfg.region,
		);
		const resp = await nodeRequest(this.bucketUrl(query), "GET", headers);
		if (resp.status === 200) return true;
		throw new Error(`HTTP ${resp.status}: ${resp.text.slice(0, 300)}`);
	}

	async listAllObjects(): Promise<S3Object[]> {
		const results: S3Object[] = [];
		let continuationToken: string | undefined;

		do {
			const query: Record<string, string> = { "list-type": "2" };
			if (continuationToken) query["continuation-token"] = continuationToken;

			const headers = await buildAuthHeaders(
				"GET", this.host, this.cfg.bucket, query,
				new Uint8Array(0), this.cfg.accessKey, this.cfg.secretKey, this.cfg.region,
			);

			const resp = await nodeRequest(this.bucketUrl(query), "GET", headers);

			if (resp.status !== 200) {
				throw new Error(`S3 list failed (${resp.status}): ${resp.text.slice(0, 200)}`);
			}

			const doc = new DOMParser().parseFromString(resp.text, "text/xml");
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
			"GET", this.host, this.objectPath(key), {},
			new Uint8Array(0), this.cfg.accessKey, this.cfg.secretKey, this.cfg.region,
		);
		const resp = await nodeRequest(this.objectUrl(key), "GET", headers);
		if (resp.status !== 200) {
			throw new Error(`S3 get failed (${resp.status}): ${key}`);
		}
		return resp.arrayBuffer;
	}

	async putObject(key: string, content: ArrayBuffer, _mimeType: string): Promise<void> {
		const body = new Uint8Array(content);
		const headers = await buildAuthHeaders(
			"PUT", this.host, this.objectPath(key), {},
			body, this.cfg.accessKey, this.cfg.secretKey, this.cfg.region,
		);
		const resp = await nodeRequest(this.objectUrl(key), "PUT", headers, body);
		if (resp.status < 200 || resp.status >= 300) {
			throw new Error(`S3 put failed (${resp.status}): ${key}`);
		}
	}

	async deleteObject(key: string): Promise<void> {
		const headers = await buildAuthHeaders(
			"DELETE", this.host, this.objectPath(key), {},
			new Uint8Array(0), this.cfg.accessKey, this.cfg.secretKey, this.cfg.region,
		);
		const resp = await nodeRequest(this.objectUrl(key), "DELETE", headers);
		if (resp.status !== 204 && resp.status !== 200 && resp.status !== 404) {
			throw new Error(`S3 delete failed (${resp.status}): ${key}`);
		}
	}
}
