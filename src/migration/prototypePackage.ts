/**
 * @req REQ-108 — 从 Phase 0 原型导出包迁移到 Phase 1 生产库。
 * @req MRC-05 — 保留笔记 ID、正文、附件 hash、关系映射。
 */
import { strFromU8, unzipSync } from 'fflate';
import { parse as parseYaml } from 'yaml';
import { ensureSchema, db, type Attachment, type NoteLink, type PkeDatabase } from '../storage/db';
import type { Note } from '../domain/note';
import { sha256Hex } from './hash';

export const PROTOTYPE_PACKAGE_SCHEMA = 5;
const MANIFEST_PATH = 'manifest.json';

interface PrototypeManifestNote {
  id: string;
  path: string;
  title: string;
  hash: string;
  tags: string[];
  folder?: string;
  created_at: string;
  updated_at: string;
}

interface PrototypeManifestAttachment {
  id: string;
  note_id: string;
  name: string;
  path: string;
  hash: string;
  size: number;
  mime: string;
}

interface PrototypeManifestRelation {
  source_id: string;
  target_id: string | null;
  target: string;
  type: 'wikilink';
}

interface PrototypeManifest {
  app: 'pke';
  schema_version: number;
  exported_at: string;
  notes: PrototypeManifestNote[];
  relations: PrototypeManifestRelation[];
  attachments: PrototypeManifestAttachment[];
}

export interface ParsedPrototypePackage {
  manifest: PrototypeManifest;
  notes: Note[];
  attachments: Attachment[];
  links: NoteLink[];
}

export interface PrototypeImportSummary {
  notesImported: number;
  notesSkipped: number;
  attachmentsImported: number;
  attachmentsSkipped: number;
  linksImported: number;
  linksSkipped: number;
}

function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!match) return { frontmatter: {}, body: content.replace(/\r?\n$/, '') };
  let frontmatter: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(match[1] ?? '');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      frontmatter = parsed as Record<string, unknown>;
    }
  } catch {
    frontmatter = {};
  }
  return {
    frontmatter,
    body: (match[2] ?? '').replace(/^\r?\n/, '').replace(/\r?\n$/, '')
  };
}

function asTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((tag): tag is string => typeof tag === 'string')
    .map((tag) => tag.trim().replace(/^#+/, ''))
    .filter(Boolean);
}

export async function parsePrototypePackage(data: Uint8Array): Promise<ParsedPrototypePackage> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(data);
  } catch {
    throw new Error('不是有效的 ZIP 包');
  }

  const manifestBytes = entries[MANIFEST_PATH];
  if (!manifestBytes) throw new Error('缺少 manifest.json');

  let manifest: PrototypeManifest;
  try {
    manifest = JSON.parse(strFromU8(manifestBytes)) as PrototypeManifest;
  } catch {
    throw new Error('manifest.json 不是有效 JSON');
  }

  if (manifest.app !== 'pke' || !Array.isArray(manifest.notes)) {
    throw new Error('manifest 结构不合法');
  }
  if (manifest.schema_version !== PROTOTYPE_PACKAGE_SCHEMA) {
    throw new Error(
      `原型包 schema_version=${manifest.schema_version}，当前迁移器只支持 ${PROTOTYPE_PACKAGE_SCHEMA}`
    );
  }

  const notes: Note[] = [];
  for (const entry of manifest.notes) {
    const bytes = entries[entry.path];
    if (!bytes) throw new Error(`笔记文件不存在：${entry.path}`);
    const actualHash = await sha256Hex(bytes);
    if (actualHash !== entry.hash) throw new Error(`笔记 hash 不匹配：${entry.path}`);

    const { frontmatter, body } = parseFrontmatter(strFromU8(bytes));
    const frontmatterId = typeof frontmatter.id === 'string' ? frontmatter.id : undefined;
    if (frontmatterId && frontmatterId !== entry.id) {
      throw new Error(`Frontmatter ID 与 manifest 不一致：${entry.path}`);
    }

    notes.push({
      id: entry.id,
      workspaceId: 'local',
      title:
        typeof frontmatter.title === 'string' && frontmatter.title.trim()
          ? frontmatter.title.trim()
          : entry.title,
      body,
      tags: asTags(frontmatter.tags ?? entry.tags),
      folder: typeof frontmatter.folder === 'string' ? frontmatter.folder.trim() : entry.folder ?? '',
      createdAt: entry.created_at,
      updatedAt: entry.updated_at
    });
  }

  const attachments: Attachment[] = [];
  for (const entry of manifest.attachments ?? []) {
    const bytes = entries[entry.path];
    if (!bytes) throw new Error(`附件不存在：${entry.path}`);
    const actualHash = await sha256Hex(bytes);
    if (actualHash !== entry.hash) throw new Error(`附件 hash 不匹配：${entry.path}`);
    if (bytes.byteLength !== entry.size) throw new Error(`附件大小不匹配：${entry.path}`);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    attachments.push({
      id: entry.id,
      noteId: entry.note_id,
      name: entry.name,
      mime: entry.mime,
      size: entry.size,
      hash: entry.hash,
      blob: new Blob([copy], { type: entry.mime }),
      createdAt: manifest.exported_at
    });
  }

  const links: NoteLink[] = (manifest.relations ?? []).map((relation) => ({
    id: `link:${relation.source_id}:${relation.target_id ?? relation.target}:${relation.type}`,
    sourceId: relation.source_id,
    targetId: relation.target_id,
    target: relation.target,
    type: relation.type,
    createdAt: manifest.exported_at
  }));

  return { manifest, notes, attachments, links };
}

export async function importPrototypePackage(
  data: Uint8Array,
  database: PkeDatabase = db
): Promise<PrototypeImportSummary> {
  await ensureSchema(database);
  const parsed = await parsePrototypePackage(data);
  const summary: PrototypeImportSummary = {
    notesImported: 0,
    notesSkipped: 0,
    attachmentsImported: 0,
    attachmentsSkipped: 0,
    linksImported: 0,
    linksSkipped: 0
  };

  await database.transaction(
    'rw',
    database.notes,
    database.attachments,
    database.note_links,
    async () => {
      for (const note of parsed.notes) {
        if (await database.notes.get(note.id)) {
          summary.notesSkipped += 1;
          continue;
        }
        await database.notes.add(note);
        summary.notesImported += 1;
      }

      for (const attachment of parsed.attachments) {
        if (await database.attachments.get(attachment.id)) {
          summary.attachmentsSkipped += 1;
          continue;
        }
        if (!(await database.notes.get(attachment.noteId))) {
          summary.attachmentsSkipped += 1;
          continue;
        }
        await database.attachments.add(attachment);
        summary.attachmentsImported += 1;
      }

      for (const link of parsed.links) {
        if (await database.note_links.get(link.id)) {
          summary.linksSkipped += 1;
          continue;
        }
        if (!(await database.notes.get(link.sourceId))) {
          summary.linksSkipped += 1;
          continue;
        }
        await database.note_links.add(link);
        summary.linksImported += 1;
      }
    }
  );

  return summary;
}
