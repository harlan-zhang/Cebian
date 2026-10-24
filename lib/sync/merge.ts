// 同步的合并决策（纯逻辑，不碰 IO / Dexie / 网络）。
//
// 两条独立的合并线：
//
// 1. **会话**：按 id 的三方合并。基线 = 上次成功同步时远端的 updatedAt。
//    两边都改过时按 updatedAt 取新（LWW）；删除用墓碑传播。
// 2. **设置 / 密钥**：按 key 的三方合并。判断「本地改过」靠值哈希与基线对比——
//    我们不拦截 storage 的写操作，所以在同步时用哈希比对来推断本地是否变动。
//    两边都改过时**保留本地**并记一次冲突（用户此刻正在这台机器上操作，可预期）。
//
// 把这些决策抽成纯函数，是为了能在单测里穷举组合——同步最怕的不是崩溃，是静默
// 覆盖用户数据。

import type { SyncEntry, SyncSessionMeta } from './types';

// ─── 值哈希 ───

/** 递归排序对象键，保证同一份数据无论键序如何都得到同一字符串。 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      // undefined 在 JSON 里会被丢掉，这里显式跳过，保证与序列化结果一致
      if (src[key] === undefined) continue;
      out[key] = canonicalize(src[key]);
    }
    return out;
  }
  return value;
}

/** 值的规范字符串（供哈希与比较）。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? 'null';
}

/** SHA-256 十六进制哈希。 */
export async function hashValue(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(value)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 判断一个值是否「空」——密钥类条目用它决定「本机没填过就别覆盖远端」。 */
export function isEmptyValue(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as object).length === 0;
  return false;
}

/**
 * 判断一条 provider 密钥是否「等于没填」。
 *
 * 不能直接用 {@link isEmptyValue}：`{ authType: 'apiKey', apiKey: '', verified: false }`
 * 是个非空对象，但它显然没有可用密钥。新设备上就是这个形状——若按「对象非空」判，
 * 会拿空 key 去覆盖云端已有的真 key。
 */
export function isEmptyCredential(value: unknown): boolean {
  if (!value || typeof value !== 'object') return isEmptyValue(value);
  const cred = value as { authType?: unknown; apiKey?: unknown; accessToken?: unknown };
  if (cred.authType === 'apiKey') {
    return typeof cred.apiKey !== 'string' || cred.apiKey.trim() === '';
  }
  if (cred.authType === 'oauth') {
    return typeof cred.accessToken !== 'string' || cred.accessToken.trim() === '';
  }
  // 未知形状：只要还有字段就当作「有值」，宁可保留本机也不误删远端
  return Object.keys(cred).length === 0;
}

// ─── 会话 ───

/** 会话合并的输入。 */
export interface SessionMergeInput {
  /** 本机会话（只需 id 与 updatedAt）。 */
  local: Array<{ id: string; updatedAt: number }>;
  /** 远端索引里的会话元数据。 */
  remote: Record<string, SyncSessionMeta>;
  /** 远端墓碑（id → 删除时间）。 */
  tombstones: Record<string, number>;
  /** 上次成功同步时的远端 updatedAt。 */
  baseline: Record<string, number>;
  now: number;
  tombstoneTtlMs: number;
}

/** 会话合并的决策。 */
export interface SessionMergePlan {
  /** 需要上传（本地更新或本地独有）。 */
  push: string[];
  /** 需要下载（远端更新或远端独有）。 */
  pull: string[];
  /** 需要在本机删除（远端墓碑早于本地修改）。 */
  deleteLocal: string[];
  /** 本地删除产生的新墓碑（id → 删除时间）。 */
  tombstone: Record<string, number>;
  /** 超过保留期、可以清掉的墓碑 id。 */
  pruneTombstones: string[];
}

/**
 * 规划会话同步。
 *
 * 规则表（base = 基线，L/R = 本地 / 远端）：
 * - 远端有墓碑：本机在删除后没再改（`local <= deletedAt`）→ 本机删除；改过 → 复活并上传。
 * - 本地独有（远端没有）→ 上传（新会话，或远端文件被清掉）。
 * - 远端独有且本地曾有（基线有）→ 本机删掉了 → 打墓碑。
 * - 远端独有且基线没有 → 别的设备新建 → 下载。
 * - 两边都有：按 base 判断谁变了；都变 → updatedAt 大的赢，相等时保留本地。
 */
