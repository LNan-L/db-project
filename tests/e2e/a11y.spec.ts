import { expect, test } from '@playwright/test';

test('B-7 Escape closes panels and focus returns to the trigger', async ({ page }) => {
  await page.goto('/');
  const trigger = page.getByTestId('sidebar-ai');
  await trigger.click();
  await expect(page.getByTestId('ai-panel')).toBeVisible();
  // 焦点应进入弹窗内部（优先第一个输入框）
  expect(
    await page.evaluate(() => Boolean(document.activeElement?.closest('[data-testid="ai-panel"]')))
  ).toBe(true);

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('ai-panel')).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('B-7 Tab cycles inside the dialog instead of escaping to the page', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('sidebar-ai').click();
  await expect(page.getByTestId('ai-panel')).toBeVisible();

  const inDialog = async () =>
    page.evaluate(() => Boolean(document.activeElement?.closest('[data-testid="ai-panel"]')));

  expect(await inDialog()).toBe(true);
  for (let i = 0; i < 40; i += 1) {
    await page.keyboard.press('Tab');
    expect(await inDialog()).toBe(true);
  }
});

test('B-7 graph nodes are keyboard reachable and labelled', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('new-note').click();
  await page.getByTestId('note-title').fill('键盘可达节点');
  await page.locator('.milkdown .ProseMirror').click();
  await page.keyboard.insertText('内容');
  await page.getByTestId('save-note').click();
  await expect(page.getByTestId('save-status')).toContainText('已保存');

  await page.getByTestId('graph-toggle').click();
  const node = page.locator('[data-testid="graph-node"]').first();
  await expect(node).toBeVisible();
  await expect(node).toHaveAttribute('role', 'button');
  await expect(node).toHaveAttribute('aria-label', /节点/);

  await node.focus();
  await page.keyboard.press('Enter');
  await expect(node).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('graph-selected-label')).toContainText('键盘可达节点');
});

test('B-7 graph canvas exposes an accessible summary label', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('new-note').click();
  await page.getByTestId('note-title').fill('图谱标签笔记');
  await page.locator('.milkdown .ProseMirror').click();
  await page.keyboard.insertText('内容');
  await page.getByTestId('save-note').click();
  await expect(page.getByTestId('save-status')).toContainText('已保存');

  await page.getByTestId('graph-toggle').click();
  const canvas = page.getByTestId('graph-canvas');
  await expect(canvas).toHaveAttribute('role', 'img');
  await expect(canvas).toHaveAttribute('aria-label', /知识图谱/);
});
