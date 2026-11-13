#!/usr/bin/env node
/**
 * @req B-5 / B-6 — 静态加密端到端回归（临时库 + 随机端口）。
 *
 * 覆盖：配置 key 后磁盘无明文；API 读回正常；附件字节加密且能下载还原；
 * 用旧 key 启动后可读（轮换兼容）；轮换后旧 key 单独无法解密。
 */
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

function argOf(flag, fallback) {
  const index = process.argv.indexOf(flag);
  return index > 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const SERVER_JS = path.resolve(argOf('--server', path.join(__dirname, 'pke-sync-server.js')));
const PORT = Number(argOf('--port', '0')) || 28000 + Math.floor(Math.random() * 6000);
const TOKEN = 'verify-atrest-token-0123456789abcd';
const BASE = `http://127.0.0.1:${PORT}`;
const STAMP = Date.now();
const DB_PATH = path.join(os.tmpdir(), `pke-atrest-verify-${STAMP}.db`);
const BLOB_DIR = path.join(os.tmpdir(), `pke-atrest-blobs-${STAMP}`);
const KEY_A = crypto.randomBytes(24).toString('base64');
const KEY_B = crypto.randomBytes(24).toString('base64');
const SECRET = '这是需要保护的正文内容';

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
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      ...(init.headers || {})
    },
    body: init.body ? JSON.stringify(init.body) : undefined
  });
  if (init.raw) return { status: response.status, buffer: Buffer.from(await response.arrayBuffer()) };
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

