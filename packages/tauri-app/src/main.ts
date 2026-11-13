import { open } from "@tauri-apps/plugin-dialog";
import { getVersion } from "@tauri-apps/api/app";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { S3Provider, SyncStateStore, SyncEngine, type ConflictStrategy, type SyncResult, type SyncIssue } from "@cloud-drive-sync/core";
import { TauriHttpClient } from "./http/tauri-http-client";
import { TauriLocalFileSystem } from "./fs/tauri-local-fs";
import { TauriSyncUI } from "./sync/tauri-sync-ui";
import { watchForStableChanges } from "./fs/watch-stable";
import {
	loadSettings, saveSettings, loadSyncState, saveSyncState, deleteSyncState,
	newPairId, DEFAULT_CONFLICT_STRATEGY, type SyncPair, type TauriAppSettings,
} from "./store/settings-store";

const els = {
	endpoint: document.querySelector<HTMLInputElement>("#endpoint")!,
	accessKey: document.querySelector<HTMLInputElement>("#accessKey")!,
	secretKey: document.querySelector<HTMLInputElement>("#secretKey")!,
	region: document.querySelector<HTMLInputElement>("#region")!,
	syncIntervalMinutes: document.querySelector<HTMLInputElement>("#syncIntervalMinutes")!,
	pairs: document.querySelector<HTMLDivElement>("#pairs")!,
	addPair: document.querySelector<HTMLButtonElement>("#addPair")!,
	pairTemplate: document.querySelector<HTMLTemplateElement>("#pairTemplate")!,
	loadBuckets: document.querySelector<HTMLButtonElement>("#loadBuckets")!,
	bucketList: document.querySelector<HTMLDataListElement>("#bucketList")!,
	save: document.querySelector<HTMLButtonElement>("#save")!,
	syncNow: document.querySelector<HTMLButtonElement>("#syncNow")!,
	pauseToggle: document.querySelector<HTMLButtonElement>("#pauseToggle")!,
	status: document.querySelector<HTMLSpanElement>("#status")!,
	errorDetail: document.querySelector<HTMLUListElement>("#errorDetail")!,
	version: document.querySelector<HTMLSpanElement>("#version")!,
	updateBanner: document.querySelector<HTMLDivElement>("#updateBanner")!,
	updateText: document.querySelector<HTMLSpanElement>("#updateText")!,
	updateNow: document.querySelector<HTMLButtonElement>("#updateNow")!,
};

const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h
type PendingUpdate = Awaited<ReturnType<typeof check>>;
let pendingUpdate: PendingUpdate = null;
let updating = false;

let settings: TauriAppSettings;
let stopWatchers: Array<() => void> = [];
let syncIntervalId: ReturnType<typeof setInterval> | null = null;
let syncing = false;
let bucketNames: string[] = [];
let bucketsLoaded = false;

// `failures`, when given, makes the status text underlined + clickable;
// clicking toggles a list of "path: message" rows below the actions bar.
function setStatus(text: string, failures: SyncIssue[] = []): void {
	els.status.textContent = text;
	els.status.classList.toggle("has-detail", failures.length > 0);
	els.errorDetail.replaceChildren(
		...failures.map((f) => {
			const li = document.createElement("li");
			li.textContent = `${f.vaultPath}: ${f.errorMessage ?? "unknown error"}`;
			return li;
		}),
	);
	if (failures.length === 0) els.errorDetail.hidden = true;
}

els.status.addEventListener("click", () => {
	if (!els.status.classList.contains("has-detail")) return;
	els.errorDetail.hidden = !els.errorDetail.hidden;
});

// ---------- form <-> settings ----------

function credsFromForm(): boolean {
	return !!(els.endpoint.value.trim() && els.accessKey.value.trim() && els.secretKey.value.trim());
}

const VALID_BUCKET = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

// Resolve a user-typed bucket name to an actual bucket. Bucket dirs on the
// server are lowercase-only, so the resolved name is always lowercase —
// a case-insensitive match to an existing bucket still resolves to lower.
function resolveBucket(typed: string): { bucket?: string; create?: boolean; error?: string } {
	const t = typed.trim();
	if (!t) return { error: "Name a bucket for each folder" };
	const lower = t.toLowerCase().replace(/\s+/g, "-");
	if (!VALID_BUCKET.test(lower)) {
		return { error: `"${t}" isn't a valid bucket name — use letters, numbers and hyphens only` };
	}
	const existing = bucketNames.some((b) => b.toLowerCase() === lower);
	return { bucket: lower, create: !existing };
}

