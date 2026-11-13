import { expect, test } from '@playwright/test';
import { buildSyncLink } from '../../src/sync/shareConfig';

test('Phase 4A2 sync panel renders a QR and a copyable link', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('sidebar-sync').click();
  await page.getByTestId('sync-share').click();

  await expect(page.getByTestId('sync-qr')).toBeVisible();
  const link = await page.getByTestId('sync-link').textContent();
  expect(link ?? '').toContain('#sync=');
  await expect(page.getByTestId('sync-copy-link')).toBeVisible();
});

test('Phase 4A2 opening a shared link pre-fills the sync config', async ({ page }) => {
  const link = buildSyncLink('', { serverUrl: 'https://shared.example.test', token: 'z'.repeat(40) });
  await page.goto('/' + link);

  await expect(page.getByTestId('sync-panel')).toBeVisible();
  await expect(page.getByTestId('sync-server')).toHaveValue('https://shared.example.test');
  await expect(page.getByTestId('sync-imported')).toBeVisible();
  await expect(page.locator('#root')).toHaveCount(1);
});

test('Phase 4A2 a loopback address in the link falls back to the page origin', async ({ page }) => {
  // PC 的同步地址是 127.0.0.1:3000；手机扫到它必须换成自己能访问的 origin
  const link = buildSyncLink('', { serverUrl: 'http://127.0.0.1:3000', token: 'y'.repeat(40) });
  await page.goto('/' + link);
  await expect(page.getByTestId('sync-server')).toHaveValue('http://127.0.0.1:4273');
  await expect(page.getByTestId('sync-imported')).toBeVisible();
});