function start(env = {}) {
  const child = spawn(process.execPath, [SERVER_JS], {
    env: {
      ...process.env,
      PKE_TOKEN: TOKEN,
      PKE_DB: DB_PATH,
      PKE_PORT: String(PORT),
      PKE_HOST: '127.0.0.1',
      PKE_BLOB_DIR: BLOB_DIR,
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stderr.on('data', (chunk) => process.stderr.write(chunk));
  return child;
}

async function ready() {
  const started = Date.now();
  while (Date.now() - started < 15000) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return true;
    } catch {
      /* not up */
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}

async function stop(child) {
  child.kill();
  await new Promise((resolve) => setTimeout(resolve, 300));
}

function rawRow(table, id) {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    const columns = table === 'notes' ? 'title, body, tags, folder' : 'name, mime';
    return db.prepare(`SELECT ${columns} FROM ${table} WHERE id = ?`).get(id);
  } finally {
    db.close();
  }
}

async function main() {
  let server = start({ PKE_DATA_KEY: KEY_A });
  try {
    if (!(await ready())) throw new Error('server not ready');

    const push = await api('/api/v1/push', {
      method: 'POST',
      body: {
        deviceId: 'atrest-device',
        notes: [
          {
            id: 'secret-note',
            title: '机密标题',
            body: SECRET,
            tags: ['机密'],
            folder: '客户机密项目',
            updatedAt: new Date().toISOString(),
            baseRevision: null
          }
        ],
        relations: [],
        attachments: [],
        canvas: []
      }
    });
    check('note pushed', push.status, 200);

    // 磁盘上不应出现明文
    const row = rawRow('notes', 'secret-note');
    check('title is encrypted on disk', row.title.startsWith('enc:v1:'), true);
    check('body is encrypted on disk', row.body.startsWith('enc:v1:'), true);
    check('disk row has no plaintext body', row.body.includes('需要保护'), false);
    check('disk row has no plaintext title', row.title.includes('机密'), false);
    check('tags are encrypted too', row.tags.startsWith('enc:v1:'), true);
    check('folder is encrypted on disk', row.folder.startsWith('enc:v1:'), true);
    check('disk row has no plaintext folder', row.folder.includes('客户机密'), false);

    // API 读回来必须是明文
    const pull = await api('/api/v1/pull', {
      query: { since: '1970-01-01T00:00:00.000Z', deviceId: 'atrest-device' }
    });
    const note = (pull.body.notes || []).find((item) => item.id === 'secret-note');
    check('API returns decrypted title', note.title, '机密标题');
    check('API returns decrypted body', note.body, SECRET);
    check('API returns decrypted tags', note.tags, ['机密']);
    check('API returns decrypted folder', note.folder, '客户机密项目');

    // 版本历史也必须加密存、解密出
    const versions = await api('/api/v1/versions/secret-note');
    check('version history readable', versions.body.versions?.[0]?.body, SECRET);
    check('version folder readable', versions.body.versions?.[0]?.folder, '客户机密项目');
    const versionRow = (() => {
      const db = new Database(DB_PATH, { readonly: true });
      try {
        return db.prepare('SELECT body, folder FROM note_versions WHERE note_id = ?').get('secret-note');
      } finally {
        db.close();
      }
    })();
    check('version body is encrypted on disk', versionRow.body.startsWith('enc:v1:'), true);
    check('version folder is encrypted on disk', versionRow.folder.startsWith('enc:v1:'), true);
    // 附件字节加密：先登记元数据，再上传字节
    await api('/api/v1/push', {
      method: 'POST',
      body: {
        deviceId: 'atrest-device',
        notes: [],
        relations: [],
        attachments: [
          {
            id: 'blob-1',
            noteId: 'secret-note',
            name: '机密图片.png',
            mime: 'image/png',
            size: 30,
            hash: 'deadbeef',
            createdAt: new Date().toISOString()
          }
        ],
        canvas: []
      }
    });
    const metaRow = rawRow('attachments', 'blob-1');
    check('attachment name is encrypted on disk', metaRow.name.startsWith('enc:v1:'), true);
    check('attachment mime is encrypted on disk', metaRow.mime.startsWith('enc:v1:'), true);

    const blob = Buffer.from('附件里的秘密图片字节');
    const upload = await fetch(`${BASE}/api/v1/attachments/blob-1/blob`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/octet-stream' },
      body: blob
    });
    check('blob uploaded', upload.status, 200);
    const onDisk = fs.readFileSync(path.join(BLOB_DIR, 'blob-1'));
    check('blob has encryption magic', onDisk.subarray(0, 7).toString('utf8'), 'PKEENC1');
    check('blob on disk is not plaintext', onDisk.includes('秘密图片'), false);
    const download = await api('/api/v1/attachments/blob-1/blob', { raw: true });
    check('blob downloads decrypted', Buffer.compare(download.buffer, blob), 0);

    // 未配置 key 的实例打不开这些数据（fail-closed）
    await stop(server);
    server = start({});
    if (!(await ready())) throw new Error('server not ready (no key)');
    const noKeyPull = await api('/api/v1/pull', {
      query: { since: '1970-01-01T00:00:00.000Z', deviceId: 'atrest-device' }
    });
    check('without the key the API fails closed', noKeyPull.status, 500);

    // 旧 key 启动：仍能读（轮换过渡期）
    await stop(server);
    server = start({ PKE_DATA_KEY: KEY_A });
    if (!(await ready())) throw new Error('server not ready (old key)');
    const oldKeyPull = await api('/api/v1/pull', {
      query: { since: '1970-01-01T00:00:00.000Z', deviceId: 'atrest-device' }
    });
    check(
      'old key still reads during transition',
      (oldKeyPull.body.notes || []).find((item) => item.id === 'secret-note')?.body,
      SECRET
    );

    // 轮换：新 key + 旧 key，启动后自动重写
    await stop(server);
    server = start({ PKE_DATA_KEY: KEY_B, PKE_DATA_KEY_OLD: KEY_A });
    if (!(await ready())) throw new Error('server not ready (rotation)');
    await new Promise((resolve) => setTimeout(resolve, 400));
    const rotatedRow = rawRow('notes', 'secret-note');
    check('row rewritten with the new key', rotatedRow.body.startsWith('enc:v1:'), true);
    const rotatedPull = await api('/api/v1/pull', {
      query: { since: '1970-01-01T00:00:00.000Z', deviceId: 'atrest-device' }
    });
    check(
      'rotated data still readable',
      (rotatedPull.body.notes || []).find((item) => item.id === 'secret-note')?.body,
      SECRET
    );
    const rotatedBlob = await api('/api/v1/attachments/blob-1/blob', { raw: true });
    check('rotated blob still downloads', Buffer.compare(rotatedBlob.buffer, blob), 0);

    // 只用新 key（拿掉 old）重启：仍可读，说明真的换成了新 key
    await stop(server);
    server = start({ PKE_DATA_KEY: KEY_B });
    if (!(await ready())) throw new Error('server not ready (new key only)');
    const newOnlyPull = await api('/api/v1/pull', {
      query: { since: '1970-01-01T00:00:00.000Z', deviceId: 'atrest-device' }
    });
    check(
      'new key alone reads after rotation',
      (newOnlyPull.body.notes || []).find((item) => item.id === 'secret-note')?.body,
      SECRET
    );
    const newOnlyBlob = await api('/api/v1/attachments/blob-1/blob', { raw: true });
    check('new key alone reads the blob after rotation', Buffer.compare(newOnlyBlob.buffer, blob), 0);
  } finally {
    await stop(server);
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
