import { expect, test } from '@playwright/test';

test('Phase 1 topbar actions stay visible at high DPI width', async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 800 });
  await page.goto('/');
  await expect(page.getByTestId('open-data')).toBeVisible();
  await expect(page.getByTestId('new-note')).toBeVisible();
});