function pairFolderText(el: HTMLButtonElement): HTMLSpanElement {
	return el.querySelector<HTMLSpanElement>(".pair-folder-text")!;
}

function renderPairRow(pair: SyncPair): void {
	const frag = els.pairTemplate.content.cloneNode(true) as DocumentFragment;
	const row = frag.querySelector<HTMLDivElement>(".pair")!;
	row.dataset.id = pair.id;

	const folderBtn = row.querySelector<HTMLButtonElement>(".pair-folder")!;
	folderBtn.dataset.path = pair.localFolder;
	pairFolderText(folderBtn).textContent = pair.localFolder || "Choose a folder on this Mac…";
	folderBtn.classList.toggle("empty", !pair.localFolder);
	folderBtn.addEventListener("click", async () => {
		const chosen = await open({ directory: true, multiple: false });
		if (typeof chosen === "string") {
			folderBtn.dataset.path = chosen;
			pairFolderText(folderBtn).textContent = chosen;
			folderBtn.classList.remove("empty");
		}
	});

	const bucketInput = row.querySelector<HTMLInputElement>(".pair-bucket")!;
	bucketInput.value = pair.bucket;
	// Lazy-load the bucket list the first time a field is focused.
	bucketInput.addEventListener("focus", () => {
		if (!bucketsLoaded && credsFromForm()) void loadBuckets();
	});
	// On blur, tidy the typed value: lowercase and turn spaces into hyphens
	// (leaving genuinely-invalid names, e.g. other symbols, for the sync error).
	bucketInput.addEventListener("blur", () => {
		const v = bucketInput.value.trim();
		if (!v) return;
		bucketInput.value = v.toLowerCase().replace(/\s+/g, "-");
	});

	row.querySelector<HTMLSelectElement>(".pair-strategy")!.value = pair.conflictStrategy ?? DEFAULT_CONFLICT_STRATEGY;
	row.querySelector<HTMLButtonElement>(".pair-remove")!.addEventListener("click", () => {
		row.remove();
	});

	els.pairs.appendChild(row);
}

function fillForm(s: TauriAppSettings): void {
	els.endpoint.value = s.s3.endpoint;
	els.accessKey.value = s.s3.accessKey;
	els.secretKey.value = s.s3.secretKey;
	els.region.value = s.s3.region;
	els.syncIntervalMinutes.value = String(s.syncIntervalMinutes);
	els.pairs.replaceChildren();
	for (const pair of s.pairs) renderPairRow(pair);
}

function readForm(): TauriAppSettings {
	const pairs: SyncPair[] = Array.from(els.pairs.querySelectorAll<HTMLDivElement>(".pair"))
		.map((row) => {
			const strategy = row.querySelector<HTMLSelectElement>(".pair-strategy")!.value as ConflictStrategy;
			return {
				id: row.dataset.id || newPairId(),
				bucket: row.querySelector<HTMLInputElement>(".pair-bucket")!.value.trim(),
				localFolder: row.querySelector<HTMLButtonElement>(".pair-folder")!.dataset.path || "",
				conflictStrategy: strategy,
			};
		})
		.filter((p) => p.bucket && p.localFolder);

	return {
		s3: {
			endpoint: els.endpoint.value.trim().replace(/\/$/, ""),
			accessKey: els.accessKey.value.trim(),
			secretKey: els.secretKey.value.trim(),
			region: els.region.value.trim() || "us-east-1",
		},
		pairs,
		paused: settings?.paused ?? false,
		syncIntervalMinutes: Number(els.syncIntervalMinutes.value) || 0,
		lastSyncTime: settings?.lastSyncTime ?? 0,
	};
}

function credsConfigured(s: TauriAppSettings): boolean {
	return !!(s.s3.endpoint && s.s3.accessKey && s.s3.secretKey);
}

// A provider not scoped to any particular bucket, for instance-level ops
// (list/create bucket). Reads creds straight from the form so it works before
// Save.
function browsingProvider(): S3Provider {
	return new S3Provider({
		endpoint: els.endpoint.value.trim().replace(/\/$/, ""),
		bucket: "",
		accessKey: els.accessKey.value.trim(),
		secretKey: els.secretKey.value.trim(),
		region: els.region.value.trim() || "us-east-1",
	}, new TauriHttpClient());
}

