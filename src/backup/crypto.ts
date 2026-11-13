/**
 * @req OPEN-011 B — 加密备份包。
 * 格式：magic PKEB1 | version | saltP | ivP | wrappedDEK(P) |
 *       saltR | ivR | wrappedDEK(R) | ivData | ciphertext
 */
const MAGIC = new TextEncoder().encode('PKEB1');
const VERSION = 1;
const PBKDF2_ITERATIONS = 200_000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const DEK_LENGTH = 32;

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function deriveKek(secret: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: bufferOf(salt),
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function wrapKey(dek: Uint8Array, secret: string): Promise<{ salt: Uint8Array; iv: Uint8Array; wrapped: Uint8Array }> {
  const salt = randomBytes(SALT_LENGTH);
  const iv = randomBytes(IV_LENGTH);
  const kek = await deriveKek(secret, salt);
  const wrapped = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bufferOf(iv) }, kek, bufferOf(dek))
  );
  return { salt, iv, wrapped };
}

async function unwrapKey(
  wrapped: Uint8Array,
  secret: string,
  salt: Uint8Array,
  iv: Uint8Array
): Promise<Uint8Array | null> {
  try {
    const kek = await deriveKek(secret, salt);
    const dek = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bufferOf(iv) }, kek, bufferOf(wrapped))
    );
    return dek.length === DEK_LENGTH ? dek : null;
  } catch {
    return null;
  }
}

export function isEncryptedBackup(data: Uint8Array): boolean {
  if (data.length < MAGIC.length) return false;
  return MAGIC.every((byte, index) => data[index] === byte);
}

export async function encryptBackup(
  zip: Uint8Array,
  passphrase: string
): Promise<{ data: Uint8Array; recoveryCode: string }> {
  if (passphrase.trim().length < 12) throw new Error('备份口令至少 12 位');

  const dek = randomBytes(DEK_LENGTH);
  const recoveryCode = `PKE-R-${toBase64Url(randomBytes(32))}`;
  const pass = await wrapKey(dek, passphrase.trim());
  const recovery = await wrapKey(dek, recoveryCode);
  const ivData = randomBytes(IV_LENGTH);
  const selfKey = await crypto.subtle.importKey('raw', bufferOf(dek), 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bufferOf(ivData) }, selfKey, bufferOf(zip))
  );

  const total = MAGIC.length + 1 + 16 + 12 + pass.wrapped.length + 16 + 12 + recovery.wrapped.length + 12 + ciphertext.length;
  const out = new Uint8Array(total);
  let offset = 0;
  out.set(MAGIC, offset);
  offset += MAGIC.length;
  out[offset++] = VERSION;
  out.set(pass.salt, offset); offset += 16;
  out.set(pass.iv, offset); offset += 12;
  out.set(pass.wrapped, offset); offset += pass.wrapped.length;
  out.set(recovery.salt, offset); offset += 16;
  out.set(recovery.iv, offset); offset += 12;
  out.set(recovery.wrapped, offset); offset += recovery.wrapped.length;
  out.set(ivData, offset); offset += 12;
  out.set(ciphertext, offset);
  return { data: out, recoveryCode };
}

export async function decryptBackup(data: Uint8Array, secret: string): Promise<Uint8Array> {
  if (!isEncryptedBackup(data)) throw new Error('不是 PKE 加密备份');
  let offset = MAGIC.length;
  if (data[offset] !== VERSION) throw new Error('加密备份版本不支持');
  offset += 1;

  const passSalt = data.slice(offset, offset + 16); offset += 16;
  const passIv = data.slice(offset, offset + 12); offset += 12;
  const passWrapped = data.slice(offset, offset + 48); offset += 48;
  const recSalt = data.slice(offset, offset + 16); offset += 16;
  const recIv = data.slice(offset, offset + 12); offset += 12;
  const recWrapped = data.slice(offset, offset + 48); offset += 48;
  const ivData = data.slice(offset, offset + 12); offset += 12;
  const ciphertext = data.slice(offset);

  const trimmed = secret.trim();
  const dek =
    (await unwrapKey(passWrapped, trimmed, passSalt, passIv)) ??
    (await unwrapKey(recWrapped, trimmed, recSalt, recIv));
  if (!dek) throw new Error('口令/恢复码错误，或备份已损坏');

  const key = await crypto.subtle.importKey('raw', bufferOf(dek), 'AES-GCM', false, ['decrypt']);
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bufferOf(ivData) }, key, bufferOf(ciphertext))
  );
}


/**
 * @req B-6 — 只换密钥不换内容：用旧口令/恢复码解开 DEK，再用新口令重新包裹。
 * 数据密文原样保留（不重新压缩/加密），因此大包也能秒级完成。
 * 返回新包 + 新的恢复码（旧的恢复码随之失效）。
 */
export async function rekeyBackup(
  data: Uint8Array,
  oldSecret: string,
  newPassphrase: string
): Promise<{ data: Uint8Array; recoveryCode: string }> {
  if (newPassphrase.trim().length < 12) throw new Error('新备份口令至少 12 位');
  const dek = await unwrapDek(data, oldSecret);
  if (!dek) throw new Error('旧口令/恢复码错误，或备份已损坏');

  const recoveryCode = `PKE-R-${toBase64Url(randomBytes(32))}`;
  const pass = await wrapKey(dek, newPassphrase.trim());
  const recovery = await wrapKey(dek, recoveryCode);

  // 找到原包里的数据段（ivData + ciphertext），原样复制。
  let offset = MAGIC.length + 1 + 16 + 12 + 48 + 16 + 12 + 48;
  const tail = data.slice(offset);

  const total =
    MAGIC.length + 1 + 16 + 12 + pass.wrapped.length + 16 + 12 + recovery.wrapped.length + tail.length;
  const out = new Uint8Array(total);
  let write = 0;
  out.set(MAGIC, write);
  write += MAGIC.length;
  out[write++] = VERSION;
  out.set(pass.salt, write); write += 16;
  out.set(pass.iv, write); write += 12;
  out.set(pass.wrapped, write); write += pass.wrapped.length;
  out.set(recovery.salt, write); write += 16;
  out.set(recovery.iv, write); write += 12;
  out.set(recovery.wrapped, write); write += recovery.wrapped.length;
  out.set(tail, write);
  return { data: out, recoveryCode };
}

/** 解开 DEK（口令或恢复码任一）；供 rekey 与验证复用。 */
export async function unwrapDek(data: Uint8Array, secret: string): Promise<Uint8Array | null> {
  if (!isEncryptedBackup(data)) throw new Error('不是 PKE 加密备份');
  let offset = MAGIC.length;
  if (data[offset] !== VERSION) throw new Error('加密备份版本不支持');
  offset += 1;
  const passSalt = data.slice(offset, offset + 16); offset += 16;
  const passIv = data.slice(offset, offset + 12); offset += 12;
  const passWrapped = data.slice(offset, offset + 48); offset += 48;
  const recSalt = data.slice(offset, offset + 16); offset += 16;
  const recIv = data.slice(offset, offset + 12); offset += 12;
  const recWrapped = data.slice(offset, offset + 48);
  const trimmed = secret.trim();
  return (
    (await unwrapKey(passWrapped, trimmed, passSalt, passIv)) ??
    (await unwrapKey(recWrapped, trimmed, recSalt, recIv))
  );
}
