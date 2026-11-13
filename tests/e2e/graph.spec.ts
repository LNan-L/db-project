import { expect, test } from '@playwright/test';

async function createNote(page: import('@playwright/test').Page, title: string, body = '') {
  const before = Number(await page.getByTestId('note-count').innerText());
  await page.getByTestId('new-note').click();
  await page.getByTestId('note-title').fill(title);
  const editor = page.locator('.milkdown .ProseMirror');
  await editor.click();
  if (body) await page.keyboard.insertText(body);
  if (body) await expect(editor).toContainText(body.replace(/\[\[|\]\]/g, ''));
  await page.getByTestId('save-note').click();
  await expect(page.getByTestId('save-status')).toContainText('已保存');
  await expect(page.getByTestId('note-count')).toHaveText(String(before + 1));
}

test('Phase 2 graph view, depth and search locate', async ({ page }) => {
  await page.goto('/');
  await createNote(page, '图谱 A', '[[图谱 B]]');
  await createNote(page, '图谱 B', '[[图谱 C]]');
  await createNote(page, '图谱 C', '终点');

  await page.getByTestId('graph-toggle').click();
  await expect(page.getByTestId('graph-canvas')).toBeVisible();
  await expect(page.getByTestId('graph-node')).toHaveCount(3);
  await expect(page.getByTestId('graph-edge')).toHaveCount(2);

  await page.getByTestId('graph-node').filter({ hasText: '图谱 A' }).click();
  await expect(page.getByTestId('graph-selected-label')).toContainText('图谱 A');

  await page.getByTestId('graph-depth-1').click();
  await expect(page.getByTestId('graph-node')).toHaveCount(2);
  await page.getByTestId('graph-depth-2').click();
  await expect(page.getByTestId('graph-node')).toHaveCount(3);
  await page.getByTestId('graph-depth-all').click();
  await expect(page.getByTestId('graph-node')).toHaveCount(3);

  await page.getByTestId('graph-zoom-in').click();
  await expect(page.getByTestId('graph-zoom')).toHaveText('110%');
  await page.getByTestId('graph-zoom-out').click();
  await expect(page.getByTestId('graph-zoom')).toHaveText('100%');

  // 拖动节点：节点 transform 改变
  const nodeA = page.getByTestId('graph-node').filter({ hasText: '图谱 A' });
  const beforeNode = await nodeA.getAttribute('transform');
  const nodeBox = await nodeA.boundingBox();
  expect(nodeBox).toBeTruthy();
  await page.mouse.move(nodeBox!.x + nodeBox!.width / 2, nodeBox!.y + nodeBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(nodeBox!.x + nodeBox!.width / 2 + 50, nodeBox!.y + nodeBox!.height / 2 + 30, { steps: 5 });
  await page.mouse.up();
  await expect(nodeA).not.toHaveAttribute('transform', beforeNode!);

  // 平移画布：viewport transform 改变
  const viewport = page.getByTestId('graph-viewport');
  const beforePan = await viewport.getAttribute('transform');
  const canvas = await page.getByTestId('graph-canvas').boundingBox();
  expect(canvas).toBeTruthy();
  await page.mouse.move(canvas!.x + 40, canvas!.y + 40);
  await page.mouse.down();
  await page.mouse.move(canvas!.x + 80, canvas!.y + 70, { steps: 5 });
  await page.mouse.up();
  await expect(viewport).not.toHaveAttribute('transform', beforePan!);

  await page.getByTestId('graph-search').fill('图谱 C');
  await page.getByTestId('graph-search-go').click();
  await expect(page.getByTestId('graph-selected-label')).toContainText('图谱 C');
  await page.getByTestId('open-graph-node').click();
  await expect(page.getByTestId('note-title')).toHaveValue('图谱 C');
});
