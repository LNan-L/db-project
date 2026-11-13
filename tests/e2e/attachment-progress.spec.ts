import { expect, test } from '@playwright/test';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=',
  'base64'
);

test.setTimeout(90000);

test('Phase 4A3 attachment download failure is visible, retryable and then completes', async ({ page }) => {
  const serverTime = '2026-11-12T00:00:00.000Z';
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
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, devices: [] }) })
  );
  // 第一次下载失败，手动重试时成功 —— 覆盖「失败可见 + 重试 + 完成」。
  // 自动退避由 attachment-auto-retry.spec.ts 覆盖，这里用可控时钟避免 5s 自动重试抢先。
  await page.route('**/api/v1/attachments/att-1/blob', (route) => {
    blobAttempts += 1;
    if (blobAttempts <= 1) {
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

  await page.clock.install();
  await page.locator('.note-item', { hasText: '远端图' }).click();

  // 失败可见
  await expect(page.getByTestId('attachment-error')).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('attachment-error')).toContainText('下载失败');

  // 同步面板也能看到失败并可重试
  await page.getByTestId('sidebar-sync').click();
  await expect(page.getByTestId('sync-blob-failures')).toBeVisible();
  await expect(page.getByTestId('sync-blob-failures')).toContainText('dot.png');
  await page.getByTestId('close-sync').click();

  // 编辑器内重试 → 成功
  await page.getByTestId('attachment-retry').click();
  await expect(page.getByTestId('attachment-chip')).toContainText('dot.png', { timeout: 30000 });
  await expect(page.locator('.milkdown img[src^="data:image/png"]')).toBeVisible({ timeout: 30000 });
  await expect(page.getByTestId('attachment-error')).toBeHidden();
  expect(blobAttempts).toBeGreaterThanOrEqual(2);
});