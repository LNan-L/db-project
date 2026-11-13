import Dexie from 'dexie';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import type { Note } from '../../src/domain/note';
import { ensureSchema, PkeDatabase, type Attachment, type ManualRelation } from '../../src/storage/db';
import { sha256Hex } from '../../src/migration/hash';
import {
  applyImportPlan,
  buildExportPackage,
  parseMarkdownFiles,
  parsePackage,
  planImport,
  planMarkdownImport
} from '../../src/backup/package';
import { needsBackupReminder } from '../../src/backup/reminder';

function note(id: string, title: string, body: string, tags: string[] = [], folder = ''): Note {
  return {
    id,
    workspaceId: 'local',
    title,
    body,
    tags,
    folder,
    createdAt: '2026-11-08T00:00:00.000Z',
    updatedAt: '2026-11-08T00:00:00.000Z'
  };
}

let seq = 0;
const names: string[] = [];
const instances: PkeDatabase[] = [];

function makeDb(): PkeDatabase {
  const name = `pke-phase1-package-${Date.now()}-${++seq}`;
  names.push(name);
  const database = new PkeDatabase(name);
  instances.push(database);
  return database;
}

afterEach(async () => {
  for (const database of instances.splice(0)) {
    try {
      database.close();
    } catch {
      // ignore
    }
  }
  for (const name of names.splice(0)) {
    await Dexie.delete(name);
  }
});

