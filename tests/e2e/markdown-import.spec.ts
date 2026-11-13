import { expect, test } from '@playwright/test';

const markdown = `# 标题一

普通段落，**粗体** 和 *斜体*。

- 列表一
- 列表二

> 引用内容

\`\`\`js
console.log('hi')
\`\`\`

[示例链接](https://example.com)

![示例图片](https://example.com/x.png)

| 列1 | 列2 |
| --- | --- |
| A | B |
`;

const logseq = `title:: Logseq 页面

- 一条 Logseq 内容
`;

test('Phase 1 Markdown features and Obsidian/Logseq import', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('open-data').click();
  await page.getByTestId('import-file').setInputFiles([
    { name: 'Markdown 全要素.md', mimeType: 'text/markdown', buffer: Buffer.from(markdown) },
    { name: 'Logseq 页面.md', mimeType: 'text/markdown', buffer: Buffer.from(logseq) }
  ]);
  await expect(page.getByTestId('import-preview')).toContainText('新增 2');
  await page.getByTestId('confirm-import').click();
  await page.getByTestId('close-data').click();

  await expect(page.getByTestId('note-count')).toHaveText('2');
  await page.getByTestId('note-list').getByText('Markdown 全要素', { exact: true }).click();

  const editor = page.locator('.milkdown .ProseMirror');
  await expect(editor.locator('h1')).toHaveText('标题一');
  await expect(editor.locator('li')).toHaveCount(2);
  await expect(editor.locator('blockquote')).toContainText('引用内容');
  await expect(editor.locator('pre')).toContainText("console.log('hi')");
  await expect(editor.locator('a')).toHaveAttribute('href', 'https://example.com');
  await expect(editor.getByRole('img', { name: '示例图片' })).toHaveAttribute(
    'src',
    'https://example.com/x.png'
  );
  await expect(editor.locator('table.children')).toContainText('列1');
  await expect(editor.locator('table.children')).toContainText('B');

  await page.getByTestId('note-list').getByText('Logseq 页面', { exact: true }).click();
  await expect(page.getByTestId('note-title')).toHaveValue('Logseq 页面');
  await expect(page.locator('.milkdown .ProseMirror')).toContainText('title:: Logseq 页面');
});
