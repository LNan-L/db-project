import { expect, test } from '@playwright/test';

test('Phase 1 production tags and folders', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('new-note').click();
  await page.getByTestId('note-title').fill('标签与文件夹');

  const editor = page.locator('.milkdown .ProseMirror');
  await editor.click();
  await page.keyboard.insertText('这篇笔记属于项目目录，并带 pke 标签。');

  await page.getByTestId('note-folder').fill('项目');
  await page.getByTestId('tag-input').fill('pke');
  await page.getByTestId('tag-input').press('Enter');
  await expect(page.getByTestId('tag-chip').filter({ hasText: '#pke' })).toHaveCount(1);

  await page.getByTestId('save-note').click();
  await expect(page.getByTestId('save-status')).toContainText('已保存');

  await page.reload();
  await expect(page.getByTestId('note-title')).toHaveValue('标签与文件夹');
  await expect(page.getByTestId('note-folder')).toHaveValue('项目');
  await expect(page.getByTestId('tag-chip').filter({ hasText: '#pke' })).toHaveCount(1);

  // 文件夹过滤
  await page.getByTestId('folder-项目').click();
  await expect(page.getByTestId('note-count')).toHaveText('1');
  await expect(page.getByTestId('note-list').getByText('标签与文件夹', { exact: true })).toBeVisible();

  // 标签过滤（叠加后仍 1 条）
  await page.getByTestId('tag-filter').getByRole('button', { name: /#pke/ }).click();
  await expect(page.getByTestId('note-count')).toHaveText('1');

  // 重置目录，标签过滤仍生效
  await page.getByTestId('folder-filter').getByRole('button', { name: '全部目录' }).click();
  await expect(page.getByTestId('note-count')).toHaveText('1');

  // 移除标签后过滤区消失
  await page.getByRole('button', { name: '移除标签 pke' }).click();
  await page.getByTestId('save-note').click();
  await expect(page.getByTestId('save-status')).toContainText('已保存');
  await expect(page.getByTestId('tag-filter')).toHaveCount(0);
  await expect(page.getByTestId('note-count')).toHaveText('1');
});
