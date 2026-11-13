/**
 * @req REQ-108 — 生产导出/导入：Markdown、manifest、schema_version、hash、关系。
 * @req REQ-603 — 生产同机备份 ZIP。
 */
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { Note } from '../domain/note';
import { newId } from '../lib/id';
import { buildLinkIndex, getOutgoingLinks } from '../domain/wikiLinks';
import {
  db,
  ensureSchema,
  type Attachment,
  type ManualRelation,
  type NoteLink,
  type PkeDatabase
} from '../storage/db';
import { sha256Hex } from '../migration/hash';
import { createStoredNote, updateNote } from '../storage/notes';

export const PACKAGE_SCHEMA_VERSION = 2;
const MANIFEST_PATH = 'manifest.json';

export interface ManifestNote {
  id: string;
  path: string;
  title: string;
  hash: string;
  tags: string[];
  folder: string;
  created_at: string;
  updated_at: string;
}

export interface ManifestRelation {
  source_id: string;
  target_id: string | null;
  target: string;
  type: 'wikilink' | 'manual';
}

export interface ManifestAttachment {
  id: string;
  note_id: string;
  name: string;
  path: string;
  hash: string;
  size: number;
  mime: string;
}

export interface ManifestCanvasCard {
  note_id: string;
  x: number;
  y: number;
  updated_at: string;
}

export interface Manifest {
  app: 'pke';
  schema_version: number;
  exported_at: string;
  notes: ManifestNote[];
  relations: ManifestRelation[];
  attachments: ManifestAttachment[];
  /** B-3：画布布局（可选，旧包没有）。 */
  canvas?: ManifestCanvasCard[];
}

export interface ParsedAttachment {
  manifest: ManifestAttachment;
  bytes: Uint8Array;
}

export interface ExportPackage {
  blob: Blob;
  fileName: string;
  manifest: Manifest;
}

export interface BuildExportOptions {
  attachments?: Attachment[];
  manualRelations?: ManualRelation[];
  /** B-3：画布布局；只导出属于本次笔记集合的卡片。 */
  canvasCards?: Array<{ noteId: string; x: number; y: number; updatedAt: string }>;
  exportedAt?: Date;
}

export interface ParsedPackage {
  manifest: Manifest;
  notes: Note[];
  relations: ManifestRelation[];
  attachments: ParsedAttachment[];
  canvas: ManifestCanvasCard[];
}

export interface ImportConflict {
  local: Note;
  remote: Note;
}

export type ConflictResolution = 'local' | 'remote' | 'copy';

export interface ImportPlan {
  notesToCreate: Note[];
  notesSkipped: number;
  pathRejected: number;
  conflicts: ImportConflict[];
  linksToCreate: NoteLink[];
  linksSkipped: number;
  relationsToCreate: ManualRelation[];
  relationsSkipped: number;
  attachmentsToCreate: Attachment[];
  attachmentsSkipped: number;
  /** B-3：恢复画布布局（只针对本次真正导入/已存在的笔记）。 */
  canvasToCreate: Array<{ noteId: string; x: number; y: number; createdAt: string; updatedAt: string }>;
  canvasSkipped: number;
}

export interface ImportSummary {
  notesImported: number;
  notesSkipped: number;
  pathRejected: number;
  linksImported: number;
  linksSkipped: number;
  relationsImported: number;
  relationsSkipped: number;
  attachmentsImported: number;
  attachmentsSkipped: number;
  canvasImported: number;
  canvasSkipped: number;
  conflictsResolved: number;
}

function slugify(value: string): string {
  const clean = value
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return Array.from(clean).slice(0, 40).join('') || 'note';
}

export function notePath(note: Note): string {
  const folder = note.folder.trim();
  return `${folder ? `notes/${slugify(folder)}/` : 'notes/'}${slugify(note.title)}-${note.id.slice(0, 8)}.md`;
}

export function serializeNote(note: Note): string {
  const frontmatter = {
    id: note.id,
    title: note.title,
    created: note.createdAt,
    updated: note.updatedAt,
    tags: note.tags,
    folder: note.folder,
    schema_version: PACKAGE_SCHEMA_VERSION
  };
  const yaml = stringifyYaml(frontmatter).replace(/\n$/, '');
  const body = note.body.endsWith('\n') ? note.body : `${note.body}\n`;
  return `---\n${yaml}\n---\n\n${body}`;
}

