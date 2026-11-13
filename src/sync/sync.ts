/**
 * @req REQ-204 / REQ-303 — Phase 3c 客户端同步。
 * 先拉后推；双方都改过的同一笔记不覆盖，交给冲突 UI。
 */
import { db, ensureSchema, type PkeDatabase } from '../storage/db';
import type { Note } from '../domain/note';
import { listNotes, updateNote, deleteNote } from '../storage/notes';
import { getMetaValue, setMetaValue } from '../storage/meta';
import { listManualRelations } from '../storage/relations';
import { listAllAttachments } from '../storage/attachments';
import { clearTombstones, listTombstones, tombstoneId, tombstoneTarget } from '../storage/tombstones';
import { uploadAttachmentBlob } from './blobs';

export const SYNC_CONFIG_KEY = 'sync_config';

export interface SyncConfig {
  serverUrl: string;
  token: string;
  deviceId: string;
  deviceName: string;
  lastSyncAt: string | null;
  revisions: Record<string, number>;
  /** B-1：本机设备凭证是否已换取；true 表示 token 是设备 token 而非管理 token。 */
  deviceToken?: boolean;
}

export interface RemoteNote {
  id: string;
  title: string;
  body: string;
  tags: string[];
  folder: string;
  updatedAt: string;
  revision: number;
  device: string;
  deleted: boolean;
}

export interface RemoteRelation {
  id: string;
  sourceId: string;
  targetId: string;
  createdAt: string;
  deleted: boolean;
}

/** 附件只同步元数据；blob 仍在各设备本地，后续再单独做传输。 */
export interface RemoteAttachmentMeta {
  id: string;
  noteId: string;
  name: string;
  mime: string;
  size: number;
  hash: string;
  createdAt: string;
  deleted: boolean;
  /** 服务端是否已有文件本体（决定能不能按需下载）。 */
  hasBlob?: boolean;
}

/** B-3：画布卡片（哪篇笔记摆在画布哪个位置）。 */
export interface RemoteCanvasCard {
  noteId: string;
  x: number;
  y: number;
  updatedAt: string;
  deleted?: boolean;
}

export interface SyncConflict {
  id: string;
  local: Note;
  remote: RemoteNote;
}

export interface SyncResult {
  pulled: number;
  pushed: number;
  canvasPulled: number;
  canvasPushed: number;
  relationsPulled: number;
  relationsPushed: number;
  attachmentsPulled: number;
  attachmentsPushed: number;
  conflicts: SyncConflict[];
  serverTime: string;
  revisions: Record<string, number>;
}

export type SyncConflictChoice = 'local' | 'remote' | 'copy';

export type FetchLike = typeof fetch;

function defaultConfig(): SyncConfig {
  return {
    serverUrl: 'http://127.0.0.1:3000',
    token: '',
    deviceId: crypto.randomUUID(),
    deviceName: 'Windows',
    lastSyncAt: null,
    revisions: {}
  };
}

export async function loadSyncConfig(database: PkeDatabase = db): Promise<SyncConfig> {
  const raw = await getMetaValue(SYNC_CONFIG_KEY, database);
  if (!raw) return defaultConfig();
  try {
    const parsed = JSON.parse(raw) as Partial<SyncConfig>;
    return {
      ...defaultConfig(),
      ...parsed,
      revisions: parsed.revisions ?? {}
    };
  } catch {
    return defaultConfig();
  }
}

export async function saveSyncConfig(
  config: SyncConfig,
  database: PkeDatabase = db
): Promise<void> {
  await setMetaValue(SYNC_CONFIG_KEY, JSON.stringify(config), database);
}

function noteContent(note: Pick<Note, 'title' | 'body' | 'tags' | 'folder'>): string {
  return JSON.stringify([note.title, note.body, note.tags, note.folder]);
}

function remoteToNote(remote: RemoteNote): Note {
  return {
    id: remote.id,
    workspaceId: 'local',
    title: remote.title,
    body: remote.body,
    tags: remote.tags,
    folder: remote.folder,
    createdAt: remote.updatedAt,
    updatedAt: remote.updatedAt
  };
}

