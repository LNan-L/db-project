import { expect, test } from '@playwright/test';

test('Phase 1 production offline read/write', async ({ page, context }) => {
  await page.goto('/');
  await page.getByTestId('new-note').click();
  await page.getByTestId('note-title').fill('离线生产笔记');
  const editor = page.locator('.milkdown .ProseMirror');
  await editor.click();
  await page.keyboard.insertText('断网后还要能看到');
  await page.getByTestId('save-note').click();
  await expect(page.getByTestId('save-status')).toContainText('已保存');

  await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) throw new Error('service worker unavailable');
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect(page.getByTestId('note-title')).toHaveValue('离线生产笔记');

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId('note-title')).toHaveValue('离线生产笔记');
  await expect(page.locator('.milkdown .ProseMirror')).toContainText('断网后还要能看到');

  await page.getByTestId('note-title').fill('离线生产笔记（断网改名）');
  await page.getByTestId('save-note').click();
  await expect(page.getByTestId('save-status')).toContainText('已保存');

  await context.setOffline(false);
  await page.reload();
  await expect(page.getByTestId('note-title')).toHaveValue('离线生产笔记（断网改名）');
});
