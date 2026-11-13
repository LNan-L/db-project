import { expect, test } from '@playwright/test';

/**
 * Phase 4.1 / 设备吊销：设备列表里的「撤销」→ 服务端 DELETE → 列表变成「已撤销」→「恢复」。
 * 用 route mock 顶替真实服务器，覆盖 UI 与服务端契约（DELETE .../devices/:id 与 .../revoked-devices/:id）。
 */
test('device registry supports revoke and restore', async ({ page }) => {
  let devices = [
    { id: 'dev-pc', name: 'PC', createdAt: '2026-11-01T00:00:00.000Z', lastSeen: '2026-11-12T01:00:00.000Z' },
    {
      id: 'dev-old-android',
      name: '旧 Android（隧道）',
      createdAt: '2026-11-09T00:00:00.000Z',
      lastSeen: '2026-11-09T00:00:00.000Z'
    }
  ];
  let revoked: Array<{ id: string; name: string; revokedAt: string }> = [];
  const deletes: string[] = [];

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());

    if (url.pathname === '/api/v1/devices' && request.method() === 'GET') {
      await route.fulfill({ json: { ok: true, devices, revoked } });
      return;
    }
    if (request.method() === 'DELETE' && url.pathname.startsWith('/api/v1/devices/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/v1/devices/'.length));
      deletes.push(`devices/${id}`);
      const row = devices.find((device) => device.id === id);
      devices = devices.filter((device) => device.id !== id);
      revoked = [...revoked, { id, name: row?.name ?? '', revokedAt: new Date().toISOString() }];
      await route.fulfill({ json: { ok: true, revoked: true, id } });
      return;
    }
    if (request.method() === 'DELETE' && url.pathname.startsWith('/api/v1/revoked-devices/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/v1/revoked-devices/'.length));
      deletes.push(`revoked-devices/${id}`);
      const row = revoked.find((device) => device.id === id);
      revoked = revoked.filter((device) => device.id !== id);
      if (row) {
        devices = [
          ...devices,
          {
            id: row.id,
            name: row.name,
            createdAt: '2026-11-09T00:00:00.000Z',
            lastSeen: '2026-11-09T00:00:00.000Z'
          }
        ];
      }
      await route.fulfill({ json: { ok: true, restored: Boolean(row), id } });
      return;
    }
    await route.fulfill({ status: 404, json: { ok: false, error: 'unmocked' } });
  });

  await page.goto('/');
  await page.getByTestId('sidebar-sync').click();
  await expect(page.getByTestId('sync-panel')).toBeVisible();
  await page.getByTestId('sync-server').fill('http://sync.test');
  await page.getByTestId('sync-token').fill('x'.repeat(32));

  await expect(page.getByTestId('device-row')).toHaveCount(2);
  await expect(page.getByTestId('device-list')).toContainText('已注册设备 2');
  await expect(page.getByTestId('device-list')).toContainText('旧 Android（隧道）');

  // 撤销旧手机（列表按 lastSeen 排序，旧记录在第二行）
  await page.getByTestId('device-revoke').nth(1).click();
  await expect(page.getByTestId('sync-message')).toContainText('已撤销「旧 Android（隧道）」');
  await expect(page.getByTestId('device-row')).toHaveCount(1);
  await expect(page.getByTestId('revoked-list')).toBeVisible();
  await expect(page.getByTestId('revoked-row')).toHaveCount(1);
  expect(deletes).toEqual(['devices/dev-old-android']);

  // 恢复
  await page.getByTestId('device-restore').click();
  await expect(page.getByTestId('sync-message')).toContainText('已恢复「旧 Android（隧道）」');
  await expect(page.getByTestId('device-row')).toHaveCount(2);
  await expect(page.getByTestId('revoked-list')).toHaveCount(0);
  expect(deletes).toEqual(['devices/dev-old-android', 'revoked-devices/dev-old-android']);
});
