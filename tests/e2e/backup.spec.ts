import { expect, test } from '@playwright/test';

test('Phase 1 production export and blank import', async ({ page, browser }) => {
  await page.goto('/');

  await page.getByTestId('new-note').click();
  await page.getByTestId('note-title').fill('备份目标');
  let editor = page.locator('.milkdown .ProseMirror');
  await editor.click();
  await page.keyboard.insertText('目标正文');
  await page.getByTestId('tag-input').fill('backup');
  await page.getByTestId('tag-input').press('Enter');
  await page.getByTestId('note-folder').fill('项目');
  await page.getByTestId('save-note').click();
  await expect(page.getByTestId('save-status')).toContainText('已保存');

  await page.getByTestId('new-note').click();
  await page.getByTestId('note-title').fill('备份来源');
  editor = page.locator('.milkdown .ProseMirror');
  await editor.click();
  await page.keyboard.insertText('参考 [[备份目标]]');
  await page.getByTestId('save-note').click();
  await expect(page.getByTestId('save-status')).toContainText('已保存');

  await page.getByTestId('open-data').click();
  await page.getByTestId('backup-secret').fill('correct horse battery staple');
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('export-data').click();
  const download = await downloadPromise;
  const zipPath = await download.path();
  expect(zipPath).toBeTruthy();
  await expect(page.getByTestId('last-export')).not.toContainText('从未导出');
  await page.getByTestId('close-data').click();

  const blankContext = await browser.newContext();
  const blank = await blankContext.newPage();
  await blank.goto('/');
  await blank.getByTestId('open-data').click();
  await blank.getByTestId('backup-secret').fill('correct horse battery staple');
  await blank.getByTestId('import-file').setInputFiles(zipPath!);
  await expect(blank.getByTestId('import-preview')).toContainText('新增 2');
  await blank.getByTestId('confirm-import').click();
  await expect(blank.getByTestId('note-count')).toHaveText('2');
  await blank.getByTestId('close-data').click();

  await blank.getByTestId('note-list').getByText('备份来源', { exact: true }).click();
  await expect(blank.getByTestId('outgoing-link')).toContainText('备份目标');
  await blank.getByTestId('note-list').getByText('备份目标', { exact: true }).click();
  await expect(blank.getByTestId('tag-chip').filter({ hasText: '#backup' })).toHaveCount(1);
  await expect(blank.getByTestId('note-folder')).toHaveValue('项目');

  await blankContext.close();
});
