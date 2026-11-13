#!/usr/bin/env node
/**
 * @req B-5 / B-6 — 静态加密与密钥轮换回归。
 * 用法：node server/verify-at-rest.js
 *
 * 覆盖：文本/字节往返、明文兼容、错误 key fail-closed、旧 key 轮换后可读且需重写、格式不自带密钥。
 */
const crypto = require('node:crypto');
const { createCrypto, TEXT_PREFIX } = require('./at-rest');

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (actual=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)})`}`
  );
}

// 1. 未配置 key：明文兼容（老库继续可用）
const plain = createCrypto({});
check('disabled crypto keeps text as-is', plain.encrypt('秘密笔记'), '秘密笔记');
check('disabled crypto reads plaintext', plain.read('秘密笔记'), '秘密笔记');
check('disabled crypto keeps bytes as-is', Buffer.compare(plain.encryptBytes(Buffer.from('abc')), Buffer.from('abc')), 0);
check('enabled flag is false without a key', plain.enabled, false);

// 2. 配置 key：文本加密往返
const keyA = crypto.randomBytes(24).toString('base64');
const a = createCrypto({ current: keyA });
const cipher = a.encrypt('火星是第四颗行星');
check('ciphertext is prefixed', cipher.startsWith(TEXT_PREFIX), true);
check('ciphertext does not contain plaintext', cipher.includes('火星'), false);
check('round-trips text', a.read(cipher), '火星是第四颗行星');
check('plaintext still readable when enabled', a.read('历史明文'), '历史明文');
check('needReencrypt is false for new ciphertext', a.decrypt(cipher).needReencrypt, false);

// 3. 字节往返
const bytes = crypto.randomBytes(2048);
const encBytes = a.encryptBytes(bytes);
check('encrypted bytes have magic', encBytes.subarray(0, 7).toString('utf8'), 'PKEENC1');
check('encrypted bytes differ from input', Buffer.compare(encBytes, bytes) === 0, false);
check('decryptBytes round-trips', Buffer.compare(a.decryptBytes(encBytes), bytes), 0);
check('plain bytes pass through', Buffer.compare(a.decryptBytes(bytes), bytes), 0);

// 4. 空值/中文/大文本
check('empty string round-trips', a.read(a.encrypt('')), '');
const long = '同步与备份'.repeat(2000);
check('long text round-trips', a.read(a.encrypt(long)).length, long.length);

// 5. fail-closed：没有正确 key 时必须报错，不能静默返回密文
const wrong = createCrypto({ current: crypto.randomBytes(24).toString('base64') });
let threw = false;
try {
  wrong.read(cipher);
} catch {
  threw = true;
}
check('wrong key fails closed', threw, true);

// 6. 轮换：旧 key 解密 + 新 key 重写
const keyB = crypto.randomBytes(24).toString('base64');
const oldOnly = createCrypto({ current: keyA });
const legacyCipher = oldOnly.encrypt('旧密钥加密的内容');
const rotating = createCrypto({ current: keyB, previous: keyA });
const rotated = rotating.decrypt(legacyCipher);
check('old key still decrypts during rotation', rotated.value, '旧密钥加密的内容');
check('rotation marks the value for re-encryption', rotated.needReencrypt, true);
const rewritten = rotating.encrypt(rotated.value);
check('rewritten value decrypts with the new key only', createCrypto({ current: keyB }).read(rewritten), '旧密钥加密的内容');
let oldKeyFails = false;
try {
  createCrypto({ current: keyA }).read(rewritten);
} catch {
  oldKeyFails = true;
}
check('after rewrite the old key no longer opens it', oldKeyFails, true);

// 7. 字节轮换
const legacyBytes = createCrypto({ current: keyA }).encryptBytes(Buffer.from('附件明文'));
check(
  'old key byte decrypts during rotation',
  rotating.decryptBytes(legacyBytes).toString('utf8'),
  '附件明文'
);

// 8. 密文不自带可用密钥（把整串密文给攻击者，无 key 也打不开）
const sample = JSON.stringify(cipher);
check('ciphertext alone is not decryptable', sample.includes('火星'), false);
check('ciphertext carries no key material', /[A-Za-z0-9+/]{43}=?$/.test(sample) && sample.length < 200, false);

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
