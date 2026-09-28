import { requestUrl } from "obsidian";
import type { HttpClient, HttpRequest, HttpResponse } from "@cloud-drive-sync/core";

// Node https available on desktop (Electron) but not mobile
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeHttps = (typeof require !== "undefined" ? require("https") : undefined) as typeof import("https") | undefined;

// Bypasses Electron/Chromium ECH+QUIC issues on desktop by going through Node's
// https module directly; falls back to Obsidian's requestUrl (native HTTP stack)
// on mobile, where Node isn't available. Both bypass the renderer's CORS
// enforcement, which the self-hosted rclone-serve-s3 endpoint needs since it
// sends no CORS headers.
export class ObsidianHttpClient implements HttpClient {
	async request(req: HttpRequest): Promise<HttpResponse> {
		if (nodeHttps) {
			return new Promise((resolve, reject) => {
				const parsed = new URL(req.url);
				const options: import("https").RequestOptions = {
					hostname: parsed.hostname,
					port: parsed.port || 443,
					path: parsed.pathname + parsed.search,
					method: req.method,
					headers: {
						...req.headers,
						...(req.body && req.body.length > 0 ? { "content-length": String(req.body.length) } : {}),
					},
				};

				const httpReq = nodeHttps!.request(options, (res) => {
					const chunks: Buffer[] = [];
					res.on("data", (chunk: Buffer) => chunks.push(chunk));
					res.on("end", () => {
						const buf = Buffer.concat(chunks);
						resolve({
							status: res.statusCode ?? 0,
							headers: Object.fromEntries(
								Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v ?? ""])
							),
							bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
						});
					});
					res.on("error", reject);
				});

				httpReq.on("error", reject);
				if (req.body && req.body.length > 0) httpReq.write(req.body);
				httpReq.end();
			});
		}

		// rclone-serve-s3 sends Last-Modified but no Cache-Control, so iOS's
		// native HTTP cache may heuristically reuse an old GET body for an
		// object URL (DEV-208). Force revalidation on every request.
		const resp = await requestUrl({
			url: req.url,
			method: req.method,
			headers: { ...req.headers, "cache-control": "no-cache" },
			body: req.body && req.body.length > 0 ? req.body.buffer as ArrayBuffer : undefined,
			throw: false,
		});
		return {
			status: resp.status,
			headers: resp.headers,
			bytes: new Uint8Array(resp.arrayBuffer),
		};
	}
}