async function requestJson(
  fetchImpl: FetchLike,
  url: string,
  token: string,
  init?: RequestInit
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetchImpl(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {})
    }
  });
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  if (!response.ok && response.status !== 401) {
    if (response.status === 403 && body.error === 'device-revoked') {
      throw new Error('本设备已被服务器撤销，无法同步；在同步面板「已撤销设备」里恢复本机后可继续。');
    }
    throw new Error(`同步服务返回 ${response.status}`);
  }
  return { status: response.status, body };
}

/** B-1：用管理 token 为本机换取设备凭证；返回设备 token（此后只保存它）。 */
export async function issueDeviceToken(
  config: SyncConfig,
  fetchImpl: FetchLike = fetch
): Promise<string> {
  if (!config.serverUrl.trim()) throw new Error('请填写同步服务器地址');
  if (!config.token.trim()) throw new Error('没有可用的管理 token');
  const base = config.serverUrl.replace(/\/+$/, '');
  const { status, body } = await requestJson(fetchImpl, `${base}/api/v1/device-token`, config.token, {
    method: 'POST',
    body: JSON.stringify({ deviceId: config.deviceId, deviceName: config.deviceName })
  });
  if (status === 401) throw new Error('管理 token 被拒绝');
  if (status === 403) {
    throw new Error(
      body.error === 'device-revoked'
        ? '本设备已被服务器撤销，无法换取凭证；先恢复本机'
        : '该 token 不能签发设备凭证（需要管理 token）'
    );
  }
  if (status !== 201 || typeof body.token !== 'string') {
    throw new Error(`换取设备凭证失败：${status}`);
  }
  return body.token;
}

export interface RemoteDeviceToken {
  deviceId: string;
  createdAt: string;
  lastUsedAt: string;
}

/** B-1：列出已签发凭证的设备（管理 token 专用）。 */
export async function listDeviceTokens(
  config: SyncConfig,
  fetchImpl: FetchLike = fetch
): Promise<{ tokens: RemoteDeviceToken[]; required: boolean }> {
  const base = config.serverUrl.replace(/\/+$/, '');
  const { status, body } = await requestJson(
    fetchImpl,
    `${base}/api/v1/device-tokens`,
    config.token
  );
  if (status === 403) throw new Error('当前是设备凭证，不能查看设备凭证列表');
  if (status !== 200) throw new Error(`读取设备凭证失败：${status}`);
  return {
    tokens: (body.tokens as RemoteDeviceToken[] | undefined) ?? [],
    required: body.required === true
  };
}

export interface AuditLogEntry {
  id: number;
  at: string;
  tool: string;
  device: string;
  paramsDigest: string;
  result: string;
  noteId: string;
}

/** 质量面板用：读取服务端审计日志（只读，需要同步 token）。 */
export async function fetchAuditLogs(
  limit = 20,
  fetchImpl: FetchLike = fetch,
  database: PkeDatabase = db,
  signal?: AbortSignal
): Promise<AuditLogEntry[]> {
  const config = await loadSyncConfig(database);
  if (!config.token) throw new Error('未配置同步 token，审计日志不可用');
  const base = config.serverUrl.replace(/\/+$/, '');
  const { status, body } = await requestJson(
    fetchImpl,
    `${base}/api/v1/audit-logs?limit=${encodeURIComponent(String(limit))}`,
    config.token,
    { signal }
  );
  if (status === 401) throw new Error('同步 token 被拒绝');
  if (status !== 200) throw new Error(`审计接口返回 ${status}`);
  return (body.logs as AuditLogEntry[] | undefined) ?? [];
}

