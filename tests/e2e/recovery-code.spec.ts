import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('Phase 1 recovery code download and close confirmation', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('new-note').click();
  await page.getByTestId('note-title').fill('恢复码测试');
  await page.getByTestId('save-note').click();
  await expect(page.getByTestId('save-status')).toContainText('已保存');

  await page.getByTestId('open-data').click();
  await page.getByTestId('backup-secret').fill('correct horse battery staple');
  const backupDownload = page.waitForEvent('download');
  await page.getByTestId('export-data').click();
  await backupDownload;
  await expect(page.getByTestId('recovery-code')).toContainText('PKE-R-');
  const code = (await page.getByTestId('recovery-code').innerText()).trim();
  expect(code.length).toBeGreaterThan(10);

  const recoveryDownload = page.waitForEvent('download');
  await page.getByTestId('download-recovery').click();
  const file = await recoveryDownload;
  const path = await file.path();
  expect(path).toBeTruthy();
  const text = await readFile(path!, 'utf8');
  expect(text).toContain(code);

  // 未确认保存时关闭 -> 警告，取消后仍留在面板
  page.once('dialog', (dialog) => void dialog.dismiss());
  await page.getByTestId('close-data').click();
  await expect(page.getByTestId('data-panel')).toBeVisible();

  await page.getByTestId('recovery-confirmed').check();
  await page.getByTestId('close-data').click();
  await expect(page.getByTestId('data-panel')).toHaveCount(0);
});
