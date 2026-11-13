/**
 * @req B-5 — 服务端静态加密（文本字段 + 附件字节）。
 *
 * 目标：拿到 sqlite 文件或备份目录的人读不到明文；传输层已由 tailnet/HTTPS 覆盖。
 * 策略：
 * - 密钥来自环境变量 `PKE_DATA_KEY`（不写库、不进仓库）；未配置则保持明文（向后兼容）。
 * - 文本值格式 `enc:v1:<base64(iv|tag|ciphertext)>`；没有该前缀的一律按明文处理。
 * - 附件字节格式 `PKEENC1 | iv | tag | ciphertext`；无该 magic 的按明文返回。
 * - `PKE_DATA_KEY_OLD` 用于轮换：用旧 key 解密成功、新 key 重新加密，写回后即可移除旧 key。
 */
const crypto = require('node:crypto');

const TEXT_PREFIX = 'enc:v1:';
const BLOB_MAGIC = Buffer.from('PKEENC1');
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_SALT = 'pke-at-rest-v1';

function deriveKey(secret) {
  const value = String(secret || '');
  if (!value) return null;
  return crypto.scryptSync(value, KEY_SALT, 32);
}

function encryptText(key, plain) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plain ?? ''), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return TEXT_PREFIX + Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

function decryptTextValue(key, payload) {
  const buffer = Buffer.from(payload, 'base64');
  const iv = buffer.subarray(0, IV_LENGTH);
  const tag = buffer.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = buffer.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

function createCrypto({ current, previous } = {}) {
  const active = deriveKey(current);
  const legacy = deriveKey(previous);

  const enabled = Boolean(active);

  /** 加密文本；未配置 key 时原样返回（保持明文兼容）。 */
  const encrypt = (plain) => (active ? encryptText(active, plain) : String(plain ?? ''));

  /**
   * 解密文本。返回 needReencrypt，调用方据此把值写回新 key。
   * 明文（无前缀）原样返回；有前缀但无可用 key 时抛错（fail-closed，不静默返回密文）。
   */
  const decrypt = (stored) => {
    const raw = String(stored ?? '');
    if (!raw.startsWith(TEXT_PREFIX)) {
      return { value: raw, needReencrypt: false, encrypted: false };
    }
    const payload = raw.slice(TEXT_PREFIX.length);
    if (active) {
      try {
        return { value: decryptTextValue(active, payload), needReencrypt: false, encrypted: true };
      } catch {
        /* 可能是旧 key 加密，继续尝试 */
      }
    }
    if (legacy) {
      const value = decryptTextValue(legacy, payload);
      return { value, needReencrypt: Boolean(active), encrypted: true };
    }
    throw new Error('无法解密：缺少可用的 PKE_DATA_KEY');
  };

  const read = (stored) => decrypt(stored).value;

  const encryptBytes = (buffer) => {
    const input = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    if (!active) return input;
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', active, iv);
    const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
    return Buffer.concat([BLOB_MAGIC, iv, cipher.getAuthTag(), ciphertext]);
  };

  const decryptBytes = (buffer) => {
    const input = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    if (input.subarray(0, BLOB_MAGIC.length).compare(BLOB_MAGIC) !== 0) return input;
    const offset = BLOB_MAGIC.length;
    const iv = input.subarray(offset, offset + IV_LENGTH);
    const tag = input.subarray(offset + IV_LENGTH, offset + IV_LENGTH + TAG_LENGTH);
    const ciphertext = input.subarray(offset + IV_LENGTH + TAG_LENGTH);
    if (active) {
      try {
        const decipher = crypto.createDecipheriv('aes-256-gcm', active, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      } catch {
        /* 可能是旧 key */
      }
    }
    if (legacy) {
      const decipher = crypto.createDecipheriv('aes-256-gcm', legacy, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    }
    throw new Error('无法解密附件：缺少可用的 PKE_DATA_KEY');
  };

  const isEncryptedBytes = (buffer) =>
    Buffer.isBuffer(buffer) && buffer.subarray(0, BLOB_MAGIC.length).compare(BLOB_MAGIC) === 0;

  /**
   * 是否仍需轮换：密文且「只有旧 key 能解开」。
   * 不能直接用 decryptBytes 判断——它会自动回退旧 key，永远成功。
   */
  const needsRotation = (buffer) => {
    const input = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
    if (!isEncryptedBytes(input) || !active || !legacy) return false;
    const offset = BLOB_MAGIC.length;
    const iv = input.subarray(offset, offset + IV_LENGTH);
    const tag = input.subarray(offset + IV_LENGTH, offset + IV_LENGTH + TAG_LENGTH);
    const ciphertext = input.subarray(offset + IV_LENGTH + TAG_LENGTH);
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', active, iv);
      decipher.setAuthTag(tag);
      Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return false; // 新 key 已能解开
    } catch {
      return true; // 只能靠旧 key
    }
  };

  return {
    enabled,
    encrypt,
    decrypt,
    read,
    encryptBytes,
    decryptBytes,
    isEncryptedBytes,
    needsRotation
  };
}

module.exports = { TEXT_PREFIX, createCrypto };
