import { expect, test } from '@playwright/test';

async function mockModels(page: import('@playwright/test').Page, pattern: string) {
  const calls: Array<Record<string, string>> = [];
  await page.route(pattern, (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      return route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET,POST,OPTIONS',
          'access-control-allow-headers': 'authorization,content-type'
        }
      });
    }
    calls.push(request.headers());
    return route.fulfill({
      status: 200,
      headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: JSON.stringify({ data: [{ id: 'model' }] })
    });
  });
  return calls;
}

test('Phase 5.0.1 configures chat and embedding endpoints separately', async ({ page }) => {
  const chatCalls = await mockModels(page, '**/mock-ai/chat/v1/models');
  const embeddingCalls = await mockModels(page, '**/mock-ai/embed/v1/models');

  await page.goto('/');
  await page.getByTestId('sidebar-ai').click();
  await expect(page.getByTestId('ai-panel')).toBeVisible();

  // 默认主库：DeepSeek chat + 硅基流动 embedding，均未启用/未授权
  await expect(page.getByTestId('ai-enabled')).not.toBeChecked();
  await expect(page.getByTestId('ai-chat-base-url')).toHaveValue('https://api.deepseek.com/v1');
  await expect(page.getByTestId('ai-chat-model')).toHaveValue('deepseek-chat');
  await expect(page.getByTestId('ai-embedding-base-url')).toHaveValue(
    'https://api.siliconflow.cn/v1'
  );
  await expect(page.getByTestId('ai-embedding-model')).toHaveValue('BAAI/bge-m3');

  const origin = await page.evaluate(() => window.location.origin);
  await page.getByTestId('ai-chat-base-url').fill(`${origin}/mock-ai/chat/v1`);
  await page.getByTestId('ai-embedding-base-url').fill(`${origin}/mock-ai/embed/v1`);

  await page.getByTestId('ai-test-chat').click();
  await expect(page.getByTestId('ai-message')).toContainText('对话连接成功');
  await page.getByTestId('ai-test-embedding').click();
  await expect(page.getByTestId('ai-message')).toContainText('嵌入连接成功');

  await page.getByTestId('ai-save').click();
  await expect(page.getByTestId('ai-message')).toContainText('已保存');
  await page.getByTestId('close-ai').click();

  await page.reload();
  await page.getByTestId('sidebar-ai').click();
  await expect(page.getByTestId('ai-chat-base-url')).toHaveValue(`${origin}/mock-ai/chat/v1`);
  await expect(page.getByTestId('ai-embedding-base-url')).toHaveValue(
    `${origin}/mock-ai/embed/v1`
  );
  expect(chatCalls).toHaveLength(1);
  expect(embeddingCalls).toHaveLength(1);
});

test('Phase 5.0.1 unauthorized chat endpoint sends no request', async ({ page }) => {
  const hits = await mockModels(page, 'http://remote.example/**');
  await page.route('**/mock-ai/embed/v1/models', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: JSON.stringify({ data: [] })
    })
  );

  await page.goto('/');
  const origin = await page.evaluate(() => window.location.origin);

  await page.getByTestId('sidebar-ai').click();
  await page.getByTestId('ai-chat-base-url').fill('http://remote.example/v1');
  await page.getByTestId('ai-embedding-base-url').fill(`${origin}/mock-ai/embed/v1`);

  await page.getByTestId('ai-test-chat').click();
  await expect(page.getByTestId('ai-message')).toContainText('未获授权');
  await page.waitForTimeout(300);
  expect(hits).toHaveLength(0);

  // 未授权也允许保存配置（授权只影响使用）
  await page.getByTestId('ai-save').click();
  await expect(page.getByTestId('ai-message')).toContainText('已保存');
});

