/**
 * @req REQ-108 — 迁移时校验导出内容/附件 hash。
 */
export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const source = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const data = new Uint8Array(source.byteLength);
  data.set(source);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
