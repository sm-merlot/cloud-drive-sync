import { requestUrl } from "obsidian";
import type { GoogleDriveSettings } from "../../types";

const REDIRECT_URI = "https://scme0.github.io/obsidian-cloud-sync";
const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/drive";

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
		});

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
