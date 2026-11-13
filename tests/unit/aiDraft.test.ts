import { describe, expect, it, vi } from 'vitest';
import type { AiProvider } from '../../src/ai/provider';
import { buildDraftPrompt, generateDraft, parseDraft } from '../../src/ai/draft';
import type { Note } from '../../src/domain/note';

function note(id: string, title: string, body: string): Note {
  return {
    id,
    workspaceId: 'local',
    title,
    body,
    tags: [],
    folder: '',
    createdAt: '2026-11-12T00:00:00.000Z',
    updatedAt: '2026-11-12T00:00:00.000Z'
  };
}

describe('AI draft', () => {
  it('builds a prompt with the intent and retrieved notes', () => {
    const messages = buildDraftPrompt('写一篇检索说明', [
      note('n1', '检索笔记', 'BM25 与向量'),
      note('n2', '草稿笔记', '待补充')
    ]);
    expect(messages).toHaveLength(2);
    expect(messages[1].content).toContain('写一篇检索说明');
    expect(messages[1].content).toContain('id=n1');
    expect(messages[1].content).toContain('检索笔记');
    expect(messages[0].content).toContain('JSON');
  });

  it('parses fenced JSON and drops relations that were not retrieved', () => {
    const raw = [
      '好的，这是草稿：',
      '```json',
      JSON.stringify({
        title: ' 草稿标题 ',
        body: '正文',
        relations: [
          { targetNoteId: 'n1', reason: '参考' },
          { targetNoteId: 'evil', reason: '编造' }
        ]
      }),
      '```'
    ].join('\n');

    const draft = parseDraft(raw, new Set(['n1']));
    expect(draft.title).toBe('草稿标题');
    expect(draft.body).toBe('正文');
    expect(draft.relations).toEqual([{ targetNoteId: 'n1', reason: '参考' }]);
  });

  it('rejects malformed drafts', () => {
    expect(() => parseDraft('没有 JSON', new Set())).toThrow('JSON');
    expect(() => parseDraft('{"body":"没有标题"}', new Set())).toThrow('标题');
    expect(() => parseDraft('{"title":"x", "body":1}', new Set())).not.toThrow();
  });

  it('calls the provider and validates relation ids', async () => {
    const fetchLike = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  title: '生成标题',
                  body: '生成正文',
                  relations: [{ targetNoteId: 'n1', reason: '相关' }]
                })
              }
            }
          ]
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const provider: AiProvider = {
      id: 'fake',
      kind: 'local',
      health: async () => true,
      embed: async () => [],
      chat: async (messages) => {
        const response = await fetchLike();
        const body = (await response.json()) as {
          choices: Array<{ message: { content: string } }>;
        };
        expect(messages[1].content).toContain('意图');
        return body.choices[0].message.content;
      }
    };

    const draft = await generateDraft('意图', [note('n1', '参考', '正文')], provider);
    expect(draft.title).toBe('生成标题');
    expect(draft.relations).toHaveLength(1);
  });
});
