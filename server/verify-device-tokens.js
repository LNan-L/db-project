#!/usr/bin/env node
/**
 * @req B-1 — 设备独立凭证回归（临时库 + 随机端口）。
 *
 * 覆盖：管理 token 可签发；设备 token 只能同步自己的 deviceId；
 * 吊销后设备 token 立即失效；恢复后旧 token 仍无效（需重签）；严格模式下管理 token 不能同步。
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
const PORT = Number(argOf('--port', '0')) || 24000 + Math.floor(Math.random() * 12000);
const ADMIN = 'verify-b1-admin-token-0123456789';
const BASE = `http://127.0.0.1:${PORT}`;
const DB_PATH = path.join(os.tmpdir(), `pke-b1-verify-${Date.now()}.db`);
const BLOB_DIR = path.join(os.tmpdir(), `pke-b1-verify-blobs-${Date.now()}`);

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (actual=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)})`}`
  );
}

async function api(pathname, { token = ADMIN, method = 'GET', body, query } = {}) {
  const url = new URL(BASE + pathname);
  if (query) for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

function startServer(env = {}) {
  const child = spawn(process.execPath, [SERVER_JS], {
    env: {
      ...process.env,
      PKE_TOKEN: ADMIN,
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

function cleanup() {
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

const seedNote = (id, title) => ({
  id,
  title,
  body: `body ${id}`,
  tags: [],
  folder: '',
  updatedAt: new Date().toISOString(),
  baseRevision: null
});

let server = null;

async function main() {
  server = startServer();
  try {
    if (!(await waitForHealth())) throw new Error('sync server not ready');

    // 1. 管理 token 签发设备凭证
    const issue = await api('/api/v1/device-token', {
      method: 'POST',
      body: { deviceId: 'dev-a', deviceName: '设备 A' }
    });
    check('admin can issue a device token', issue.status, 201);
    const tokenA = issue.body.token;
    check('token looks like a device token', typeof tokenA === 'string' && tokenA.startsWith('pked_'), true);
    const tokenList = (await api('/api/v1/device-tokens')).body;
    check(
      'token list never exposes the secret',
      JSON.stringify(tokenList).includes('pked_'),
      false
    );

    // 2. 设备 token 能同步自己的 deviceId
    const pushA = await api('/api/v1/push', {
      token: tokenA,
      method: 'POST',
      body: { deviceId: 'dev-a', deviceName: '设备 A', notes: [seedNote('n1', 'A 的笔记')], relations: [], attachments: [] }
    });
    check('device token can push', pushA.status, 200);
    const pullA = await api('/api/v1/pull', {
      token: tokenA,
      query: { since: '1970-01-01T00:00:00.000Z', deviceId: 'dev-a' }
    });
    check('device token can pull', pullA.status, 200);
    check('note arrived', (pullA.body.notes || []).length, 1);

    // 3. 设备 token 冒用别的 deviceId：服务端以凭证绑定为准
    const pushSpoof = await api('/api/v1/push', {
      token: tokenA,
      method: 'POST',
      body: { deviceId: 'dev-b', deviceName: '冒充', notes: [seedNote('n2', '冒充')], relations: [], attachments: [] }
    });
    check('device token cannot act as another device', pushSpoof.status, 200);
    const devices = await api('/api/v1/devices');
    const ids = (devices.body.devices || []).map((row) => row.id);
    check('spoofed deviceId is not registered', ids.includes('dev-b'), false);
    check('write is attributed to the real device', ids.includes('dev-a'), true);

    // 4. 设备 token 不能做设备管理
    const listDevices = await api('/api/v1/devices', { token: tokenA });
    check('device token cannot list devices', listDevices.status, 403);
    check('device token cannot issue tokens', (await api('/api/v1/device-token', { token: tokenA, method: 'POST', body: { deviceId: 'dev-c' } })).status, 403);
    check('device token cannot revoke devices', (await api('/api/v1/devices/dev-a', { token: tokenA, method: 'DELETE' })).status, 403);

    // 5. 吊销立即作废凭证
    const revoke = await api('/api/v1/devices/dev-a', { method: 'DELETE' });
    check('admin can revoke', revoke.status, 200);
    const afterRevoke = await api('/api/v1/pull', {
      token: tokenA,
      query: { since: '1970-01-01T00:00:00.000Z', deviceId: 'dev-a' }
    });
    check('revoked device token is rejected', afterRevoke.status, 401);

    // 6. 恢复设备但旧凭证仍无效，必须重签
    const restore = await api('/api/v1/revoked-devices/dev-a', { method: 'DELETE' });
    check('admin can restore', restore.status, 200);
    const oldTokenAgain = await api('/api/v1/pull', {
      token: tokenA,
      query: { since: '1970-01-01T00:00:00.000Z', deviceId: 'dev-a' }
    });
    check('old token stays dead after restore', oldTokenAgain.status, 401);
    check('device token list is empty after revoke', (await api('/api/v1/device-tokens')).body.tokens.length, 0);

    const reissue = await api('/api/v1/device-token', {
      method: 'POST',
      body: { deviceId: 'dev-a', deviceName: '设备 A' }
    });
    check('admin can re-issue after restore', reissue.status, 201);
    const newToken = reissue.body.token;
    check('re-issued token differs', newToken === tokenA, false);
    check(
      're-issued token works',
      (await api('/api/v1/pull', { token: newToken, query: { since: '1970-01-01T00:00:00.000Z', deviceId: 'dev-a' } })).status,
      200
    );

    // 7. 已吊销的设备不能被签发
    await api('/api/v1/devices/dev-a', { method: 'DELETE' });
    const issueRevoked = await api('/api/v1/device-token', {
      method: 'POST',
      body: { deviceId: 'dev-a' }
    });
    check('cannot issue for a revoked device', issueRevoked.status, 403);
    await api('/api/v1/revoked-devices/dev-a', { method: 'DELETE' });

    // 8. 管理 token 仍可直接同步（默认模式，老设备不受影响）
    const adminSync = await api('/api/v1/pull', {
      query: { since: '1970-01-01T00:00:00.000Z', deviceId: 'legacy-device' }
    });
    check('admin token can still sync by default', adminSync.status, 200);

    // 9. 未知 token 一律 401
    check('unknown token rejected', (await api('/api/v1/pull', { token: 'pked_nope', query: { since: '1970-01-01T00:00:00.000Z' } })).status, 401);
    check('empty token rejected', (await api('/api/v1/pull', { token: '', query: { since: '1970-01-01T00:00:00.000Z' } })).status, 401);
  } finally {
    server.kill();
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  // 10. 严格模式：管理 token 不能同步，设备 token 可以
  const db2 = DB_PATH.replace(/\.db$/, '-strict.db');
  server = spawn(process.execPath, [SERVER_JS], {
    env: {
      ...process.env,
      PKE_TOKEN: ADMIN,
      PKE_DB: db2,
      PKE_PORT: String(PORT),
      PKE_HOST: '127.0.0.1',
      PKE_BLOB_DIR: BLOB_DIR,
      PKE_REQUIRE_DEVICE_TOKENS: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stderr.on('data', (chunk) => process.stderr.write(chunk));
  try {
    if (!(await waitForHealth())) throw new Error('strict sync server not ready');
    const issue = await api('/api/v1/device-token', { method: 'POST', body: { deviceId: 'dev-s' } });
    const tokenS = issue.body.token;
    const adminPull = await api('/api/v1/pull', {
      query: { since: '1970-01-01T00:00:00.000Z', deviceId: 'dev-s' }
    });
    check('strict mode rejects admin token on pull', adminPull.status, 401);
    check('strict mode reports why', adminPull.body.error, 'device-token-required');
    check(
      'strict mode accepts device token',
      (await api('/api/v1/pull', { token: tokenS, query: { since: '1970-01-01T00:00:00.000Z', deviceId: 'dev-s' } })).status,
      200
    );
    const flags = await api('/api/v1/device-tokens');
    check('strict flag is reported', flags.body.required, true);
  } finally {
    server.kill();
    await new Promise((resolve) => setTimeout(resolve, 200));
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(db2 + suffix);
      } catch {
        /* ignore */
      }
    }
    cleanup();
  }

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('verify failed:', error);
  try {
    server?.kill();
  } catch {
    /* ignore */
  }
  cleanup();
  process.exit(1);
});
