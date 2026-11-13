import { expect, test } from '@playwright/test';

test('Phase 1 production wikilinks and backlinks', async ({ page }) => {
  await page.goto('/');

  // 目标笔记
  await page.getByTestId('new-note').click();
  await page.getByTestId('note-title').fill('链接目标');
  let editor = page.locator('.milkdown .ProseMirror');
  await editor.click();
  await page.keyboard.insertText('目标正文');
  await page.getByTestId('save-note').click();
  await expect(page.getByTestId('save-status')).toContainText('已保存');

  // 来源笔记，正文含双链
  await page.getByTestId('new-note').click();
  await page.getByTestId('note-title').fill('链接源');
  editor = page.locator('.milkdown .ProseMirror');
  await editor.click();
  await page.keyboard.insertText('参考 [[链接目标]]');
  await page.getByTestId('save-note').click();
  await expect(page.getByTestId('save-status')).toContainText('已保存');

  // 出链面板 + 编辑器内点击
  await expect(page.getByTestId('outgoing-link')).toContainText('链接目标');
  await expect(page.locator('.pke-wikilink').first()).toContainText('链接目标');
  await page.locator('.pke-wikilink').first().click();
  await expect(page.getByTestId('note-title')).toHaveValue('链接目标');

  // 目标笔记的反向引用
  await expect(page.getByTestId('backlink-link')).toContainText('链接源');
});
