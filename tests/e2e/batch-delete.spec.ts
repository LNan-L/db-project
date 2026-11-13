import { expect, test } from '@playwright/test';

test('Phase 1 production batch delete and folder management', async ({ page }) => {
  await page.goto('/');

  await page.getByTestId('new-note').click();
  await page.getByTestId('note-title').fill('移动笔记');
  const editor = page.locator('.milkdown .ProseMirror');
  await editor.click();
  await page.keyboard.insertText('移动到项目文件夹');
  await page.getByTestId('note-folder').fill('项目');
  await page.getByTestId('save-note').click();
  await expect(page.getByTestId('save-status')).toContainText('已保存');

  await page.reload();
  await expect(page.getByTestId('note-folder')).toHaveValue('项目', { timeout: 15000 });
  await page.getByTestId('folder-项目').click();
  await expect(page.getByTestId('note-count')).toHaveText('1', { timeout: 15000 });
  await expect(page.getByTestId('note-list').getByText('移动笔记', { exact: true })).toBeVisible();

  await page.getByTestId('folder-filter').getByRole('button', { name: '全部目录' }).click();
  await page.getByTestId('new-note').click();
  await page.getByTestId('note-title').fill('批量二');
  await page.getByTestId('save-note').click();
  await expect(page.getByTestId('save-status')).toContainText('已保存');
  await expect(page.getByTestId('note-count')).toHaveText('2', { timeout: 15000 });

  await page.getByTestId('batch-toggle').click();
  const checkboxes = page.getByTestId('select-note');
  await expect(checkboxes).toHaveCount(2, { timeout: 15000 });
  await checkboxes.nth(0).check();
  await checkboxes.nth(1).check();
  await expect(page.getByTestId('batch-delete')).toContainText('2');

  page.on('dialog', (dialog) => void dialog.accept());
  await page.getByTestId('batch-delete').click();
  await expect(page.getByTestId('empty-list')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('note-count')).toHaveText('0');
});
