import { describe, expect, it, vi } from 'vitest';
import {
  fetchDeviceRegistry,
  fetchDevices,
  restoreDevice,
  revokeDevice
} from '../../src/sync/devices';
import type { FetchLike, SyncConfig } from '../../src/sync/sync';

const config: SyncConfig = {
  serverUrl: 'http://sync.test/',
  token: 'x'.repeat(32),
  deviceId: 'd1',
  deviceName: 'PC',
  lastSyncAt: null,
  revisions: {}
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

type MockFetch = ReturnType<typeof vi.fn>;
function mockFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): MockFetch {
  return vi.fn(impl) as unknown as MockFetch;
}

describe('device registry client', () => {
  it('fetches the device list with bearer auth', async () => {
    const fetchImpl = mockFetch(async () =>
      json({
        ok: true,
        devices: [{ id: 'd1', name: 'PC', createdAt: 'x', lastSeen: 'y' }]
      })
    );

    const rows = await fetchDevices(config, fetchImpl as unknown as FetchLike);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe('PC');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://sync.test/api/v1/devices');
    expect(init.headers.Authorization).toBe(`Bearer ${'x'.repeat(32)}`);
  });

  it('returns an empty list when the endpoint fails', async () => {
    const fetchImpl = mockFetch(async () => new Response('{}', { status: 500 }));
    expect(await fetchDevices(config, fetchImpl as unknown as FetchLike)).toEqual([]);
  });

  it('parses revoked devices and tolerates an old server without the field', async () => {
    const fetchImpl = mockFetch(async () =>
      json({
        ok: true,
        devices: [{ id: 'd1', name: 'PC', createdAt: 'x', lastSeen: 'y' }],
        revoked: [{ id: 'd-old', name: '旧手机', revokedAt: '2026-11-12T00:00:00.000Z' }]
      })
    );
    const registry = await fetchDeviceRegistry(config, fetchImpl as unknown as FetchLike);
    expect(registry.devices).toHaveLength(1);
    expect(registry.revoked[0]?.id).toBe('d-old');

    const legacy = mockFetch(async () => json({ ok: true, devices: [] }));
    expect((await fetchDeviceRegistry(config, legacy as unknown as FetchLike)).revoked).toEqual([]);
  });
});

describe('device revocation client', () => {
  it('revokes through DELETE .../devices/:id with an encoded id', async () => {
    const fetchImpl = mockFetch(async () => json({ ok: true, revoked: true }));
    expect(await revokeDevice(config, 'dev old/1', fetchImpl as unknown as FetchLike)).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://sync.test/api/v1/devices/dev%20old%2F1');
    expect(init.method).toBe('DELETE');
    expect(init.headers.Authorization).toBe(`Bearer ${'x'.repeat(32)}`);
  });

  it('restores through DELETE .../revoked-devices/:id', async () => {
    const fetchImpl = mockFetch(async () => json({ ok: true, restored: true }));
    expect(await restoreDevice(config, 'dev-old', fetchImpl as unknown as FetchLike)).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://sync.test/api/v1/revoked-devices/dev-old');
    expect(init.method).toBe('DELETE');
  });

  it('reports refusal and network failure as false instead of throwing', async () => {
    const refused = mockFetch(async () => json({ ok: false }, 403));
    expect(await revokeDevice(config, 'd1', refused as unknown as FetchLike)).toBe(false);

    const offline = mockFetch(async () => {
      throw new Error('offline');
    });
    expect(await revokeDevice(config, 'd1', offline as unknown as FetchLike)).toBe(false);
  });
});