export function planSessionSync(input: SessionMergeInput): SessionMergePlan {
  const { local, remote, tombstones, baseline, now, tombstoneTtlMs } = input;
  const push = new Set<string>();
  const pull = new Set<string>();
  const deleteLocal = new Set<string>();
  const tombstone: Record<string, number> = {};
  const localUpdatedAt = new Map(local.map((s) => [s.id, s.updatedAt]));

  // 1) 远端墓碑
  for (const [id, deletedAt] of Object.entries(tombstones)) {
    const localTime = localUpdatedAt.get(id);
    // 本机早就没了
    if (localTime === undefined) continue;
    if (localTime > deletedAt) {
      // 删除之后又在本机改过 → 以本机为准，复活
      push.add(id);
    } else {
      deleteLocal.add(id);
    }
  }

  // 2) 本机有的会话
  for (const [id, localTime] of localUpdatedAt) {
    // 已在 1) 处理
    if (tombstones[id] !== undefined) continue;
    const remoteMeta = remote[id];
    const base = baseline[id];

    if (!remoteMeta) {
      push.add(id);
      continue;
    }
    if (base === undefined) {
      // 首次见到这一条（新设备 / 新会话）：两边都有就按时间取新
      if (localTime >= remoteMeta.updatedAt) push.add(id);
      else pull.add(id);
      continue;
    }

    const localChanged = localTime > base;
    const remoteChanged = remoteMeta.updatedAt > base;
    if (localChanged && remoteChanged) {
      if (localTime >= remoteMeta.updatedAt) push.add(id);
      else pull.add(id);
    } else if (localChanged) {
      push.add(id);
    } else if (remoteChanged) {
      pull.add(id);
    }
  }

  // 3) 远端有、本机没有
  for (const [id, remoteMeta] of Object.entries(remote)) {
    if (localUpdatedAt.has(id)) continue;
    if (tombstones[id] !== undefined) continue;
    if (baseline[id] === undefined) {
      // 别的设备新建的
      pull.add(id);
    } else {
      // 本机删掉的，告诉别人
      tombstone[id] = now;
    }
  }

  // 4) 清理过期墓碑
  const pruneTombstones = Object.entries(tombstones)
    .filter(([, deletedAt]) => now - deletedAt > tombstoneTtlMs)
    .map(([id]) => id);

  // 同一个 id 不应同时出现在推送与删除里（1) 与 2) 已互斥），这里兜底
  for (const id of deleteLocal) push.delete(id);

  return {
    push: [...push],
    pull: [...pull],
    deleteLocal: [...deleteLocal],
    tombstone,
    pruneTombstones,
  };
}

// ─── 设置 / 密钥 ───

/** 条目合并的输入。 */
export interface EntryMergeInput<T> {
  /** 本机的全部条目（设置项恒有值——storage 会给 fallback）。 */
  local: Record<string, T>;
  /** 远端条目。 */
  remote: Record<string, SyncEntry<T>>;
  /** 上次成功同步时的基线（哈希 + 远端时间戳）。 */
  baseline: Record<string, { hash: string; updatedAt: number }>;
  /** 本机值的哈希（由调用方异步算好后传入）。 */
  localHashes: Record<string, string>;
  now: number;
  /**
   * 首次见到某个 key（没有基线）且远端存在时：
   * - `true`：采纳远端（设置类——新设备应继承云端配置）；
   * - `false`：本机非空则保留本机（密钥类——不静默替换用户已填的 key）。
   */
  adoptRemoteWhenUnseen: boolean;
  /** 判断「本机没填过」的谓词，默认 {@link isEmptyValue}；密钥传 {@link isEmptyCredential}。 */
  isEmpty?: (value: T) => boolean;
}

/** 条目合并的决策。 */
export interface EntryMergePlan<T> {
  /** 需要上传的条目。 */
  push: Record<string, SyncEntry<T>>;
  /** 需要写回本机的条目。 */
  pull: Record<string, T>;
  /** 两边都改过的 key（已按「保留本地」处理）。 */
  conflicts: string[];
}

