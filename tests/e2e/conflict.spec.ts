import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';

test('Phase 3 conflict preview resolves remote without silent overwrite', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('new-note').click();
  await page.getByTestId('note-title').fill('冲突笔记');
  const editor = page.locator('.milkdown .ProseMirror');
  await editor.click();
  await page.keyboard.insertText('本地正文');
  await page.getByTestId('save-note').click();
  await expect(page.getByTestId('save-status')).toContainText('已保存');

  const noteId = await page.locator('[data-testid="note-list"] .note-item').first().getAttribute('data-note-id');
  expect(noteId).toBeTruthy();

  const content = `---
id: ${noteId}
title: 冲突笔记
created: 2026-11-09T00:00:00.000Z
updated: 2026-11-10T00:00:00.000Z
tags: []
folder: ''
schema_version: 2
---
远端正文
`;
  const hash = createHash('sha256').update(content).digest('hex');
  const manifest = {
    app: 'pke',
    schema_version: 2,
    exported_at: '2026-11-10T00:00:00.000Z',
    notes: [
      {
        id: noteId,
        path: 'notes/冲突笔记.md',
        title: '冲突笔记',
        hash,
        tags: [],
        folder: '',
        created_at: '2026-11-09T00:00:00.000Z',
        updated_at: '2026-11-10T00:00:00.000Z'
      }
    ],
    relations: [],
    attachments: []
  };
  const zip = zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest)),
    'notes/冲突笔记.md': strToU8(content)
  });

  await page.getByTestId('open-data').click();
  await page.getByTestId('import-file').setInputFiles({
    name: 'conflict.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(zip)
  });
  await expect(page.getByTestId('import-preview')).toContainText('冲突 1');
  const conflict = page.getByTestId('conflict-item');
  await expect(conflict).toContainText('本地正文');
  await expect(conflict).toContainText('远端正文');

  await page.getByTestId('conflict-remote').click();
  await page.getByTestId('confirm-import').click();
  await page.getByTestId('close-data').click();
  await expect(editor).toContainText('远端正文');
  await expect(editor).not.toContainText('本地正文');
});