function parseNote(content: string, fallbackTitle: string, fallbackId: string): Note {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  let frontmatter: Record<string, unknown> = {};
  if (match) {
    try {
      const parsed = parseYaml(match[1] ?? '');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        frontmatter = parsed as Record<string, unknown>;
      }
    } catch {
      frontmatter = {};
    }
  }
  const now = new Date().toISOString();
  const tags = Array.isArray(frontmatter.tags)
    ? frontmatter.tags.filter((tag): tag is string => typeof tag === 'string').map((tag) => tag.replace(/^#+/, ''))
    : [];
  const body = match
    ? (match[2] ?? '').replace(/^\r?\n/, '').replace(/\r?\n$/, '')
    : content.replace(/\r?\n$/, '');

  return {
    id: typeof frontmatter.id === 'string' ? frontmatter.id : fallbackId,
    workspaceId: 'local',
    title: typeof frontmatter.title === 'string' && frontmatter.title.trim() ? frontmatter.title.trim() : fallbackTitle,
    body,
    tags,
    folder: typeof frontmatter.folder === 'string' ? frontmatter.folder.trim() : '',
    createdAt: typeof frontmatter.created === 'string' ? frontmatter.created : now,
    updatedAt: typeof frontmatter.updated === 'string' ? frontmatter.updated : now
  };
}

export async function buildExportPackage(
  notes: Note[],
  options: BuildExportOptions = {}
): Promise<ExportPackage> {
  const exportedAt = options.exportedAt ?? new Date();
  const index = buildLinkIndex(notes);
  const relations: ManifestRelation[] = [];
  for (const note of notes) {
    for (const link of getOutgoingLinks(note, index)) {
      relations.push({
        source_id: note.id,
        target_id: link.noteId,
        target: link.target,
        type: 'wikilink'
      });
    }
  }
  for (const relation of options.manualRelations ?? []) {
    const target = notes.find((note) => note.id === relation.targetId);
    relations.push({
      source_id: relation.sourceId,
      target_id: relation.targetId,
      target: target?.title ?? relation.targetId,
      type: 'manual'
    });
  }

  const manifestNotes: ManifestNote[] = [];
  const manifestAttachments: ManifestAttachment[] = [];
  const files: Record<string, Uint8Array> = {};
  const noteIds = new Set(notes.map((note) => note.id));
  for (const note of notes) {
    const content = serializeNote(note);
    const hash = await sha256Hex(content);
    const path = notePath(note);
    manifestNotes.push({
      id: note.id,
      path,
      title: note.title,
      hash,
      tags: note.tags,
      folder: note.folder,
      created_at: note.createdAt,
      updated_at: note.updatedAt
    });
    files[path] = strToU8(content);
  }

  for (const attachment of options.attachments ?? []) {
    if (!noteIds.has(attachment.noteId)) continue;
    const source = new Uint8Array(await attachment.blob.arrayBuffer());
    const bytes = new Uint8Array(source.byteLength);
    bytes.set(source);
    const hash = await sha256Hex(bytes);
    const path = `attachments/${attachment.id}-${slugify(attachment.name)}`;
    manifestAttachments.push({
      id: attachment.id,
      note_id: attachment.noteId,
      name: attachment.name,
      path,
      hash,
      size: attachment.size,
      mime: attachment.mime
    });
    files[path] = bytes;
  }

  const canvas: ManifestCanvasCard[] = (options.canvasCards ?? [])
    .filter((card) => noteIds.has(card.noteId))
    .map((card) => ({
      note_id: card.noteId,
      x: card.x,
      y: card.y,
      updated_at: card.updatedAt
    }));

  const manifest: Manifest = {
    app: 'pke',
    schema_version: PACKAGE_SCHEMA_VERSION,
    exported_at: exportedAt.toISOString(),
    notes: manifestNotes,
    relations,
    attachments: manifestAttachments,
    canvas
  };
  files[MANIFEST_PATH] = strToU8(JSON.stringify(manifest, null, 2));
  const zip = zipSync(files, { level: 6 });
  const blob = new Blob([zip], { type: 'application/zip' });
  const stamp = exportedAt.toISOString().replace(/[:.]/g, '-');
  return { blob, fileName: `pke-backup-${stamp}.zip`, manifest };
}

export function readPackageSchema(data: Uint8Array): number | null {
  try {
    const entries = unzipSync(data);
    const manifestBytes = entries[MANIFEST_PATH];
    if (!manifestBytes) return null;
    const parsed = JSON.parse(strFromU8(manifestBytes)) as { schema_version?: unknown };
    return typeof parsed.schema_version === 'number' ? parsed.schema_version : null;
  } catch {
    return null;
  }
}

export async function parsePackage(data: Uint8Array): Promise<ParsedPackage> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(data);
  } catch {
    throw new Error('不是有效的 ZIP 包');
  }
  const manifestBytes = entries[MANIFEST_PATH];
  if (!manifestBytes) throw new Error('缺少 manifest.json');

  let manifest: Manifest;
  try {
    manifest = JSON.parse(strFromU8(manifestBytes)) as Manifest;
  } catch {
    throw new Error('manifest.json 不是有效 JSON');
  }
  if (manifest.app !== 'pke' || !Array.isArray(manifest.notes)) throw new Error('manifest 结构不合法');
  if (manifest.schema_version !== PACKAGE_SCHEMA_VERSION) {
    throw new Error(`schema_version=${manifest.schema_version}，当前导入器只支持 ${PACKAGE_SCHEMA_VERSION}`);
  }

  const notes: Note[] = [];
  for (const entry of manifest.notes) {
    const bytes = entries[entry.path];
    if (!bytes) throw new Error(`笔记文件不存在：${entry.path}`);
    if ((await sha256Hex(bytes)) !== entry.hash) throw new Error(`笔记 hash 不匹配：${entry.path}`);
    notes.push(parseNote(strFromU8(bytes), entry.title, entry.id));
  }

  const attachments: ParsedAttachment[] = [];
  for (const entry of manifest.attachments ?? []) {
    const bytes = entries[entry.path];
    if (!bytes) throw new Error(`附件不存在：${entry.path}`);
    if ((await sha256Hex(bytes)) !== entry.hash) throw new Error(`附件 hash 不匹配：${entry.path}`);
    if (bytes.byteLength !== entry.size) throw new Error(`附件大小不匹配：${entry.path}`);
    attachments.push({ manifest: entry, bytes });
  }

  const canvas = Array.isArray(manifest.canvas)
    ? manifest.canvas
        .filter((card) => card && typeof card.note_id === 'string')
        .map((card) => ({
          note_id: card.note_id,
          x: Number(card.x) || 0,
          y: Number(card.y) || 0,
          updated_at: typeof card.updated_at === 'string' ? card.updated_at : new Date().toISOString()
        }))
    : [];
  return { manifest, notes, relations: manifest.relations ?? [], attachments, canvas };
}

