/**
 * @req REQ-101/REQ-104 — 笔记领域模型与纯构造函数。
 */
import { newId } from '../lib/id';

export const DEFAULT_WORKSPACE_ID = 'local';

export interface Note {
  id: string;
  workspaceId: string;
  title: string;
  body: string;
  tags: string[];
  folder: string;
  createdAt: string;
  updatedAt: string;
}

export interface NewNoteInput {
  id?: string;
  workspaceId?: string;
  title?: string;
  body?: string;
  tags?: string[];
  folder?: string;
  now?: Date;
}

export function normalizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().replace(/^#+/, '').trim();
    if (!tag || /\s/.test(tag) || seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
  }
  return result;
}

export function createNote(input: NewNoteInput = {}): Note {
  const now = (input.now ?? new Date()).toISOString();
  return {
    id: input.id ?? newId(),
    workspaceId: input.workspaceId?.trim() || DEFAULT_WORKSPACE_ID,
    title: input.title?.trim() || '未命名笔记',
    body: input.body ?? '',
    tags: normalizeTags(input.tags ?? []),
    folder: input.folder?.trim() ?? '',
    createdAt: now,
    updatedAt: now
  };
}
