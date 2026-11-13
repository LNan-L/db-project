import { expect, test } from '@playwright/test';

async function createNote(page: import('@playwright/test').Page, title: string) {
  await page.getByTestId('new-note').click();
  await page.getByTestId('note-title').fill(title);
  await page.getByTestId('save-note').click();
  await expect(page.getByTestId('save-status')).toContainText('已保存');
}

test('Phase 2 manual graph relations are distinct and persist', async ({ page }) => {
  await page.goto('/');
  await createNote(page, '关系 A');
  await createNote(page, '关系 B');

  await page.getByTestId('graph-toggle').click();
  await expect(page.getByTestId('graph-node')).toHaveCount(2);
  await page.getByTestId('graph-node').filter({ hasText: '关系 A' }).click();
  await page.getByTestId('graph-relation-target').selectOption({ label: '关系 B' });
  await page.getByTestId('graph-add-relation').click();

  const manualEdge = page.locator('[data-testid="graph-edge"][data-kind="manual"]');
  await expect(manualEdge).toHaveCount(1);
  await expect(page.getByTestId('graph-edge')).toHaveCount(1);
  await page.getByTestId('open-graph-node').click();
  await expect(page.getByTestId('note-title')).toHaveValue('关系 A');

  await page.reload();
  await page.getByTestId('graph-toggle').click();
  await page.getByTestId('graph-node').filter({ hasText: '关系 A' }).click();
  await expect(manualEdge).toHaveCount(1);
  await page.getByTestId('graph-remove-relation').click();
  await expect(manualEdge).toHaveCount(0);
});
