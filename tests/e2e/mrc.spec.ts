import { expect, test } from '@playwright/test';

test('Phase 1 MRC six-step closed loop', async ({ page, browser }) => {
  await page.goto('/');

  await page.getByTestId('new-note').click();
  await page.getByTestId('note-title').fill('MRC 目标');
  let editor = page.locator('.milkdown .ProseMirror');
  await editor.click();
  await page.keyboard.insertText('目标内容');
  await page.getByTestId('save-note').click();
  await expect(page.getByTestId('save-status')).toContainText('已保存');

  await page.reload();
  await expect(page.getByTestId('note-title')).toHaveValue('MRC 目标');

  await page.getByTestId('new-note').click();
  await page.getByTestId('note-title').fill('MRC 来源');
  editor = page.locator('.milkdown .ProseMirror');
  await editor.click();
  await page.keyboard.insertText('参考 [[MRC 目标]]');
  await page.getByTestId('save-note').click();
  await page.locator('.pke-wikilink').first().click();
  await expect(page.getByTestId('note-title')).toHaveValue('MRC 目标');
  await expect(page.getByTestId('backlink-link')).toContainText('MRC 来源');

  await page.getByTestId('open-data').click();
  await page.getByTestId('backup-secret').fill('correct horse battery staple');
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('export-data').click();
  const download = await downloadPromise;
  const zipPath = await download.path();
  expect(zipPath).toBeTruthy();
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
  await blank.getByTestId('note-list').getByText('MRC 来源', { exact: true }).click();
  await expect(blank.getByTestId('outgoing-link')).toContainText('MRC 目标');

  await blank.getByTestId('search-input').fill('来源');
  await expect(blank.getByTestId('search-count')).toHaveText('找到 1 条');
  await blank.getByTestId('search-result').click();
  await expect(blank.getByTestId('note-title')).toHaveValue('MRC 来源');

  await blankContext.close();
});
