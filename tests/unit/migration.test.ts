import Dexie from 'dexie';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureSchema, PkeDatabase } from '../../src/storage/db';
import { sha256Hex } from '../../src/migration/hash';
import {
  importPrototypePackage,
  parsePrototypePackage
} from '../../src/migration/prototypePackage';

let seq = 0;
const names: string[] = [];
const instances: PkeDatabase[] = [];

function makeDb(): PkeDatabase {
  const name = `pke-phase1-migration-${Date.now()}-${++seq}`;
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

function noteFile(id: string, title: string, body: string, tags: string[], folder: string): string {
  return `---
id: ${id}
title: ${title}
created: 2026-11-08T00:00:00.000Z
updated: 2026-11-08T00:00:00.000Z
tags: [${tags.join(', ')}]
folder: ${folder}
schema_version: 5
---

${body}
`;
}

async function buildPackage(): Promise<Uint8Array> {
  const noteA = noteFile('id-a', '来源', '参考 [[目标]]', ['pke'], '项目');
  const noteB = noteFile('id-b', '目标', '正文', ['pke'], '项目');
  const attachmentBytes = new Uint8Array([1, 2, 3, 4]);
  const noteAHash = await sha256Hex(noteA);
  const noteBHash = await sha256Hex(noteB);
  const attachmentHash = await sha256Hex(attachmentBytes);

  const manifest = {
    app: 'pke',
    schema_version: 5,
    exported_at: '2026-11-08T00:00:00.000Z',
    notes: [
      {
        id: 'id-a',
        path: 'notes/项目/来源-id-a.md',
        title: '来源',
        hash: noteAHash,
        tags: ['pke'],
        folder: '项目',
        created_at: '2026-11-08T00:00:00.000Z',
        updated_at: '2026-11-08T00:00:00.000Z'
      },
      {
        id: 'id-b',
        path: 'notes/项目/目标-id-b.md',
        title: '目标',
        hash: noteBHash,
        tags: ['pke'],
        folder: '项目',
        created_at: '2026-11-08T00:00:00.000Z',
        updated_at: '2026-11-08T00:00:00.000Z'
      }
    ],
    relations: [
      {
        source_id: 'id-a',
        target_id: 'id-b',
        target: '目标',
        type: 'wikilink'
      }
    ],
    attachments: [
      {
        id: 'att-1',
        note_id: 'id-a',
        name: 'a.bin',
        path: 'attachments/att-1-a.bin',
        hash: attachmentHash,
        size: attachmentBytes.byteLength,
        mime: 'application/octet-stream'
      }
    ]
  };

  return zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
    'notes/项目/来源-id-a.md': strToU8(noteA),
    'notes/项目/目标-id-b.md': strToU8(noteB),
    'attachments/att-1-a.bin': attachmentBytes
  });
}

describe('prototype package migration', () => {
  it('preserves ids, body, tags, folder, attachment hash and links', async () => {
    const database = makeDb();
    await ensureSchema(database);
    const data = await buildPackage();
    const parsed = await parsePrototypePackage(data);
    expect(parsed.notes).toHaveLength(2);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.links).toHaveLength(1);

    const summary = await importPrototypePackage(data, database);
    expect(summary).toMatchObject({
      notesImported: 2,
      attachmentsImported: 1,
      linksImported: 1
    });

    const noteA = await database.notes.get('id-a');
    expect(noteA?.body).toBe('参考 [[目标]]');
    expect(noteA?.tags).toEqual(['pke']);
    expect(noteA?.folder).toBe('项目');
    expect(noteA?.workspaceId).toBe('local');

    const attachment = await database.attachments.get('att-1');
    expect(attachment?.hash).toBe(await sha256Hex(new Uint8Array([1, 2, 3, 4])));
    expect(attachment?.noteId).toBe('id-a');

    const link = await database.note_links.get('link:id-a:id-b:wikilink');
    expect(link?.sourceId).toBe('id-a');
    expect(link?.targetId).toBe('id-b');
    database.close();
  });

  it('is idempotent on repeated import', async () => {
    const database = makeDb();
    await ensureSchema(database);
    const data = await buildPackage();
    await importPrototypePackage(data, database);
    const second = await importPrototypePackage(data, database);
    expect(second.notesImported).toBe(0);
    expect(second.notesSkipped).toBe(2);
    expect(second.attachmentsImported).toBe(0);
    expect(second.linksImported).toBe(0);
    expect(await database.notes.count()).toBe(2);
    expect(await database.attachments.count()).toBe(1);
    expect(await database.note_links.count()).toBe(1);
    database.close();
  });

  it('rejects a tampered note hash without writing', async () => {
    const database = makeDb();
    await ensureSchema(database);
    const data = await buildPackage();
    const entries = unzipSync(data);
    const notePath = Object.keys(entries).find((entry) => entry.endsWith('.md'));
    expect(notePath).toBeTruthy();
    entries[notePath!] = strToU8(`${strFromU8(entries[notePath!]!)}\n篡改`);
    const tampered = zipSync(entries);
    await expect(importPrototypePackage(tampered, database)).rejects.toThrow(/hash/);
    expect(await database.notes.count()).toBe(0);
    database.close();
  });
});