export async function syncNotes(
  config: SyncConfig,
  database: PkeDatabase = db,
  fetchImpl: FetchLike = fetch
): Promise<SyncResult> {
  if (!config.serverUrl.trim()) throw new Error('请填写同步服务器地址');
  if (config.token.trim().length < 16) throw new Error('同步 token 无效');
  await ensureSchema(database);

  const base = config.serverUrl.replace(/\/+$/, '');
  // 自愈：本地一篇都没有、游标却已推进（换机/重装/中途失败），说明游标跳过了数据，
  // 继续用它永远拉不到早于游标的内容 —— 直接回到 1970 全量重拉。
  const localNoteCount = await database.notes.count();
  const cursorLost = localNoteCount === 0 && Boolean(config.lastSyncAt);
  const since = cursorLost ? '1970-01-01T00:00:00.000Z' : (config.lastSyncAt ?? '1970-01-01T00:00:00.000Z');
  const pull = await requestJson(
    fetchImpl,
    `${base}/api/v1/pull?since=${encodeURIComponent(since)}&deviceId=${encodeURIComponent(config.deviceId)}&deviceName=${encodeURIComponent(config.deviceName)}`,
    config.token
  );
  if (pull.status === 401) throw new Error('同步 token 被拒绝');
  const remoteNotes = (pull.body.notes as RemoteNote[] | undefined) ?? [];
  const revisions = { ...config.revisions };
  const beforePull = await listNotes('local', database);
  const dirtyIds = new Set(
    beforePull
      .filter((note) => !config.lastSyncAt || note.updatedAt > config.lastSyncAt)
      .map((note) => note.id)
  );
  const local = new Map(beforePull.map((note) => [note.id, note]));
  const conflicts: SyncConflict[] = [];
  let pulled = 0;

  for (const remote of remoteNotes) {
    const current = local.get(remote.id);
    if (remote.deleted) {
      if (current) {
        await deleteNote(remote.id, database);
        local.delete(remote.id);
        delete revisions[remote.id];
        pulled += 1;
      }
      // 远端已删，本地不必再把这次删除当成"待推送"。
      await clearTombstones([tombstoneId('note', remote.id)], database);
      continue;
    }
    if (!current) {
      await database.notes.add(remoteToNote(remote));
      revisions[remote.id] = remote.revision;
      pulled += 1;
      continue;
    }

    const localDirty = !config.lastSyncAt || current.updatedAt > config.lastSyncAt;
    const remoteDirty = !config.lastSyncAt || remote.updatedAt > config.lastSyncAt;
    const same = noteContent(current) === noteContent(remote);
    if (!same && localDirty && remoteDirty) {
      conflicts.push({ id: remote.id, local: current, remote });
      continue;
    }
    if (!same && remote.updatedAt > current.updatedAt) {
      const updated = await updateNote(
        current.id,
        {
          title: remote.title,
          body: remote.body,
          tags: remote.tags,
          folder: remote.folder
        },
        database
      );
      if (updated) pulled += 1;
    }
    revisions[remote.id] = remote.revision;
  }

  // 关系：集合语义，没有内容冲突；删除靠墓碑传播。
  const remoteRelations = (pull.body.relations as RemoteRelation[] | undefined) ?? [];
  let relationsPulled = 0;
  for (const remote of remoteRelations) {
    if (remote.deleted) {
      await database.relations.delete(remote.id);
      await clearTombstones([tombstoneId('relation', remote.id)], database);
      continue;
    }
    const existing = await database.relations.get(remote.id);
    if (!existing) {
      await database.relations.add({
        id: remote.id,
        sourceId: remote.sourceId,
        targetId: remote.targetId,
        createdAt: remote.createdAt
      });
      relationsPulled += 1;
    }
  }

  // 附件：只收元数据，落到 attachment_refs；本地已有实体则不重复登记。
  const remoteAttachments = (pull.body.attachments as RemoteAttachmentMeta[] | undefined) ?? [];
  let attachmentsPulled = 0;
  for (const remote of remoteAttachments) {
    if (remote.deleted) {
      await database.attachment_refs.delete(remote.id);
      await clearTombstones([tombstoneId('attachment', remote.id)], database);
      continue;
    }
    const known = await database.attachment_refs.get(remote.id);
    const owned = await database.attachments.get(remote.id);
    if (!known && !owned) {
      await database.attachment_refs.add({
        id: remote.id,
        noteId: remote.noteId,
        name: remote.name,
        mime: remote.mime,
        size: remote.size,
        hash: remote.hash,
        createdAt: remote.createdAt
      });
      attachmentsPulled += 1;
    }
  }

  // B-3：画布卡片按 noteId 覆盖；远端更新才写本地，避免旧数据把新布局推回去。
  const remoteCanvas = (pull.body.canvas as RemoteCanvasCard[] | undefined) ?? [];
  let canvasPulled = 0;
  for (const remote of remoteCanvas) {
    const existing = await database.canvas_cards.get(remote.noteId);
    if (existing && existing.updatedAt >= remote.updatedAt) continue;
    await database.canvas_cards.put({
      noteId: remote.noteId,
      x: Number(remote.x) || 0,
      y: Number(remote.y) || 0,
      createdAt: existing?.createdAt ?? remote.updatedAt,
      updatedAt: remote.updatedAt
    });
    canvasPulled += 1;
  }

  const afterPull = await listNotes('local', database);
  const pushNotes = afterPull
    .filter((note) => dirtyIds.has(note.id))
    .map((note) => ({
      id: note.id,
      title: note.title,
      body: note.body,
      tags: note.tags,
      folder: note.folder,
      updatedAt: note.updatedAt,
      baseRevision: revisions[note.id] ?? null
    }));

  const noteTombstones = await listTombstones('note', database);
  const relationTombstones = await listTombstones('relation', database);
  const attachmentTombstones = await listTombstones('attachment', database);
  const localCanvas = await database.canvas_cards.toArray();
  const canvasPayload = localCanvas
    .filter((card) => !config.lastSyncAt || card.updatedAt > config.lastSyncAt)
    .map((card) => ({
      noteId: card.noteId,
      x: card.x,
      y: card.y,
      updatedAt: card.updatedAt
    }));

  const localRelations = await listManualRelations(database);
  const localAttachments = await listAllAttachments(database);

  const pushNotesDeleted = noteTombstones.map((tombstone) => {
    const id = tombstoneTarget(tombstone);
    return {
      id,
      title: '',
      body: '',
      tags: [] as string[],
      folder: '',
      updatedAt: tombstone.deletedAt,
      baseRevision: revisions[id] ?? null,
      deleted: true
    };
  });
  // 关系/附件按"全量 + 墓碑"推送：服务端只在内容变化时推进游标，重复推送无副作用。
  const pushRelations = [
    ...localRelations.map((relation) => ({
      id: relation.id,
      sourceId: relation.sourceId,
      targetId: relation.targetId,
      createdAt: relation.createdAt,
      deleted: false
    })),
    ...relationTombstones.map((tombstone) => ({
      id: tombstoneTarget(tombstone),
      sourceId: '',
      targetId: '',
      createdAt: tombstone.deletedAt,
      deleted: true
    }))
  ];
  const pushAttachments = [
    // 只推本机上次同步之后新建的附件：附件元数据不可变，重复推送没有意义
    // （服务端也做了幂等，这里只是减少 payload）。
    ...localAttachments
      .filter((row) => !config.lastSyncAt || row.createdAt > config.lastSyncAt)
      .map((row) => ({
        id: row.id,
        noteId: row.noteId,
        name: row.name,
        mime: row.mime,
        size: row.size,
        hash: row.hash,
        createdAt: row.createdAt,
        deleted: false
      })),
    ...attachmentTombstones.map((tombstone) => ({
      id: tombstoneTarget(tombstone),
      noteId: '',
      name: '',
      mime: '',
      size: 0,
      hash: '',
      createdAt: tombstone.deletedAt,
      deleted: true
    }))
  ];

  let pushed = 0;
  let relationsPushed = 0;
  let attachmentsPushed = 0;
  let canvasPushed = 0;
  let serverTime = String(pull.body.serverTime ?? new Date().toISOString());
  const total =
    pushNotes.length +
    pushNotesDeleted.length +
    pushRelations.length +
    pushAttachments.length +
    canvasPayload.length;
  if (total > 0) {
    const push = await requestJson(fetchImpl, `${base}/api/v1/push`, config.token, {
      method: 'POST',
      body: JSON.stringify({
        deviceId: config.deviceId,
        deviceName: config.deviceName,
        notes: [...pushNotes, ...pushNotesDeleted],
        relations: pushRelations,
        attachments: pushAttachments,
        canvas: canvasPayload
      })
    });
    if (push.status === 401) throw new Error('同步 token 被拒绝');
    const applied = (push.body.applied as Array<{ id: string; revision: number }> | undefined) ?? [];
    for (const entry of applied) revisions[entry.id] = entry.revision;
    pushed = applied.length;
    relationsPushed = Number(push.body.relationsApplied ?? 0);
    attachmentsPushed = Number(push.body.attachmentsApplied ?? 0);
    canvasPushed = Number(push.body.canvasApplied ?? 0);
    const pushConflicts =
      (push.body.conflicts as Array<{ id: string; server?: RemoteNote }> | undefined) ?? [];
    for (const conflict of pushConflicts) {
      if (!conflict.server) continue;
      const localNote = afterPull.find((note) => note.id === conflict.id);
      if (localNote && !conflicts.some((item) => item.id === conflict.id)) {
        conflicts.push({ id: conflict.id, local: localNote, remote: conflict.server });
      }
    }
    const appliedIds = new Set(applied.map((entry) => entry.id));
    await clearTombstones(
      [
        ...noteTombstones.filter((tombstone) => appliedIds.has(tombstoneTarget(tombstone))).map((t) => t.id),
        ...relationTombstones.map((t) => t.id),
        ...attachmentTombstones.map((t) => t.id)
      ],
      database
    );
    serverTime = String(push.body.serverTime ?? serverTime);
  }

  // 附件文件本体：只传还没传过的，每轮最多 5 个，避免拖慢同步。
  const uploadedRaw = await getMetaValue('uploaded_blob_ids', database);
  let uploadedIds: string[] = [];
  try {
    uploadedIds = uploadedRaw ? (JSON.parse(uploadedRaw) as string[]) : [];
  } catch {
    uploadedIds = [];
  }
  const uploaded = new Set(uploadedIds);
  const pendingUploads = localAttachments.filter((row) => !uploaded.has(row.id)).slice(0, 5);
  if (pendingUploads.length > 0) {
    for (const row of pendingUploads) {
      try {
        if (await uploadAttachmentBlob(config, row, fetchImpl)) uploaded.add(row.id);
      } catch {
        // 网络不稳就下一轮再试，元数据已经同步过了
      }
    }
    await setMetaValue('uploaded_blob_ids', JSON.stringify([...uploaded]), database);
  }

  return {
    pulled,
    pushed,
    relationsPulled,
    relationsPushed,
    attachmentsPulled,
    attachmentsPushed,
    canvasPulled,
    canvasPushed,
    conflicts,
    serverTime,
    revisions
  };
}

