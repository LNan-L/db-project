#!/usr/bin/env node
/**
 * @req REQ-302 — MCP 服务回归（stdio JSON-RPC）。
 *
 * 自带临时同步库/端口，不碰生产数据。用法：
 *   node server/verify-mcp.js [--server <pke-sync-server.js>] [--mcp <mcp-server.js>]
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function argOf(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const SERVER_JS = path.resolve(argOf('--server', path.join(__dirname, 'pke-sync-server.js')));
const MCP_JS = path.resolve(argOf('--mcp', path.join(__dirname, 'mcp-server.js')));
const PORT = Number(argOf('--port', '0')) || 22000 + Math.floor(Math.random() * 20000);
const TOKEN = 'verify-mcp-token-0123456789abcdef';
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(os.tmpdir(), `pke-mcp-verify-${Date.now()}.db`);
const BLOB_DIR = path.join(os.tmpdir(), `pke-mcp-verify-blobs-${Date.now()}`);

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (actual=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)})`}`
  );
}

async function api(pathname, init = {}) {
  const response = await fetch(BASE + pathname, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      ...(init.headers || {})
    }
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

function startMcp() {
  const child = spawn(process.execPath, [MCP_JS], {
    env: {
      ...process.env,
      PKE_SYNC_URL: BASE,
      PKE_TOKEN: TOKEN,
      PKE_MCP_DEVICE: 'mcp-verify'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let buffer = '';
  let seq = 0;
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        if (message.id !== undefined && pending.has(message.id)) {
          const waiter = pending.get(message.id);
          pending.delete(message.id);
          waiter.resolve(message);
        }
      } catch {
        /* 忽略非 JSON 输出 */
      }
    }
  });
  child.stderr.on('data', (chunk) => process.stderr.write(`[mcp] ${chunk}`));
  const rpc = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP 超时：${method}`));
      }, 15000);
      pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        }
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  return { child, rpc };
}

function toolText(response) {
  return response?.result?.content?.[0]?.text ?? '';
}

function startSyncServer() {
  const child = spawn(process.execPath, [SERVER_JS], {
    env: {
      ...process.env,
      PKE_TOKEN: TOKEN,
      PKE_DB: DB_PATH,
      PKE_PORT: String(PORT),
      PKE_HOST: '127.0.0.1',
      PKE_BLOB_DIR: BLOB_DIR
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    process.stderr.write(chunk);
  });
  return { child, stderr: () => stderr };
}

async function waitForHealth(deadlineMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    try {
      const response = await fetch(`${BASE}/health`);
      if (response.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

async function main() {
  const server = startSyncServer();
  let mcp = null;
  try {
    if (!(await waitForHealth())) throw new Error('同步服务未就绪');

    const seed = await api('/api/v1/push', {
      method: 'POST',
      body: JSON.stringify({
        deviceId: 'seed',
        deviceName: 'seed',
        notes: [
          {
            id: 'note-a',
            title: 'alpha 检索笔记',
            body: 'BM25 与向量的混合检索说明',
            tags: ['检索'],
            folder: '',
            updatedAt: new Date().toISOString(),
            baseRevision: null
          },
          {
            id: 'note-b',
            title: 'beta 同步笔记',
            body: '多设备同步与冲突处理',
            tags: ['同步'],
            folder: '',
            updatedAt: new Date().toISOString(),
            baseRevision: null
          }
        ],
        relations: [],
        attachments: []
      })
    });
    check('seed notes pushed', seed.body.applied.length, 2);

    mcp = startMcp();

    const init = await mcp.rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'verify', version: '1' }
    });
    check('initialize server name', init.result?.serverInfo?.name, 'pke-mcp');
    check('initialize tools capability', Boolean(init.result?.capabilities?.tools), true);

    const list = await mcp.rpc('tools/list');
    const names = (list.result?.tools || []).map((tool) => tool.name).sort();
    check('tools/list contains write_note', names.includes('write_note'), true);
    check('tools/list contains search_notes', names.includes('search_notes'), true);

    const search = await mcp.rpc('tools/call', {
      name: 'search_notes',
      arguments: { query: '混合检索' }
    });
    const searchRows = JSON.parse(toolText(search));
    check('search finds note-a first', searchRows[0]?.id, 'note-a');

    const read = await mcp.rpc('tools/call', {
      name: 'read_note',
      arguments: { id: 'note-a' }
    });
    check('read_note body', JSON.parse(toolText(read)).body, 'BM25 与向量的混合检索说明');

    const tags = await mcp.rpc('tools/call', { name: 'list_tags', arguments: {} });
    check('list_tags count', JSON.parse(toolText(tags)).length, 2);

    const draft = await mcp.rpc('tools/call', {
      name: 'draft_note',
      arguments: { intent: '整理检索方案', sourceIds: ['note-a'] }
    });
    const draftBody = JSON.parse(toolText(draft));
    check('draft title', draftBody.title, '整理检索方案');
    check('draft not written', draftBody.note.includes('尚未写入'), true);

    const before = await api('/api/v1/pull?since=1970-01-01T00:00:00.000Z');
    check('draft did not write', before.body.notes.length, 2);

    const unconfirmed = await mcp.rpc('tools/call', {
      name: 'write_note',
      arguments: { title: '未经批准', body: 'x', confirm: false }
    });
    check('write without confirm rejected', Boolean(unconfirmed.result?.isError), true);
    const afterReject = await api('/api/v1/pull?since=1970-01-01T00:00:00.000Z');
    check('rejected write did not persist', afterReject.body.notes.length, 2);

    const written = await mcp.rpc('tools/call', {
      name: 'write_note',
      arguments: { title: 'MCP 写入的笔记', body: '来自 MCP 的内容', confirm: true }
    });
    const writtenBody = JSON.parse(toolText(written));
    check('write returns revision', writtenBody.revision, 1);
    const afterWrite = await api('/api/v1/pull?since=1970-01-01T00:00:00.000Z');
    check('confirmed write persisted', afterWrite.body.notes.length, 3);

    const relationRejected = await mcp.rpc('tools/call', {
      name: 'create_relation',
      arguments: { sourceId: 'note-a', targetId: 'note-b', confirm: false }
    });
    check('relation without confirm rejected', Boolean(relationRejected.result?.isError), true);

    const relation = await mcp.rpc('tools/call', {
      name: 'create_relation',
      arguments: { sourceId: 'note-a', targetId: 'note-b', confirm: true }
    });
    const relationBody = JSON.parse(toolText(relation));
    check('relation id', relationBody.id, 'manual:note-a:note-b');
    const afterRelation = await api('/api/v1/pull?since=1970-01-01T00:00:00.000Z');
    check(
      'relation persisted',
      afterRelation.body.relations.some((row) => row.id === 'manual:note-a:note-b'),
      true
    );

    const audit = await api('/api/v1/audit-logs?limit=20');
    const tools = (audit.body.logs || []).map((row) => row.tool);
    check('audit has write_note', tools.includes('write_note'), true);
    check('audit has create_relation', tools.includes('create_relation'), true);
    check(
      'audit records note id',
      (audit.body.logs || []).some((row) => row.noteId === writtenBody.id),
      true
    );
  } finally {
    if (mcp) mcp.child.kill();
    server.child.kill();
    await new Promise((resolve) => setTimeout(resolve, 200));
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(DB_PATH + suffix);
      } catch {
        /* ignore */
      }
    }
    try {
      fs.rmSync(BLOB_DIR, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('verify failed:', error);
  process.exit(1);
});