/**
 * 规划设置 / 密钥的同步。
 *
 * - 本机没有该 key：远端有就下载。
 * - 远端没有该 key：上传（新 key，或远端被清掉）。
 * - 没有基线：按 `adoptRemoteWhenUnseen` 决定（见字段注释）。
 * - 有基线：哈希变了 = 本地改过；远端 updatedAt 变大 = 远端改过。
 *   都改 → 保留本地并记冲突；只有一边改 → 那一边赢。
 */
export function planEntrySync<T>(input: EntryMergeInput<T>): EntryMergePlan<T> {
  const { local, remote, baseline, localHashes, now, adoptRemoteWhenUnseen } = input;
  const isEmpty = input.isEmpty ?? isEmptyValue;
  const push: Record<string, SyncEntry<T>> = {};
  const pull: Record<string, T> = {};
  const conflicts: string[] = [];

  const keys = new Set([...Object.keys(local), ...Object.keys(remote)]);
  for (const key of keys) {
    const hasLocal = Object.hasOwn(local, key);
    const remoteEntry = remote[key];
    const base = baseline[key];

    if (!hasLocal) {
      if (remoteEntry) pull[key] = remoteEntry.value;
      continue;
    }
    const localValue = local[key];

    if (!remoteEntry) {
      push[key] = { value: localValue, updatedAt: now };
      continue;
    }

    if (!base) {
      if (adoptRemoteWhenUnseen || isEmpty(localValue)) {
        pull[key] = remoteEntry.value;
      } else {
        push[key] = { value: localValue, updatedAt: now };
      }
      continue;
    }

    const localChanged = localHashes[key] !== base.hash;
    const remoteChanged = remoteEntry.updatedAt > base.updatedAt;

    if (localChanged && remoteChanged) {
      conflicts.push(key);
      push[key] = { value: localValue, updatedAt: now };
    } else if (localChanged) {
      push[key] = { value: localValue, updatedAt: now };
    } else if (remoteChanged) {
      pull[key] = remoteEntry.value;
    }
  }

  return { push, pull, conflicts };
}

/**
 * 把本机要推送的条目合并进远端 blob。
 *
 * 远端 blob 是整份文件读写的：同一时刻另一台设备可能刚写过。调用方在写之前会重新
 * 读一次远端，再调本函数——按 key 取 `updatedAt` 较大的那条，把「后写覆盖先写」
 * 的窗口压到最小。
 */
export function mergeEntries<T>(
  remote: Record<string, SyncEntry<T>>,
  incoming: Record<string, SyncEntry<T>>,
): Record<string, SyncEntry<T>> {
  const out: Record<string, SyncEntry<T>> = { ...remote };
  for (const [key, entry] of Object.entries(incoming)) {
    const existing = out[key];
    if (!existing || entry.updatedAt >= existing.updatedAt) out[key] = entry;
  }
  return out;
}

/** 把本机的索引改动合并进刚读到的远端索引（写回前调用，缩小竞态窗口）。 */
export function mergeIndexPatch(
  remote: {
    devices: Record<string, { name: string; lastSyncAt: number }>;
    sessions: Record<string, SyncSessionMeta>;
    tombstones: Record<string, number>;
  },
  patch: {
    devices: Record<string, { name: string; lastSyncAt: number }>;
    sessions: Record<string, SyncSessionMeta>;
    tombstones: Record<string, number>;
  },
): { devices: Record<string, { name: string; lastSyncAt: number }>; sessions: Record<string, SyncSessionMeta>; tombstones: Record<string, number> } {
  const devices = { ...remote.devices };
  for (const [id, info] of Object.entries(patch.devices)) {
    const existing = devices[id];
    devices[id] = existing && existing.lastSyncAt > info.lastSyncAt ? existing : info;
  }

  const sessions = { ...remote.sessions };
  for (const [id, meta] of Object.entries(patch.sessions)) {
    const existing = sessions[id];
    if (!existing || meta.updatedAt >= existing.updatedAt) sessions[id] = meta;
  }

  const tombstones = { ...remote.tombstones };
  for (const [id, deletedAt] of Object.entries(patch.tombstones)) {
    const existing = tombstones[id];
    if (existing === undefined || deletedAt > existing) tombstones[id] = deletedAt;
  }
  return { devices, sessions, tombstones };
}
