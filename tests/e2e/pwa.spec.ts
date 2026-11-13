import { expect, test } from '@playwright/test';

test('Phase 5.5 PC PWA exposes an installable manifest and a service worker', async ({ page }) => {
  await page.goto('/');

  const manifestLink = page.locator('link[rel="manifest"]');
  await expect(manifestLink).toHaveCount(1);
  const href = await manifestLink.getAttribute('href');
  if (!href) throw new Error('manifest link is missing href');

  const manifest = (await page.evaluate(async (url) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`manifest ${response.status}`);
    return response.json();
  }, href)) as {
    name: string;
    short_name: string;
    display: string;
    start_url: string;
    icons: Array<{ src: string; sizes: string; type: string }>;
  };

  expect(manifest.name).toBe('Personal Knowledge Engine');
  expect(manifest.short_name).toBe('PKE');
  expect(manifest.display).toBe('standalone');
  expect(manifest.start_url).toBe('/');
  const sizes = manifest.icons.map((icon) => icon.sizes);
  expect(sizes).toContain('192x192');
  expect(sizes).toContain('512x512');
  for (const icon of manifest.icons) {
    expect((await page.request.get(new URL(icon.src, page.url()).toString())).status()).toBe(200);
  }

  await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) throw new Error('service worker unavailable');
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect
    .poll(async () => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), {
      timeout: 10000
    })
    .toBe(true);
});