test('Phase 5.0.1 chat consent is bound to its own origin', async ({ page }) => {
  const hitsA = await mockModels(page, 'http://remote-a.example/**');
  const hitsB = await mockModels(page, 'http://remote-b.example/**');
  await page.route('**/mock-ai/embed/v1/models', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: JSON.stringify({ data: [] })
    })
  );

  await page.goto('/');
  const origin = await page.evaluate(() => window.location.origin);

  await page.getByTestId('sidebar-ai').click();
  await page.getByTestId('ai-chat-base-url').fill('http://remote-a.example/v1');
  await page.getByTestId('ai-embedding-base-url').fill(`${origin}/mock-ai/embed/v1`);

  // 内联确认（不依赖浏览器原生 dialog）
  await page.getByTestId('ai-chat-remote').click();
  await expect(page.getByTestId('ai-chat-consent-prompt')).toBeVisible();
  await page.getByTestId('ai-chat-consent-confirm').click();
  await expect(page.getByTestId('ai-chat-remote')).toBeChecked();
  await expect(page.getByTestId('ai-chat-consent')).toContainText('remote-a.example');

  await page.getByTestId('ai-chat-base-url').fill('http://remote-b.example/v1');
  await expect(page.getByTestId('ai-chat-remote')).not.toBeChecked();
  await expect(page.getByTestId('ai-chat-blocked')).toContainText('未获授权');
  await page.getByTestId('ai-test-chat').click();
  await expect(page.getByTestId('ai-message')).toContainText('未获授权');
  await page.waitForTimeout(300);
  expect(hitsA).toHaveLength(0);
  expect(hitsB).toHaveLength(0);
});

test('Phase 5.0.1 cancelling chat consent keeps the endpoint blocked', async ({ page }) => {
  await page.route('**/mock-ai/embed/v1/models', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: JSON.stringify({ data: [] })
    })
  );

  await page.goto('/');
  const origin = await page.evaluate(() => window.location.origin);

  await page.getByTestId('sidebar-ai').click();
  await page.getByTestId('ai-chat-base-url').fill('http://remote-a.example/v1');
  await page.getByTestId('ai-embedding-base-url').fill(`${origin}/mock-ai/embed/v1`);

  await page.getByTestId('ai-chat-remote').click();
  await expect(page.getByTestId('ai-chat-consent-prompt')).toBeVisible();
  await page.getByTestId('ai-chat-consent-cancel').click();

  await expect(page.getByTestId('ai-chat-remote')).not.toBeChecked();
  await expect(page.getByTestId('ai-chat-consent')).toHaveCount(0);
  await page.getByTestId('ai-save').click();
  await expect(page.getByTestId('ai-message')).toContainText('已保存');
  await page.getByTestId('ai-test-chat').click();
  await expect(page.getByTestId('ai-message')).toContainText('未获授权');
});

test('Phase 5.0.1 authorized chat endpoint sends its own key', async ({ page }) => {
  const hits = await mockModels(page, 'http://remote-a.example/**');
  await page.route('**/mock-ai/embed/v1/models', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: JSON.stringify({ data: [] })
    })
  );

  await page.goto('/');
  const origin = await page.evaluate(() => window.location.origin);

  await page.getByTestId('sidebar-ai').click();
  await page.getByTestId('ai-chat-base-url').fill('http://remote-a.example/v1');
  await page.getByTestId('ai-chat-key').fill('chat-secret');
  await page.getByTestId('ai-embedding-base-url').fill(`${origin}/mock-ai/embed/v1`);

  await page.getByTestId('ai-chat-remote').click();
  await page.getByTestId('ai-chat-consent-confirm').click();

  await page.getByTestId('ai-test-chat').click();
  await expect(page.getByTestId('ai-message')).toContainText('对话连接成功');
  expect(hits).toHaveLength(1);
  expect(hits[0]?.authorization).toBe('Bearer chat-secret');
});


test('Phase 5.0.1 rebuild requires an API key for a remote embedding endpoint', async ({
  page
}) => {
  const hits = await mockModels(page, 'http://remote-a.example/**');
  await page.goto('/');
  const origin = await page.evaluate(() => window.location.origin);
  await page.getByTestId('sidebar-ai').click();
  await page.getByTestId('ai-chat-base-url').fill(`${origin}/mock-ai/chat/v1`);
  await page.getByTestId('ai-embedding-base-url').fill('http://remote-a.example/v1');
  await page.getByTestId('ai-embedding-remote').click();
  await page.getByTestId('ai-embedding-consent-confirm').click();
  await page.getByTestId('ai-enabled').check();

  await page.getByTestId('ai-rebuild-vector').click();
  await expect(page.getByTestId('ai-message')).toContainText('缺少 API key');
  await page.waitForTimeout(300);
  expect(hits).toHaveLength(0);
});
