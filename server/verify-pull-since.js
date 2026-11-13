/**
 * @req REQ-303 — 增量同步回归验证。
 *
 * 断言的缺陷：pull 曾经用 notes.updated_at（内容时间）当变更游标，导致
 * 「已经同步过的设备，拉不到后补进来的旧内容」（新设备反而能拉到）。
 * 修复后用 synced_at（服务端接收时间）做游标。
 *
 * 用法（需要 express / better-sqlite3 / cors，一般只在服务器上跑）：
 *   node server/verify-pull-since.js [--server <pke-sync-server.js>] [--port 3999]
 *
 * 自带临时数据库和临时端口，不会碰生产库。
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
const TOKEN = 'verify-token-0123456789abcdef';
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(os.tmpdir(), `pke-verify-${Date.now()}.db`);
// 附件目录也必须是每次全新的：旧文件会让「上传前 404」这条断言假失败。
const BLOB_DIR = path.join(os.tmpdir(), `pke-verify-blobs-${Date.now()}`);

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (actual=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)})`}`);
}

async function api(pathname, init = {}) {
  const response = await fetch(BASE + pathname, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...(init.headers || {}) }
  });
  return { status: response.status, body: await response.json() };
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

function note(id, title, updatedAt) {
  return { id, title, body: title, tags: [], folder: '', updatedAt, baseRevision: null };
}

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
  childRef = child;
  child.stderr.on('data', (chunk) => {
    childStderr += chunk;
    process.stderr.write(chunk);
  });

  try {
    if (!(await waitForHealth())) throw new Error('server did not become healthy: ' + childStderr);

    // 1. 新设备：拿到 t0 作为「已同步过」的游标
    const first = await api('/api/v1/pull?since=1970-01-01T00:00:00.000Z');
    check('empty server pull', first.body.notes.length, 0);
    const t0 = first.body.serverTime;

    // 2. 另一台设备补推 4 篇「内容时间很旧」的笔记（典型场景：旧库补传 / 恢复备份）
    const old = '2026-11-08T16:00:00.000Z';
    const push = await api('/api/v1/push', {
      method: 'POST',
      body: JSON.stringify({ deviceId: 'device-a', notes: [1, 2, 3, 4].map((i) => note(`old-${i}`, `old note ${i}`, old)) })
    });
    check('push applied', push.body.applied.length, 4);

    // 3. 核心回归：已同步过的设备必须能拉到这 4 篇（修复前这里是 0）
    const afterPush = await api(`/api/v1/pull?since=${encodeURIComponent(t0)}`);
    check('backfilled old notes visible to already-synced device', afterPush.body.notes.length, 4);
    check('old content time preserved', afterPush.body.notes[0]?.updatedAt, old);

    // 4. 再拉一次：没有新变更
    const noop = await api(`/api/v1/pull?since=${encodeURIComponent(afterPush.body.serverTime)}`);
    check('second pull is empty', noop.body.notes.length, 0);

    // 5. 同一篇再推 = revision 2，且能被拉到
    const bump = await api('/api/v1/push', {
      method: 'POST',
      body: JSON.stringify({
        deviceId: 'device-a',
        notes: [{ ...note('old-1', 'old note 1 v2', new Date().toISOString()), baseRevision: 1 }]
      })
    });
    check('revision bumped', bump.body.applied[0].revision, 2);
    const afterBump = await api(`/api/v1/pull?since=${encodeURIComponent(noop.body.serverTime)}`);
    check('updated note visible', afterBump.body.notes.length, 1);
    check('updated note title', afterBump.body.notes[0].title, 'old note 1 v2');

    // 6. 删除墓碑也要走同一游标
    const del = await api('/api/v1/push', {
      method: 'POST',
      body: JSON.stringify({
        deviceId: 'device-a',
        notes: [{ ...note('old-2', 'old note 2', new Date().toISOString()), baseRevision: 1, deleted: true }]
      })
    });
    check('delete applied', del.body.applied.length, 1);
    const afterDel = await api(`/api/v1/pull?since=${encodeURIComponent(afterBump.body.serverTime)}`);
    check('tombstone visible', afterDel.body.notes.map((n) => n.deleted), [true]);

    // 7. 关系 / 附件元数据：全量推送幂等，只有变化才推进游标
    const relationRow = { id: 'manual:a:b', sourceId: 'a', targetId: 'b', createdAt: old, deleted: false };
    const attachmentRow = {
      id: 'att-1',
      noteId: 'a',
      name: 'x.png',
      mime: 'image/png',
      size: 3,
      hash: 'h',
      createdAt: old,
      deleted: false
    };
    const metaPush = await api('/api/v1/push', {
      method: 'POST',
      body: JSON.stringify({ deviceId: 'device-a', notes: [], relations: [relationRow], attachments: [attachmentRow] })
    });
    check('relations applied', metaPush.body.relationsApplied, 1);
    check('attachments applied', metaPush.body.attachmentsApplied, 1);

    const repeatPush = await api('/api/v1/push', {
      method: 'POST',
      body: JSON.stringify({ deviceId: 'device-a', notes: [], relations: [relationRow], attachments: [attachmentRow] })
    });
    check('re-push is idempotent', [repeatPush.body.relationsApplied, repeatPush.body.attachmentsApplied], [0, 0]);

    const afterMeta = await api(`/api/v1/pull?since=${encodeURIComponent(afterDel.body.serverTime)}`);
    check('relations visible', afterMeta.body.relations.length, 1);
    check('attachments visible', afterMeta.body.attachments.length, 1);
    check('attachment payload carries metadata (no blob)', afterMeta.body.attachments[0].hash, 'h');

    // 8. 关系删除墓碑
    const relationDel = await api('/api/v1/push', {
      method: 'POST',
      body: JSON.stringify({
        deviceId: 'device-a',
        notes: [],
        relations: [{ ...relationRow, deleted: true }],
        attachments: []
      })
    });
    check('relation delete applied', relationDel.body.relationsApplied, 1);
    const afterRelationDel = await api(`/api/v1/pull?since=${encodeURIComponent(afterMeta.body.serverTime)}`);
    check('relation tombstone visible', afterRelationDel.body.relations.map((row) => row.deleted), [true]);
    // 10. 设备注册表
    await api('/api/v1/pull?since=1970-01-01T00:00:00.000Z&deviceId=dev-1&deviceName=测试机');
    const devices = await api('/api/v1/devices');
    const registered = (devices.body.devices || []).find((row) => row.id === 'dev-1');
    check('device registered on pull', registered?.name, '测试机');
    check('device has lastSeen', Boolean(registered?.lastSeen), true);

    // 11. 设备吊销（Phase 4.1）：移出注册表 + 挡住该 deviceId 的 pull/push + 可恢复
    await api('/api/v1/pull?since=1970-01-01T00:00:00.000Z&deviceId=dev-old&deviceName=旧手机');
    const revokeRes = await fetch(`${BASE}/api/v1/devices/dev-old`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    check('revoke accepted', revokeRes.status, 200);

    const revokedPull = await api('/api/v1/pull?since=1970-01-01T00:00:00.000Z&deviceId=dev-old');
    check('revoked device pull blocked', revokedPull.status, 403);
    check('revoked device reason', revokedPull.body.error, 'device-revoked');

    const revokedPush = await api('/api/v1/push', {
      method: 'POST',
      body: JSON.stringify({ deviceId: 'dev-old', notes: [note('after-revoke', 'x', old)] })
    });
    check('revoked device push blocked', revokedPush.status, 403);

    const afterRevokeList = await api('/api/v1/devices');
    check(
      'revoked device removed from registry',
      afterRevokeList.body.devices.some((row) => row.id === 'dev-old'),
      false
    );
    check('revoked device listed separately', afterRevokeList.body.revoked.map((row) => row.id), ['dev-old']);

    const blockedNote = await api('/api/v1/pull?since=1970-01-01T00:00:00.000Z');
    check(
      'blocked push wrote nothing',
      blockedNote.body.notes.some((row) => row.id === 'after-revoke'),
      false
    );

    const restoreRes = await fetch(`${BASE}/api/v1/revoked-devices/dev-old`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    check('restore accepted', restoreRes.status, 200);
    const restoredPull = await api(
      '/api/v1/pull?since=1970-01-01T00:00:00.000Z&deviceId=dev-old&deviceName=旧手机'
    );
    check('restored device can pull', restoredPull.status, 200);
    const restoredList = await api('/api/v1/devices');
    check(
      'restored device re-registered',
      restoredList.body.devices.some((row) => row.id === 'dev-old'),
      true
    );

    const unauthRevoke = await fetch(`${BASE}/api/v1/devices/dev-1`, { method: 'DELETE' });
    check('revoke requires auth', unauthRevoke.status, 401);

    // 12. 版本历史分页（Phase 4.4）：游标分页不重不漏，末页 nextCursor=null
    for (let i = 1; i <= 5; i += 1) {
      const pushed = await api('/api/v1/push', {
        method: 'POST',
        body: JSON.stringify({ deviceId: 'device-a', notes: [note('history-note', `v${i}`, new Date().toISOString())] })
      });
      check(`history push ${i} applied`, pushed.body.applied.length, 1);
    }
    const versionsAll = await api('/api/v1/versions/history-note');
    check('versions default page keeps old behaviour', versionsAll.body.versions.length, 5);
    check('versions default no cursor', versionsAll.body.nextCursor, null);

    const page1 = await api('/api/v1/versions/history-note?limit=2');
    check('versions page1 size', page1.body.versions.length, 2);
    check('versions page1 order', page1.body.versions.map((row) => row.title), ['v5', 'v4']);
    check('versions page1 has cursor', typeof page1.body.nextCursor, 'number');

    const page2 = await api(`/api/v1/versions/history-note?limit=2&before=${page1.body.nextCursor}`);
    check('versions page2 order', page2.body.versions.map((row) => row.title), ['v3', 'v2']);
    check('versions page2 has cursor', typeof page2.body.nextCursor, 'number');

    const page3 = await api(`/api/v1/versions/history-note?limit=2&before=${page2.body.nextCursor}`);
    check('versions page3 order', page3.body.versions.map((row) => row.title), ['v1']);
    check('versions last page no cursor', page3.body.nextCursor, null);

    const versionIds = new Set(
      [...page1.body.versions, ...page2.body.versions, ...page3.body.versions].map((row) => row.id)
    );
    check('versions pages do not overlap', versionIds.size, 5);

    // 9. 附件二进制通道
    const blobMissing = await fetch(`${BASE}/api/v1/attachments/att-1/blob`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    check('blob missing before upload', blobMissing.status, 404);

    const payload = Buffer.from([1, 2, 3, 4, 5]);
    const putBlob = await fetch(`${BASE}/api/v1/attachments/att-1/blob`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'image/png' },
      body: payload
    });
    check('blob upload accepted', putBlob.status, 200);

    const getBlob = await fetch(`${BASE}/api/v1/attachments/att-1/blob`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    const gotBytes = Buffer.from(await getBlob.arrayBuffer());
    check('blob roundtrip matches', gotBytes.equals(payload), true);
    check('blob content type', getBlob.headers.get('content-type'), 'image/png');

    const unauthBlob = await fetch(`${BASE}/api/v1/attachments/att-1/blob`);
    check('blob requires auth', unauthBlob.status, 401);

    check(
      'relation tombstone keeps endpoints',
      [afterRelationDel.body.relations[0].sourceId, afterRelationDel.body.relations[0].targetId],
      ['a', 'b']
    );
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
