import { expect, test } from '@playwright/test';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { strToU8, zipSync } from 'fflate';

/**
 * 在 Node 侧生成真实的 .pke.enc（与 src/backup/crypto.ts 同格式），
 * 避免 E2E 依赖 /src 源码模块（production build 不提供）。
 * 格式：PKEB1 | version | saltP | ivP | wrappedDEK(P) | saltR | ivR | wrappedDEK(R) | ivData | ciphertext
 */
const MAGIC = new TextEncoder().encode('PKEB1');
const ITERATIONS = 200_000;

function buf(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/**
 * 造一个合法的最小 PKE 包（schema v2），让「换口令后的包能真的导入」可被验证。
 * 结构：manifest.json + 一篇带 frontmatter 的 Markdown；hash 是正文 UTF-8 字节的 SHA-256。
 */
function makePackagePayload(): Uint8Array {
  const id = randomUUID();
  const title = '换口令往返验证';
  const body = '换口令之后，这个包仍然可以导入。';
  const notePath = `notes/rekey-roundtrip-${id.slice(0, 8)}.md`;
  const createdAt = '2026-01-01T00:00:00.000Z';
  const note =
    '---\n' +
    `id: ${id}\n` +
    `title: ${title}\n` +
    `created: ${createdAt}\n` +
    `updated: ${createdAt}\n` +
    'tags: []\n' +
    "folder: ''\n" +
    'schema_version: 2\n' +
    '---\n\n' +
    `${body}\n`;
  const noteBytes = strToU8(note);
  const manifest = {
    app: 'pke',
    schema_version: 2,
    exported_at: createdAt,
    notes: [
      {
        id,
        path: notePath,
        title,
        hash: createHash('sha256').update(noteBytes).digest('hex'),
        tags: [],
        folder: '',
        created_at: createdAt,
        updated_at: createdAt
      }
    ],
    relations: [],
    attachments: []
  };
  return zipSync(
    { [notePath]: noteBytes, 'manifest.json': strToU8(JSON.stringify(manifest, null, 2)) },
    { level: 6 }
  );
}

async function deriveKek(secret: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: buf(salt), iterations: ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );
}

async function wrapKey(
  dek: Uint8Array,
  secret: string
): Promise<{ salt: Uint8Array; iv: Uint8Array; wrapped: Uint8Array }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const kek = await deriveKek(secret, salt);
  const wrapped = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(iv) }, kek, buf(dek))
  );
  return { salt, iv, wrapped };
}

async function makeEncryptedBackup(passphrase: string): Promise<string> {
  const dek = crypto.getRandomValues(new Uint8Array(32));
  const recoveryCode = `PKE-R-${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url')}`;
  const pass = await wrapKey(dek, passphrase);
  const recovery = await wrapKey(dek, recoveryCode);
  const ivData = crypto.getRandomValues(new Uint8Array(12));
  const selfKey = await crypto.subtle.importKey('raw', buf(dek), 'AES-GCM', false, ['encrypt']);
  const payload = makePackagePayload();
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: buf(ivData) }, selfKey, buf(payload))
  );

  const total =
    MAGIC.length + 1 + 16 + 12 + 48 + 16 + 12 + 48 + 12 + ciphertext.length;
  const out = new Uint8Array(total);
  let offset = 0;
  out.set(MAGIC, offset); offset += MAGIC.length;
  out[offset++] = 1;
  out.set(pass.salt, offset); offset += 16;
  out.set(pass.iv, offset); offset += 12;
  out.set(pass.wrapped, offset); offset += 48;
  out.set(recovery.salt, offset); offset += 16;
  out.set(recovery.iv, offset); offset += 12;
  out.set(recovery.wrapped, offset); offset += 48;
  out.set(ivData, offset); offset += 12;
  out.set(ciphertext, offset);

  const file = join(tmpdir(), `pke-rekey-${Date.now()}-${Math.random().toString(36).slice(2)}.pke.enc`);
  writeFileSync(file, Buffer.from(out));
  return file;
}

test('B-6 rekeys an existing backup with a new passphrase', async ({ page }) => {
  await page.goto('/');
  const file = await makeEncryptedBackup('old-passphrase-123');

  await page.getByTestId('open-data').click();
  await expect(page.getByTestId('data-panel')).toBeVisible();

  await page.getByTestId('backup-secret').fill('old-passphrase-123');
  await page.getByTestId('rekey-file').setInputFiles(file);
  await page.getByTestId('rekey-new-secret').fill('new-passphrase-456');
  await page.getByTestId('rekey-run').click();

  await expect(page.getByTestId('data-message')).toContainText('已用新口令重包', { timeout: 30000 });
  await expect(page.getByTestId('recovery-code')).toContainText('PKE-R-');
  await expect(page.getByTestId('backup-hash')).toBeVisible();
});

test('B-6 refuses a wrong old passphrase', async ({ page }) => {
  await page.goto('/');
  const file = await makeEncryptedBackup('old-passphrase-123');

  await page.getByTestId('open-data').click();
  await page.getByTestId('backup-secret').fill('definitely-wrong-secret');
  await page.getByTestId('rekey-file').setInputFiles(file);
  await page.getByTestId('rekey-new-secret').fill('new-passphrase-456');
  await page.getByTestId('rekey-run').click();

  await expect(page.getByTestId('data-message')).toContainText('更换口令失败', { timeout: 30000 });
  await expect(page.getByTestId('data-message')).toContainText('旧口令');
});

test('B-6 requires a 12+ character new passphrase', async ({ page }) => {
  await page.goto('/');
  const file = await makeEncryptedBackup('old-passphrase-123');

  await page.getByTestId('open-data').click();
  await page.getByTestId('backup-secret').fill('old-passphrase-123');
  await page.getByTestId('rekey-file').setInputFiles(file);
  await page.getByTestId('rekey-new-secret').fill('short');
  await page.getByTestId('rekey-run').click();

  await expect(page.getByTestId('data-message')).toContainText('新口令至少 12 位');
});

/**
 * 往返验证：换出来的包必须在**全新上下文**里能用新口令导入。
 * 这补上了「只断言提示文案」的盲区——真正证明数据密文没有被改坏。
 */
test('B-6 a rekeyed backup imports under the new passphrase', async ({ page, browser }) => {
  await page.goto('/');
  const file = await makeEncryptedBackup('old-passphrase-123');

  await page.getByTestId('open-data').click();
  await page.getByTestId('backup-secret').fill('old-passphrase-123');
  await page.getByTestId('rekey-file').setInputFiles(file);
  await page.getByTestId('rekey-new-secret').fill('new-passphrase-456');

  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('rekey-run').click();
  const download = await downloadPromise;
  const rekeyed = await download.path();
  expect(rekeyed).toBeTruthy();
  await expect(page.getByTestId('data-message')).toContainText('已用新口令重包', { timeout: 30000 });

  const restoreContext = await browser.newContext();
  const restore = await restoreContext.newPage();
  await restore.goto('/');
  await restore.getByTestId('open-data').click();
  await restore.getByTestId('backup-secret').fill('new-passphrase-456');
  await restore.getByTestId('import-file').setInputFiles(rekeyed!);

  await expect(restore.getByTestId('import-preview')).toContainText('新增 1', { timeout: 30000 });
  await restore.getByTestId('confirm-import').click();
  await expect(restore.getByTestId('note-count')).toHaveText('1', { timeout: 30000 });
  await expect(restore.getByTestId('note-list')).toContainText('换口令往返验证');

  await restoreContext.close();
});
