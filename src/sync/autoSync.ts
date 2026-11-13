/**
 * @req REQ-204 / REQ-303 — 自动同步。
 *
 * 本地变更 → 防抖 → 自动同步；失败按退避重试；离线时等 online 事件再试。
 * 同步本身是「先拉后推 + 全量关系/附件 + 墓碑」，所以失败重试天然幂等，
 * 不需要额外的"离线队列"表：未推成功的墓碑和 dirty 笔记就留在本地。
 */
import type { SyncConflict, SyncConfig, SyncResult } from './sync';

export const AUTO_SYNC_DEBOUNCE_MS = 2000;
export const RETRY_DELAYS_MS = [5000, 15000, 60000, 300000];

export type AutoSyncStatus =
  | 'unconfigured'
  | 'idle'
  | 'pending'
  | 'syncing'
  | 'error'
  | 'offline'
  | 'conflict';

export interface AutoSyncState {
  status: AutoSyncStatus;
  pendingChanges: boolean;
  lastSuccessAt: string | null;
  lastError: string | null;
  retries: number;
  nextRetryMs: number | null;
  conflicts: SyncConflict[];
}

export interface AutoSyncDeps {
  loadConfig(): Promise<SyncConfig>;
  saveConfig(config: SyncConfig): Promise<void>;
  sync(config: SyncConfig): Promise<SyncResult>;
  isOnline(): boolean;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(id: unknown): void;
  now(): string;
}

export interface AutoSyncOptions {
  debounceMs: number;
  retryDelays: number[];
}

const initialState = (): AutoSyncState => ({
  status: 'unconfigured',
  pendingChanges: false,
  lastSuccessAt: null,
  lastError: null,
  retries: 0,
  nextRetryMs: null,
  conflicts: []
});

export class AutoSyncEngine {
  private state: AutoSyncState = initialState();
  private listeners = new Set<(state: AutoSyncState) => void>();
  private timer: unknown = null;
  private running = false;

  constructor(
    private readonly deps: AutoSyncDeps,
    private readonly options: AutoSyncOptions = {
      debounceMs: AUTO_SYNC_DEBOUNCE_MS,
      retryDelays: RETRY_DELAYS_MS
    }
  ) {}

  getState(): AutoSyncState {
    return { ...this.state, conflicts: [...this.state.conflicts] };
  }

  subscribe(listener: (state: AutoSyncState) => void): () => void {
    this.listeners.add(listener);
    listener(this.getState());
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 本地数据变更后调用：防抖后自动同步。 */
  notifyLocalChange(): void {
    this.state.pendingChanges = true;
    this.cancelTimer();
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      void this.run(false);
    }, this.options.debounceMs);
    if (this.state.status !== 'syncing') {
      this.patch({ status: 'pending', nextRetryMs: null });
    }
  }

  /** manual = 用户点了「立即同步」。返回 null 表示没跑（未配置/离线/正在跑）。 */
  async run(manual = false): Promise<SyncResult | null> {
    if (this.running) return null;
    this.cancelTimer();
    if (manual) this.patch({ retries: 0 });

    const config = await this.deps.loadConfig();
    if (!config.token || config.token.trim().length < 16) {
      this.patch({ status: 'unconfigured' });
      return null;
    }
    if (!this.deps.isOnline()) {
      this.patch({ status: 'offline', nextRetryMs: null });
      return null;
    }

    this.running = true;
    this.patch({ status: 'syncing', lastError: null, nextRetryMs: null });
    try {
      const result = await this.deps.sync(config);
      await this.deps.saveConfig({
        ...config,
        lastSyncAt: result.serverTime,
        revisions: result.revisions
      });
      this.patch({
        status: result.conflicts.length > 0 ? 'conflict' : 'idle',
        pendingChanges: false,
        lastSuccessAt: this.deps.now(),
        lastError: null,
        retries: 0,
        nextRetryMs: null,
        conflicts: result.conflicts
      });
      return result;
    } catch (error) {
      const retries = this.state.retries + 1;
      const delay = this.options.retryDelays[Math.min(retries - 1, this.options.retryDelays.length - 1)];
      const willRetry = retries <= this.options.retryDelays.length;
      this.patch({
        status: 'error',
        lastError: String(error),
        retries,
        nextRetryMs: willRetry ? delay : null
      });
      if (willRetry) {
        this.timer = this.deps.setTimer(() => {
          this.timer = null;
          void this.run(false);
        }, delay);
      }
      return null;
    } finally {
      this.running = false;
    }
  }

  handleOnline(): void {
    if (this.state.status === 'offline' || this.state.pendingChanges) {
      void this.run(false);
    }
  }

  clearConflict(id: string): void {
    const conflicts = this.state.conflicts.filter((conflict) => conflict.id !== id);
    this.patch({ conflicts, status: conflicts.length > 0 ? 'conflict' : 'idle' });
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      this.deps.clearTimer(this.timer);
      this.timer = null;
    }
  }

  private patch(partial: Partial<AutoSyncState>): void {
    this.state = { ...this.state, ...partial };
    const snapshot = this.getState();
    for (const listener of this.listeners) listener(snapshot);
  }
}

export const autoSync = new AutoSyncEngine({
  loadConfig: async () => (await import('./sync')).loadSyncConfig(),
  saveConfig: async (config) => (await import('./sync')).saveSyncConfig(config),
  sync: async (config) => (await import('./sync')).syncNotes(config),
  isOnline: () => typeof navigator === 'undefined' || navigator.onLine !== false,
  setTimer: (fn, ms) =>
    typeof window === 'undefined' ? setTimeout(fn, ms) : window.setTimeout(fn, ms),
  clearTimer: (id) =>
    typeof window === 'undefined' ? clearTimeout(id as never) : window.clearTimeout(id as number),
  now: () => new Date().toISOString()
});

export function notifyLocalChange(): void {
  autoSync.notifyLocalChange();
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => autoSync.handleOnline());
}
