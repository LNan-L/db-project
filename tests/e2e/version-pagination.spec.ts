import { expect, test } from '@playwright/test';

/**
 * Phase 4.4 / REQ-303 版本历史分页：
 * 首屏只拉第一页，点「加载更多云端历史」再按 before 游标追加更早的版本，末页后按钮消失。
 */
test('version history loads older remote versions page by page', async ({ page }) => {
  const remote = (id: number, title: string, createdAt: string) => ({
    id,
    noteId: 'note-1',
    title,
    body: `${title} 的正文`,
    tags: [],
    folder: '',
    updatedAt: createdAt,
    revision: id,
    device: 'other',
    createdAt
  });

  const firstPage = {
    ok: true,
    versions: [
      remote(21, '远端三', '2026-11-12T03:00:00.000Z'),
      remote(20, '远端二', '2026-11-12T02:00:00.000Z')
    ],
    nextCursor: 20
  };
  const secondPage = {
    ok: true,
    versions: [remote(19, '远端一', '2026-11-12T01:00:00.000Z')],
    nextCursor: null
  };
  let requestedBefore: string | null = null;

  await page.route(/\/api\/v1\/versions\//, async (route) => {
    const url = new URL(route.request().url());
    const before = url.searchParams.get('before');
    if (before) {
      requestedBefore = before;
      await route.fulfill({ json: secondPage });
      return;
    }
    await route.fulfill({ json: firstPage });
  });

  await page.goto('/');
  await page.getByTestId('new-note').click();
  await page.getByTestId('note-title').fill('分页笔记');
  await page.getByTestId('save-note').click();
  await expect(page.getByTestId('save-status')).toContainText('已保存');

  // 配好 token，版本面板才会去拉云端历史（不需要真的同步）
  await page.getByTestId('sidebar-sync').click();
  await page.getByTestId('sync-server').fill('http://mock.test');
  await page.getByTestId('sync-token').fill('x'.repeat(32));
  await page.getByTestId('sync-config-save').click();
  await page.getByTestId('close-sync').click();

  await page.getByTestId('open-history').click();
  const remoteItems = page.getByTestId('version-item').filter({ hasText: '云端' });
  await expect(remoteItems).toHaveCount(2, { timeout: 15000 });
  await expect(page.getByTestId('version-remote-count')).toContainText('已加载 2 条');
  await expect(page.getByTestId('version-load-more')).toBeVisible();

  await page.getByTestId('version-load-more').click();
  await expect(remoteItems).toHaveCount(3);
  await expect(page.getByTestId('version-load-more')).toBeHidden();
  expect(requestedBefore).toBe('20');

  await page.getByTestId('close-history').click();
});
