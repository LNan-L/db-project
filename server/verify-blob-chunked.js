/**
 * @req B-5 — 附件分块上传 / 断点续传。
 *
 * 背景：手机上行 1 Mbps 且不稳定，1 MB 以上整包 PUT 经常在中途 ECONNABORTED
 * （实测 1149208 字节传到 393000 就断了）。分块后每块 256 KB，断了只需补一块。
 *
 * 这里验证：
 *   - upload-status 能报告已收字节
 *   - 乱序上传不会提前完成
 *   - 收齐后落盘是 PKEENC1 密文，下载能还原原始字节
 *   - 重传同一块不会重复计数
 *   - 老客户端（无分块头）的整包 PUT 仍然可用
 *
 * 用法（需要 express / better-sqlite3 / cors）：
 *   node server/verify-blob-chunked.js [--server <pke-sync-server.js>] [--port 0]
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
const TOKEN = 'verify-chunked-0123456789abcdef';
const DATA_KEY = 'verify-chunked-key-0123456789abcdef';
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(os.tmpdir(), `pke-chunked-${Date.now()}.db`);
const BLOB_DIR = path.join(os.tmpdir(), `pke-chunked-blobs-${Date.now()}`);

const CHUNK = 1024;
const TOTAL = CHUNK * 3 + 137; // 三块半，故意留一个不整块的尾巴

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

function putChunk(id, offset, bytes) {
  return fetch(`${BASE}/api/v1/attachments/${id}/blob`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/octet-stream',
      'X-PKE-Offset': String(offset),
      'X-PKE-Total': String(TOTAL)
    },
    body: bytes
  }).then(async (response) => ({ status: response.status, body: await response.json() }));
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

    const bytes = Buffer.alloc(TOTAL);
    for (let i = 0; i < TOTAL; i += 1) bytes[i] = (i * 7) % 251;

    await api('/api/v1/push', {
      method: 'POST',
      body: JSON.stringify({
        deviceId: 'chunked-device',
        attachments: [
          {
            id: 'chunked-1',
            noteId: 'note-1',
            name: 'big.jpg',
            mime: 'image/jpeg',
            size: TOTAL,
            hash: 'hash-big',
            createdAt: new Date().toISOString()
          }
        ]
      })
    });

    const initial = await api('/api/v1/attachments/chunked-1/blob/upload-status');
    check('status starts empty', [initial.body.received, initial.body.complete], [0, false]);

    // 1. 先传第一块
    const first = await putChunk('chunked-1', 0, bytes.subarray(0, CHUNK));
    check('first chunk accepted', [first.status, first.body.complete, first.body.received], [200, false, CHUNK]);

    // 2. 重传同一块：不能重复计数
    const again = await putChunk('chunked-1', 0, bytes.subarray(0, CHUNK));
    check('re-sending a chunk does not double count', again.body.received, CHUNK);

    // 3. 乱序：先传最后一块，中间有洞，不能完成
    const lastOffset = CHUNK * 3;
    const last = await putChunk('chunked-1', lastOffset, bytes.subarray(lastOffset, TOTAL));
    check('out-of-order chunk is not complete', last.body.complete, false);
    check('out-of-order chunk is counted', last.body.received, CHUNK + (TOTAL - lastOffset));

    // 4. 补齐中间两块 → 完成
    await putChunk('chunked-1', CHUNK, bytes.subarray(CHUNK, CHUNK * 2));
    const done = await putChunk('chunked-1', CHUNK * 2, bytes.subarray(CHUNK * 2, lastOffset));
    check('assembled after filling the gap', done.body.complete, true);
    check('assembled size', done.body.size, TOTAL);

    // 5. 落盘必须是密文
    const onDisk = fs.readFileSync(path.join(BLOB_DIR, 'chunked-1'));
    check('blob has encryption magic', onDisk.subarray(0, 7).toString('utf8'), 'PKEENC1');
    check('blob on disk is larger than plaintext (iv+tag)', onDisk.length > TOTAL, true);

    // 6. 下载还原原始字节
    const download = await fetch(`${BASE}/api/v1/attachments/chunked-1/blob`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    const back = Buffer.from(await download.arrayBuffer());
    check('download round-trips every byte', Buffer.compare(back, bytes), 0);

    // 7. 完成后 status 报告 complete
    const after = await api('/api/v1/attachments/chunked-1/blob/upload-status');
    check('status reports complete', after.body.complete, true);

    // 8. 老客户端：无分块头的整包 PUT 仍然可用
    await api('/api/v1/push', {
      method: 'POST',
      body: JSON.stringify({
        deviceId: 'chunked-device',
        attachments: [
          {
            id: 'legacy-1',
            noteId: 'note-1',
            name: 'small.jpg',
            mime: 'image/jpeg',
            size: 4,
            hash: 'hash-small',
            createdAt: new Date().toISOString()
          }
        ]
      })
    });
    const legacy = await fetch(`${BASE}/api/v1/attachments/legacy-1/blob`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/octet-stream' },
      body: Buffer.from([1, 2, 3, 4])
    });
    check('legacy single-shot PUT still works', legacy.status, 200);
    const legacyBack = await fetch(`${BASE}/api/v1/attachments/legacy-1/blob`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    check('legacy blob round-trips', Buffer.compare(Buffer.from(await legacyBack.arrayBuffer()), Buffer.from([1, 2, 3, 4])), 0);
  } finally {
    if (childRef && childRef.exitCode === null) childRef.kill();
    try {
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(DB_PATH + suffix, { force: true });
      fs.rmSync(BLOB_DIR, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error('verify failed:', error);
  process.exitCode = 1;
});