export function parseMarkdownFiles(files: Array<{ name: string; text: string }>): Note[] {
  return files
    .filter((file) => file.name.toLowerCase().endsWith('.md'))
    .map((file) =>
      parseNote(
        file.text,
        file.name.replace(/\.md$/i, '') || '未命名笔记',
        newId()
      )
    );
}

export function planMarkdownImport(notes: Note[], existing: Note[]): ImportPlan {
  const existingIds = new Set(existing.map((note) => note.id));
  const existingPaths = new Set(existing.map(notePath));
  const notesToCreate: Note[] = [];
  let notesSkipped = 0;
  let pathRejected = 0;
  for (const note of notes) {
    if (existingIds.has(note.id)) {
      notesSkipped += 1;
      continue;
    }
    if (existingPaths.has(notePath(note))) {
      pathRejected += 1;
      continue;
    }
    notesToCreate.push(note);
  }
  return {
    notesToCreate,
    notesSkipped,
    pathRejected,
    conflicts: [],
    linksToCreate: [],
    linksSkipped: 0,
    relationsToCreate: [],
    relationsSkipped: 0,
    attachmentsToCreate: [],
    attachmentsSkipped: 0,
    canvasToCreate: [],
    canvasSkipped: 0
  };
}

export function planImport(parsed: ParsedPackage, existing: Note[]): ImportPlan {
  const existingById = new Map(existing.map((note) => [note.id, note]));
  const existingPaths = new Set(existing.map(notePath));
  const notesToCreate: Note[] = [];
  const conflicts: ImportConflict[] = [];
  let notesSkipped = 0;
  let pathRejected = 0;

  for (const note of parsed.notes) {
    const local = existingById.get(note.id);
    if (local) {
      const same =
        local.title === note.title &&
        local.body === note.body &&
        local.folder === note.folder &&
        local.tags.length === note.tags.length &&
        local.tags.every((tag, index) => tag === note.tags[index]);
      if (same) notesSkipped += 1;
      else conflicts.push({ local, remote: note });
      continue;
    }
    if (existingPaths.has(notePath(note))) {
      pathRejected += 1;
      continue;
    }
    notesToCreate.push(note);
  }

  const available = new Set([...existingById.keys(), ...notesToCreate.map((note) => note.id)]);
  const linksToCreate: NoteLink[] = [];
  const relationsToCreate: ManualRelation[] = [];
  let linksSkipped = 0;
  let relationsSkipped = 0;
  for (const relation of parsed.relations) {
    if (!available.has(relation.source_id)) {
      relation.type === 'manual' ? (relationsSkipped += 1) : (linksSkipped += 1);
      continue;
    }
    if (relation.type === 'manual') {
      if (!relation.target_id || !available.has(relation.target_id)) {
        relationsSkipped += 1;
        continue;
      }
      const [source, target] = [relation.source_id, relation.target_id].sort();
      relationsToCreate.push({
        id: `manual:${source}:${target}`,
        sourceId: source,
        targetId: target,
        createdAt: parsed.manifest.exported_at
      });
      continue;
    }
    if (relation.target_id && !available.has(relation.target_id)) {
      linksSkipped += 1;
      continue;
    }
    linksToCreate.push({
      id: `link:${relation.source_id}:${relation.target_id ?? relation.target}:wikilink`,
      sourceId: relation.source_id,
      targetId: relation.target_id,
      target: relation.target,
      type: 'wikilink',
      createdAt: parsed.manifest.exported_at
    });
  }

  const attachmentsToCreate: Attachment[] = [];
  let attachmentsSkipped = 0;
  for (const attachment of parsed.attachments) {
    if (!available.has(attachment.manifest.note_id)) {
      attachmentsSkipped += 1;
      continue;
    }
    const source = new Uint8Array(attachment.bytes.byteLength);
    source.set(attachment.bytes);
    attachmentsToCreate.push({
      id: attachment.manifest.id,
      noteId: attachment.manifest.note_id,
      name: attachment.manifest.name,
      mime: attachment.manifest.mime,
      size: attachment.manifest.size,
      hash: attachment.manifest.hash,
      blob: new Blob([source], { type: attachment.manifest.mime }),
      createdAt: parsed.manifest.exported_at
    });
  }
  // B-3：画布卡片只保留目标笔记存在的（导入前已存在或本次要导入）。
  const canvasToCreate: ImportPlan['canvasToCreate'] = [];
  let canvasSkipped = 0;
  const knownIds = new Set([
    ...existing.map((note) => note.id),
    ...notesToCreate.map((note) => note.id)
  ]);
  for (const card of parsed.canvas ?? []) {
    if (!knownIds.has(card.note_id)) {
      canvasSkipped += 1;
      continue;
    }
    canvasToCreate.push({
      noteId: card.note_id,
      x: card.x,
      y: card.y,
      createdAt: card.updated_at,
      updatedAt: card.updated_at
    });
  }

  return {
    notesToCreate,
    notesSkipped,
    pathRejected,
    conflicts,
    linksToCreate,
    linksSkipped,
    relationsToCreate,
    relationsSkipped,
    attachmentsToCreate,
    attachmentsSkipped,
    canvasToCreate,
    canvasSkipped
  };
}

