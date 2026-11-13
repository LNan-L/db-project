#!/usr/bin/env node
/**
 * @req REQ-302 — PKE MCP 服务（stdio，JSON-RPC 2.0）。
 *
 * 工具：search_notes / read_note / list_tags / draft_note（只返回草稿，不写）
 *       / write_note / create_relation（后两者必须 confirm: true）。
 * 数据来源：同步 API（要求笔记已同步）；不监听端口、不开放公网。
 * 审计：写操作成功后 POST /api/v1/audit-logs。
 *
 * 环境变量：PKE_SYNC_URL（默认 http://127.0.0.1:3000）、PKE_TOKEN（必填）、PKE_MCP_DEVICE（默认 mcp）。
 */
const crypto = require('node:crypto');

const SYNC_URL = (process.env.PKE_SYNC_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const TOKEN = process.env.PKE_TOKEN || '';
const DEVICE = process.env.PKE_MCP_DEVICE || 'mcp';
const SERVER_NAME = 'pke-mcp';
const SERVER_VERSION = '0.1.0';
const PROTOCOL_VERSION = '2024-11-05';
const EMPTY_SINCE = '1970-01-01T00:00:00.000Z';

if (!TOKEN) {
  console.error('PKE_TOKEN is required');
  process.exit(1);
}

let cache = null;

function headers(extra = {}) {
  return { Authorization: `Bearer ${TOKEN}`, ...extra };
}

async function api(pathname, init = {}) {
  return fetch(SYNC_URL + pathname, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...headers(), ...(init.headers || {}) }
  });
}

async function pullAll() {
  const response = await api(
    `/api/v1/pull?since=${encodeURIComponent(EMPTY_SINCE)}&deviceId=${encodeURIComponent(
      DEVICE
    )}&deviceName=${encodeURIComponent('MCP')}`
  );
  if (!response.ok) throw new Error(`同步服务返回 ${response.status}`);
  const body = await response.json();
  cache = { notes: body.notes || [], relations: body.relations || [] };
  return cache;
}

async function getCache(force = false) {
  if (!cache || force) await pullAll();
  return cache;
}

function tokenize(text) {
  const lower = String(text || '').toLowerCase();
  const words = lower.match(/[\p{Script=Han}]|[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(words.filter(Boolean))];
}

function occurrences(haystack, needle) {
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) >= 0) {
    count += 1;
    index += needle.length;
  }
  return count;
}

function scoreNote(note, tokens) {
  const title = String(note.title || '').toLowerCase();
  const body = String(note.body || '').toLowerCase();
  const tags = (note.tags || []).join(' ').toLowerCase();
  let score = 0;
  for (const token of tokens) {
    score += occurrences(title, token) * 3;
    score += occurrences(tags, token) * 2;
    score += Math.min(5, occurrences(body, token));
  }
  return score;
}

function snippetFor(note, tokens) {
  const text = String(note.body || note.title || '').replace(/\s+/g, ' ');
  const lower = text.toLowerCase();
  for (const token of tokens) {
    const index = lower.indexOf(token);
    if (index >= 0) {
      const start = Math.max(0, index - 40);
      return `${start > 0 ? '…' : ''}${text.slice(start, start + 120)}`;
    }
  }
  return text.slice(0, 120);
}

