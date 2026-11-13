import { describe, expect, it, vi } from 'vitest';
import type { NoteVersion } from '../../src/storage/db';
import {
  buildTimeline,
  fetchRemoteVersions,
  fetchRemoteVersionsPage,
  type RemoteVersion
} from '../../src/sync/versions';
import type { FetchLike, SyncConfig } from '../../src/sync/sync';

const config: SyncConfig = {
  serverUrl: 'http://sync.test/',
  token: 'x'.repeat(32),
  deviceId: 'd',
  deviceName: 't',
  lastSyncAt: null,
  revisions: {}
};

function localVersion(id: string, createdAt: string, body: string): NoteVersion {
  return {
    id,
    noteId: 'note-1',
    title: '标题',
    body,
    tags: [],
    folder: '',
    createdAt,
    source: 'save'
  };
}

function remoteVersion(id: number, createdAt: string, body: string): RemoteVersion {
  return {
    id,
    noteId: 'note-1',
    title: '标题',
    body,
    tags: [],
    folder: '',
    updatedAt: createdAt,
    revision: 3,
    device: 'other',
    createdAt
  };
}

describe('version history sync', () => {
  it('merges local and remote versions newest first', () => {
    const timeline = buildTimeline(
      [localVersion('l1', '2026-11-11T10:00:00.000Z', '本地旧')],
      [remoteVersion(1, '2026-11-11T12:00:00.000Z', '云端新')]
    );
    expect(timeline.map((item) => item.source)).toEqual(['remote', 'local']);
  });

  it('dedupes the same revision recorded on both sides', () => {
    const timeline = buildTimeline(
      [localVersion('l1', '2026-11-11T10:00:00.000Z', '同一版')],
      [remoteVersion(1, '2026-11-11T10:00:00.000Z', '同一版')]
    );
    expect(timeline).toHaveLength(1);
    expect(timeline[0]?.source).toBe('local');
  });

  it('fetches remote versions with bearer auth and tolerates errors', async () => {
    const okFetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, versions: [remoteVersion(7, '2026-11-11T12:00:00.000Z', 'x')] }), {
        status: 200
      })
    ) as unknown as FetchLike;
    const rows = await fetchRemoteVersions(config, 'note-1', okFetch);
    expect(rows).toHaveLength(1);
    const [url, init] = (okFetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://sync.test/api/v1/versions/note-1');
    expect(init.headers.Authorization).toBe(`Bearer ${'x'.repeat(32)}`);

    const failing = vi.fn(async () => new Response('{}', { status: 500 })) as unknown as FetchLike;
    expect(await fetchRemoteVersions(config, 'note-1', failing)).toEqual([]);
  });

  it('pages remote versions with before/limit and reads nextCursor', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          versions: [remoteVersion(9, '2026-11-11T09:00:00.000Z', '更早')],
          nextCursor: 9
        }),
        { status: 200 }
      )
    ) as unknown as FetchLike;

    const page = await fetchRemoteVersionsPage(config, 'note-1', { limit: 2, before: 12 }, fetchImpl);
    expect(page.versions).toHaveLength(1);
    expect(page.nextCursor).toBe(9);
    const [url] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://sync.test/api/v1/versions/note-1?limit=2&before=12');

    const trailing = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, versions: [], nextCursor: null }), { status: 200 })
    ) as unknown as FetchLike;
    expect(await fetchRemoteVersionsPage(config, 'note-1', { before: 9 }, trailing)).toEqual({
      versions: [],
      nextCursor: null
    });

    const failing = vi.fn(async () => new Response('{}', { status: 500 })) as unknown as FetchLike;
    expect(await fetchRemoteVersionsPage(config, 'note-1', {}, failing)).toEqual({
      versions: [],
      nextCursor: null
    });
  });
});