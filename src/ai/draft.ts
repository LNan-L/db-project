/**
 * @req REQ-205 — AI 草稿：基于检索结果生成草稿，确认前不写正式数据。
 *
 * 模型只返回 JSON；解析时校验字段，关系目标必须来自本次检索到的笔记 id，
 * 其它 id 一律丢弃（避免模型编造或越权引用）。
 */
import type { Note } from '../domain/note';
import type { AiProvider, ChatMessage } from './provider';

export interface DraftRelation {
  targetNoteId: string;
  reason: string;
}

export interface DraftSuggestion {
  title: string;
  body: string;
  relations: DraftRelation[];
}

export function buildDraftPrompt(intent: string, sources: Note[]): ChatMessage[] {
  const context = sources
    .slice(0, 5)
    .map((note, index) => {
      const excerpt = note.body.replace(/\s+/g, ' ').slice(0, 800);
      return `[${index + 1}] id=${note.id}\n标题：${note.title}\n正文：${excerpt}`;
    })
    .join('\n\n');
  return [
    {
      role: 'system',
      content:
        '你是个人知识库的写作助手。根据用户意图和参考笔记，生成一份草稿。' +
        '只输出一个 JSON 对象，不要输出 Markdown 代码块或解释：' +
        '{"title": string, "body": string, "relations": [{"targetNoteId": string, "reason": string}]}。' +
        'relations 只能引用参考笔记里出现的 id；没有就返回空数组。'
    },
    {
      role: 'user',
      content: `意图：${intent}\n\n参考笔记：\n${context || '（没有检索到参考笔记，请仅根据意图写作）'}`
    }
  ];
}

export function parseDraft(raw: string, allowedIds: Set<string>): DraftSuggestion {
  const text = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('AI 没有返回可解析的 JSON 草稿');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error('AI 返回的草稿不是合法 JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AI 返回的草稿结构不正确');
  }
  const object = parsed as Record<string, unknown>;
  const title = typeof object.title === 'string' ? object.title.trim() : '';
  const body = typeof object.body === 'string' ? object.body : '';
  if (!title) throw new Error('AI 返回的草稿缺少标题');
  const relations: DraftRelation[] = [];
  if (Array.isArray(object.relations)) {
    for (const item of object.relations) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const target = record.targetNoteId;
      if (typeof target !== 'string' || !allowedIds.has(target)) continue;
      relations.push({
        targetNoteId: target,
        reason: typeof record.reason === 'string' ? record.reason.trim().slice(0, 200) : ''
      });
    }
  }
  return { title: title.slice(0, 500), body, relations };
}

export async function generateDraft(
  intent: string,
  sources: Note[],
  provider: AiProvider,
  signal?: AbortSignal
): Promise<DraftSuggestion> {
  const raw = await provider.chat(buildDraftPrompt(intent, sources), {
    temperature: 0.3,
    signal
  });
  return parseDraft(raw, new Set(sources.map((note) => note.id)));
}