async function searchNotes({ query, limit } = {}) {
  const tokens = tokenize(query);
  if (tokens.length === 0) throw new Error('query 不能为空');
  const { notes } = await getCache();
  const top = Number.isFinite(limit) ? Math.min(Math.max(1, Math.floor(limit)), 20) : 5;
  return notes
    .map((note) => ({ note, score: scoreNote(note, tokens) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || String(a.note.title).localeCompare(String(b.note.title)))
    .slice(0, top)
    .map(({ note, score }) => ({
      id: note.id,
      title: note.title,
      score,
      snippet: snippetFor(note, tokens)
    }));
}

async function readNote({ id } = {}) {
  const { notes } = await getCache();
  const note = notes.find((row) => row.id === id);
  if (!note) throw new Error(`找不到笔记：${id}`);
  return {
    id: note.id,
    title: note.title,
    body: note.body,
    tags: note.tags,
    folder: note.folder,
    updatedAt: note.updatedAt,
    revision: note.revision,
    deleted: note.deleted
  };
}

async function listTags() {
  const { notes } = await getCache();
  const counts = new Map();
  for (const note of notes) {
    for (const tag of note.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag, count]) => ({ tag, count }));
}

async function draftNote({ intent, sourceIds } = {}) {
  const text = String(intent || '').trim();
  if (!text) throw new Error('intent 不能为空');
  const { notes } = await getCache();
  const ids = Array.isArray(sourceIds) ? sourceIds.map(String) : [];
  const sources = ids
    .map((id) => notes.find((note) => note.id === id))
    .filter(Boolean)
    .slice(0, 5);
  const title = text.slice(0, 60);
  const body = [
    `# ${title}`,
    '',
    text,
    '',
    ...(sources.length > 0 ? ['参考：', ...sources.map((note) => `- ${note.title}（${note.id}）`)] : [])
  ].join('\n');
  return {
    title,
    body,
    sourceIds: sources.map((note) => note.id),
    note: '草稿尚未写入；确认后用 write_note（confirm: true）落库'
  };
}

function digest(params) {
  return crypto.createHash('sha256').update(JSON.stringify(params)).digest('hex').slice(0, 16);
}

async function writeAudit(tool, params, result, noteId) {
  try {
    const response = await api('/api/v1/audit-logs', {
      method: 'POST',
      body: JSON.stringify({
        tool,
        device: DEVICE,
        paramsDigest: digest(params),
        result,
        noteId
      })
    });
    if (!response.ok) console.error('audit log failed', response.status);
  } catch (error) {
    console.error('audit log failed', error.message || error);
  }
}

async function writeNote({ title, body, confirm } = {}) {
  if (confirm !== true) throw new Error('write_note 需要 confirm: true（人工批准后才会写入）');
  const cleanTitle = typeof title === 'string' ? title.trim().slice(0, 500) : '';
  if (!cleanTitle) throw new Error('title 不能为空');
  if (typeof body !== 'string') throw new Error('body 必须是字符串');
  const now = new Date().toISOString();
  const note = {
    id: crypto.randomUUID(),
    title: cleanTitle,
    body,
    tags: [],
    folder: '',
    updatedAt: now,
    baseRevision: null
  };
  const response = await api('/api/v1/push', {
    method: 'POST',
    body: JSON.stringify({ deviceId: DEVICE, deviceName: 'MCP', notes: [note], relations: [], attachments: [] })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`写入失败：同步服务返回 ${response.status}`);
  const applied = (payload.applied || []).find((row) => row.id === note.id);
  if (!applied) {
    throw new Error(`写入被拒绝：${JSON.stringify(payload.conflicts || payload.error || 'unknown')}`);
  }
  await writeAudit('write_note', { title: cleanTitle, chars: body.length }, 'created', note.id);
  cache = null;
  return { id: note.id, revision: applied.revision, title: note.title };
}

async function createRelation({ sourceId, targetId, confirm } = {}) {
  if (confirm !== true) throw new Error('create_relation 需要 confirm: true（人工批准后才会写入）');
  const source = String(sourceId || '');
  const target = String(targetId || '');
  if (!source || !target || source === target) throw new Error('sourceId/targetId 无效');
  const { notes } = await getCache();
  if (!notes.some((note) => note.id === source) || !notes.some((note) => note.id === target)) {
    throw new Error('sourceId 或 targetId 不在已同步的笔记里');
  }
  const [a, b] = [source, target].sort();
  const id = `manual:${a}:${b}`;
  const response = await api('/api/v1/push', {
    method: 'POST',
    body: JSON.stringify({
      deviceId: DEVICE,
      deviceName: 'MCP',
      notes: [],
      relations: [{ id, sourceId: a, targetId: b, createdAt: new Date().toISOString(), deleted: false }],
      attachments: []
    })
  });
  if (!response.ok) throw new Error(`写入失败：同步服务返回 ${response.status}`);
  await writeAudit('create_relation', { sourceId: a, targetId: b }, 'created', id);
  cache = null;
  return { id, sourceId: a, targetId: b };
}

const tools = [
  {
    name: 'search_notes',
    description: '按关键词搜索已同步的笔记（标题/标签/正文加权），返回 id、标题、摘要。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索词' },
        limit: { type: 'number', description: '返回条数，默认 5，最大 20' }
      },
      required: ['query']
    }
  },
  {
    name: 'read_note',
    description: '按 id 读取一篇笔记的完整内容。',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: '笔记 id' } },
      required: ['id']
    }
  },
  {
    name: 'list_tags',
    description: '列出标签及使用次数。',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'draft_note',
    description: '根据意图生成草稿（不写库）。确认后用 write_note 落库。',
    inputSchema: {
      type: 'object',
      properties: {
        intent: { type: 'string', description: '想写的内容' },
        sourceIds: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：参考笔记 id 列表'
        }
      },
      required: ['intent']
    }
  },
  {
    name: 'write_note',
    description: '写一篇新笔记。必须传 confirm: true（人工批准），写入后记录 audit_logs。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        confirm: { type: 'boolean', description: '必须为 true' }
      },
      required: ['title', 'body', 'confirm']
    }
  },
  {
    name: 'create_relation',
    description: '在两篇已同步笔记之间建立手动关系。必须传 confirm: true。',
    inputSchema: {
      type: 'object',
      properties: {
        sourceId: { type: 'string' },
        targetId: { type: 'string' },
        confirm: { type: 'boolean', description: '必须为 true' }
      },
      required: ['sourceId', 'targetId', 'confirm']
    }
  }
];

const handlers = {
  search_notes: searchNotes,
  read_note: readNote,
  list_tags: listTags,
  draft_note: draftNote,
  write_note: writeNote,
  create_relation: createRelation
};

async function dispatch(method, params) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: params.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools };
    case 'tools/call': {
      const name = String(params.name || '');
      const handler = handlers[name];
      if (!handler) throw new Error(`未知工具：${name}`);
      try {
        const payload = await handler(params.arguments || {});
        return {
          content: [
            {
              type: 'text',
              text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
            }
          ]
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: String(error.message || error) }],
          isError: true
        };
      }
    }
    default:
      throw new Error(`未知方法：${method}`);
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let queue = Promise.resolve();

async function handleLine(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    console.error('mcp: 收到非法 JSON');
    return;
  }
  const { id, method, params } = message;
  if (typeof method === 'string' && method.startsWith('notifications/')) return;
  try {
    const result = await dispatch(method, params || {});
    if (id !== undefined && id !== null) send({ jsonrpc: '2.0', id, result });
  } catch (error) {
    if (id !== undefined && id !== null) {
      send({ jsonrpc: '2.0', id, error: { code: -32000, message: String(error.message || error) } });
    }
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    queue = queue.then(() => handleLine(line));
  }
});
process.stdin.on('end', () => {
  queue.finally(() => process.exit(0));
});
process.on('SIGINT', () => process.exit(0));
