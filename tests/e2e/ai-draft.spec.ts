import { expect, test } from '@playwright/test';

const DRAFT = {
  title: '火星草稿',
  body: '火星是太阳系第四颗行星。',
  relations: []
};

test('Phase 5.2 AI draft is previewed first and only written after confirmation', async ({
  page
}) => {
  await page.route('**/mock-ai/chat/v1/chat/completions', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: JSON.stringify({
        choices: [{ message: { content: JSON.stringify(DRAFT) } }]
      })
    })
  );

  await page.goto('/');

  // 一篇参考笔记，供检索命中
  await page.getByTestId('new-note').click();
  await page.getByTestId('note-title').fill('火星笔记');
  const editor = page.locator('.milkdown .ProseMirror');
  await editor.click();
  await page.keyboard.insertText('火星是太阳系第四颗行星');
  await page.getByTestId('save-note').click();
  await expect(page.getByTestId('save-status')).toContainText('已保存');
  await expect(page.getByTestId('note-count')).toHaveText('1');

  // 配置本地 provider 并启用 AI（关闭向量，走 BM25 检索参考）
  const origin = await page.evaluate(() => window.location.origin);
  await page.getByTestId('sidebar-ai').click();
  await page.getByTestId('ai-chat-base-url').fill(`${origin}/mock-ai/chat/v1`);
  await page.getByTestId('ai-embedding-base-url').fill(`${origin}/mock-ai/embed/v1`);
  await page.getByTestId('ai-enabled').check();
  await page.getByTestId('ai-save').click();
  await expect(page.getByTestId('ai-message')).toContainText('已保存');
  await page.getByTestId('close-ai').click();

  // 生成草稿：只预览，笔记数不变
  await page.getByTestId('sidebar-draft').click();
  await page.getByTestId('ai-draft-intent').fill('写一篇火星探索笔记');
  await page.getByTestId('ai-draft-generate').click();
  await expect(page.getByTestId('ai-draft-preview')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('ai-draft-title')).toHaveValue('火星草稿');
  await expect(page.getByTestId('ai-draft-message')).toContainText('确认后才会写入');
  await expect(page.getByTestId('note-count')).toHaveText('1');

  // 确认后才写入
  await page.getByTestId('ai-draft-confirm').click();
  await expect(page.getByTestId('ai-draft-panel')).toHaveCount(0);
  await expect(page.getByTestId('note-count')).toHaveText('2');
  await expect(page.getByTestId('note-title')).toHaveValue('火星草稿');
});

test('Phase 5.2 discarding a draft writes nothing', async ({ page }) => {
  await page.route('**/mock-ai/chat/v1/chat/completions', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' },
      body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(DRAFT) } }] })
    })
  );

  await page.goto('/');
  const origin = await page.evaluate(() => window.location.origin);
  await page.getByTestId('sidebar-ai').click();
  await page.getByTestId('ai-chat-base-url').fill(`${origin}/mock-ai/chat/v1`);
  await page.getByTestId('ai-embedding-base-url').fill(`${origin}/mock-ai/embed/v1`);
  await page.getByTestId('ai-enabled').check();
  await page.getByTestId('ai-save').click();
  await page.getByTestId('close-ai').click();

  await page.getByTestId('sidebar-draft').click();
  await page.getByTestId('ai-draft-intent').fill('写点什么');
  await page.getByTestId('ai-draft-generate').click();
  await expect(page.getByTestId('ai-draft-preview')).toBeVisible({ timeout: 15000 });

  await page.getByTestId('ai-draft-discard').click();
  await expect(page.getByTestId('ai-draft-preview')).toHaveCount(0);
  await expect(page.getByTestId('ai-draft-message')).toContainText('未写入');
  await page.getByTestId('close-ai-draft').click();
  await expect(page.getByTestId('note-count')).toHaveText('0');
});
