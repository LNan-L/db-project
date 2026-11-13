import { expect, test } from '@playwright/test';

/**
 * Phase 5.1 / REQ-301：
 * 混合检索能命中 BM25 找不到的同义内容；关闭向量后回退全文（同样查询应无结果）。
 */
test('Phase 5.1 hybrid search finds semantic matches and falls back to BM25', async ({ page }) => {
  await page.route('**/mock-ai/embed/v1/embeddings', (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { input?: unknown };
    const inputs = Array.isArray(body.input) ? (body.input as string[]) : [String(body.input ?? '')];
    const data = inputs.map((text) => ({
      embedding: /火星|红色星球/.test(text) ? [1, 0] : /苹果/.test(text) ? [0, 1] : [0, 0]
    }));
    return route.fulfill({
      status: 200,
      headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: JSON.stringify({ data })
    });
  });

  await page.goto('/');

  // 两篇笔记：火星不含「红色星球」字样，苹果是干扰项
  for (const note of [
    { title: '火星笔记', body: '火星是太阳系第四颗行星' },
    { title: '苹果笔记', body: '苹果是一种水果' }
  ]) {
    await page.getByTestId('new-note').click();
    await page.getByTestId('note-title').fill(note.title);
    const editor = page.locator('.milkdown .ProseMirror');
    await editor.click();
    await page.keyboard.insertText(note.body);
    await page.getByTestId('save-note').click();
    await expect(page.getByTestId('save-status')).toContainText('已保存');
  }

  // 配置本地（同源 mock）provider，并打开语义检索
  await page.getByTestId('sidebar-ai').click();
  const origin = await page.evaluate(() => window.location.origin);
  await page.getByTestId('ai-chat-base-url').fill(`${origin}/mock-ai/chat/v1`);
  await page.getByTestId('ai-embedding-base-url').fill(`${origin}/mock-ai/embed/v1`);
  // AI 总开关必须打开，否则不会建索引、也不会发语义检索请求
  await page.getByTestId('ai-enabled').check();
  await page.getByTestId('ai-vector').check();
  await page.getByTestId('ai-save').click();
  await expect(page.getByTestId('ai-message')).toContainText('已保存');
  await page.getByTestId('close-ai').click();

  // 混合检索：BM25 对「红色星球」无命中，靠向量找到火星笔记
  await page.getByTestId('search-input').fill('红色星球');
  await expect(page.getByTestId('search-mode')).toContainText('混合检索', { timeout: 15000 });
  await expect(page.getByTestId('search-result')).toContainText('火星笔记');
  await expect(page.getByTestId('search-count')).toHaveText('找到 1 条');

  // 关闭向量：同一查询回退到 BM25，应无结果、且不再显示混合检索
  await page.getByTestId('sidebar-ai').click();
  await page.getByTestId('ai-vector').uncheck();
  await page.getByTestId('ai-save').click();
  await expect(page.getByTestId('ai-message')).toContainText('已保存');
  await page.getByTestId('close-ai').click();

  await page.getByTestId('search-input').fill('');
  await page.getByTestId('search-input').fill('红色星球');
  await expect(page.getByTestId('search-count')).toHaveText('找到 0 条');
  await expect(page.getByTestId('search-mode')).toHaveCount(0);
});


test('Phase 5.1 AI disabled: semantic search never sends embedding requests', async ({ page }) => {
  const embeddingCalls: string[] = [];
  await page.route('**/mock-ai/embed/v1/embeddings', (route) => {
    embeddingCalls.push(route.request().url());
    return route.fulfill({ status: 200, json: { data: [{ embedding: [1, 0] }] } });
  });

  await page.goto('/');
  await page.getByTestId('new-note').click();
  await page.getByTestId('note-title').fill('火星笔记');
  const editor = page.locator('.milkdown .ProseMirror');
  await editor.click();
  await page.keyboard.insertText('火星是太阳系第四颗行星');
  await page.getByTestId('save-note').click();
  await expect(page.getByTestId('save-status')).toContainText('已保存');

  const origin = await page.evaluate(() => window.location.origin);
  await page.getByTestId('sidebar-ai').click();
  await page.getByTestId('ai-chat-base-url').fill(`${origin}/mock-ai/chat/v1`);
  await page.getByTestId('ai-embedding-base-url').fill(`${origin}/mock-ai/embed/v1`);
  await page.getByTestId('ai-vector').check();
  // 故意不勾 ai-enabled
  await page.getByTestId('ai-vector-needs-enabled').waitFor();
  await page.getByTestId('ai-save').click();
  await expect(page.getByTestId('ai-message')).toContainText('已保存');
  await page.getByTestId('close-ai').click();

  await page.getByTestId('search-input').fill('红色星球');
  await expect(page.getByTestId('search-count')).toHaveText('找到 0 条');
  await page.waitForTimeout(500);
  expect(embeddingCalls).toHaveLength(0);
  await expect(page.getByTestId('search-mode')).toHaveCount(0);
});
