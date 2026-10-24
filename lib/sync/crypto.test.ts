import { describe, it, expect } from 'vitest';
import { createKeyMeta, decryptJson, decryptWithKey, deriveSyncKey, encryptJson, encryptWithKey } from './crypto';
import type { SyncKeyMeta } from './types';

/** 测试用参数：迭代次数取允许的下限，避免每个用例都跑 60 万次 PBKDF2。 */
function fastMeta(): SyncKeyMeta {
  return { ...createKeyMeta(), iterations: 100_000 };
}

describe('同步加密', () => {
  it('createKeyMeta 产出 16 字节 salt 与默认迭代次数', () => {
    const meta = createKeyMeta();
    expect(meta.v).toBe(1);
    expect(atob(meta.salt)).toHaveLength(16);
    expect(meta.iterations).toBeGreaterThanOrEqual(100_000);
  });

  it('同一口令 + 同一 salt 派生出可互解的密钥', async () => {
    const meta = fastMeta();
    const k1 = await deriveSyncKey('correct horse', meta);
    const k2 = await deriveSyncKey('correct horse', meta);
    const plain = new TextEncoder().encode('hello 同步');
    const cipher = await encryptWithKey(k1, plain);
    const out = await decryptWithKey(k2, cipher);
    expect(new TextDecoder().decode(out)).toBe('hello 同步');
  });

  it('每次加密的 IV 不同（同一明文得到不同密文）', async () => {
    const key = await deriveSyncKey('pw', fastMeta());
    const plain = new TextEncoder().encode('same');
    const a = await encryptWithKey(key, plain);
    const b = await encryptWithKey(key, plain);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it('口令错误 → 解密失败（GCM 认证不通过）', async () => {
    const meta = fastMeta();
    const right = await deriveSyncKey('right', meta);
    const wrong = await deriveSyncKey('wrong', meta);
    const cipher = await encryptWithKey(right, new TextEncoder().encode('secret'));
    await expect(decryptWithKey(wrong, cipher)).rejects.toThrow();
  });

  it('密文被篡改 → 解密失败', async () => {
    const key = await deriveSyncKey('pw', fastMeta());
    const cipher = await encryptWithKey(key, new TextEncoder().encode('secret'));
    cipher[cipher.length - 1] ^= 0xff;
    await expect(decryptWithKey(key, cipher)).rejects.toThrow();
  });

  it('过短的负载直接拒绝（不是合法密文）', async () => {
    const key = await deriveSyncKey('pw', fastMeta());
    await expect(decryptWithKey(key, new Uint8Array(5))).rejects.toThrow(/too short/);
  });

  it('JSON 往返', async () => {
    const key = await deriveSyncKey('pw', fastMeta());
    const value = { entries: { a: { value: { x: 1 }, updatedAt: 2 } } };
    const bytes = await encryptJson(key, value);
    expect(await decryptJson(key, bytes)).toEqual(value);
  });

  it('迭代次数越界 → 拒绝派生（防 DoS / 弱化攻击）', async () => {
    await expect(
      deriveSyncKey('pw', { v: 1, salt: createKeyMeta().salt, iterations: 10 }),
    ).rejects.toThrow(/iterations/);
    await expect(
      deriveSyncKey('pw', { v: 1, salt: createKeyMeta().salt, iterations: 10_000_000 }),
    ).rejects.toThrow(/iterations/);
  });

  it('salt 长度不对 → 拒绝派生', async () => {
    await expect(
      deriveSyncKey('pw', { v: 1, salt: btoa('short'), iterations: 100_000 }),
    ).rejects.toThrow(/salt length/);
  });
});
