/**
 * @req REQ-303 — 版本历史同步。
 *
 * 服务端在每次 push 时会写一条 note_versions，客户端此前只读本地表，
 * 换设备就看不到历史。这里补上：拉远端版本 + 与本机版本合并成一条时间线。
 */
import type { NoteVersion } from '../storage/db';
import type { FetchLike, SyncConfig } from './sync';

export interface RemoteVersion {
  id: number;
  noteId: string;
  title: string;
  body: string;
  tags: string[];
  folder: string;
  updatedAt: string;
  revision: number;
  device: string;
  createdAt: string;
}

export interface TimelineVersion {
  key: string;
  source: 'local' | 'remote';
  noteId: string;
  title: string;
  body: string;
  tags: string[];
  folder: string;
  createdAt: string;
  revision: number | null;
  device: string | null;
}

export interface RemoteVersionPage {
  versions: RemoteVersion[];
  /** 还存在更早的版本时给出下次请求的游标（服务端自增 id）。 */
  nextCursor: number | null;
}

export async function fetchRemoteVersionsPage(
  config: SyncConfig,
  noteId: string,
  options: { before?: number | null; limit?: number } = {},
  fetchImpl: FetchLike = fetch
): Promise<RemoteVersionPage> {
  const base = config.serverUrl.replace(/\/+$/, '');
  const params = new URLSearchParams();
  if (options.limit && options.limit > 0) params.set('limit', String(options.limit));
  if (options.before && options.before > 0) params.set('before', String(options.before));
  const query = params.toString();
  const url = `${base}/api/v1/versions/${encodeURIComponent(noteId)}${query ? `?${query}` : ''}`;
  try {
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${config.token}` }
    });
    if (!response.ok) return { versions: [], nextCursor: null };
    const body = (await response.json()) as {
      versions?: RemoteVersion[];
      nextCursor?: number | null;
    };
    return {
      versions: body.versions ?? [],
      nextCursor: typeof body.nextCursor === 'number' ? body.nextCursor : null
    };
  } catch {
    return { versions: [], nextCursor: null };
  }
}

/** 兼容旧调用：只取第一页（服务端默认最新 200 条）。 */
export async function fetchRemoteVersions(
  config: SyncConfig,
  noteId: string,
  fetchImpl: FetchLike = fetch
): Promise<RemoteVersion[]> {
  const page = await fetchRemoteVersionsPage(config, noteId, {}, fetchImpl);
  return page.versions;
}

/** 本机 + 云端合并成一条时间线；两端同一时刻同一内容算同一条（本机优先）。 */
export function buildTimeline(local: NoteVersion[], remote: RemoteVersion[]): TimelineVersion[] {
  const items: TimelineVersion[] = [
    ...local.map((version) => ({
      key: `local:${version.id}`,
      source: 'local' as const,
      noteId: version.noteId,
      title: version.title,
      body: version.body,
      tags: version.tags,
      folder: version.folder,
      createdAt: version.createdAt,
      revision: null,
      device: null
    })),
    ...remote.map((version) => ({
      key: `remote:${version.id}`,
      source: 'remote' as const,
      noteId: version.noteId,
      title: version.title,
      body: version.body,
      tags: version.tags,
      folder: version.folder,
      createdAt: version.createdAt,
      revision: version.revision,
      device: version.device
    }))
  ];
  const seen = new Set<string>();
  const deduped = items.filter((item) => {
    const signature = `${item.createdAt}|${item.title}|${item.body.length}`;
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
  return deduped.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
