import { beforeEach, afterEach, vi } from "vitest";
import { SyncEngine } from "../../src/sync/sync-engine";
import type { SyncStateStore } from "../../src/sync/sync-state";
import { computeMD5 } from "../../src/util/hash";
import { KEY_FILE_NAME, createKeyFile, serializeKeyFile } from "../../src/crypto/folder-crypto";
import type { ConflictStrategy } from "../../src/types";
import type { UnlockCache } from "../../src/sync/folder-encryption";
import { FakeLocalFs, FakeProvider, FakeUI, makeState } from "./fakes";

// Shared setup for encrypted-folder engine tests: a fake clock, a provider
// whose writes advance it, and "devices" (fs + state + engine) sharing one
// remote.

export const FOLDER = "Journal";
export const KEY_PATH = `${FOLDER}/${KEY_FILE_NAME}`;
export const md5 = (s: string) => computeMD5(new TextEncoder().encode(s).buffer as ArrayBuffer);
export const text = (b: Uint8Array | undefined) => (b ? new TextDecoder().decode(b) : undefined);

export async function writeKeyFile(provider: FakeProvider, password: string, rotation: { fromKeyId: string } | null = null) {
	const { keyFile } = await createKeyFile(password, { iterations: 1000, rotation });
	provider.setObject(KEY_PATH, serializeKeyFile(keyFile), Date.now());
	return keyFile;
}

export interface Device {
	fs: FakeLocalFs;
	store: SyncStateStore;
	ui: FakeUI;
	engine: SyncEngine;
	notices: string[];
	password: string | null;
}

// Fake Date so every upload gets a strictly later modifiedTime than the
// record that saw the previous version (the engine compares with ">").
export function useFakeClock(): void {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(1_700_000_000_000);
	});
	afterEach(() => vi.useRealTimers());
}
export const tick = () => {
	vi.setSystemTime(Date.now() + 1000);
	return Date.now();
};

export function makeProvider(): FakeProvider {
	const p = new FakeProvider();
	const upload = p.uploadFile.bind(p);
	const update = p.updateFile.bind(p);
	p.uploadFile = async (...args) => { tick(); return upload(...args); };
	p.updateFile = async (...args) => { tick(); return update(...args); };
	return p;
}

export function device(
	provider: FakeProvider,
	password: string | null,
	opts: { configured?: boolean; strategy?: ConflictStrategy; lastSyncTime?: number; encryption?: boolean; unlockCache?: UnlockCache; maxFileSize?: number } = {},
): Device {
	const fs = new FakeLocalFs();
	const { store } = makeState([], opts.lastSyncTime ?? 1000);
	const ui = new FakeUI();
	const notices: string[] = [];
	const dev: Device = { fs, store, ui, notices, password, engine: undefined as unknown as SyncEngine };
	dev.engine = new SyncEngine(fs, "/root", provider, store, ui, {
		conflictStrategy: opts.strategy ?? "prompt",
		excludePatterns: [],
		maxFileSize: opts.maxFileSize,
		encryption: opts.encryption === false ? undefined : {
			folders: opts.configured === false ? [] : [FOLDER],
			passwordFor: (f) => (f === FOLDER ? dev.password : null),
			unlockCache: opts.unlockCache,
		},
	});
	dev.engine.onNotice = (m) => notices.push(m);
	return dev;
}

export function remoteKeysUnder(provider: FakeProvider, folder: string): string[] {
	return Array.from(provider.objects.keys()).filter((k) => k.startsWith(folder + "/") && k !== KEY_PATH);
}

export function snapshot(dev: Device) {
	return {
		files: Array.from(dev.fs.files, ([p, f]) => [p, text(f.bytes), f.mtimeMs]),
		records: JSON.parse(JSON.stringify(dev.store.getAllRecords())),
	};
}
