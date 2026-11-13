import { describe, expect, it } from 'vitest';
import { AutoSyncEngine, RETRY_DELAYS_MS, type AutoSyncDeps } from '../../src/sync/autoSync';
import type { SyncConfig, SyncResult } from '../../src/sync/sync';

function makeConfig(overrides: Partial<SyncConfig> = {}): SyncConfig {
  return {
    serverUrl: 'http://sync.test',
    token: 'x'.repeat(32),
    deviceId: 'device-test',
    deviceName: 'test',
    lastSyncAt: null,
    revisions: {},
    ...overrides
  };
}

function makeResult(conflicts: SyncResult['conflicts'] = []): SyncResult {
  return {
    pulled: 0,
    pushed: 0,
    canvasPulled: 0,
    canvasPushed: 0,
    relationsPulled: 0,
    relationsPushed: 0,
    attachmentsPulled: 0,
    attachmentsPushed: 0,
    conflicts,
    serverTime: '2026-11-11T00:00:05.000Z',
    revisions: {}
  };
}

function makeHarness(overrides: Partial<AutoSyncDeps> = {}) {
  const state = {
    config: makeConfig(),
    saved: [] as SyncConfig[],
    timers: new Map<number, { fn: () => void; ms: number }>(),
    nextTimer: 1,
    online: true,
    syncCalls: 0
  };
  const deps: AutoSyncDeps = {
    loadConfig: async () => state.config,
    saveConfig: async (config) => {
      state.saved.push(config);
      state.config = config;
    },
    sync: async () => {
      state.syncCalls += 1;
      return makeResult();
    },
    isOnline: () => state.online,
    setTimer: (fn, ms) => {
      const id = state.nextTimer++;
      state.timers.set(id, { fn, ms });
      return id;
    },
    clearTimer: (id) => {
      state.timers.delete(id as number);
    },
    now: () => '2026-11-11T00:00:06.000Z',
    ...overrides
  };
  const engine = new AutoSyncEngine(deps, { debounceMs: 2000, retryDelays: RETRY_DELAYS_MS });
  return { engine, state, deps };
}

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('auto sync engine', () => {
  it('debounces local changes into a single sync', async () => {
    const { engine, state } = makeHarness();
    engine.notifyLocalChange();
    engine.notifyLocalChange();
    expect(state.timers.size).toBe(1);
    expect(state.syncCalls).toBe(0);

    const [timer] = [...state.timers.values()];
    expect(timer?.ms).toBe(2000);
    timer?.fn();
    await flush();

    expect(state.syncCalls).toBe(1);
    expect(engine.getState().status).toBe('idle');
    expect(engine.getState().pendingChanges).toBe(false);
  });

  it('stays idle without saving when the token is not configured', async () => {
    const { engine, state } = makeHarness({
      loadConfig: async () => makeConfig({ token: '' })
    });
    await engine.run(true);
    expect(state.syncCalls).toBe(0);
    expect(engine.getState().status).toBe('unconfigured');
  });

  it('reports offline and retries when the network comes back', async () => {
    const { engine, state } = makeHarness();
    state.online = false;
    await engine.run(true);
    expect(engine.getState().status).toBe('offline');
    expect(state.syncCalls).toBe(0);

    state.online = true;
    engine.handleOnline();
    await flush();
    expect(state.syncCalls).toBe(1);
    expect(engine.getState().status).toBe('idle');
  });

  it('schedules a backoff retry after a failure and clears it on success', async () => {
    let attempts = 0;
    const { engine, state } = makeHarness({
      sync: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('网络断了');
        return makeResult();
      }
    });

    await engine.run(true);
    expect(engine.getState().status).toBe('error');
    expect(engine.getState().retries).toBe(1);
    expect(engine.getState().nextRetryMs).toBe(RETRY_DELAYS_MS[0]);
    expect([...state.timers.values()][0]?.ms).toBe(RETRY_DELAYS_MS[0]);

    const [retry] = [...state.timers.values()];
    retry?.fn();
    await flush();

    expect(attempts).toBe(2);
    expect(engine.getState().status).toBe('idle');
    expect(engine.getState().retries).toBe(0);
  });

  it('keeps conflicts until they are resolved', async () => {
    const conflict = {
      id: 'note-1',
      local: { id: 'note-1', workspaceId: 'local', title: 'a', body: '本地', tags: [], folder: '', createdAt: 'x', updatedAt: 'x' },
      remote: {
        id: 'note-1',
        title: 'a',
        body: '远端',
        tags: [],
        folder: '',
        updatedAt: 'y',
        revision: 2,
        device: 'other',
        deleted: false
      }
    } as SyncResult['conflicts'][number];
    const { engine } = makeHarness({ sync: async () => makeResult([conflict]) });

    await engine.run(true);
    expect(engine.getState().status).toBe('conflict');
    expect(engine.getState().conflicts).toHaveLength(1);

    engine.clearConflict('note-1');
    expect(engine.getState().status).toBe('idle');
    expect(engine.getState().conflicts).toEqual([]);
  });
});
