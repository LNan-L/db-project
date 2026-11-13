import { describe, expect, it } from 'vitest';
import {
  decryptBackup,
  encryptBackup,
  isEncryptedBackup,
  rekeyBackup
} from '../../src/backup/crypto';

const passphrase = 'correct horse battery staple';

describe('OPEN-011 B crypto', () => {
  it('round-trips with passphrase', async () => {
    const plain = new Uint8Array([1, 2, 3, 4, 5]);
    const encrypted = await encryptBackup(plain, passphrase);
    expect(isEncryptedBackup(encrypted.data)).toBe(true);
    expect(encrypted.recoveryCode.startsWith('PKE-R-')).toBe(true);
    await expect(decryptBackup(encrypted.data, passphrase)).resolves.toEqual(plain);
  });

  it('round-trips with recovery code', async () => {
    const plain = new Uint8Array([9, 8, 7]);
    const encrypted = await encryptBackup(plain, passphrase);
    await expect(decryptBackup(encrypted.data, encrypted.recoveryCode)).resolves.toEqual(plain);
  });

  it('rejects wrong secret without revealing content', async () => {
    const encrypted = await encryptBackup(new Uint8Array([1]), passphrase);
    await expect(decryptBackup(encrypted.data, 'wrong-secret-123')).rejects.toThrow(
      /口令|恢复码|损坏/
    );
  });

  it('rejects short passphrase', async () => {
    await expect(encryptBackup(new Uint8Array([1]), 'short')).rejects.toThrow(/12/);
  });
});

describe('B-6 backup rekey', () => {
  const plain = new Uint8Array([42, 43, 44, 45, 46, 47]);

  it('re-wraps the same payload under a new passphrase', async () => {
    const original = await encryptBackup(plain, passphrase);
    const rekeyed = await rekeyBackup(original.data, passphrase, 'a brand new passphrase');

    expect(isEncryptedBackup(rekeyed.data)).toBe(true);
    // 新口令能解开，且数据完全一致
    await expect(decryptBackup(rekeyed.data, 'a brand new passphrase')).resolves.toEqual(plain);
    // 新恢复码也能解开
    await expect(decryptBackup(rekeyed.data, rekeyed.recoveryCode)).resolves.toEqual(plain);
    // 旧口令失效
    await expect(decryptBackup(rekeyed.data, passphrase)).rejects.toThrow(/口令|恢复码|损坏/);
    // 旧恢复码也失效
    await expect(decryptBackup(rekeyed.data, original.recoveryCode)).rejects.toThrow(
      /口令|恢复码|损坏/
    );
  });

  it('keeps the payload ciphertext untouched (no re-encryption of data)', async () => {
    const original = await encryptBackup(plain, passphrase);
    const rekeyed = await rekeyBackup(original.data, passphrase, 'another passphrase here');
    // 数据段（iv + ciphertext，从尾部算）必须逐字节相同
    const tail = original.data.slice(-(plain.length + 12 + 16));
    const newTail = rekeyed.data.slice(-(plain.length + 12 + 16));
    expect(Buffer.compare(Buffer.from(tail), Buffer.from(newTail))).toBe(0);
  });

  it('accepts the old recovery code as the old secret', async () => {
    const original = await encryptBackup(plain, passphrase);
    const rekeyed = await rekeyBackup(original.data, original.recoveryCode, 'rekeyed via recovery');
    await expect(decryptBackup(rekeyed.data, 'rekeyed via recovery')).resolves.toEqual(plain);
  });

  it('rejects a wrong old secret and short new passphrase', async () => {
    const original = await encryptBackup(plain, passphrase);
    await expect(rekeyBackup(original.data, 'wrong-old-secret', 'valid new passphrase')).rejects.toThrow(
      /旧口令|恢复码|损坏/
    );
    await expect(rekeyBackup(original.data, passphrase, 'short')).rejects.toThrow(/12/);
  });

  it('produces a different recovery code each time', async () => {
    const original = await encryptBackup(plain, passphrase);
    const first = await rekeyBackup(original.data, passphrase, 'first new passphrase');
    const second = await rekeyBackup(original.data, passphrase, 'second new passphrase');
    expect(first.recoveryCode).not.toBe(second.recoveryCode);
    expect(first.recoveryCode).not.toBe(original.recoveryCode);
  });
});