function refreshBucketDatalist(): void {
	els.bucketList.replaceChildren(...bucketNames.map((n) => {
		const o = document.createElement("option");
		o.value = n;
		return o;
	}));
}

async function loadBuckets(announce = true): Promise<void> {
	if (!credsFromForm()) {
		if (announce) setStatus("Enter endpoint + keys first");
		return;
	}
	if (announce) setStatus("Loading buckets…");
	try {
		bucketNames = await browsingProvider().listBuckets();
		bucketsLoaded = true;
		refreshBucketDatalist();
		if (announce) setStatus(bucketNames.length ? `Buckets: ${bucketNames.join(", ")}` : "No buckets yet");
	} catch (e) {
		if (announce) setStatus(`Load buckets failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}

// ---------- sync ----------

// Resolve the pair's typed bucket to a real one, creating it if it's a new,
// valid lowercase name. Throws with a friendly message on invalid names.
async function ensureBucket(typed: string): Promise<string> {
	if (!bucketsLoaded) await loadBuckets(false);
	const r = resolveBucket(typed);
	if (r.error || !r.bucket) throw new Error(r.error ?? "Invalid bucket");
	if (r.create) {
		await browsingProvider().createBucket(r.bucket);
		if (!bucketNames.includes(r.bucket)) {
			bucketNames.push(r.bucket);
			refreshBucketDatalist();
		}
	}
	return r.bucket;
}

async function syncPair(pair: SyncPair): Promise<SyncResult> {
	const strategy = pair.conflictStrategy ?? DEFAULT_CONFLICT_STRATEGY;
	const bucket = await ensureBucket(pair.bucket);
	const provider = new S3Provider(
		{ ...settings.s3, bucket },
		new TauriHttpClient(),
	);
	const syncState = await loadSyncState(pair.id);
	const stateStore = new SyncStateStore(syncState, () => saveSyncState(pair.id, syncState));
	const engine = new SyncEngine(
		new TauriLocalFileSystem(), pair.localFolder,
		provider, stateStore,
		new TauriSyncUI(strategy),
		{ conflictStrategy: strategy, excludePatterns: [] },
	);
	return engine.sync();
}

async function runSync(): Promise<void> {
	if (syncing) return;
	if (settings.paused) {
		setStatus("Paused");
		return;
	}
	if (!credsConfigured(settings)) {
		setStatus("Configure S3 credentials first");
		return;
	}
	if (settings.pairs.length === 0) {
		setStatus("Add at least one synced folder");
		return;
	}

	syncing = true;
	const total: SyncResult = { uploaded: 0, downloaded: 0, deleted: 0, conflicts: 0, errors: 0, failures: [], lockedFolders: [], atRestFolders: [], tooBig: [] };
	let lastError = "";
	try {
		for (const pair of settings.pairs) {
			setStatus(`Syncing ${pair.bucket}…`);
			try {
				const r = await syncPair(pair);
				total.uploaded += r.uploaded;
				total.downloaded += r.downloaded;
				total.deleted += r.deleted;
				total.conflicts += r.conflicts;
				total.errors += r.errors;
				total.failures.push(...r.failures);
				total.lockedFolders.push(...r.lockedFolders);
				total.tooBig.push(...r.tooBig);
			} catch (e) {
				total.errors++;
				lastError = e instanceof Error ? e.message : String(e);
				total.failures.push({ vaultPath: pair.bucket, type: "error", errorMessage: lastError });
				console.error(`sync failed for ${pair.bucket}:`, e);
			}
		}

		settings.lastSyncTime = Date.now();
		await saveSettings(settings);

		// A single bucket-name / config error is more useful shown verbatim than
		// as "1 errors".
		if (total.errors === 1 && lastError && total.uploaded + total.downloaded + total.deleted === 0) {
			setStatus(lastError, total.failures);
			return;
		}

		const parts: string[] = [];
		if (total.uploaded) parts.push(`${total.uploaded} uploaded`);
		if (total.downloaded) parts.push(`${total.downloaded} downloaded`);
		if (total.deleted) parts.push(`${total.deleted} deleted`);
		if (total.errors) parts.push(`${total.errors} errors`);
		setStatus(parts.length ? `Synced: ${parts.join(", ")}` : "Everything up to date", total.failures);
	} finally {
		syncing = false;
	}
}

async function restartWatchers(): Promise<void> {
	for (const stop of stopWatchers) stop();
	stopWatchers = [];
	if (settings.paused) return;
	const fs = new TauriLocalFileSystem();
	for (const pair of settings.pairs) {
		if (!pair.localFolder) continue;
		// A change under any watched folder triggers a full multi-pair sync —
		// simple, and pairs are independent so ordering doesn't matter.
		const stop = await watchForStableChanges(pair.localFolder, fs, () => void runSync());
		stopWatchers.push(stop);
	}
}

function restartInterval(): void {
	if (syncIntervalId !== null) clearInterval(syncIntervalId);
	syncIntervalId = null;
	if (!settings.paused && settings.syncIntervalMinutes > 0) {
		syncIntervalId = setInterval(() => void runSync(), settings.syncIntervalMinutes * 60 * 1000);
	}
}

// ---------- pause ----------

function reflectPauseUI(): void {
	els.pauseToggle.textContent = settings.paused ? "Resume" : "Pause";
	els.pauseToggle.classList.toggle("paused", settings.paused);
	void invoke("set_tray_paused", { paused: settings.paused }).catch(() => {});
}

async function setPaused(paused: boolean): Promise<void> {
	settings.paused = paused;
	await saveSettings(settings);
	reflectPauseUI();
	await restartWatchers();
	restartInterval();
	setStatus(paused ? "Paused" : "Resumed");
}

// Drop persisted sync state for pairs the user removed, so a re-added folder
// starts fresh rather than resurrecting stale deletions.
async function pruneRemovedPairState(oldPairs: SyncPair[], newPairs: SyncPair[]): Promise<void> {
	const kept = new Set(newPairs.map((p) => p.id));
	for (const old of oldPairs) {
		if (!kept.has(old.id)) await deleteSyncState(old.id);
	}
}

// ---------- init ----------

async function checkForUpdate(announce = false): Promise<void> {
	if (announce) setStatus("Checking for updates…");
	try {
		const update = await check();
		if (update) {
			pendingUpdate = update;
			els.updateText.textContent = `Version ${update.version} available`;
			els.updateBanner.hidden = false;
			if (announce) setStatus(`Update available: ${update.version}`);
		} else {
			pendingUpdate = null;
			els.updateBanner.hidden = true;
			if (announce) setStatus("You're on the latest version");
		}
	} catch (e) {
		console.error("Update check failed:", e);
		if (announce) setStatus(`Update check failed: ${e instanceof Error ? e.message : String(e)}`);
	}
}

async function applyUpdate(): Promise<void> {
	if (!pendingUpdate || updating) return;
	updating = true;
	els.updateNow.disabled = true;
	try {
		els.updateText.textContent = "Downloading update…";
		await pendingUpdate.downloadAndInstall();
		els.updateText.textContent = "Restarting…";
		await relaunch();
	} catch (e) {
		els.updateText.textContent = `Update failed: ${e instanceof Error ? e.message : String(e)}`;
		els.updateNow.disabled = false;
		updating = false;
	}
}

async function init(): Promise<void> {
	getVersion().then((v) => { els.version.textContent = `v${v}`; }).catch(() => {});

	settings = await loadSettings();
	fillForm(settings);
	reflectPauseUI();
	await restartWatchers();
	restartInterval();

	els.pauseToggle.addEventListener("click", () => void setPaused(!settings.paused));
	await listen("tray-toggle-pause", () => void setPaused(!settings.paused));

	els.addPair.addEventListener("click", () => {
		renderPairRow({ id: newPairId(), bucket: "", localFolder: "" });
	});

	els.loadBuckets.addEventListener("click", () => void loadBuckets());

	els.save.addEventListener("click", async () => {
		const previous = settings.pairs;
		settings = readForm();
		await saveSettings(settings);
		await pruneRemovedPairState(previous, settings.pairs);
		fillForm(settings); // re-render so dropped empty rows clear
		await restartWatchers();
		restartInterval();
		setStatus("Settings saved");
	});

	els.syncNow.addEventListener("click", () => void runSync());
	els.updateNow.addEventListener("click", () => void applyUpdate());

	await listen("tray-sync-now", () => void runSync());
	await listen("menu-check-updates", () => void checkForUpdate(true));

	// Preload buckets so the dropdowns are populated without a manual step.
	if (credsFromForm()) void loadBuckets(false);

	// Surface updates via the banner rather than force-installing on startup,
	// and re-check periodically since the app lives in the tray for a long time.
	void checkForUpdate();
	setInterval(() => void checkForUpdate(), UPDATE_CHECK_INTERVAL_MS);
}

void init();
