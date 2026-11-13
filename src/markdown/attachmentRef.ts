/**
 * @req REQ-102 / REQ-108 — 正文里的附件引用。
 *
 * 正文若内联 data: URL，一张 275 KB 的图会让笔记正文变成 367 KB，
 * 同步按整篇传，慢链路上必然超时。所以：
 *   - 存库（= 同步）用 `attachment:<id>` 引用，正文只有几十字节
 *   - 编辑器里显示时再换回 data: URL，渲染行为不变
 * 附件文件本体仍在 attachments 表，导出包会带上它。
 */
import type { Attachment } from '../storage/db';

export const ATTACHMENT_REF_PREFIX = 'attachment:';

const dataUrlCache = new Map<string, string>();

export function attachmentRef(id: string): string {
  return `${ATTACHMENT_REF_PREFIX}${id}`;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

export async function attachmentDataUrl(attachment: Attachment): Promise<string> {
  const cached = dataUrlCache.get(attachment.id);
  if (cached) return cached;
  const url = await blobToDataUrl(attachment.blob);
  dataUrlCache.set(attachment.id, url);
  return url;
}

/** 正文里引用到的附件 id（用于按需下载文件本体）。 */
export function attachmentIdsInMarkdown(markdown: string): string[] {
  const ids = new Set<string>();
  const pattern = new RegExp(ATTACHMENT_REF_PREFIX + '([A-Za-z0-9_-]+)', 'g');
  let match = pattern.exec(markdown);
  while (match) {
    ids.add(match[1]);
    match = pattern.exec(markdown);
  }
  return [...ids];
}

/** 存库形式：把附件对应的 data: URL 全换成 attachment:<id>。 */
export async function toStoredMarkdown(
  markdown: string,
  attachments: Attachment[]
): Promise<string> {
  if (!markdown.includes('data:')) return markdown;
  const byUrl = new Map<string, string>();
  for (const attachment of attachments) {
    byUrl.set(await attachmentDataUrl(attachment), attachmentRef(attachment.id));
  }
  const imagePattern = new RegExp('!\\[([^\\]]*)\\]\\((data:[^)]+)\\)', 'g');
  return markdown.replace(imagePattern, (whole, alt, url) => {
    const ref = byUrl.get(url);
    return ref ? `![${alt}](${ref})` : whole;
  });
}

/** 显示形式：把 attachment:<id> 换回 data: URL，编辑器里才看得到图。 */
export async function toDisplayMarkdown(
  markdown: string,
  attachments: Attachment[]
): Promise<string> {
  if (!markdown.includes(ATTACHMENT_REF_PREFIX)) return markdown;
  let result = markdown;
  for (const attachment of attachments) {
    const ref = attachmentRef(attachment.id);
    if (!result.includes(ref)) continue;
    result = result.split(ref).join(await attachmentDataUrl(attachment));
  }
  return result;
}
