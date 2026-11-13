import { expect, test } from '@playwright/test';

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=',
  'base64'
);
const SERVER_TIME = '2026-11-12T00:00:00.000Z';

async function mockRemoteNote(page: import('@playwright/test').Page, count: number) {
  const blobs = new Map<string, number>();
  const attachments = Array.from({ length: count }, (_, index) => ({
    id: `att-${index + 1}`,
    noteId: 'remote-note',
    name: `dot-${index + 1}.png`,
    mime: 'image/png',
    size: PNG.length,
    hash: `h${index + 1}`,
    createdAt: SERVER_TIME,
    deleted: false,
    hasBlob: true
  }));
  const body = attachments
    .map((row) => `![${row.name}](attachment:${row.id})`)
    .join('\n\n');

  await page.route('**/api/v1/pull*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: true,
        notes: [
          {
            id: 'remote-note',
            title: '批量图',
            body,
            tags: [],
            folder: '',
            updatedAt: SERVER_TIME,
            revision: 1,
            device: 'other',
            deleted: false
          }
        ],
        relations: [],
        attachments,
        serverTime: SERVER_TIME
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
        serverTime: SERVER_TIME
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
  await page.route('**/api/v1/attachments/*/blob', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2) ?? '';
    blobs.set(id, (blobs.get(id) ?? 0) + 1);
    return route.fulfill({
      status: 200,
      headers: { 'content-type': 'image/png', 'access-control-allow-origin': '*' },
      body: PNG
    });
  });
  return { blobs, total: () => [...blobs.values()].reduce((sum, value) => sum + value, 0) };
}

async function syncFromMock(page: import('@playwright/test').Page) {
  await page.getByTestId('sidebar-sync').click();
  await page.getByTestId('sync-server').fill('http://mock.test');
  await page.getByTestId('sync-token').fill('x'.repeat(32));
  await page.getByTestId('sync-now').click();
  await expect(page.getByTestId('sync-result')).toContainText('拉取 1');
}

test('Phase 4.6 downloads all missing attachments of a note in one batch', async ({ page }) => {
  const mock = await mockRemoteNote(page, 4);

  await page.goto('/');
  await syncFromMock(page);
  await page.getByTestId('close-sync').click();

  await page.locator('.note-item', { hasText: '批量图' }).click();
  await expect(page.getByTestId('attachment-chip')).toHaveCount(4, { timeout: 20000 });
  await expect(page.getByTestId('attachment-progress')).toBeHidden();
  expect(mock.total()).toBe(4);
  expect(mock.blobs.size).toBe(4);
});

test('Phase 4.6 weak-network mode defers prefetch until the user asks', async ({ page }) => {
  const mock = await mockRemoteNote(page, 2);

  await page.goto('/');
  await syncFromMock(page);

  // 打开弱网模式后再关面板
  await page.getByTestId('sync-weak-net').check();
  await expect(page.getByTestId('sync-weak-net')).toBeChecked();
  await page.getByTestId('close-sync').click();

  await page.locator('.note-item', { hasText: '批量图' }).click();
  await expect(page.getByTestId('attachment-pending')).toContainText('有 2 个附件未下载');
  await page.waitForTimeout(600);
  expect(mock.total()).toBe(0);

  await page.getByTestId('attachment-download-all').click();
  await expect(page.getByTestId('attachment-chip')).toHaveCount(2, { timeout: 20000 });
  await expect(page.getByTestId('attachment-pending')).toHaveCount(0);
  expect(mock.total()).toBe(2);
});
