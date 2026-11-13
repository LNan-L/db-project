import { expect, test } from '@playwright/test';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=',
  'base64'
);

test.setTimeout(90000);

const SERVER_TIME = '2026-11-12T00:00:00.000Z';

/** 远端有一篇笔记 + 一个附件；blob 请求交给 onBlob 决定成功/失败。 */
async function mockRemoteNote(
  page: import('@playwright/test').Page,
  onBlob: () => 'ok' | 'fail'
): Promise<{ attempts: () => number }> {
  const serverTime = SERVER_TIME;
  let blobAttempts = 0;

  await page.route('**/api/v1/pull*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        notes: [
          {
            id: 'remote-note',
            title: '远端图',
            body: '![dot.png](attachment:att-1)',
            tags: [],
            folder: '',
            updatedAt: serverTime,
            revision: 1,
            device: 'other',
            deleted: false
          }
        ],
        relations: [],
        attachments: [
          {
            id: 'att-1',
            noteId: 'remote-note',
            name: 'dot.png',
            mime: 'image/png',
            size: PNG.length,
            hash: 'h',
            createdAt: serverTime,
            deleted: false,
            hasBlob: true
          }
        ],
        serverTime
      })
    })
  );
  await page.route('**/api/v1/push*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        applied: [],
        conflicts: [],
        relationsApplied: 0,
        attachmentsApplied: 0,
        serverTime
      })
    })
  );
  await page.route('**/api/v1/devices', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true, devices: [], revoked: [] })
    })
  );
  await page.route('**/api/v1/attachments/att-1/blob', (route) => {
    blobAttempts += 1;
    if (onBlob() === 'fail') {
      return route.fulfill({
        status: 500,
        headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
        body: JSON.stringify({ ok: false, error: 'boom' })
      });
    }
    return route.fulfill({
      status: 200,
      headers: { 'content-type': 'image/png', 'access-control-allow-origin': '*' },
      body: PNG
    });
  });

  await page.goto('/');
  await page.getByTestId('sidebar-sync').click();
  await page.getByTestId('sync-server').fill('http://mock.test');
  await page.getByTestId('sync-token').fill('x'.repeat(32));
  await page.getByTestId('sync-now').click();
  await expect(page.getByTestId('sync-result')).toContainText('拉取 1');
  await page.getByTestId('close-sync').click();

  return { attempts: () => blobAttempts };
}

test('Phase 4.3 attachment download retries automatically with backoff', async ({ page }) => {
  let calls = 0;
  const blob = await mockRemoteNote(page, () => (++calls === 1 ? 'fail' : 'ok'));

  // 用可控时钟观察退避，不用真的等 5 秒。
  await page.clock.install();
  await page.locator('.note-item', { hasText: '远端图' }).click();

  // 并行跑全量时首屏下载可能更慢，给足等待；尝试次数用 poll 避免竞态。
  await expect(page.getByTestId('attachment-error')).toContainText('稍后自动重试', {
    timeout: 20000
  });
  await expect.poll(() => blob.attempts(), { timeout: 10000 }).toBe(1);

  await page.clock.fastForward(5_100);

  await expect(page.getByTestId('attachment-chip')).toContainText('dot.png', { timeout: 20000 });
  await expect(page.locator('.milkdown img[src^="data:image/png"]')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('attachment-error')).toBeHidden();
  expect(blob.attempts()).toBe(2);
});

test('Phase 4.3 auto retry gives up after 4 backoff attempts and keeps manual retry', async ({ page }) => {
  const blob = await mockRemoteNote(page, () => 'fail');

  await page.clock.install();
  await page.locator('.note-item', { hasText: '远端图' }).click();

  // 5s → 15s → 60s → 300s，每次到点自动再试一次
  for (const [index, delay] of [5_100, 15_100, 60_100, 300_100].entries()) {
    await expect(page.getByTestId('attachment-error')).toContainText(`第 ${index + 1} 次失败`);
    await page.clock.fastForward(delay);
  }

  await expect(page.getByTestId('attachment-error')).toContainText('自动重试已停止');
  expect(blob.attempts()).toBe(5);

  // 停手之后不再偷偷发请求
  await page.clock.fastForward(600_000);
  expect(blob.attempts()).toBe(5);

  await page.getByTestId('sidebar-sync').click();
  await expect(page.getByTestId('sync-blob-failures')).toContainText('自动重试已停止');
  await page.getByTestId('close-sync').click();

  // 手动重试仍可用（这里仍然失败，只验证按钮能点、计数继续）
  await page.getByTestId('attachment-retry').click();
  await expect(page.getByTestId('attachment-error')).toContainText('第 1 次失败');
  expect(blob.attempts()).toBe(6);
});