describe('production package', () => {
  it('exports, parses and imports notes with links/tags/folders', async () => {
    const notes = [
      note('id-a', '来源', '参考 [[目标]]', ['pke'], '项目'),
      note('id-b', '目标', '正文', ['pke'], '项目')
    ];
    const pkg = await buildExportPackage(notes, { exportedAt: new Date('2026-11-08T00:00:00.000Z') });
    expect(pkg.manifest.notes).toHaveLength(2);
    expect(pkg.manifest.relations).toHaveLength(1);
    expect(pkg.manifest.notes[0]?.hash).toMatch(/^[a-f0-9]{64}$/);

    const bytes = new Uint8Array(await pkg.blob.arrayBuffer());
    const parsed = await parsePackage(bytes);
    expect(parsed.notes).toHaveLength(2);

    const database = makeDb();
    await ensureSchema(database);
    const plan = planImport(parsed, []);
    expect(plan.notesToCreate).toHaveLength(2);
    const summary = await applyImportPlan(plan, {}, database);
    expect(summary.notesImported).toBe(2);
    expect(summary.linksImported).toBe(1);
    const restored = await database.notes.get('id-a');
    expect(restored?.tags).toEqual(['pke']);
    expect(restored?.folder).toBe('项目');
    expect(await database.note_links.get('link:id-a:id-b:wikilink')).toBeTruthy();
    database.close();
  });

  it('skips same id on repeated import', async () => {
    const notes = [note('id-a', '来源', '正文')];
    const pkg = await buildExportPackage(notes);
    const bytes = new Uint8Array(await pkg.blob.arrayBuffer());
    const parsed = await parsePackage(bytes);
    const database = makeDb();
    await ensureSchema(database);
    await applyImportPlan(planImport(parsed, []), {}, database);
    const second = planImport(parsed, await database.notes.toArray());
    expect(second.notesToCreate).toHaveLength(0);
    expect(second.notesSkipped).toBe(1);
    database.close();
  });

  it('exports and imports attachments with hash', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const hash = await sha256Hex(bytes);
    const attachment: Attachment = {
      id: 'att-1',
      noteId: 'id-a',
      name: 'a.bin',
      mime: 'application/octet-stream',
      size: bytes.byteLength,
      hash,
      blob: new Blob([bytes]),
      createdAt: '2026-11-08T00:00:00.000Z'
    };
    const notes = [note('id-a', '附件笔记', '正文')];
    const pkg = await buildExportPackage(notes, { attachments: [attachment] });
    expect(pkg.manifest.attachments).toHaveLength(1);
    expect(pkg.manifest.attachments[0]?.hash).toBe(hash);

    const parsed = await parsePackage(new Uint8Array(await pkg.blob.arrayBuffer()));
    expect(parsed.attachments).toHaveLength(1);
    const database = makeDb();
    await ensureSchema(database);
    const summary = await applyImportPlan(planImport(parsed, []), {}, database);
    expect(summary.attachmentsImported).toBe(1);
    const restored = await database.attachments.get('att-1');
    expect(restored?.hash).toBe(hash);
    expect(restored?.noteId).toBe('id-a');
    database.close();
  });

  it('imports raw Markdown files with filename titles', () => {
    const notes = parseMarkdownFiles([
      { name: 'Markdown 全要素.md', text: '# 标题一\n\n- 列表一' },
      { name: 'Logseq 页面.md', text: 'title:: Logseq 页面\n\n- 内容' }
    ]);
    expect(notes).toHaveLength(2);
    expect(notes[0]?.title).toBe('Markdown 全要素');
    expect(notes[0]?.body).toContain('- 列表一');
    expect(notes[1]?.title).toBe('Logseq 页面');
    expect(notes[1]?.body).toContain('title:: Logseq 页面');
    const plan = planMarkdownImport(notes, []);
    expect(plan.notesToCreate).toHaveLength(2);
  });

  it('rejects a tampered package without importing', async () => {
    const pkg = await buildExportPackage([note('id-a', '来源', '正文')]);
    const entries = unzipSync(new Uint8Array(await pkg.blob.arrayBuffer()));
    const path = Object.keys(entries).find((entry) => entry.endsWith('.md'));
    expect(path).toBeTruthy();
    entries[path!] = strToU8(`${strFromU8(entries[path!]!)}\n篡改`);
    const tampered = zipSync(entries);
    await expect(parsePackage(tampered)).rejects.toThrow(/hash/);
  });

  it('exports and imports manual relations', async () => {
    const notes = [note('id-a', '关系 A', '正文'), note('id-b', '关系 B', '正文')];
    const relation: ManualRelation = {
      id: 'manual:id-a:id-b',
      sourceId: 'id-a',
      targetId: 'id-b',
      createdAt: '2026-11-09T00:00:00.000Z'
    };
    const pkg = await buildExportPackage(notes, { manualRelations: [relation] });
    expect(pkg.manifest.relations.some((item) => item.type === 'manual')).toBe(true);

    const parsed = await parsePackage(new Uint8Array(await pkg.blob.arrayBuffer()));
    const database = makeDb();
    await ensureSchema(database);
    const summary = await applyImportPlan(planImport(parsed, []), {}, database);
    expect(summary.relationsImported).toBe(1);
    expect(await database.relations.get('manual:id-a:id-b')).toBeTruthy();
    database.close();
  });

  it('creates a whole-note conflict copy without overwriting local', async () => {
    const local = note('id-conflict', '冲突笔记', '本地正文');
    const remote = note('id-conflict', '冲突笔记', '远端正文');
    const pkg = await buildExportPackage([remote]);
    const parsed = await parsePackage(new Uint8Array(await pkg.blob.arrayBuffer()));
    const database = makeDb();
    await ensureSchema(database);
    await database.notes.add(local);

    const plan = planImport(parsed, [local]);
    expect(plan.conflicts).toHaveLength(1);
    const summary = await applyImportPlan(plan, { 'id-conflict': 'copy' }, database);
    expect(summary.conflictsResolved).toBe(1);
    expect((await database.notes.get('id-conflict'))?.body).toBe('本地正文');
    const rows = await database.notes.toArray();
    expect(rows).toHaveLength(2);
    expect(rows.some((item) => item.body === '远端正文' && item.id !== 'id-conflict')).toBe(true);
    database.close();
  });

  it('reminds when no export or older than 7 days', () => {
    const now = new Date('2026-11-08T12:00:00.000Z');
    expect(needsBackupReminder(null, now)).toBe(true);
    expect(needsBackupReminder('2026-11-08T00:00:00.000Z', now)).toBe(false);
    expect(needsBackupReminder('2026-10-01T00:00:00.000Z', now)).toBe(true);
  });
});
