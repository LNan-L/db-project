/**
 * @req REQ-204 / REQ-303 — Phase 3 自建同步服务。
 * 仅绑定本地/内网；Bearer token 鉴权；SQLite 存笔记、版本、冲突基线。
 */
const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createCrypto } = require('./at-rest');

const PORT = Number(process.env.PKE_PORT || 3000);
const HOST = process.env.PKE_HOST || '127.0.0.1';
const DB_PATH = process.env.PKE_DB || '/opt/pke-sync/pke-sync.db';
const TOKEN = process.env.PKE_TOKEN || '';
// 附件二进制落盘（元数据在 sqlite，文件在磁盘）。
const BLOB_DIR = process.env.PKE_BLOB_DIR || '/opt/pke-sync/blobs';
fs.mkdirSync(BLOB_DIR, { recursive: true });
const BLOB_ID = /^[A-Za-z0-9_-]{1,80}$/;

function blobPath(id) {
  return path.join(BLOB_DIR, id);
}

if (!TOKEN) {
  console.error('PKE_TOKEN is required');
  process.exit(1);
}

// B-5：PKE_DATA_KEY 配置后，笔记/版本/附件在磁盘上加密；未配置保持明文。
const atRest = createCrypto({
  current: process.env.PKE_DATA_KEY,
  previous: process.env.PKE_DATA_KEY_OLD
});

const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: true, allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '8mb' }));

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    tags TEXT NOT NULL,
    folder TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revision INTEGER NOT NULL,
    device TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    synced_at TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS note_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    note_id TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    tags TEXT NOT NULL,
    folder TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revision INTEGER NOT NULL,
    device TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  );
  -- 设备吊销名单：从 devices 删除后仍要挡住该 deviceId 的 pull/push，
  -- 否则下一次同步会把它重新注册回来（见 rejectRevokedDevice）。
  -- B-3：画布卡片（哪篇笔记摆在画布哪个位置）。按 noteId 唯一。
  CREATE TABLE IF NOT EXISTS canvas_cards (
    note_id TEXT PRIMARY KEY,
    x REAL NOT NULL,
    y REAL NOT NULL,
    updated_at TEXT NOT NULL,
    device TEXT NOT NULL DEFAULT '',
    synced_at TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_canvas_synced ON canvas_cards(synced_at);
  -- B-1：设备独立凭证。只存 sha256 摘要，原文只在签发时返回一次。
  CREATE TABLE IF NOT EXISTS device_tokens (
    device_id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_device_tokens_hash ON device_tokens(token_hash);
  CREATE TABLE IF NOT EXISTS revoked_devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    revoked_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS relations (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    synced_at TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    note_id TEXT NOT NULL,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    synced_at TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    tool TEXT NOT NULL,
    device TEXT NOT NULL DEFAULT '',
    params_digest TEXT NOT NULL DEFAULT '',
    result TEXT NOT NULL DEFAULT '',
    note_id TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_logs(at);
  CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at);
  CREATE INDEX IF NOT EXISTS idx_versions_note ON note_versions(note_id, created_at DESC);
`);

// 迁移：旧库补 synced_at（服务端变更游标）。历史上 pull 按 updated_at（内容时间）过滤，
// 导致「已同步过的设备拉不到后补的旧内容」。回填成迁移时刻，让现存数据对新游标可见一次。
const noteColumns = db.prepare('PRAGMA table_info(notes)').all();
if (!noteColumns.some((column) => column.name === 'synced_at')) {
  db.exec("ALTER TABLE notes ADD COLUMN synced_at TEXT NOT NULL DEFAULT ''");
}
const backfill = db
  .prepare("UPDATE notes SET synced_at = ? WHERE synced_at = ''")
  .run(new Date().toISOString());
if (backfill.changes > 0) {
  console.log(`synced_at backfilled for ${backfill.changes} notes`);
}
db.exec('CREATE INDEX IF NOT EXISTS idx_notes_synced ON notes(synced_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_relations_synced ON relations(synced_at)');
db.exec('CREATE INDEX IF NOT EXISTS idx_attachments_synced ON attachments(synced_at)');

// synced_at 严格递增，pull 用 "synced_at > since" 才不会同毫秒漏数据。
let syncCursor = (() => {
  const row = db.prepare('SELECT MAX(synced_at) AS m FROM notes').get();
  const parsed = row && row.m ? Date.parse(row.m) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
})();

function nextSyncedAt() {
  syncCursor = Math.max(Date.now(), syncCursor + 1);
  return new Date(syncCursor).toISOString();
}

function nowStamp() {
  return new Date(Math.max(Date.now(), syncCursor)).toISOString();
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function normalizeTags(value) {
  if (Array.isArray(value)) {
    return value.map((tag) => String(tag).replace(/^#+/, '').trim()).filter(Boolean);
  }
  return [];
}

function normalizeNote(input) {
  return {
    id: String(input.id || ''),
    title: String(input.title || '未命名笔记').slice(0, 500),
    body: String(input.body || ''),
    tags: normalizeTags(input.tags),
    folder: String(input.folder || '').slice(0, 500),
    updatedAt: String(input.updatedAt || new Date().toISOString()),
    deleted: input.deleted ? 1 : 0,
    baseRevision:
      input.baseRevision === undefined || input.baseRevision === null
        ? null
        : Number(input.baseRevision)
  };
}

function mapRelation(row) {
  return {
    id: row.id,
    sourceId: row.source_id,
    targetId: row.target_id,
    createdAt: row.created_at,
    deleted: Boolean(row.deleted)
  };
}

function mapAttachment(row) {
  return {
    id: row.id,
    noteId: row.note_id,
    name: atRest.read(row.name),
    mime: atRest.read(row.mime),
    size: row.size,
    hash: row.hash,
    createdAt: row.created_at,
    deleted: Boolean(row.deleted)
  };
}

function touchDevice(id, name) {
  const deviceId = String(id || '').slice(0, 200);
  if (!deviceId) return;
  const label = String(name || '').slice(0, 120) || '未命名设备';
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO devices (id, name, created_at, last_seen) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen`
  ).run(deviceId, label, now, now);
}

