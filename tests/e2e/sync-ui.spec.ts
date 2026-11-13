import { expect, test } from '@playwright/test';

test('Phase 3 sync panel validates server settings', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('sidebar-sync').click();
  await expect(page.getByTestId('sync-panel')).toBeVisible();
  await expect(page.getByTestId('sync-server')).toBeVisible();
  await expect(page.getByTestId('sync-token')).toBeVisible();
  await page.getByTestId('sync-server').fill('http://127.0.0.1:1');
  await page.getByTestId('sync-token').fill('x'.repeat(32));
  await page.getByTestId('sync-now').click();
  await expect(page.getByTestId('sync-message')).toContainText('同步失败');
  await page.getByTestId('close-sync').click();
});
