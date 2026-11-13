import { expect, test } from '@playwright/test';

test('Phase 1 production CRUD and Markdown persistence', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Personal Knowledge Engine' })).toBeVisible();
  await expect(page.getByTestId('empty-list')).toBeVisible();

  await page.getByTestId('new-note').click();
  await expect(page.getByTestId('note-title')).toBeVisible();
  await page.getByTestId('note-title').fill('生产笔记');

  const editor = page.locator('.milkdown .ProseMirror');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.insertText('这是 Phase 1 生产实现的第一段。');

  await page.getByTestId('save-note').click();
  await expect(page.getByTestId('save-status')).toContainText('已保存');

  await page.reload();
  await expect(page.getByTestId('note-title')).toHaveValue('生产笔记');
  await expect(page.locator('.milkdown .ProseMirror')).toContainText('这是 Phase 1 生产实现的第一段。');

  await page.getByTestId('note-title').fill('生产笔记（改名）');
  await page.getByTestId('save-note').click();
  await expect(page.getByTestId('save-status')).toContainText('已保存');
  await page.reload();
  await expect(page.getByTestId('note-title')).toHaveValue('生产笔记（改名）');

  page.on('dialog', (dialog) => void dialog.accept());
  await page.getByTestId('delete-note').click();
  await expect(page.getByTestId('empty-list')).toBeVisible();
  await expect(page.getByTestId('note-count')).toHaveText('0');
});