export async function resolveSyncConflict(
  conflict: SyncConflict,
  choice: SyncConflictChoice,
  config: SyncConfig,
  database: PkeDatabase = db,
  fetchImpl: FetchLike = fetch
): Promise<Record<string, number>> {
  if (choice === 'remote') {
    await updateNote(
      conflict.local.id,
      {
        title: conflict.remote.title,
        body: conflict.remote.body,
        tags: conflict.remote.tags,
        folder: conflict.remote.folder
      },
      database
    );
    return { ...config.revisions, [conflict.id]: conflict.remote.revision };
  }

  if (choice === 'local') {
    const base = config.serverUrl.replace(/\/+$/, '');
    const result = await requestJson(fetchImpl, `${base}/api/v1/push`, config.token, {
      method: 'POST',
      body: JSON.stringify({
        deviceId: config.deviceId,
        notes: [
          {
            id: conflict.local.id,
            title: conflict.local.title,
            body: conflict.local.body,
            tags: conflict.local.tags,
            folder: conflict.local.folder,
            updatedAt: conflict.local.updatedAt,
            baseRevision: conflict.remote.revision
          }
        ]
      })
    });
    const applied = (result.body.applied as Array<{ id: string; revision: number }> | undefined) ?? [];
    const revision = applied[0]?.revision ?? conflict.remote.revision + 1;
    return { ...config.revisions, [conflict.id]: revision };
  }

  const copy: Note = {
    ...conflict.remote,
    id: crypto.randomUUID(),
    workspaceId: 'local',
    title: `${conflict.remote.title}（冲突副本）`,
    createdAt: conflict.remote.updatedAt,
    updatedAt: new Date().toISOString()
  };
  await database.notes.add(copy);
  const base = config.serverUrl.replace(/\/+$/, '');
  const result = await requestJson(fetchImpl, `${base}/api/v1/push`, config.token, {
    method: 'POST',
    body: JSON.stringify({
      deviceId: config.deviceId,
      notes: [
        {
          id: copy.id,
          title: copy.title,
          body: copy.body,
          tags: copy.tags,
          folder: copy.folder,
          updatedAt: copy.updatedAt,
          baseRevision: null
        }
      ]
    })
  });
  const applied = (result.body.applied as Array<{ id: string; revision: number }> | undefined) ?? [];
  return { ...config.revisions, [copy.id]: applied[0]?.revision ?? 1 };
}
