import { expect, test } from '@playwright/test';

const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=';

test('Phase 1 production attachments and inline images', async ({ page, browser }) => {
  await page.goto('/');
  await page.getByTestId('new-note').click();
  await page.getByTestId('note-title').fill('附件生产笔记');
  const editor = page.locator('.milkdown .ProseMirror');
  await editor.click();
  await page.keyboard.insertText('正文');

  await page.getByTestId('attachment-input').setInputFiles({
    name: 'dot.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_BASE64, 'base64')
  });

  await expect(page.getByTestId('attachment-chip')).toContainText('dot.png');
  await expect(page.locator('.milkdown img[src^="data:image/png"]')).toBeVisible();
  await page.getByTestId('save-note').click();
  await expect(page.getByTestId('save-status')).toContainText('已保存');

  await page.reload();
  await expect(page.getByTestId('attachment-chip')).toContainText('dot.png');
  await expect(page.locator('.milkdown img[src^="data:image/png"]')).toBeVisible();

  await page.getByTestId('open-data').click();
  await page.getByTestId('backup-secret').fill('correct horse battery staple');
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('export-data').click();
  const download = await downloadPromise;
  const zipPath = await download.path();
  expect(zipPath).toBeTruthy();
  await expect(page.getByTestId('data-message')).toContainText('1 个附件');
  await page.getByTestId('close-data').click();

  const blankContext = await browser.newContext();
  const blank = await blankContext.newPage();
  await blank.goto('/');
  await blank.getByTestId('open-data').click();
  await blank.getByTestId('backup-secret').fill('correct horse battery staple');
  await blank.getByTestId('import-file').setInputFiles(zipPath!);
  await expect(blank.getByTestId('import-preview')).toContainText('附件 1');
  await blank.getByTestId('confirm-import').click();
  await blank.getByTestId('close-data').click();

  await expect(blank.getByTestId('note-title')).toHaveValue('附件生产笔记');
  await expect(blank.getByTestId('attachment-chip')).toContainText('dot.png');
  await expect(blank.locator('.milkdown img[src^="data:image/png"]')).toBeVisible();

  await blankContext.close();
});

/**
 * 手机 PWA（standalone / WebView）里，label 隐式激活和 input.click() 都可能打不开选择器。
 * 现在原生 input 透明盖在按钮上，手指点在原生控件上由系统弹选择器。
 * 这条锁住：点击区域命中的是原生 input，且它可见、可点、不是 display:none。
 */
test('attachment trigger is a real, tappable file input (mobile PWA path)', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');

  // 窄屏首次进入会弹移动端引导（异步挂载），等它出现再关掉
  const skip = page.getByTestId('onboarding-skip');
  await skip.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  if (await skip.count()) await skip.click();

  await page.getByTestId('new-note').click();

  const input = page.getByTestId('attachment-input');
  await expect(input).toBeVisible();

  const hit = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="attachment-add"]') as HTMLElement | null;
    const input = document.querySelector('[data-testid="attachment-input"]') as HTMLInputElement | null;
    if (!el || !input) return { hitTestId: null, display: '', opacity: '', pointerEvents: '', accept: '' };
    const r = el.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const cs = getComputedStyle(input);
    return {
      hitTestId: top ? top.getAttribute('data-testid') : null,
      display: cs.display,
      opacity: cs.opacity,
      pointerEvents: cs.pointerEvents,
      accept: input.accept || ''
    };
  });
  // 手指点到的必须就是原生 input，而不是被别的元素挡住
  expect(hit.hitTestId).toBe('attachment-input');
  expect(hit.display).not.toBe('none');
  expect(hit.pointerEvents).not.toBe('none');

  const chooserPromise = page.waitForEvent('filechooser', { timeout: 5000 });
  await input.setInputFiles({
    name: 'tap.png',
    mimeType: 'image/png',
    buffer: Buffer.from(PNG_BASE64, 'base64')
  });
  await expect(page.getByTestId('attachment-chip')).toContainText('tap.png');
  await chooserPromise.catch(() => undefined);
});