const selectRevoked = db.prepare('SELECT id, name, revoked_at FROM revoked_devices WHERE id = ?');
const listRevoked = db.prepare('SELECT id, name, revoked_at FROM revoked_devices ORDER BY revoked_at DESC');
const insertRevoked = db.prepare(
  `INSERT INTO revoked_devices (id, name, revoked_at) VALUES (?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET revoked_at = excluded.revoked_at`
);
const deleteRevoked = db.prepare('DELETE FROM revoked_devices WHERE id = ?');
const getDevice = db.prepare('SELECT id, name FROM devices WHERE id = ?');
const deleteDeviceRow = db.prepare('DELETE FROM devices WHERE id = ?');

// 吊销是 deviceId 维度的：token 是共享的，被撤销的设备只要换一个 id 仍能同步。
// 因此这里是「清理 + 拦住旧记录复活」，不是强度量级的访问控制（文档里写明）。
function deviceIdOf(req) {
  const raw = req.method === 'GET' ? req.query.deviceId : req.body && req.body.deviceId;
  return bindDevice(req.auth, raw);
}

function rejectRevokedDevice(req, res, next) {
  const deviceId = deviceIdOf(req);
  if (deviceId && selectRevoked.get(deviceId)) {
    res.status(403).json({ ok: false, error: 'device-revoked', deviceId });
    return;
  }
  next();
}

function mapNote(row) {
  return {
    id: row.id,
    title: atRest.read(row.title),
    body: atRest.read(row.body),
    tags: JSON.parse(atRest.read(row.tags) || '[]'),
    folder: atRest.read(row.folder),
    updatedAt: row.updated_at,
    revision: row.revision,
    device: row.device,
    deleted: Boolean(row.deleted)
  };
}

/**
 * B-6：密钥轮换。配了 PKE_DATA_KEY_OLD 时，把能用旧 key 解开的行用新 key 重写。
 * 只处理文本列（notes/title,body,tags；note_versions；attachments/name,mime）；
 * 附件字节按需解密后重写（启动时一次性处理，数量通常很小）。
 * 幂等：已经是新 key 的行会解密成功且不标记 needReencrypt，直接跳过。
 */
