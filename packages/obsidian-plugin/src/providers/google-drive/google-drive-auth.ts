import { requestUrl } from "obsidian";
import type { GoogleDriveSettings } from "@cloud-drive-sync/core";

const REDIRECT_URI = "https://cloud-drive-sync.pages.dev/";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/drive";

/**
 * Thrown when Google rejects the stored refresh token (`invalid_grant`): it
 * expired or was revoked, so no retry will help and the user has to sign in
 * again. Refresh tokens of an OAuth client in "Testing" publishing status
 * expire after 7 days, and a Workspace admin's session-length policy can make
 * them expire sooner.
 */
export class GoogleAuthExpiredError extends Error {
	constructor(detail: string) {
		super(`Google Drive sign-in expired: ${detail}`);
		this.name = "GoogleAuthExpiredError";
	}
}

interface TokenResponse {
	accessToken: string;
	refreshToken: string;
	expiresIn: number;
}

export class GoogleDriveAuth {
	private settings: GoogleDriveSettings;
	private onTokenUpdate: (updates: Partial<GoogleDriveSettings>) => void;

	constructor(
		settings: GoogleDriveSettings,
		onTokenUpdate: (updates: Partial<GoogleDriveSettings>) => void
	) {
		this.settings = settings;
		this.onTokenUpdate = onTokenUpdate;
	}

	static getAuthUrl(clientId: string): string {
		const params = new URLSearchParams({
			client_id: clientId,
			redirect_uri: REDIRECT_URI,
			response_type: "code",
			scope: SCOPE,
			access_type: "offline",
			prompt: "consent",
		});
		return `${AUTH_ENDPOINT}?${params.toString()}`;
	}

	static async exchangeCode(
		code: string,
		clientId: string,
		clientSecret: string
	): Promise<TokenResponse> {
		const resp = await requestUrl({
			url: TOKEN_ENDPOINT,
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				code,
				client_id: clientId,
				client_secret: clientSecret,
				redirect_uri: REDIRECT_URI,
				grant_type: "authorization_code",
			}).toString(),
		});

		if (resp.status !== 200) {
			throw new Error(`Token exchange failed: ${resp.text}`);
		}

		const data = resp.json;
		return {
			accessToken: data.access_token,
			refreshToken: data.refresh_token,
			expiresIn: data.expires_in,
		};
	}

	async ensureValidToken(): Promise<string> {
		const bufferMs = 5 * 60 * 1000; // refresh 5 min early
		if (Date.now() < this.settings.tokenExpiry - bufferMs) {
			return this.settings.accessToken;
		}
		return this.refresh();
	}

	private async refresh(): Promise<string> {
		const resp = await requestUrl({
			url: TOKEN_ENDPOINT,
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				refresh_token: this.settings.refreshToken,
				client_id: this.settings.clientId,
				client_secret: this.settings.clientSecret,
				grant_type: "refresh_token",
			}).toString(),
			throw: false,
		});

		if (resp.status === 400 || resp.status === 401) {
			let error = "";
			try {
				error = resp.json?.error ?? "";
			} catch {
				// non-JSON body, fall through to the generic error
			}
			if (error === "invalid_grant") {
				throw new GoogleAuthExpiredError(resp.json?.error_description ?? error);
			}
		}
		if (resp.status !== 200) {
			throw new Error(`Token refresh failed: ${resp.text}`);
		}

		const data = resp.json;
		const accessToken: string = data.access_token;
		const tokenExpiry = Date.now() + data.expires_in * 1000;

		this.settings.accessToken = accessToken;
		this.settings.tokenExpiry = tokenExpiry;
		this.onTokenUpdate({ accessToken, tokenExpiry });

		return accessToken;
	}
}
