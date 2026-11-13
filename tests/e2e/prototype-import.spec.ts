import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { strToU8, zipSync } from 'fflate';

test('Phase 1 imports a Phase 0 prototype schema 5 ZIP', async ({ page }) => {
  const body = '从原型迁移过来的正文';
  const content = `---
id: proto-note-1
title: 原型笔记
created: 2026-11-08T00:00:00.000Z
updated: 2026-11-08T00:00:00.000Z
tags:
  - imported
folder: 迁移
---
${body}
`;
  const hash = createHash('sha256').update(content).digest('hex');
  const manifest = {
    app: 'pke',
    schema_version: 5,
    exported_at: '2026-11-08T00:00:00.000Z',
    notes: [
      {
        id: 'proto-note-1',
        path: 'notes/原型笔记.md',
        title: '原型笔记',
        hash,
        tags: ['imported'],
        folder: '迁移',
        created_at: '2026-11-08T00:00:00.000Z',
        updated_at: '2026-11-08T00:00:00.000Z'
      }
    ],
    relations: [],
    attachments: []
  };
  const zip = zipSync({
    'manifest.json': strToU8(JSON.stringify(manifest)),
    'notes/原型笔记.md': strToU8(content)
  });

  await page.goto('/');
  await page.getByTestId('open-data').click();
  await page.getByTestId('import-file').setInputFiles({
    name: 'prototype-export.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from(zip)
  });
  await expect(page.getByTestId('import-preview')).toContainText('新增 1');
  await page.getByTestId('confirm-import').click();
  await page.getByTestId('close-data').click();

  await expect(page.getByTestId('note-count')).toHaveText('1');
  await expect(page.getByTestId('note-title')).toHaveValue('原型笔记');
  await expect(page.locator('.milkdown .ProseMirror')).toContainText(body);
  await expect(page.getByTestId('tag-chip').filter({ hasText: '#imported' })).toHaveCount(1);
  await expect(page.getByTestId('note-folder')).toHaveValue('迁移');
});
