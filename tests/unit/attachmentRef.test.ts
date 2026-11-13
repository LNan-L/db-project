import { describe, expect, it } from 'vitest';
import {
  attachmentRef,
  toDisplayMarkdown,
  toStoredMarkdown
} from '../../src/markdown/attachmentRef';
import type { Attachment } from '../../src/storage/db';

function makeAttachment(id: string): Attachment {
  const blob = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02])], { type: 'image/png' });
  return {
    id,
    noteId: 'note-1',
    name: 'dot.png',
    mime: 'image/png',
    size: blob.size,
    hash: 'h',
    blob,
    createdAt: '2026-11-11T00:00:00.000Z'
  };
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

describe('attachment refs in note bodies', () => {
  it('swaps inline data urls for a short ref and back', async () => {
    const attachment = makeAttachment('att-1');
    const dataUrl = await blobToDataUrl(attachment.blob);
    const display = `# 标题\n\n![dot.png](${dataUrl})\n`;

    const stored = await toStoredMarkdown(display, [attachment]);
    expect(stored).toBe(`# 标题\n\n![dot.png](${attachmentRef('att-1')})\n`);
    expect(stored.length).toBeLessThan(60);

    const roundTrip = await toDisplayMarkdown(stored, [attachment]);
    expect(roundTrip).toBe(display);
  });

  it('leaves unrelated data urls and plain markdown alone', async () => {
    const attachment = makeAttachment('att-2');
    const markdown = '正文\n\n![remote](https://example.com/a.png)\n';
    expect(await toStoredMarkdown(markdown, [attachment])).toBe(markdown);
    expect(await toDisplayMarkdown(markdown, [attachment])).toBe(markdown);
  });

  it('keeps an unresolved ref when the attachment is missing', async () => {
    const stored = '![gone](attachment:missing)\n';
    expect(await toDisplayMarkdown(stored, [])).toBe(stored);
  });
});