import { expect, test } from '@playwright/test';

async function createNote(page: import('@playwright/test').Page, title: string) {
  const before = Number(await page.getByTestId('note-count').innerText());
  await page.getByTestId('new-note').click();
  await page.getByTestId('note-title').fill(title);
  await page.getByTestId('save-note').click();
  await expect(page.getByTestId('save-status')).toContainText('已保存');
  await expect(page.getByTestId('note-count')).toHaveText(String(before + 1));
}

test('Phase 2 AI suggestion style placeholder is distinct and labeled', async ({ page }) => {
  await page.goto('/');
  await createNote(page, 'AI 占位 A');
  await createNote(page, 'AI 占位 B');
  await expect(page.getByTestId('note-count')).toHaveText('2');
  await page.getByTestId('graph-toggle').click();

  await expect(page.getByTestId('graph-ai-legend')).toContainText('AI 待审核建议');
  await expect(page.getByTestId('graph-node')).toHaveCount(2);
  await page.getByTestId('graph-node').filter({ hasText: 'AI 占位 A' }).click();
  await page.getByTestId('graph-relation-target').selectOption({ label: 'AI 占位 B' });
  await expect(page.getByTestId('graph-ai-preview')).toBeEnabled();
  await page.getByTestId('graph-ai-preview').click();

  const aiEdge = page.getByTestId('graph-edge-ai');
  await expect(aiEdge).toHaveCount(1);
  await expect(aiEdge).toHaveAttribute('data-kind', 'ai-suggestion');
  await expect(page.getByTestId('graph-message')).toContainText('占位');
  await page.getByTestId('graph-ai-preview').click();
  await expect(aiEdge).toHaveCount(0);
});
