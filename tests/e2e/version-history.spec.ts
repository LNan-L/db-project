import { expect, test } from '@playwright/test';

test('Phase 3 note version history and restore', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('new-note').click();
  await page.getByTestId('note-title').fill('版本笔记');

  const editor = page.locator('.milkdown .ProseMirror');
  await editor.click();
  await page.keyboard.insertText('版本一');
  await page.getByTestId('save-note').click();
  await expect(page.getByTestId('save-status')).toContainText('已保存');

  await editor.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.insertText('版本二');
  await page.getByTestId('save-note').click();
  await expect(page.getByTestId('save-status')).toContainText('已保存');

  await page.getByTestId('open-history').click();
  const items = page.getByTestId('version-item');
  await expect(items.first()).toBeVisible();
  expect(await items.count()).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId('version-list')).toContainText('版本一');

  page.once('dialog', (dialog) => void dialog.accept());
  await items.filter({ hasText: '版本一' }).getByTestId('restore-version').click();
  await page.getByTestId('close-history').click();
  await expect(editor).toContainText('版本一');
  await expect(page.getByTestId('save-status')).toContainText('已保存');
});
