import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { expect, test } from '@playwright/test';

test('Phase 1 note survives full browser restart', async () => {
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'pke-phase1-restart-'));
  const launchOptions = {
    channel: 'msedge',
    headless: true,
    viewport: { width: 1280, height: 800 }
  };

  try {
    let context = await chromium.launchPersistentContext(userDataDir, launchOptions);
    let page = context.pages()[0] ?? (await context.newPage());
    await page.goto('http://127.0.0.1:4273');
    await page.getByTestId('new-note').click();
    await page.getByTestId('note-title').fill('重启生产笔记');
    const editor = page.locator('.milkdown .ProseMirror');
    await editor.click();
    await page.keyboard.insertText('浏览器完全重启后还在');
    await page.getByTestId('save-note').click();
    await expect(page.getByTestId('save-status')).toContainText('已保存');
    await context.close();

    context = await chromium.launchPersistentContext(userDataDir, launchOptions);
    page = context.pages()[0] ?? (await context.newPage());
    await page.goto('http://127.0.0.1:4273');
    await expect(page.getByTestId('note-title')).toHaveValue('重启生产笔记');
    await expect(page.locator('.milkdown .ProseMirror')).toContainText('浏览器完全重启后还在');
    await context.close();
  } finally {
    await rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
  }
});
