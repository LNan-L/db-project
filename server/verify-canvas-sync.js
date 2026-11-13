#!/usr/bin/env node
/**
 * @req B-3 — 画布布局同步回归（临时库 + 随机端口）。
 * 覆盖：卡片随同步往返、较旧的 updatedAt 不覆盖较新的、删除卡片会传播。
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
const PORT = Number(argOf('--port', '0')) || 26000 + Math.floor(Math.random() * 8000);
const TOKEN = 'verify-b3-token-0123456789abcdef';
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(os.tmpdir(), `pke-b3-verify-${Date.now()}.db`);
const BLOB_DIR = path.join(os.tmpdir(), `pke-b3-verify-blobs-${Date.now()}`);

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (actual=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)})`}`
  );
}

async function api(pathname, init = {}) {
  const url = new URL(BASE + pathname);
  if (init.query) for (const [key, value] of Object.entries(init.query)) url.searchParams.set(key, value);
  const response = await fetch(url, {
    method: init.method || 'GET',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: init.body ? JSON.stringify(init.body) : undefined
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const since = () => ({ since: '1970-01-01T00:00:00.000Z', deviceId: 'b3-device' });

async function main() {
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
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));

  try {
    const started = Date.now();
    let healthy = false;
    while (Date.now() - started < 15000) {
      try {
        if ((await fetch(`${BASE}/health`)).ok) {
          healthy = true;
          break;
        }
      } catch {
        /* not up yet */
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    if (!healthy) throw new Error('sync server not ready');

    // 先把两篇笔记推上去（卡片要有对应笔记）
    const note = (id) => ({
      id,
      title: id,
      body: 'x',
      tags: [],
      folder: '',
      updatedAt: new Date().toISOString(),
      baseRevision: null
    });
    check(
      'seed notes',
      (await api('/api/v1/push', { method: 'POST', body: { deviceId: 'b3-device', notes: [note('n1'), note('n2')], relations: [], attachments: [] } })).status,
      200
    );

    const t1 = '2026-11-12T10:00:00.000Z';
    const push = await api('/api/v1/push', {
      method: 'POST',
      body: {
        deviceId: 'b3-device',
        notes: [],
        relations: [],
        attachments: [],
        canvas: [
          { noteId: 'n1', x: 120, y: 80, updatedAt: t1 },
          { noteId: 'n2', x: -40.5, y: 310.25, updatedAt: t1 }
        ]
      }
    });
    check('canvas push accepted', push.status, 200);
    check('two cards applied', push.body.canvasApplied, 2);

    const pull1 = await api('/api/v1/pull', { query: since() });
    check('canvas returned by pull', (pull1.body.canvas || []).length, 2);
    const card1 = (pull1.body.canvas || []).find((row) => row.noteId === 'n1');
    check('card coordinates round-trip', [card1.x, card1.y], [120, 80]);
    check('fractional coordinates kept', (pull1.body.canvas || []).find((row) => row.noteId === 'n2').y, 310.25);

    // 更旧的 updatedAt 不应回滚
    const stale = await api('/api/v1/push', {
      method: 'POST',
      body: {
        deviceId: 'b3-device',
        notes: [],
        relations: [],
        attachments: [],
        canvas: [{ noteId: 'n1', x: 999, y: 999, updatedAt: '2026-11-01T00:00:00.000Z' }]
      }
    });
    check('stale card ignored', stale.body.canvasApplied, 0);
    const pull2 = await api('/api/v1/pull', { query: since() });
    const card1b = (pull2.body.canvas || []).find((row) => row.noteId === 'n1');
    check('stale push did not move the card', [card1b.x, card1b.y], [120, 80]);

    // 更新的 updatedAt 应当生效
    const fresh = await api('/api/v1/push', {
      method: 'POST',
      body: {
        deviceId: 'b3-device',
        notes: [],
        relations: [],
        attachments: [],
        canvas: [{ noteId: 'n1', x: 500, y: 400, updatedAt: '2026-11-12T12:00:00.000Z' }]
      }
    });
    check('newer card applied', fresh.body.canvasApplied, 1);
    const pull3 = await api('/api/v1/pull', { query: since() });
    const card1c = (pull3.body.canvas || []).find((row) => row.noteId === 'n1');
    check('newer push moved the card', [card1c.x, card1c.y], [500, 400]);

    // 删除卡片传播
    const remove = await api('/api/v1/push', {
      method: 'POST',
      body: {
        deviceId: 'b3-device',
        notes: [],
        relations: [],
        attachments: [],
        canvas: [{ noteId: 'n2', deleted: true }]
      }
    });
    check('card delete applied', remove.body.canvasApplied, 1);
    const pull4 = await api('/api/v1/pull', { query: since() });
    check('deleted card is gone', (pull4.body.canvas || []).some((row) => row.noteId === 'n2'), false);
    check('other card remains', (pull4.body.canvas || []).some((row) => row.noteId === 'n1'), true);

    // 增量游标：用最新 serverTime 再拉，没有新变更
    const pull5 = await api('/api/v1/pull', {
      query: { since: pull4.body.serverTime, deviceId: 'b3-device' }
    });
    check('incremental pull has no duplicate cards', (pull5.body.canvas || []).length, 0);

    // 未知笔记也能存（服务端不强制外键，避免删除竞态丢布局）
    const orphan = await api('/api/v1/push', {
      method: 'POST',
      body: {
        deviceId: 'b3-device',
        notes: [],
        relations: [],
        attachments: [],
        canvas: [{ noteId: 'missing-note', x: 1, y: 2, updatedAt: t1 }]
      }
    });
    check('orphan card accepted (no FK)', orphan.body.canvasApplied, 1);
  } finally {
    child.kill();
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