function rotateAtRestKeys() {
  if (!atRest.enabled || !process.env.PKE_DATA_KEY_OLD) return;
  const stats = { notes: 0, versions: 0, attachments: 0, blobs: 0, failed: 0 };
  const rewriteNote = db.prepare('UPDATE notes SET title=?, body=?, tags=?, folder=? WHERE id=?');
  const rewriteVersion = db.prepare('UPDATE note_versions SET title=?, body=?, tags=?, folder=? WHERE id=?');
  const rewriteAttachment = db.prepare('UPDATE attachments SET name=?, mime=? WHERE id=?');

  db.transaction(() => {
    for (const row of db.prepare('SELECT id, title, body, tags, folder FROM notes').all()) {
      try {
        const title = atRest.decrypt(row.title);
        const body = atRest.decrypt(row.body);
        const tags = atRest.decrypt(row.tags);
        const folder = atRest.decrypt(row.folder);
        if (!title.needReencrypt && !body.needReencrypt && !tags.needReencrypt && !folder.needReencrypt) continue;
        rewriteNote.run(
          atRest.encrypt(title.value),
          atRest.encrypt(body.value),
          atRest.encrypt(tags.value),
          atRest.encrypt(folder.value),
          row.id
        );
        stats.notes += 1;
      } catch (error) {
        stats.failed += 1;
        console.error(`rotate: note ${row.id} failed`, error.message);
      }
    }
    for (const row of db.prepare('SELECT id, title, body, tags, folder FROM note_versions').all()) {
      try {
        const title = atRest.decrypt(row.title);
        const body = atRest.decrypt(row.body);
        const tags = atRest.decrypt(row.tags);
        const folder = atRest.decrypt(row.folder);
        if (!title.needReencrypt && !body.needReencrypt && !tags.needReencrypt && !folder.needReencrypt) continue;
        rewriteVersion.run(
          atRest.encrypt(title.value),
          atRest.encrypt(body.value),
          atRest.encrypt(tags.value),
          atRest.encrypt(folder.value),
          row.id
        );
        stats.versions += 1;
      } catch (error) {
        stats.failed += 1;
        console.error(`rotate: version ${row.id} failed`, error.message);
      }
    }
    for (const row of db.prepare('SELECT id, name, mime FROM attachments').all()) {
      try {
        const name = atRest.decrypt(row.name);
        const mime = atRest.decrypt(row.mime);
        if (!name.needReencrypt && !mime.needReencrypt) continue;
        rewriteAttachment.run(atRest.encrypt(name.value), atRest.encrypt(mime.value), row.id);
        stats.attachments += 1;
      } catch (error) {
        stats.failed += 1;
        console.error(`rotate: attachment ${row.id} failed`, error.message);
      }
    }
  })();

  // 附件字节：只重写仍是旧 key 的（尝试用新 key 解密会失败）。
  for (const file of fs.readdirSync(BLOB_DIR)) {
    const full = path.join(BLOB_DIR, file);
    if (!fs.statSync(full).isFile() || !BLOB_ID.test(file)) continue;
    const bytes = fs.readFileSync(full);
    if (!atRest.needsRotation(bytes)) continue;
    try {
      fs.writeFileSync(full, atRest.encryptBytes(atRest.decryptBytes(bytes)));
      stats.blobs += 1;
    } catch (error) {
      stats.failed += 1;
      console.error(`rotate: blob ${file} failed`, error.message);
    }
  }

  console.log(
    `at-rest rotation: notes=${stats.notes} versions=${stats.versions} attachments=${stats.attachments} blobs=${stats.blobs} failed=${stats.failed}`
  );
  if (stats.failed > 0) {
    console.error('at-rest rotation had failures; 保留 PKE_DATA_KEY_OLD 后重试');
  }
}

app.get('/health', (_req, res) => {
  res.json({ ok: true, app: 'pke-sync', time: new Date().toISOString() });
});

// B-1：管理 token（PKE_TOKEN）与设备 token 并存。
// - 管理 token：可做设备管理、签发/吊销；是否允许直接同步由 PKE_REQUIRE_DEVICE_TOKENS 决定。
// - 设备 token：绑定 deviceId，吊销时一并作废，换 id 也绕不过去。
const REQUIRE_DEVICE_TOKENS = process.env.PKE_REQUIRE_DEVICE_TOKENS === '1';
const hashToken = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');
const selectDeviceToken = db.prepare(
  'SELECT device_id, token_hash FROM device_tokens WHERE token_hash = ?'
);
const upsertDeviceToken = db.prepare(
  `INSERT INTO device_tokens (device_id, token_hash, created_at, last_used_at) VALUES (?, ?, ?, ?)
   ON CONFLICT(device_id) DO UPDATE SET token_hash = excluded.token_hash, created_at = excluded.created_at, last_used_at = excluded.last_used_at`
);
const deleteDeviceToken = db.prepare('DELETE FROM device_tokens WHERE device_id = ?');
const touchDeviceToken = db.prepare('UPDATE device_tokens SET last_used_at = ? WHERE device_id = ?');
const listDeviceTokens = db.prepare('SELECT device_id, created_at, last_used_at FROM device_tokens');

function authenticate(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return { ok: false };
  if (safeEqual(token, TOKEN)) return { ok: true, role: 'admin' };
  const row = selectDeviceToken.get(hashToken(token));
  if (!row) return { ok: false };
  return { ok: true, role: 'device', deviceId: row.device_id };
}

