import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { HttpClient, HttpRequest, HttpResponse } from "../../src/http/http-client";

// Minimal Node HttpClient for integration tests (the hosts use Obsidian's
// requestUrl / Node https, or Tauri's fetch).
export class NodeHttpClient implements HttpClient {
	request(req: HttpRequest): Promise<HttpResponse> {
		const url = new URL(req.url);
		const send = url.protocol === "https:" ? httpsRequest : httpRequest;
		const headers: Record<string, string> = {};
		for (const [k, v] of Object.entries(req.headers ?? {})) {
			if (k.toLowerCase() !== "host") headers[k] = v; // Node derives Host from the URL
		}
		if (req.body) headers["content-length"] = String(req.body.byteLength);
		return new Promise((resolve, reject) => {
			const r = send(url, { method: req.method, headers }, (res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c: Buffer) => chunks.push(c));
				res.on("end", () => {
					const out: Record<string, string> = {};
					for (const [k, v] of Object.entries(res.headers)) {
						if (v !== undefined) out[k] = Array.isArray(v) ? v.join(", ") : v;
					}
					resolve({ status: res.statusCode ?? 0, headers: out, bytes: new Uint8Array(Buffer.concat(chunks)) });
				});
				res.on("error", reject);
			});
			r.on("error", reject);
			if (req.body) r.write(req.body);
			r.end();
		});
	}
}
