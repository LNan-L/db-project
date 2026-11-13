import { expect, test } from '@playwright/test';

test('Phase 1 production search opens and highlights hits', async ({ page }) => {
  await page.goto('/');

  await page.getByTestId('new-note').click();
  await page.getByTestId('note-title').fill('项目计划');
  let editor = page.locator('.milkdown .ProseMirror');
  await editor.click();
  await page.keyboard.insertText('PKE 第一周施工顺序');
  await page.getByTestId('save-note').click();
  await expect(page.getByTestId('save-status')).toContainText('已保存');

  await page.getByTestId('new-note').click();
  await page.getByTestId('note-title').fill('会议记录');
  editor = page.locator('.milkdown .ProseMirror');
  await editor.click();
  await page.keyboard.insertText('讨论 alpha 检索');
  await page.getByTestId('save-note').click();
  await expect(page.getByTestId('save-status')).toContainText('已保存');

  await page.getByTestId('search-input').fill('alpha');
  await expect(page.getByTestId('search-count')).toHaveText('找到 1 条');
  await expect(page.getByTestId('search-result')).toContainText('会议记录');
  await page.getByTestId('search-result').click();
  await expect(page.getByTestId('note-title')).toHaveValue('会议记录');
  await expect(page.locator('.pke-search-hit').first()).toContainText('alpha');

  await page.getByTestId('search-input').fill('施工');
  await expect(page.getByTestId('search-result')).toContainText('项目计划');

  await page.getByTestId('search-input').fill('zzz-not-found');
  await expect(page.getByTestId('search-count')).toHaveText('找到 0 条');

  await page.getByTestId('clear-search').click();
  await expect(page.getByTestId('search-results')).toHaveCount(0);
  await expect(page.getByTestId('note-count')).toHaveText('2');
});
