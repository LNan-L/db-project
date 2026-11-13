import { expect, test } from '@playwright/test';

/**
 * B-1 设备独立凭证：用管理 token 换取本机设备 token，之后只保存设备 token。
 * route mock 顶替服务器，验证 UI 与服务端契约（POST /api/v1/device-token）。
 */
test('B-1 exchanges the admin token for a device token', async ({ page }) => {
  const issued: Array<{ deviceId: string; authorization: string }> = [];
  const pulls: string[] = [];
  let deviceTokenActive = false;

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const authorization = request.headers().authorization ?? '';

    if (url.pathname === '/api/v1/device-token' && request.method() === 'POST') {
      const body = JSON.parse(request.postData() ?? '{}');
      issued.push({ deviceId: body.deviceId, authorization });
      await route.fulfill({ status: 201, json: { ok: true, deviceId: body.deviceId, token: 'pked_device_token_value_1234' } });
      return;
    }
    if (url.pathname === '/api/v1/pull') {
      pulls.push(authorization);
      if (authorization === 'Bearer pked_device_token_value_1234') deviceTokenActive = true;
      await route.fulfill({
        json: { ok: true, notes: [], relations: [], attachments: [], serverTime: new Date().toISOString() }
      });
      return;
    }
    if (url.pathname === '/api/v1/push') {
      await route.fulfill({ json: { ok: true, applied: [], conflicts: [], relationsApplied: 0, attachmentsApplied: 0 } });
      return;
    }
    if (url.pathname === '/api/v1/devices') {
      await route.fulfill({ json: { ok: true, devices: [], revoked: [] } });
      return;
    }
    await route.fulfill({ status: 404, json: { ok: false, error: 'unmocked' } });
  });

  await page.goto('/');
  await page.getByTestId('sidebar-sync').click();
  await page.getByTestId('sync-server').fill('https://sync.example.ts.net');
  await page.getByTestId('sync-token').fill('admin-token-0123456789abcdef');
  await expect(page.getByTestId('sync-token-kind')).toContainText('管理 token');

  await page.getByTestId('sync-use-device-token').click();
  await expect(page.getByTestId('sync-message')).toContainText('已换取设备凭证', { timeout: 15000 });

  // 请求带了管理 token，服务端拿到的是本机 deviceId
  expect(issued).toHaveLength(1);
  expect(issued[0]?.authorization).toBe('Bearer admin-token-0123456789abcdef');
  expect(issued[0]?.deviceId).toMatch(/[0-9a-f-]{36}/);

  // 面板与存储都换成设备 token，且标记为设备凭证
  await expect(page.getByTestId('sync-token')).toHaveValue('pked_device_token_value_1234');
  await expect(page.getByTestId('sync-token-kind')).toContainText('专属设备凭证');
  await expect(page.getByTestId('sync-use-device-token')).toHaveCount(0);

  // 刷新后仍然是设备 token（已持久化）
  await page.reload();
  await page.getByTestId('sidebar-sync').click();
  await expect(page.getByTestId('sync-token')).toHaveValue('pked_device_token_value_1234');
  await expect(page.getByTestId('sync-token-kind')).toContainText('专属设备凭证');

  // 用设备 token 同步
  await page.getByTestId('sync-now').click();
  await expect(page.getByTestId('sync-message')).toContainText('同步', { timeout: 15000 });
  expect(deviceTokenActive).toBe(true);
  expect(pulls.every((header) => header !== 'Bearer admin-token-0123456789abcdef')).toBe(true);
});

test('B-1 keeps the admin token when issuing fails', async ({ page }) => {
  await page.route('**/api/v1/device-token', (route) =>
    route.fulfill({ status: 401, json: { ok: false, error: 'unauthorized' } })
  );
  await page.route('**/api/v1/devices', (route) =>
    route.fulfill({ json: { ok: true, devices: [], revoked: [] } })
  );

  await page.goto('/');
  await page.getByTestId('sidebar-sync').click();
  await page.getByTestId('sync-server').fill('https://sync.example.ts.net');
  await page.getByTestId('sync-token').fill('admin-token-0123456789abcdef');
  await page.getByTestId('sync-use-device-token').click();

  await expect(page.getByTestId('sync-message')).toContainText('原 token 未改动');
  await expect(page.getByTestId('sync-token')).toHaveValue('admin-token-0123456789abcdef');
  await expect(page.getByTestId('sync-token-kind')).toContainText('管理 token');
});

test('B-1 editing the token clears the device-token flag', async ({ page }) => {
  await page.route('**/api/v1/devices', (route) =>
    route.fulfill({ json: { ok: true, devices: [], revoked: [] } })
  );
  await page.route('**/api/v1/device-token', (route) =>
    route.fulfill({ status: 201, json: { ok: true, token: 'pked_one' } })
  );

  await page.goto('/');
  await page.getByTestId('sidebar-sync').click();
  await page.getByTestId('sync-server').fill('https://sync.example.ts.net');
  await page.getByTestId('sync-token').fill('admin-token-0123456789abcdef');
  await page.getByTestId('sync-use-device-token').click();
  await expect(page.getByTestId('sync-token-kind')).toContainText('专属设备凭证');

  await page.getByTestId('sync-token').fill('pasted-by-hand-token-1234');
  await expect(page.getByTestId('sync-token-kind')).toContainText('管理 token');
});
