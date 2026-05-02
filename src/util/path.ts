export function getParentPath(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx === -1 ? "" : path.substring(0, idx);
}

export function getFileName(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx === -1 ? path : path.substring(idx + 1);
}

export function shouldExclude(path: string, patterns: string[]): boolean {
	for (const pattern of patterns) {
		if (matchGlob(path, pattern)) return true;
	}
	return false;
}

function matchGlob(path: string, pattern: string): boolean {
	// Handle ** (matches any depth)
	if (pattern.endsWith("/**")) {
		const prefix = pattern.slice(0, -3);
		return path === prefix || path.startsWith(prefix + "/");
	}

	// Handle *.ext
	if (pattern.startsWith("*.")) {
		return path.endsWith(pattern.slice(1));
	}

	// Handle exact match
	if (pattern === path) return true;

	// Handle prefix/**
	if (pattern.includes("/**")) {
		const parts = pattern.split("/**");
		if (parts[0] && path.startsWith(parts[0] + "/")) return true;
	}

	return false;
}

export function guessMimeType(path: string): string {
	const ext = path.split(".").pop()?.toLowerCase() || "";
	const map: Record<string, string> = {
		md: "text/markdown",
		txt: "text/plain",
		json: "application/json",
		css: "text/css",
		js: "application/javascript",
		ts: "application/typescript",
		html: "text/html",
		xml: "application/xml",
		yaml: "text/yaml",
		yml: "text/yaml",
		csv: "text/csv",
		png: "image/png",
		jpg: "image/jpeg",
		jpeg: "image/jpeg",
		gif: "image/gif",
		svg: "image/svg+xml",
		webp: "image/webp",
		pdf: "application/pdf",
		mp3: "audio/mpeg",
		mp4: "video/mp4",
		wav: "audio/wav",
		canvas: "application/json",
	};
	return map[ext] || "application/octet-stream";
}
