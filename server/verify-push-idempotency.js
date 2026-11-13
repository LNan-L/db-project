/**
 * @req B-5 — 同步写入幂等。
 *
 * 背景：开了 PKE_DATA_KEY 之后，同一份明文每次加密的 IV 不同，密文必然不同。
 * 如果"有没有变化"靠比较密文（或压根不比较），重复 push 就会：
 *   - 把同一篇笔记的 revision 一路推高、版本历史多出重复条目；
 *   - 每次都重写附件行，别的设备于是反复拉到"新"附件。
 *
 * 这个回归用**带 key 的服务端**跑，覆盖的就是这个加密场景。
 *
 * 用法（需要 express / better-sqlite3 / cors）：
 *   node server/verify-push-idempotency.js [--server <pke-sync-server.js>] [--port 0]
 *
 * 自带临时数据库、临时附件目录和临时端口，不碰生产库。
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
const PORT = Number(argOf('--port', '0')) || 20000 + Math.floor(Math.random() * 20000);
const TOKEN = 'verify-idempotency-0123456789';
const DATA_KEY = 'verify-idempotency-key-0123456789abcdef';
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(os.tmpdir(), `pke-idem-${Date.now()}.db`);
const BLOB_DIR = path.join(os.tmpdir(), `pke-idem-blobs-${Date.now()}`);

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
  return { status: response.status, body: await response.json() };
}

function note(title, body) {
  return { id: 'idem-note', title, body, tags: [], folder: '', updatedAt: new Date().toISOString(), baseRevision: null };
}

function attachment(hash) {
  return {
    id: 'idem-att',
    noteId: 'idem-note',
    name: 'photo.jpg',
    mime: 'image/jpeg',
    size: 3,
    hash,
    createdAt: '2026-11-01T00:00:00.000Z',
    deleted: false
  };
}

async function waitForHealth(deadlineMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < deadlineMs) {
    if (childRef.exitCode !== null) return false;
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

let childRef = null;
let childStderr = '';

async function main() {
  const child = spawn(process.execPath, [SERVER_JS], {
    env: {
      ...process.env,
      PKE_TOKEN: TOKEN,
      PKE_DB: DB_PATH,
      PKE_PORT: String(PORT),
      PKE_HOST: '127.0.0.1',
      PKE_BLOB_DIR: BLOB_DIR,
      // 关键：开着加密跑，密文比较的坑才会暴露
      PKE_DATA_KEY: DATA_KEY,
      PKE_DATA_KEY_OLD: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  childRef = child;
  child.stderr.on('data', (chunk) => {
    childStderr += chunk;
    process.stderr.write(chunk);
  });

  try {
    if (!(await waitForHealth())) throw new Error('server did not become healthy: ' + childStderr);

    // 1. 首次推送
    const first = await api('/api/v1/push', {
      method: 'POST',
      body: JSON.stringify({ deviceId: 'device-idem', notes: [note('v1', 'body v1')] })
    });
    check('first push applied', first.body.applied.length, 1);
    check('first push revision', first.body.applied[0].revision, 1);

    // 2. 完全相同的内容再推一次（自动同步重试 / 客户端时钟偏差）
    const duplicate = await api('/api/v1/push', {
      method: 'POST',
      body: JSON.stringify({ deviceId: 'device-idem', notes: [note('v1', 'body v1')] })
    });
    check('duplicate push applies nothing', duplicate.body.applied.length, 0);
    check('duplicate push reports no conflict', duplicate.body.conflicts.length, 0);

    const versions = await api('/api/v1/versions/idem-note');
    check('duplicate push writes no extra version', versions.body.versions.length, 1);
    check('duplicate push keeps revision 1', versions.body.versions[0].revision, 1);

    // 3. 内容真的变了才涨 revision
    const changed = await api('/api/v1/push', {
      method: 'POST',
      body: JSON.stringify({
        deviceId: 'device-idem',
        notes: [{ ...note('v2', 'body v2'), baseRevision: 1 }]
      })
    });
    check('changed content applies', changed.body.applied.length, 1);
    check('changed content bumps revision', changed.body.applied[0].revision, 2);

    // 4. 已过期的 baseRevision + 相同内容：幂等优先，不要求客户端升级
    const stale = await api('/api/v1/push', {
      method: 'POST',
      body: JSON.stringify({
        deviceId: 'device-idem',
        notes: [{ ...note('v2', 'body v2'), baseRevision: 1 }]
      })
    });
    check('stale duplicate applies nothing', stale.body.applied.length, 0);
    check('stale duplicate is not a conflict', stale.body.conflicts.length, 0);

    // 5. 附件：首次写入 1 次，重复推送 0 次
    const attFirst = await api('/api/v1/push', {
      method: 'POST',
      body: JSON.stringify({ deviceId: 'device-idem', attachments: [attachment('hash-a')] })
    });
    check('first attachment push applied', attFirst.body.attachmentsApplied, 1);

    const attDup = await api('/api/v1/push', {
      method: 'POST',
      body: JSON.stringify({ deviceId: 'device-idem', attachments: [attachment('hash-a')] })
    });
    check('duplicate attachment push applies nothing', attDup.body.attachmentsApplied, 0);

    // 6. 附件内容变化（hash 变）才写
    const attChanged = await api('/api/v1/push', {
      method: 'POST',
      body: JSON.stringify({ deviceId: 'device-idem', attachments: [attachment('hash-b')] })
    });
    check('changed attachment applies', attChanged.body.attachmentsApplied, 1);

    // 7. 游标之后没有"假"变更：重复推送过的行不该再被拉出来
    const pull = await api(`/api/v1/pull?since=${encodeURIComponent(attChanged.body.serverTime)}`);
    check('no attachment churn after push', pull.body.attachments.length, 0);
    check('no note churn after push', pull.body.notes.length, 0);
  } finally {
    if (childRef && childRef.exitCode === null) childRef.kill();
    try {
      fs.rmSync(DB_PATH, { force: true });
      fs.rmSync(`${DB_PATH}-wal`, { force: true });
      fs.rmSync(`${DB_PATH}-shm`, { force: true });
      fs.rmSync(BLOB_DIR, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
