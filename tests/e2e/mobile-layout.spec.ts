import { expect, test } from '@playwright/test';

test('Phase 4 mobile single-column layout', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto('/');

  // Phase 4.5：首次进入会先弹引导页，先关掉再验证布局
  await expect(page.getByTestId('mobile-onboarding')).toBeVisible();
  await page.getByTestId('onboarding-skip').click();
  await expect(page.getByTestId('mobile-onboarding')).toHaveCount(0);

  // 列表态：侧栏占满，编辑器不占屏
  await expect(page.getByTestId('sidebar-sync')).toBeVisible();
  await expect(page.locator('.note-editor')).toBeHidden();

  await page.getByTestId('new-note').click();

  // 编辑态：单栏，编辑器占满宽度，列表让位
  const editor = page.locator('.note-editor');
  await expect(editor).toBeVisible();
  await expect(page.getByTestId('sidebar-sync')).toBeHidden();
  await expect(page.getByTestId('mobile-back')).toBeVisible();

  const box = await editor.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(300);

  const prose = page.locator('.milkdown .ProseMirror');
  await expect(prose).toBeVisible();
  const proseBox = await prose.boundingBox();
  // 立项书 A1：正文渲染宽度必须 > 240px，否则就是被挤成一条
  expect(proseBox?.width ?? 0).toBeGreaterThan(240);
  await page.getByTestId('note-title').fill('手机布局');
  await expect(page.getByTestId('note-title')).toHaveValue('手机布局');

  // 返回列表
  await page.getByTestId('mobile-back').click();
  await expect(page.getByTestId('sidebar-sync')).toBeVisible();
  await expect(page.locator('.note-editor')).toBeHidden();

  await context.close();
});