app.use('/api/v1', (req, res, next) => {
  const auth = authenticate(req);
  if (!auth.ok) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }
  req.auth = auth;
  if (auth.role === 'device') {
    // 每次成功鉴权都刷新 last_used_at，面板能看出凭证是否还在用。
    touchDeviceToken.run(new Date().toISOString(), auth.deviceId);
  }
  next();
});

// 只允许管理 token 的接口（设备管理、签发）。
function requireAdmin(req, res, next) {
  if (req.auth && req.auth.role === 'admin') {
    next();
    return;
  }
  res.status(403).json({ ok: false, error: 'admin-required' });
}

// 设备 token 生效时，deviceId 一律以凭证绑定为准，忽略请求里的值（防冒用）。
function bindDevice(auth, fallback) {
  if (auth && auth.role === 'device') return auth.deviceId;
  return String(fallback || '').slice(0, 200);
}

// 被吊销的设备不能继续 pull/push。放在路由之前，这样 touchDevice 不会把旧记录写回来。
app.use('/api/v1/pull', rejectRevokedDevice);
app.use('/api/v1/push', rejectRevokedDevice);

// 开了严格模式后，同步必须用设备凭证；管理 token 只用于管理。
// 默认关闭，老设备继续用全局 token（迁移期零锁死）。
app.use(['/api/v1/pull', '/api/v1/push'], (req, res, next) => {
  if (REQUIRE_DEVICE_TOKENS && req.auth && req.auth.role === 'admin') {
    res.status(401).json({ ok: false, error: 'device-token-required' });
    return;
  }
  next();
});

/**
 * 附件分块上传。
 *
 * 手机上行 1 Mbps 且不稳定，1 MB 以上整包 PUT 常在中途 ECONNABORTED
 * （实测 1149208 字节传到 393000 就断了）。分块后每块 256 KB，断了只要补一块。
 *
 * 分块暂存在**进程内存**里、不落盘：避免明文写进磁盘破坏 B-5 的静态加密，
 * 收齐后一次性加密再原子 rename 到最终路径。服务重启会丢未完成的分块，
 * 客户端下次同步从头重传即可。
 */
const BLOB_UPLOAD_MAX = 16 * 1024 * 1024;
const BLOB_UPLOAD_TTL_MS = 10 * 60 * 1000;
const blobUploads = new Map();

function pruneBlobUploads() {
  const now = Date.now();
  for (const [id, session] of blobUploads) {
    if (now - session.updatedAt > BLOB_UPLOAD_TTL_MS) blobUploads.delete(id);
  }
}

/** 按 offset 拼装；中间有洞就返回 null（等客户端把缺的块补上）。 */
function assembleBlobUpload(session) {
  const parts = [...session.chunks.entries()].sort((a, b) => a[0] - b[0]);
  let cursor = 0;
  const buffers = [];
  for (const [offset, buffer] of parts) {
    if (offset !== cursor) return null;
    buffers.push(buffer);
    cursor += buffer.length;
  }
  return cursor === session.total ? Buffer.concat(buffers) : null;
}

/** 加密后原子落盘：先写 .tmp 再 rename，避免进程中断留下半个文件。 */
function writeBlobAtomic(id, plain) {
  const target = blobPath(id);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, atRest.encryptBytes(plain), { mode: 0o600 });
  fs.renameSync(tmp, target);
}

app.get('/api/v1/attachments/:id/blob/upload-status', (req, res) => {
  const id = String(req.params.id);
  if (!BLOB_ID.test(id)) {
    res.status(400).json({ ok: false, error: 'invalid id' });
    return;
  }
  const session = blobUploads.get(id);
  res.json({
    ok: true,
    id,
    complete: fs.existsSync(blobPath(id)),
    received: session ? session.received : 0,
    total: session ? session.total : 0
  });
});

app.put('/api/v1/attachments/:id/blob', express.raw({ type: '*/*', limit: '16mb' }), (req, res) => {
  const id = String(req.params.id);
  if (!BLOB_ID.test(id) || !Buffer.isBuffer(req.body) || req.body.length === 0) {
    res.status(400).json({ ok: false, error: 'invalid blob' });
    return;
  }
  if (!getAttachment.get(id)) {
    res.status(404).json({ ok: false, error: 'unknown attachment' });
    return;
  }

  const offset = Number(req.headers['x-pke-offset']);
  const total = Number(req.headers['x-pke-total']);

  // 没有分块头 = 老客户端或小文件，保持整包 PUT 的原行为。
  if (!Number.isFinite(offset) || !Number.isFinite(total) || total <= 0) {
    const plain = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
    writeBlobAtomic(id, plain);
    res.json({ ok: true, id, size: plain.length, complete: true });
    return;
  }

  if (total > BLOB_UPLOAD_MAX || offset < 0 || offset + req.body.length > total) {
    res.status(413).json({ ok: false, error: 'blob too large' });
    return;
  }

  pruneBlobUploads();
  let session = blobUploads.get(id);
  // total 变了说明客户端重新开始，丢掉旧分块。
  if (!session || session.total !== total) {
    session = { total, chunks: new Map(), received: 0, updatedAt: Date.now() };
    blobUploads.set(id, session);
  }
  // 按 offset 存：重传同一块（响应丢了）不会重复计数。
  session.chunks.set(offset, Buffer.from(req.body));
  session.received = [...session.chunks.values()].reduce((sum, buf) => sum + buf.length, 0);
  session.updatedAt = Date.now();

  const assembled = assembleBlobUpload(session);
  if (!assembled) {
    res.json({ ok: true, id, complete: false, received: session.received, total });
    return;
  }

  writeBlobAtomic(id, assembled);
  blobUploads.delete(id);
  res.json({ ok: true, id, complete: true, size: assembled.length });
});

