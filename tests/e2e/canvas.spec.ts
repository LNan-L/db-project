import { expect, test } from '@playwright/test';

/**
 * Phase 4.2 / REQ-201 无限画布验收：
 * 添加卡片 → 拖动移动 → 拖圆点建立连线 → 刷新后位置与连线都还在。
 */
test('infinite canvas: add, move, connect and keep layout after reload', async ({ page }) => {
  await page.goto('/');

  for (const title of ['画布甲', '画布乙']) {
    await page.getByTestId('new-note').click();
    await expect(page.getByTestId('note-title')).toBeVisible();
    await page.getByTestId('note-title').fill(title);
    await page.getByTestId('save-note').click();
    await expect(page.getByTestId('save-status')).toContainText('已保存');
  }

  await page.getByTestId('canvas-toggle').click();
  await expect(page.getByTestId('canvas-view')).toBeVisible();

  for (const title of ['画布甲', '画布乙']) {
    await page.getByTestId('canvas-note-select').selectOption({ label: title });
    await page.getByTestId('canvas-add-card').click();
  }
  await expect(page.getByTestId('canvas-card')).toHaveCount(2);

  const cardA = page.getByTestId('canvas-card').filter({ hasText: '画布甲' });
  const cardB = page.getByTestId('canvas-card').filter({ hasText: '画布乙' });
  const readPos = async (locator: typeof cardA) => {
    const x = Number(await locator.getAttribute('data-card-x'));
    const y = Number(await locator.getAttribute('data-card-y'));
    return { x, y };
  };
  const before = await cardA.boundingBox();
  const beforePos = await readPos(cardA);
  expect(before).not.toBeNull();

  // 移动：向左拖 80、向下拖 40（向左避免压住第二张卡片的连线把手）
  await page.mouse.move(before!.x + 90, before!.y + 40);
  await page.mouse.down();
  await page.mouse.move(before!.x + 10, before!.y + 80, { steps: 8 });
  await page.mouse.up();

  const movedPos = await readPos(cardA);
  expect(Math.abs(movedPos.x - (beforePos.x - 80))).toBeLessThan(2);
  expect(Math.abs(movedPos.y - (beforePos.y + 40))).toBeLessThan(2);

  // 连线：从甲右侧圆点拖到乙卡片中心
  const handle = cardA.getByTestId('canvas-handle');
  const handleBox = await handle.boundingBox();
  const targetBox = await cardB.boundingBox();
  expect(handleBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, {
    steps: 10
  });
  await page.mouse.up();

  await expect(page.getByTestId('canvas-edge')).toHaveCount(1);
  await expect(page.getByTestId('canvas-message')).toContainText('已建立连线');

  // 刷新：卡片位置与连线都要保持
  await page.reload();
  await page.getByTestId('canvas-toggle').click();
  await expect(page.getByTestId('canvas-card')).toHaveCount(2);
  await expect(page.getByTestId('canvas-edge')).toHaveCount(1);

  const reloadedPos = await readPos(page.getByTestId('canvas-card').filter({ hasText: '画布甲' }));
  expect(reloadedPos).toEqual(movedPos);

  // 缩放：视口也要持久化（重置按钮旁边的百分比）。
  await page.getByTestId('canvas-zoom-in').click();
  await expect(page.getByTestId('canvas-zoom')).toHaveText('110%');
  await page.waitForTimeout(700);
  await page.reload();
  await page.getByTestId('canvas-toggle').click();
  await expect(page.getByTestId('canvas-zoom')).toHaveText('110%');
});
