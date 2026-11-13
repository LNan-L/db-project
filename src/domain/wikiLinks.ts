/**
 * @req REQ-103 — 生产双链解析、解析目标、反向引用派生。
 */
import type { Note } from './note';

export interface WikiLink {
  target: string;
  label: string;
  raw: string;
}

export interface LinkIndex {
  byId: Map<string, Note>;
  byTitle: Map<string, Note[]>;
  byTitleLower: Map<string, Note[]>;
}

export interface ResolvedLink {
  target: string;
  label: string;
  noteId: string | null;
  noteTitle: string | null;
  broken: boolean;
  ambiguous: boolean;
}

const WIKI_LINK_SOURCE = /\[\[([^\]\n|]+?)(?:\|([^\]\n]+?))?\]\]/g;

export function normalizeWikiLinkMarkdown(markdown: string): string {
  return markdown.replace(/\\\[\\\[/g, '[[').replace(/\\\]\\\]/g, ']]');
}

export function stripCode(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/`[^`\n]*`/g, '');
}

export function parseWikiLinks(markdown: string): WikiLink[] {
  const text = stripCode(normalizeWikiLinkMarkdown(markdown));
  const links: WikiLink[] = [];
  const pattern = new RegExp(WIKI_LINK_SOURCE.source, 'g');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const target = (match[1] ?? '').trim();
    if (!target) continue;
    links.push({ target, label: (match[2] ?? target).trim(), raw: match[0] });
  }
  return links;
}

function addToMap(map: Map<string, Note[]>, key: string, note: Note): void {
  const list = map.get(key) ?? [];
  list.push(note);
  map.set(key, list);
}

export function buildLinkIndex(notes: Note[]): LinkIndex {
  const byId = new Map<string, Note>();
  const byTitle = new Map<string, Note[]>();
  const byTitleLower = new Map<string, Note[]>();

  for (const note of notes) {
    byId.set(note.id, note);
    const title = note.title.trim();
    if (title) {
      addToMap(byTitle, title, note);
      addToMap(byTitleLower, title.toLocaleLowerCase(), note);
    }
  }

  return { byId, byTitle, byTitleLower };
}

function candidates(index: LinkIndex, target: string): Note[] {
  const clean = target.split('#')[0]?.trim() ?? '';
  if (!clean) return [];
  const byId = index.byId.get(clean);
  if (byId) return [byId];
  const exact = index.byTitle.get(clean);
  if (exact) return exact;
  const lower = index.byTitleLower.get(clean.toLocaleLowerCase());
  if (lower) return lower;
  const leaf = clean.split('/').pop()?.trim();
  if (leaf && leaf !== clean) {
    const leafExact = index.byTitle.get(leaf);
    if (leafExact) return leafExact;
    const leafLower = index.byTitleLower.get(leaf.toLocaleLowerCase());
    if (leafLower) return leafLower;
  }
  return [];
}

export function resolveTarget(
  index: LinkIndex,
  target: string,
  label = target
): ResolvedLink {
  const resolved = candidates(index, target);
  if (resolved.length === 1) {
    const note = resolved[0]!;
    return {
      target,
      label,
      noteId: note.id,
      noteTitle: note.title,
      broken: false,
      ambiguous: false
    };
  }
  return {
    target,
    label,
    noteId: null,
    noteTitle: null,
    broken: resolved.length === 0,
    ambiguous: resolved.length > 1
  };
}

export function getOutgoingLinks(note: Note, index: LinkIndex): ResolvedLink[] {
  return parseWikiLinks(note.body).map((link) =>
    resolveTarget(index, link.target, link.label)
  );
}

export function getBacklinks(
  target: Note,
  notes: Note[],
  index: LinkIndex
): Array<{ note: Note; link: ResolvedLink }> {
  const seen = new Set<string>();
  const result: Array<{ note: Note; link: ResolvedLink }> = [];
  for (const note of notes) {
    if (note.id === target.id || seen.has(note.id)) continue;
    for (const link of parseWikiLinks(note.body)) {
      const resolved = resolveTarget(index, link.target, link.label);
      if (resolved.noteId === target.id) {
        seen.add(note.id);
        result.push({ note, link: resolved });
        break;
      }
    }
  }
  return result;
}