export async function applyImportPlan(
  plan: ImportPlan,
  resolutions: Record<string, ConflictResolution> = {},
  database: PkeDatabase = db
): Promise<ImportSummary> {
  await ensureSchema(database);
  const summary: ImportSummary = {
    notesImported: 0,
    notesSkipped: plan.notesSkipped,
    pathRejected: plan.pathRejected,
    linksImported: 0,
    linksSkipped: plan.linksSkipped,
    relationsImported: 0,
    relationsSkipped: plan.relationsSkipped,
    attachmentsImported: 0,
    attachmentsSkipped: plan.attachmentsSkipped,
    canvasImported: 0,
    canvasSkipped: plan.canvasSkipped,
    conflictsResolved: 0
  };

  await database.transaction(
    'rw',
    [
      database.notes,
      database.note_links,
      database.relations,
      database.attachments,
      database.canvas_cards
    ],
    async () => {
    for (const note of plan.notesToCreate) {
      if (await database.notes.get(note.id)) {
        summary.notesSkipped += 1;
        continue;
      }
      await database.notes.add(note);
      summary.notesImported += 1;
    }
    for (const relation of plan.relationsToCreate) {
      if (await database.relations.get(relation.id)) {
        summary.relationsSkipped += 1;
        continue;
      }
      await database.relations.add(relation);
      summary.relationsImported += 1;
    }

    for (const attachment of plan.attachmentsToCreate) {
      if (await database.attachments.get(attachment.id)) {
        summary.attachmentsSkipped += 1;
        continue;
      }
      await database.attachments.add(attachment);
      summary.attachmentsImported += 1;
    }

    for (const link of plan.linksToCreate) {
      if (await database.note_links.get(link.id)) {
        summary.linksSkipped += 1;
        continue;
      }
      await database.note_links.add(link);
      summary.linksImported += 1;
    }

    // B-3：恢复画布布局；同一笔记已有卡片时保留当前设备摆放。
    for (const card of plan.canvasToCreate) {
      if (await database.canvas_cards.get(card.noteId)) {
        summary.canvasSkipped += 1;
        continue;
      }
      await database.canvas_cards.put(card);
      summary.canvasImported += 1;
    }
  }
  );

  for (const conflict of plan.conflicts) {
    const resolution = resolutions[conflict.local.id] ?? 'local';
    if (resolution === 'local') continue;
    if (resolution === 'remote') {
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
    } else {
      await createStoredNote(
        {
          title: `${conflict.remote.title}（冲突副本）`,
          body: conflict.remote.body,
          tags: conflict.remote.tags,
          folder: conflict.remote.folder
        },
        database
      );
    }
    summary.conflictsResolved += 1;
  }

  return summary;
}