app.get('/api/v1/attachments/:id/blob', (req, res) => {
  const id = String(req.params.id);
  if (!BLOB_ID.test(id) || !fs.existsSync(blobPath(id))) {
    res.status(404).json({ ok: false, error: 'blob missing' });
    return;
  }
  const row = getAttachment.get(id);
  res.setHeader('Content-Type', row ? atRest.read(row.mime) : 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  // 清掉可能由 express 设置的 length，避免解密后长度变化引发截断。
  res.removeHeader('Content-Length');
  res.end(atRest.decryptBytes(fs.readFileSync(blobPath(id))));
});

app.get('/api/v1/pull', (req, res) => {
  const since = typeof req.query.since === 'string' ? req.query.since : '';
  // B-1：设备凭证绑定时，一律用绑定值，忽略请求里的 deviceId。
  touchDevice(deviceIdOf(req), req.query.deviceName);
  const pick = (table) =>
    since
      ? db.prepare(`SELECT * FROM ${table} WHERE synced_at > ? ORDER BY synced_at ASC`).all(since)
      : db.prepare(`SELECT * FROM ${table} ORDER BY synced_at ASC`).all();
  if (process.env.PKE_SYNC_LOG === '1') {
    const noteRows = pick('notes');
    console.log(
      `pull since=${since || '(none)'} notes=${noteRows.length} relations=${pick('relations').length} attachments=${pick('attachments').length}`
    );
  }
  res.json({
    ok: true,
    notes: pick('notes').map(mapNote),
    canvas: pick('canvas_cards').map((row) => ({
      noteId: row.note_id,
      x: row.x,
      y: row.y,
      updatedAt: row.updated_at
    })),
    relations: pick('relations').map(mapRelation),
    attachments: pick('attachments').map((row) => ({
      ...mapAttachment(row),
      hasBlob: fs.existsSync(blobPath(row.id))
    })),
    serverTime: nowStamp()
  });
});

const pushNote = db.prepare(`
  INSERT INTO notes (id, title, body, tags, folder, updated_at, revision, device, deleted, synced_at)
  VALUES (@id, @title, @body, @tags, @folder, @updated_at, @revision, @device, @deleted, @synced_at)
  ON CONFLICT(id) DO UPDATE SET
    title=excluded.title,
    body=excluded.body,
    tags=excluded.tags,
    folder=excluded.folder,
    updated_at=excluded.updated_at,
    revision=excluded.revision,
    device=excluded.device,
    deleted=excluded.deleted,
    synced_at=excluded.synced_at
`);
const getNote = db.prepare('SELECT * FROM notes WHERE id = ?');
const insertVersion = db.prepare(`
  INSERT INTO note_versions (note_id, title, body, tags, folder, updated_at, revision, device, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const getRelation = db.prepare('SELECT * FROM relations WHERE id = ?');
const putRelation = db.prepare(`
  INSERT INTO relations (id, source_id, target_id, created_at, deleted, synced_at)
  VALUES (@id, @source_id, @target_id, @created_at, @deleted, @synced_at)
  ON CONFLICT(id) DO UPDATE SET
    source_id=excluded.source_id,
    target_id=excluded.target_id,
    created_at=excluded.created_at,
    deleted=excluded.deleted,
    synced_at=excluded.synced_at
`);
const getAttachment = db.prepare('SELECT * FROM attachments WHERE id = ?');
const putAttachment = db.prepare(`
  INSERT INTO attachments (id, note_id, name, mime, size, hash, created_at, deleted, synced_at)
  VALUES (@id, @note_id, @name, @mime, @size, @hash, @created_at, @deleted, @synced_at)
  ON CONFLICT(id) DO UPDATE SET
    note_id=excluded.note_id,
    name=excluded.name,
    mime=excluded.mime,
    size=excluded.size,
    hash=excluded.hash,
    created_at=excluded.created_at,
    deleted=excluded.deleted,
    synced_at=excluded.synced_at
`);

const getCanvasCard = db.prepare('SELECT * FROM canvas_cards WHERE note_id = ?');
const putCanvasCard = db.prepare(`
  INSERT INTO canvas_cards (note_id, x, y, updated_at, device, synced_at)
  VALUES (@note_id, @x, @y, @updated_at, @device, @synced_at)
  ON CONFLICT(note_id) DO UPDATE SET
    x=excluded.x,
    y=excluded.y,
    updated_at=excluded.updated_at,
    device=excluded.device,
    synced_at=excluded.synced_at
`);
const deleteCanvasCard = db.prepare('DELETE FROM canvas_cards WHERE note_id = ?');

/**
 * 入站笔记与库里内容是否逐字段一致。
 * 比较的是**明文**：密文每次加密都有新 IV，直接比密文永远不会相等。
 * 用途：自动同步重试、客户端时钟偏差导致的重复推送不应涨 revision、不应多写一条版本。
 */
function sameNoteContent(existing, note) {
  if (Boolean(existing.deleted) !== Boolean(note.deleted)) return false;
  if (atRest.read(existing.folder) !== note.folder) return false;
  if (atRest.read(existing.title) !== note.title) return false;
  if (atRest.read(existing.body) !== note.body) return false;
  try {
    return JSON.stringify(JSON.parse(atRest.read(existing.tags) || '[]')) === JSON.stringify(note.tags);
  } catch {
    return false;
  }
}

const pushTransaction = db.transaction((device, payload) => {
  const applied = [];
  const conflicts = [];
  for (const input of payload.notes) {
    const note = normalizeNote(input);
    if (!note.id || note.id.length > 200) {
      conflicts.push({ id: note.id, reason: 'invalid-id' });
      continue;
    }
    const existing = getNote.get(note.id);
    // 幂等：内容没变就不算一次新修订。放在冲突判断之前——内容一致时谈不上冲突。
    if (existing && sameNoteContent(existing, note)) continue;
    if (existing && note.baseRevision !== null && existing.revision > note.baseRevision) {
      conflicts.push({ id: note.id, reason: 'revision-conflict', server: mapNote(existing) });
      continue;
    }
    const revision = existing ? existing.revision + 1 : 1;
    const updatedAt = note.updatedAt || new Date().toISOString();
    const row = {
      id: note.id,
      title: atRest.encrypt(note.title),
      body: atRest.encrypt(note.body),
      tags: atRest.encrypt(JSON.stringify(note.tags)),
      folder: atRest.encrypt(note.folder),
      updated_at: updatedAt,
      revision,
      device,
      deleted: note.deleted,
      synced_at: nextSyncedAt()
    };
    pushNote.run(row);
    insertVersion.run(
      note.id,
      row.title,
      row.body,
      row.tags,
      row.folder,
      updatedAt,
      revision,
      device,
      new Date().toISOString()
    );
    applied.push({ id: note.id, revision });
  }

  // 关系 / 附件元数据：集合语义，没有 revision；只有内容变化才推进 synced_at。
  let relationsApplied = 0;
  for (const input of payload.relations) {
    const id = String(input.id || '');
    if (!id || id.length > 300) continue;
    const deleted = input.deleted ? 1 : 0;
    const existing = getRelation.get(id);
    // 墓碑通常不带 source/target（本地行已删）；库里已有就沿用原值，别把关系两端抹掉。
    const row = {
      id,
      source_id: deleted && existing ? existing.source_id : String(input.sourceId || ''),
      target_id: deleted && existing ? existing.target_id : String(input.targetId || ''),
      created_at: deleted && existing ? existing.created_at : String(input.createdAt || new Date().toISOString()),
      deleted
    };
    if (
      existing &&
      existing.source_id === row.source_id &&
      existing.target_id === row.target_id &&
      existing.deleted === row.deleted
    ) {
      continue;
    }
    putRelation.run({ ...row, synced_at: nextSyncedAt() });
    relationsApplied += 1;
  }

  let attachmentsApplied = 0;
  for (const input of payload.attachments) {
    const id = String(input.id || '');
    if (!id || id.length > 300) continue;
    const deleted = input.deleted ? 1 : 0;
    const existing = getAttachment.get(id);
    // 墓碑只翻转 deleted，元数据用库里已有的；普通推送比较**明文**。
    const name = deleted && existing ? atRest.read(existing.name) : String(input.name || '').slice(0, 500);
    const mime = deleted && existing ? atRest.read(existing.mime) : String(input.mime || '');
    const row = {
      id,
      note_id: deleted && existing ? existing.note_id : String(input.noteId || ''),
      name: atRest.encrypt(name),
      mime: atRest.encrypt(mime),
      size: deleted && existing ? existing.size : Number(input.size) || 0,
      hash: deleted && existing ? existing.hash : String(input.hash || ''),
      created_at: deleted && existing ? existing.created_at : String(input.createdAt || new Date().toISOString()),
      deleted
    };
    if (
      existing &&
      existing.note_id === row.note_id &&
      atRest.read(existing.name) === name &&
      atRest.read(existing.mime) === mime &&
      existing.size === row.size &&
      existing.hash === row.hash &&
      existing.deleted === row.deleted
    ) {
      continue;
    }
    putAttachment.run({ ...row, synced_at: nextSyncedAt() });
    attachmentsApplied += 1;
  }

  // B-3：画布卡片按 noteId 覆盖，updated_at 更旧的忽略（避免旧设备把新布局推回去）。
  let canvasApplied = 0;
  for (const input of payload.canvas || []) {
    const noteId = String(input.noteId || '').slice(0, 200);
    if (!noteId) continue;
    if (input.deleted) {
      if (getCanvasCard.get(noteId)) {
        deleteCanvasCard.run(noteId);
        canvasApplied += 1;
      }
      continue;
    }
    const existing = getCanvasCard.get(noteId);
    const updatedAt = String(input.updatedAt || new Date().toISOString());
    if (existing && existing.updated_at > updatedAt) continue;
    putCanvasCard.run({
      note_id: noteId,
      x: Number(input.x) || 0,
      y: Number(input.y) || 0,
      updated_at: updatedAt,
      device,
      synced_at: nextSyncedAt()
    });
    canvasApplied += 1;
  }

  return { applied, conflicts, relationsApplied, attachmentsApplied, canvasApplied };
});

app.post('/api/v1/push', (req, res) => {
  const device = deviceIdOf(req);
  touchDevice(device, req.body?.deviceName);
  const notes = Array.isArray(req.body?.notes) ? req.body.notes : [];
  const relations = Array.isArray(req.body?.relations) ? req.body.relations : [];
  const attachments = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
  const canvas = Array.isArray(req.body?.canvas) ? req.body.canvas : [];
  if (
    !device ||
    notes.length > 500 ||
    relations.length > 2000 ||
    attachments.length > 2000 ||
    canvas.length > 2000
  ) {
    res.status(400).json({ ok: false, error: 'deviceId required; payload too large' });
    return;
  }
  try {
    const result = pushTransaction(device, { notes, relations, attachments, canvas });
    res.json({
      ok: true,
      applied: result.applied,
      conflicts: result.conflicts,
      relationsApplied: result.relationsApplied,
      attachmentsApplied: result.attachmentsApplied,
      canvasApplied: result.canvasApplied,
      serverTime: nowStamp()
    });
  } catch (error) {
    console.error('push failed', error);
    res.status(500).json({ ok: false, error: String(error?.message || error) });
  }
});

// B-1：为本机签发/轮换设备凭证。原文只返回这一次，之后只存摘要。
app.post('/api/v1/device-token', requireAdmin, (req, res) => {
  const deviceId = String(req.body?.deviceId || '').slice(0, 200);
  if (!deviceId) {
    res.status(400).json({ ok: false, error: 'deviceId required' });
    return;
  }
  if (selectRevoked.get(deviceId)) {
    res.status(403).json({ ok: false, error: 'device-revoked', deviceId });
    return;
  }
  const token = `pked_${crypto.randomBytes(32).toString('base64url')}`;
  const now = new Date().toISOString();
  upsertDeviceToken.run(deviceId, hashToken(token), now, now);
  touchDevice(deviceId, req.body?.deviceName);
  res.status(201).json({ ok: true, deviceId, token });
});

app.get('/api/v1/device-tokens', requireAdmin, (_req, res) => {
  res.json({
    ok: true,
    tokens: listDeviceTokens.all().map((row) => ({
      deviceId: row.device_id,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at
    })),
    required: REQUIRE_DEVICE_TOKENS
  });
});

app.get('/api/v1/devices', requireAdmin, (_req, res) => {
  const rows = db.prepare('SELECT id, name, created_at, last_seen FROM devices ORDER BY last_seen DESC').all();
  res.json({
    ok: true,
    devices: rows.map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      lastSeen: row.last_seen
    })),
    revoked: listRevoked.all().map((row) => ({ id: row.id, name: row.name, revokedAt: row.revoked_at }))
  });
});

// 吊销 = 移出 devices + 进 revoked_devices（可恢复）。历史笔记保持不动。
app.delete('/api/v1/devices/:id', requireAdmin, (req, res) => {
  const id = String(req.params.id || '').slice(0, 200);
  if (!id) {
    res.status(400).json({ ok: false, error: 'device id required' });
    return;
  }
  const row = getDevice.get(id);
  db.transaction(() => {
    insertRevoked.run(id, row ? row.name : '', new Date().toISOString());
    deleteDeviceRow.run(id);
    // B-1：吊销立即作废该设备的凭证，换 deviceId 也绕不过去。
    deleteDeviceToken.run(id);
  })();
  res.json({ ok: true, revoked: true, id, name: row ? row.name : '' });
});

app.delete('/api/v1/revoked-devices/:id', requireAdmin, (req, res) => {
  const id = String(req.params.id || '').slice(0, 200);
  if (!id) {
    res.status(400).json({ ok: false, error: 'device id required' });
    return;
  }
  const result = deleteRevoked.run(id);
  res.json({ ok: true, restored: result.changes > 0, id });
});

// 版本历史分页（Phase 4.4）：按自增 id 倒序游标，`before` 只取更早的行；
// 不传参数时保持旧行为（最新 200 条），老客户端不受影响。
const VERSION_PAGE_MAX = 200;
// MCP / AI 写操作的审计日志（只追加、可查询；写操作必须带 confirm 由调用方保证）。
app.post('/api/v1/audit-logs', (req, res) => {
  const tool = String(req.body?.tool || '').slice(0, 100);
  if (!tool) {
    res.status(400).json({ ok: false, error: 'tool required' });
    return;
  }
  const info = db
    .prepare(
      'INSERT INTO audit_logs (at, tool, device, params_digest, result, note_id) VALUES (?, ?, ?, ?, ?, ?)'
    )
    .run(
      new Date().toISOString(),
      tool,
      String(req.body?.device || '').slice(0, 200),
      String(req.body?.paramsDigest || '').slice(0, 500),
      String(req.body?.result || '').slice(0, 1000),
      String(req.body?.noteId || '').slice(0, 200)
    );
  res.status(201).json({ ok: true, id: Number(info.lastInsertRowid) });
});

app.get('/api/v1/audit-logs', (req, res) => {
  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 200) : 50;
  const rows = db
    .prepare('SELECT id, at, tool, device, params_digest, result, note_id FROM audit_logs ORDER BY id DESC LIMIT ?')
    .all(limit);
  res.json({
    ok: true,
    logs: rows.map((row) => ({
      id: row.id,
      at: row.at,
      tool: row.tool,
      device: row.device,
      paramsDigest: row.params_digest,
      result: row.result,
      noteId: row.note_id
    }))
  });
});

app.get('/api/v1/versions/:id', (req, res) => {
  const noteId = String(req.params.id);
  const limitRaw = Number(req.query.limit);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(Math.floor(limitRaw), VERSION_PAGE_MAX)
      : VERSION_PAGE_MAX;
  const beforeRaw = Number(req.query.before);
  const before = Number.isFinite(beforeRaw) && beforeRaw > 0 ? Math.floor(beforeRaw) : null;
  const select = `SELECT id, note_id, title, body, tags, folder, updated_at, revision, device, created_at
                  FROM note_versions WHERE note_id = ?`;
  const rows = before
    ? db.prepare(`${select} AND id < ? ORDER BY id DESC LIMIT ?`).all(noteId, before, limit)
    : db.prepare(`${select} ORDER BY id DESC LIMIT ?`).all(noteId, limit);
  let nextCursor = null;
  if (rows.length === limit) {
    const last = rows[rows.length - 1].id;
    const older = db
      .prepare('SELECT 1 AS more FROM note_versions WHERE note_id = ? AND id < ? LIMIT 1')
      .get(noteId, last);
    if (older) nextCursor = last;
  }
  res.json({
    ok: true,
    versions: rows.map((row) => ({
      id: row.id,
      noteId: row.note_id,
      title: atRest.read(row.title),
      body: atRest.read(row.body),
      tags: JSON.parse(atRest.read(row.tags) || '[]'),
      folder: atRest.read(row.folder),
      updatedAt: row.updated_at,
      revision: row.revision,
      device: row.device,
      createdAt: row.created_at
    })),
    nextCursor
  });
});

app.use((error, _req, res, _next) => {
  console.error('unhandled error', error);
  res.status(500).json({ ok: false, error: String(error?.message || error) });
});

rotateAtRestKeys();

app.listen(PORT, HOST, () => {
  console.log(`PKE sync server listening on http://${HOST}:${PORT}`);
});
