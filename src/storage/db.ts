/**
 * @req REQ-101 — Phase 1 生产数据访问层。
 * @req REQ-107 — IndexedDB 本地持久化。
 */
import Dexie, { type Table } from 'dexie';
import { DEFAULT_WORKSPACE_ID, type Note } from '../domain/note';

export const SCHEMA_VERSION = 7;

export interface Workspace {
  id: string;
  name: string;
  createdAt: string;
}

export interface MetaRecord {
  key: string;
  value: string;
  updatedAt: string;
}

export interface Attachment {
  id: string;
  noteId: string;
  name: string;
  mime: string;
  size: number;
  hash: string;
  blob: Blob;
  createdAt: string;
}

export interface NoteLink {
  id: string;
  sourceId: string;
  targetId: string | null;
  target: string;
  type: 'wikilink';
  createdAt: string;
}

export interface ManualRelation {
  id: string;
  sourceId: string;
  targetId: string;
  createdAt: string;
}

export interface AttachmentRef {
  id: string;
  noteId: string;
  name: string;
  mime: string;
  size: number;
  hash: string;
  createdAt: string;
}

export interface SyncTombstone {
  id: string;
  kind: 'note' | 'relation' | 'attachment';
  deletedAt: string;
}

export interface NoteEmbedding {
  noteId: string;
  model: string;
  dimension: number;
  /** 生成索引时的笔记 updatedAt；不一致说明需要重建。 */
  noteUpdatedAt: string;
  updatedAt: string;
  chunks: Array<{ text: string; offset: number; vector: number[] }>;
}

export interface CanvasCard {
  noteId: string;
  x: number;
  y: number;
  createdAt: string;
  updatedAt: string;
}

export interface NoteVersion {
  id: string;
  noteId: string;
  title: string;
  body: string;
  tags: string[];
  folder: string;
  createdAt: string;
  source: 'save' | 'restore';
}

export class PkeDatabase extends Dexie {
  workspaces!: Table<Workspace, string>;
  notes!: Table<Note, string>;
  attachments!: Table<Attachment, string>;
  note_links!: Table<NoteLink, string>;
  relations!: Table<ManualRelation, string>;
  note_versions!: Table<NoteVersion, string>;
  sync_tombstones!: Table<SyncTombstone, string>;
  attachment_refs!: Table<AttachmentRef, string>;
  canvas_cards!: Table<CanvasCard, string>;
  embeddings!: Table<NoteEmbedding, string>;
  meta!: Table<MetaRecord, string>;

  constructor(name = 'pke') {
    super(name);
    this.version(1).stores({
      workspaces: 'id',
      notes: 'id, workspaceId, updatedAt, folder, *tags',
      meta: 'key'
    });
    this.version(2).stores({
      workspaces: 'id',
      notes: 'id, workspaceId, updatedAt, folder, *tags',
      attachments: 'id, noteId, hash',
      note_links: 'id, sourceId, targetId',
      meta: 'key'
    });
    this.version(3).stores({
      workspaces: 'id',
      notes: 'id, workspaceId, updatedAt, folder, *tags',
      attachments: 'id, noteId, hash',
      note_links: 'id, sourceId, targetId',
      relations: 'id, sourceId, targetId, createdAt',
      meta: 'key'
    });
    this.version(4).stores({
      workspaces: 'id',
      notes: 'id, workspaceId, updatedAt, folder, *tags',
      attachments: 'id, noteId, hash',
      note_links: 'id, sourceId, targetId',
      relations: 'id, sourceId, targetId, createdAt',
      note_versions: 'id, noteId, createdAt',
      meta: 'key'
    });
    // v5：删除墓碑，保证删除能同步出去（笔记 / 关系 / 附件）。
    this.version(5).stores({
      workspaces: 'id',
      notes: 'id, workspaceId, updatedAt, folder, *tags',
      attachments: 'id, noteId, hash',
      note_links: 'id, sourceId, targetId',
      relations: 'id, sourceId, targetId, createdAt',
      note_versions: 'id, noteId, createdAt',
      sync_tombstones: 'id, kind, deletedAt',
      attachment_refs: 'id, noteId, hash',
      meta: 'key'
    });
    // v6：无限画布卡片（REQ-201）。只存「哪篇笔记摆在哪」，不复制笔记内容。
    this.version(6).stores({
      workspaces: 'id',
      notes: 'id, workspaceId, updatedAt, folder, *tags',
      attachments: 'id, noteId, hash',
      note_links: 'id, sourceId, targetId',
      relations: 'id, sourceId, targetId, createdAt',
      note_versions: 'id, noteId, createdAt',
      sync_tombstones: 'id, kind, deletedAt',
      attachment_refs: 'id, noteId, hash',
      canvas_cards: 'noteId',
      meta: 'key'
    });
    // v7：本地向量索引（REQ-301）。只存本机，不参与同步/备份。
    this.version(7).stores({
      workspaces: 'id',
      notes: 'id, workspaceId, updatedAt, folder, *tags',
      attachments: 'id, noteId, hash',
      note_links: 'id, sourceId, targetId',
      relations: 'id, sourceId, targetId, createdAt',
      note_versions: 'id, noteId, createdAt',
      sync_tombstones: 'id, kind, deletedAt',
      attachment_refs: 'id, noteId, hash',
      canvas_cards: 'noteId',
      embeddings: 'noteId, model',
      meta: 'key'
    });
    this.workspaces = this.table('workspaces');
    this.notes = this.table('notes');
    this.attachments = this.table('attachments');
    this.note_links = this.table('note_links');
    this.relations = this.table('relations');
    this.note_versions = this.table('note_versions');
    this.sync_tombstones = this.table('sync_tombstones');
    this.attachment_refs = this.table('attachment_refs');
    this.canvas_cards = this.table('canvas_cards');
    this.embeddings = this.table('embeddings');
    this.meta = this.table('meta');
  }
}

export const db = new PkeDatabase();

export async function ensureSchema(database: PkeDatabase = db): Promise<void> {
  const workspace = await database.workspaces.get(DEFAULT_WORKSPACE_ID);
  if (!workspace) {
    await database.workspaces.put({
      id: DEFAULT_WORKSPACE_ID,
      name: '本地知识库',
      createdAt: new Date().toISOString()
    });
  }
  const meta = await database.meta.get('schema_version');
  if (!meta || meta.value !== String(SCHEMA_VERSION)) {
    await database.meta.put({
      key: 'schema_version',
      value: String(SCHEMA_VERSION),
      updatedAt: new Date().toISOString()
    });
  }
}
