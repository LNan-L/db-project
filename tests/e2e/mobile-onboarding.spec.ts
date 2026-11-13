import { expect, test } from '@playwright/test';

test('mobile onboarding shows once and can be skipped', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto('/');

  await expect(page.getByTestId('mobile-onboarding')).toBeVisible();
  await expect(page.getByTestId('mobile-onboarding')).toContainText('欢迎使用 PKE');
  await expect(page.getByTestId('mobile-onboarding')).toContainText('配置二维码');

  await page.getByTestId('onboarding-skip').click();
  await expect(page.getByTestId('mobile-onboarding')).toHaveCount(0);

  // 关过之后（标记已写库）再打开不该再弹
  await page.waitForTimeout(300);
  await page.reload();
  await expect(page.getByTestId('sidebar-sync')).toBeVisible();
  await page.waitForTimeout(400);
  await expect(page.getByTestId('mobile-onboarding')).toHaveCount(0);

  await context.close();
});

test('onboarding opens the sync panel and will not nag again', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto('/');

  await page.getByTestId('onboarding-open-sync').click();
  await expect(page.getByTestId('sync-panel')).toBeVisible();
  await expect(page.getByTestId('mobile-onboarding')).toHaveCount(0);

  await page.getByTestId('close-sync').click();
  await page.waitForTimeout(300);
  await page.reload();
  await expect(page.getByTestId('sidebar-sync')).toBeVisible();
  await page.waitForTimeout(400);
  await expect(page.getByTestId('mobile-onboarding')).toHaveCount(0);

  await context.close();
});

test('desktop does not show the mobile onboarding', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('new-note')).toBeVisible();
  await expect(page.getByTestId('mobile-onboarding')).toHaveCount(0);
});
