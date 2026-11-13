import { expect, test } from '@playwright/test';

test('Phase 1 hardening: corrupt import, delete cancel, labels', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Personal Knowledge Engine' })).toBeVisible();
  await expect(page.getByRole('button', { name: '新建笔记' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '搜索笔记' })).toBeVisible();

  // 坏包：不写入任何笔记
  await page.getByTestId('open-data').click();
  await page.getByTestId('import-file').setInputFiles({
    name: 'bad.zip',
    mimeType: 'application/zip',
    buffer: Buffer.from('this is not a zip')
  });
  await expect(page.getByTestId('data-message')).toContainText('没有可导入');
  await page.getByTestId('close-data').click();
  await expect(page.getByTestId('note-count')).toHaveText('0');

  // 取消删除：笔记保留
  await page.getByTestId('new-note').click();
  await page.getByTestId('note-title').fill('取消删除笔记');
  await page.getByTestId('save-note').click();
  await expect(page.getByTestId('save-status')).toContainText('已保存');

  page.on('dialog', (dialog) => void dialog.dismiss());
  await page.getByTestId('delete-note').click();
  await expect(page.getByTestId('note-title')).toHaveValue('取消删除笔记');
  await expect(page.getByTestId('note-count')).toHaveText('1');
});
