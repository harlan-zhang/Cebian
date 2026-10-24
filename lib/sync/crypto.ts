// 同步仓库的加密层。
//
// 与备份（lib/backup/crypto.ts）的区别：备份每个 zip 只加密一次，可以每次随机 salt；
// 同步要把许多小文件分别加密，若每个文件都跑一遍 PBKDF2（600k 次迭代）会慢到不可用。
// 所以这里把「派生密钥」与「加解密」拆开：
//
// - salt 固定在远端 meta.json 里（全仓库共用），口令只在一次同步开始时派生一次密钥；
// - 每个文件用随机 IV 独立加密，格式为 `[12 字节 IV][密文]`。
//
// 共用 salt 不影响安全性：salt 的职责只是防止彩虹表与跨用户预计算，不需要每次不同；
// IV 每次随机才是 AES-GCM 的硬性要求。口令错误时 GCM 认证失败，解密直接抛错。

import { bytesToBase64, base64ToBytes } from '@/lib/utils';
import { SYNC_PBKDF2_ITERATIONS } from './types';
import type { SyncKeyMeta } from './types';

/** salt 字节数（PBKDF2）。 */
const SALT_BYTES = 16;
/** IV 字节数（AES-GCM 推荐 12）。 */
const IV_BYTES = 12;
/** 派生密钥长度（bit）。 */
const KEY_LENGTH_BITS = 256;
/** 可接受的迭代次数下限——低于此值视为被篡改的弱化攻击。 */
const MIN_ITERATIONS = 100_000;
/** 可接受的迭代次数上限——防止恶意 meta 用超大迭代次数让 PBKDF2 卡死。 */
const MAX_ITERATIONS = 5_000_000;

/** 生成一份新的密钥参数（首次初始化远端仓库时用）。 */
export function createKeyMeta(): SyncKeyMeta {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  return {
    v: 1,
    salt: bytesToBase64(salt),
    iterations: SYNC_PBKDF2_ITERATIONS,
  };
}

/** 校验来自远端的 meta 是否可用；返回解码后的 salt。 */
function validateKeyMeta(meta: SyncKeyMeta): Uint8Array {
  if (!Number.isSafeInteger(meta.iterations) || meta.iterations < MIN_ITERATIONS || meta.iterations > MAX_ITERATIONS) {
    throw new Error(`Invalid sync key iterations: ${String(meta.iterations)}`);
  }
  let salt: Uint8Array;
  try {
    salt = base64ToBytes(meta.salt);
  } catch {
    throw new Error('Malformed sync key salt (not valid base64)');
  }
  if (salt.length !== SALT_BYTES) {
    throw new Error(`Invalid sync key salt length: ${salt.length}`);
  }
  return salt;
}

/** 从同步口令 + 远端 salt 派生 AES-GCM 密钥。一次同步只调用一次。 */
export async function deriveSyncKey(password: string, meta: SyncKeyMeta): Promise<CryptoKey> {
  const salt = validateKeyMeta(meta);
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: meta.iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: KEY_LENGTH_BITS },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** 用已派生的密钥加密一段字节，返回 `[IV][密文]`。 */
export async function encryptWithKey(key: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plaintext as BufferSource),
  );
  const out = new Uint8Array(iv.length + cipher.length);
  out.set(iv, 0);
  out.set(cipher, iv.length);
  return out;
}

/** 解密 `[IV][密文]`。口令错误 / 内容被篡改时 GCM 认证失败，抛错且不产出半解密数据。 */
export async function decryptWithKey(key: CryptoKey, payload: Uint8Array): Promise<Uint8Array> {
  if (payload.length <= IV_BYTES) {
    throw new Error('Encrypted sync payload is too short');
  }
  const iv = payload.subarray(0, IV_BYTES);
  const cipher = payload.subarray(IV_BYTES);
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    cipher as BufferSource,
  );
  return new Uint8Array(plain);
}

/** 加密一段 JSON。 */
export async function encryptJson(key: CryptoKey, value: unknown): Promise<Uint8Array> {
  return encryptWithKey(key, new TextEncoder().encode(JSON.stringify(value)));
}

/** 解密一段 JSON。JSON 解析失败归为「仓库损坏」。 */
export async function decryptJson<T>(key: CryptoKey, payload: Uint8Array): Promise<T> {
  const plain = await decryptWithKey(key, payload);
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}
