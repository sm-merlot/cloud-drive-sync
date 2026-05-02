import type { SyncFileRecord, SyncState } from "../types";

export class SyncStateStore {
	private state: SyncState;
	private persist: () => Promise<void>;

	constructor(state: SyncState, persist: () => Promise<void>) {
		this.state = state;
		this.persist = persist;
	}

	getRecord(vaultPath: string): SyncFileRecord | undefined {
		return this.state.files[vaultPath];
	}

	setRecord(vaultPath: string, record: SyncFileRecord): void {
		this.state.files[vaultPath] = record;
	}

	removeRecord(vaultPath: string): void {
		delete this.state.files[vaultPath];
	}

	getAllRecords(): Record<string, SyncFileRecord> {
		return this.state.files;
	}

	getAllTrackedPaths(): string[] {
		return Object.keys(this.state.files);
	}

	get lastSyncTime(): number {
		return this.state.lastSyncTime;
	}

	set lastSyncTime(time: number) {
		this.state.lastSyncTime = time;
	}

	get remoteChangeToken(): string | undefined {
		return this.state.remoteChangeToken;
	}

	set remoteChangeToken(token: string | undefined) {
		this.state.remoteChangeToken = token;
	}

	async save(): Promise<void> {
		await this.persist();
	}
}
