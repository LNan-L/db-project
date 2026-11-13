import { expect, test } from '@playwright/test';

async function addNote(
  page: import('@playwright/test').Page,
  title: string,
  body: string
): Promise<void> {
  await page.getByTestId('new-note').click();
  await page.getByTestId('note-title').fill(title);
  const editor = page.locator('.milkdown .ProseMirror');
  await editor.click();
  await page.keyboard.insertText(body);
  await page.getByTestId('save-note').click();
  await expect(page.getByTestId('save-status')).toContainText('已保存');
}

test('Phase 5.4 quality panel lists duplicates, orphans and broken links', async ({ page }) => {
  await page.goto('/');
  await addNote(page, '重复笔记', '相同内容用于测试合并');
  await addNote(page, '重复笔记', '相同内容用于测试合并');
  await addNote(page, '孤立笔记', '没有任何链接');
  await addNote(page, '链接源', '参见 [[不存在的目标]]');
  await expect(page.getByTestId('note-count')).toHaveText('4');

  await page.getByTestId('sidebar-quality').click();
  await expect(page.getByTestId('quality-panel')).toBeVisible();
  await expect(page.getByTestId('quality-summary')).toContainText('重复 1');
  await expect(page.getByTestId('quality-summary')).toContainText('断链 1');
  await expect(page.getByTestId('quality-duplicates')).toContainText('重复笔记');
  await expect(page.getByTestId('quality-orphans')).toContainText('孤立笔记');
  await expect(page.getByTestId('quality-broken')).toContainText('不存在的目标');
});

test('Phase 5.4 merges a duplicate and creates a missing target only after confirmation', async ({
  page
}) => {
  await page.goto('/');
  await addNote(page, '重复笔记', '相同内容用于测试合并');
  await addNote(page, '重复笔记', '相同内容用于测试合并');
  await addNote(page, '链接源', '参见 [[不存在的目标]]');
  await expect(page.getByTestId('note-count')).toHaveText('3');

  await page.getByTestId('sidebar-quality').click();
  await page.getByTestId('quality-merge-0').click();
  await expect(page.getByTestId('quality-merge-confirm-row')).toBeVisible();
  // 确认前不写库
  await page.getByTestId('quality-merge-cancel').click();
  await expect(page.getByTestId('note-count')).toHaveText('3');

  await page.getByTestId('quality-merge-0').click();
  await page.getByTestId('quality-merge-confirm').click();
  await expect(page.getByTestId('quality-message')).toContainText('已合并');
  await expect(page.getByTestId('note-count')).toHaveText('2');

  await page.getByTestId('quality-create-0').click();
  await expect(page.getByTestId('quality-create-confirm-row')).toBeVisible();
  await page.getByTestId('quality-create-confirm').click();
  await expect(page.getByTestId('quality-message')).toContainText('已创建目标笔记');
  await expect(page.getByTestId('note-count')).toHaveText('3');
  await expect(page.getByTestId('quality-broken')).toContainText('没有断链');
});
