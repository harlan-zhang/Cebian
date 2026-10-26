// 多设备同步的核心逻辑——与「数据放在哪」和「在哪个上下文跑」都无关。
//
// 两个维度被抽象掉了：
// - `SyncStore`：仓库读写（WebDAV / 本地文件夹）。见 lib/sync/store.ts。
// - `SyncLocalAdapter`：本机数据读写。background 直接操作 Dexie；扩展页面必须
//   经备份 IPC（Dexie 的唯一写者是 background）。见各自的 adapter 实现。
//
// 一次同步的流程：
//   1. 确保仓库就绪，读 meta 并派生密钥（一次同步只派生一次）
//   2. 读远端索引 + 设置 / 密钥 blob
//   3. 用基线做三方合并，得到「推 / 拉 / 删」三份计划（纯逻辑在 merge.ts）
//   4. 先应用拉取与删除（本地数据就位）
//   5. 再上传本地改动，最后写索引
//   6. 更新基线
//
// 顺序上的两个关键点：
// - **索引最后写**：索引一旦指向某个会话文件，文件必须已经存在；反过来的短暂不一致
//   只会让别的设备多试一次。
// - **墓碑先入索引、再删远端文件**：先删文件再写索引，会让恰好在两者之间同步的设备
//   读到「索引说有、文件却没有」的悬空条目。

import { isValidSessionLike, type SessionBackupRecord } from '@/lib/persistence/db';
import type { ProviderCredential, ProviderCredentials } from '@/lib/persistence/storage';
import { createKeyMeta, decryptJson, deriveSyncKey, encryptJson } from './crypto';
import { SyncFolderError } from './folder-store';
import {
  hashValue,
  isEmptyCredential,
  mergeEntries,
  mergeIndexPatch,
  planEntrySync,
  planSessionSync,
} from './merge';
import { SyncRemoteError, SYNC_FILES } from './remote';
import type { SyncStore } from './store';
import {
  SYNC_SCHEMA_VERSION,
  TOMBSTONE_TTL_MS,
  emptySyncIndex,
  emptySyncStats,
  type BaselineEntry,
  type SyncBlob,
  type SyncConfig,
  type SyncErrorCode,
  type SyncIndex,
  type SyncReason,
  type SyncRunResult,
  type SyncState,
} from './types';

/** 本机数据读写。两个执行上下文各实现一份。 */
export interface SyncLocalAdapter {
  /** 全部会话的轻量元数据（id + updatedAt）。读之前必须先把在途写落定。 */
  listSessionMeta(): Promise<Array<{ id: string; updatedAt: number }>>;
  /** 读一个会话的同步形态（行 + mutation 日志投影）。 */
  readSessionRecord(id: string): Promise<SessionBackupRecord | null>;
  /** 写入拉取到的会话（merge 语义：只写更新的）。 */
  applySessionRecords(records: SessionBackupRecord[]): Promise<void>;
  /** 删除会话（远端墓碑落到本机时）。 */
  deleteSessions(ids: string[]): Promise<void>;
  readSettings(): Promise<Record<string, unknown>>;
  /** 写回一个设置项；未知 key 返回 false。 */
  writeSetting(key: string, value: unknown): Promise<boolean>;
  readCredentials(): Promise<ProviderCredentials>;
  writeCredentials(next: ProviderCredentials): Promise<void>;
}

/** 一次同步所需的全部依赖。 */
export interface SyncCoreDeps {
  config: SyncConfig;
  state: SyncState;
  store: SyncStore;
  local: SyncLocalAdapter;
  /** 保存新状态（成功或失败都要写）。 */
  saveState: (state: SyncState) => Promise<void>;
  reason?: SyncReason;
  log?: (message: string, err?: unknown) => void;
}

/** 把远端索引归一化成完整形状。缺字段时补空，而不是让后续 Object.entries(undefined) 抛裸 TypeError。 */
function normalizeIndex(raw: Partial<SyncIndex> | null): SyncIndex {
  const obj = (v: unknown): Record<string, unknown> =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  return {
    version: typeof raw?.version === 'number' ? raw.version : SYNC_SCHEMA_VERSION,
    updatedAt: typeof raw?.updatedAt === 'number' ? raw.updatedAt : Date.now(),
    devices: obj(raw?.devices) as SyncIndex['devices'],
    sessions: obj(raw?.sessions) as SyncIndex['sessions'],
    tombstones: obj(raw?.tombstones) as SyncIndex['tombstones'],
  };
}

/** 同上，用于 settings / credentials blob。 */
function normalizeBlob<T>(raw: Partial<SyncBlob<T>> | null): SyncBlob<T> {
  const entries = raw?.entries;
  return {
    entries: entries && typeof entries === 'object' && !Array.isArray(entries) ? entries : {},
  };
}

/** 取错误的可读摘要（截断，避免把超长栈信息塞进 storage / toast）。 */
export function errorDetail(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return text.length > 300 ? `${text.slice(0, 297)}...` : text;
}

/** 基础设施类错误：必须整体失败，不能当成「这条数据有问题」跳过。 */
export function isInfrastructureError(err: unknown): boolean {
  return err instanceof SyncRemoteError || err instanceof SyncFolderError;
}

/** 把未知异常翻译成同步错误码。 */
export function toErrorCode(err: unknown): SyncErrorCode {
  if (err instanceof SyncRemoteError) {
    switch (err.code) {
      case 'network':
      case 'timeout':
        return 'network';
      case 'unauthorized':
        return 'unauthorized';
      case 'forbidden':
        return 'forbidden';
      case 'invalid':
      case 'notFound':
      case 'conflict':
      case 'server':
        return 'server';
    }
  }
  if (err instanceof SyncFolderError) {
    switch (err.code) {
      case 'permission':
        return 'needsPermission';
      case 'missing':
        return 'noFolder';
      case 'unsupported':
        return 'unsupported';
      case 'invalid':
      case 'io':
        return 'server';
    }
  }
  if (err instanceof Error && err.name === 'OperationError') {
    // AES-GCM 认证失败：口令错误，或密文被篡改
    return 'wrongPassword';
  }
  return 'unknown';
}

/** 计算一组值的哈希。 */
async function hashAll(values: Record<string, unknown>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    out[key] = await hashValue(value);
  }
  return out;
}

/** 分批写库的批大小：会话里常有 base64 图片，一次全攒进内存会占几十 MB。 */
const PULL_BATCH = 20;

/**
 * 执行一次同步。失败不抛异常——返回可序列化的结果，并已把错误写进 state。
 *
 * 调用方负责：配置 / 状态读取、store 构造、keepalive、并发闸。
 */
export async function runSyncCore(deps: SyncCoreDeps): Promise<SyncRunResult> {
  const { config, state: prevState, store, local, saveState } = deps;
  const log = deps.log ?? ((message: string, err?: unknown) => console.warn(message, err));
  const reason = deps.reason ?? 'manual';

  if (!config.syncPassword) return { ok: false, code: 'notConfigured' };

  const startedAt = Date.now();
  const deviceId = prevState.deviceId || crypto.randomUUID();
  const stats = emptySyncStats();

  // 失败时把「卡在哪一步」写进 detail：只给一个 unknown 无法排障。
  let phase = 'ready';
  try {
    await store.ensureReady();

    // ─ 1. 密钥 ─
    phase = 'key';
    let meta = await store.readMeta();
    if (!meta) {
      meta = createKeyMeta();
      await store.writeMeta(meta);
    }
    if (meta.v > SYNC_SCHEMA_VERSION) return { ok: false, code: 'incompatible' };
    const key = await deriveSyncKey(config.syncPassword, meta);

    // ─ 2. 读远端 ─
    phase = 'read-remote';
    const indexBytes = await store.readFile(SYNC_FILES.index);
    const remoteIndex: SyncIndex = indexBytes
      ? normalizeIndex(await decryptJson<Partial<SyncIndex>>(key, indexBytes))
      : emptySyncIndex(startedAt);
    if (remoteIndex.version > SYNC_SCHEMA_VERSION) return { ok: false, code: 'incompatible' };

    const settingsBytes = await store.readFile(SYNC_FILES.settings);
    const remoteSettings: SyncBlob<unknown> = normalizeBlob<unknown>(
      settingsBytes ? await decryptJson<Partial<SyncBlob<unknown>>>(key, settingsBytes) : null,
    );

    const credsBytes = await store.readFile(SYNC_FILES.credentials);
    const remoteCreds: SyncBlob<ProviderCredential> = normalizeBlob<ProviderCredential>(
      credsBytes ? await decryptJson<Partial<SyncBlob<ProviderCredential>>>(key, credsBytes) : null,
    );

    // ─ 3. 采集本地 + 规划 ─
    phase = 'collect-local';
    const localSessions = await local.listSessionMeta();
    const localSettings = await local.readSettings();
    const localCreds = await local.readCredentials();

    phase = 'plan';
    const sessionPlan = planSessionSync({
      local: localSessions,
      remote: remoteIndex.sessions,
      tombstones: remoteIndex.tombstones,
      baseline: prevState.sessions,
      now: startedAt,
      tombstoneTtlMs: TOMBSTONE_TTL_MS,
    });

    const settingsPlan = planEntrySync<unknown>({
      local: localSettings,
      remote: remoteSettings.entries,
      baseline: prevState.settings,
      localHashes: await hashAll(localSettings),
      now: startedAt,
      // 设置：新设备应继承云端配置
      adoptRemoteWhenUnseen: true,
    });

    const credPlan = planEntrySync<ProviderCredential>({
      local: localCreds,
      remote: remoteCreds.entries,
      baseline: prevState.credentials,
      localHashes: await hashAll(localCreds),
      now: startedAt,
      // 密钥：本机已有值就不被远端静默替换
      adoptRemoteWhenUnseen: false,
      isEmpty: isEmptyCredential,
    });

    stats.conflicts = settingsPlan.conflicts.length + credPlan.conflicts.length;

    // ─ 4. 应用拉取与删除 ─
    phase = 'pull-sessions';
    let batch: SessionBackupRecord[] = [];
    const flushPulls = async (): Promise<void> => {
      if (batch.length === 0) return;
      const current = batch;
      batch = [];
      try {
        // merge 语义：只写比本地更新的，等于再兜一次 LWW 保护
        await local.applySessionRecords(current);
        stats.pulledSessions += current.length;
      } catch (err) {
        // 单条会话数据坏掉不该让整次同步失败：记日志、跳过这一批，下次再试。
        // 但传输 / 权限这类基础设施错误必须整体失败，否则会静默漏数据。
        if (isInfrastructureError(err)) throw err;
        log(`[sync] failed to apply ${current.length} pulled session(s), skipped`, err);
      }
    };

    for (const id of sessionPlan.pull) {
      const bytes = await store.readSession(id);
      // 索引悬空（索引说有、文件却没有）：跳过，下次索引会修正
      if (!bytes) continue;
      const record = await decryptJson<SessionBackupRecord>(key, bytes);
      if (!isValidSessionLike(record) || record.id !== id) {
        log(`[sync] skipping malformed remote session ${id}`);
        continue;
      }
      batch.push(record);
      if (batch.length >= PULL_BATCH) await flushPulls();
    }
    await flushPulls();

    phase = 'delete-sessions';
    if (sessionPlan.deleteLocal.length > 0) {
      await local.deleteSessions(sessionPlan.deleteLocal);
      stats.deletedSessions = sessionPlan.deleteLocal.length;
    }

    phase = 'pull-settings';
    for (const [settingKey, value] of Object.entries(settingsPlan.pull)) {
      if (await local.writeSetting(settingKey, value)) stats.pulledSettings++;
    }

    phase = 'pull-credentials';
    if (Object.keys(credPlan.pull).length > 0) {
      const current = await local.readCredentials();
      await local.writeCredentials({ ...current, ...credPlan.pull });
      stats.pulledCredentials = Object.keys(credPlan.pull).length;
    }

    // ─ 5. 上传本地改动 ─
    phase = 'push-sessions';
    const pushedSessionMeta: Record<string, { updatedAt: number }> = {};
    for (const id of sessionPlan.push) {
      try {
        const record = await local.readSessionRecord(id);
        if (!record) continue;
        await store.writeSession(id, await encryptJson(key, record));
        pushedSessionMeta[id] = { updatedAt: record.updatedAt };
        stats.pushedSessions++;
      } catch (err) {
        // 同拉取：基础设施问题整体失败，单条数据问题跳过
        if (isInfrastructureError(err)) throw err;
        log(`[sync] failed to push session ${id}, skipped`, err);
      }
    }

    phase = 'push-settings';
    if (Object.keys(settingsPlan.push).length > 0) {
      // 写前重读远端，把「另一台设备刚写过」的窗口压到最小
      const fresh = await store.readFile(SYNC_FILES.settings);
      const current: SyncBlob<unknown> = fresh
        ? await decryptJson<SyncBlob<unknown>>(key, fresh)
        : remoteSettings;
      const merged = mergeEntries(current.entries, settingsPlan.push);
      await store.writeFile(SYNC_FILES.settings, await encryptJson(key, { entries: merged }));
      stats.pushedSettings = Object.keys(settingsPlan.push).length;
    }

    phase = 'push-credentials';
    if (Object.keys(credPlan.push).length > 0) {
      const fresh = await store.readFile(SYNC_FILES.credentials);
      const current: SyncBlob<ProviderCredential> = fresh
        ? await decryptJson<SyncBlob<ProviderCredential>>(key, fresh)
        : remoteCreds;
      const merged = mergeEntries(current.entries, credPlan.push);
      await store.writeFile(SYNC_FILES.credentials, await encryptJson(key, { entries: merged }));
      stats.pushedCredentials = Object.keys(credPlan.push).length;
    }

    // ─ 6. 写索引（最后一步） ─
    phase = 'write-index';
    const freshIndexBytes = await store.readFile(SYNC_FILES.index);
    const freshIndex: SyncIndex = freshIndexBytes
      ? normalizeIndex(await decryptJson<Partial<SyncIndex>>(key, freshIndexBytes))
      : remoteIndex;
    const mergedIndex = mergeIndexPatch(
      {
        devices: freshIndex.devices,
        sessions: freshIndex.sessions,
        tombstones: freshIndex.tombstones,
      },
      {
        devices: { [deviceId]: { name: config.deviceName || 'Cebian', lastSyncAt: startedAt } },
        sessions: pushedSessionMeta,
        tombstones: sessionPlan.tombstone,
      },
    );

    // 墓碑对应的会话元数据与过期墓碑一并清掉
    for (const id of Object.keys(sessionPlan.tombstone)) delete mergedIndex.sessions[id];
    for (const id of sessionPlan.pruneTombstones) delete mergedIndex.tombstones[id];

    const nextIndex: SyncIndex = {
      version: SYNC_SCHEMA_VERSION,
      updatedAt: startedAt,
      ...mergedIndex,
    };
    await store.writeFile(SYNC_FILES.index, await encryptJson(key, nextIndex));

    // 索引已落盘，再删远端文件（先删会让别的设备读到悬空条目）
    for (const id of Object.keys(sessionPlan.tombstone)) {
      try {
        await store.removeSession(id);
      } catch (err) {
        log(`[sync] failed to remove tombstoned session file ${id}`, err);
      }
    }

    // ─ 7. 更新基线 ─
    phase = 'update-state';
    // 设置 / 密钥的基线必须反映「同步后的本地值」：拉取后本地变了，推送后远端变了。
    const finalSettings = await local.readSettings();
    const finalSettingsHashes = await hashAll(finalSettings);
    const settingsBaseline: Record<string, BaselineEntry> = {};
    for (const [settingKey, hash] of Object.entries(finalSettingsHashes)) {
      const pushed = settingsPlan.push[settingKey];
      const remoteEntry = remoteSettings.entries[settingKey];
      const updatedAt = pushed?.updatedAt ?? remoteEntry?.updatedAt ?? startedAt;
      settingsBaseline[settingKey] = { hash, updatedAt };
    }

    const finalCreds = await local.readCredentials();
    const finalCredHashes = await hashAll(finalCreds);
    const credBaseline: Record<string, BaselineEntry> = {};
    for (const [providerId, hash] of Object.entries(finalCredHashes)) {
      const pushed = credPlan.push[providerId];
      const remoteEntry = remoteCreds.entries[providerId];
      const updatedAt = pushed?.updatedAt ?? remoteEntry?.updatedAt ?? startedAt;
      credBaseline[providerId] = { hash, updatedAt };
    }

    // 会话基线只记录「本机确实有」的 id。索引里有、但这次没拉下来（远端文件缺失 /
    // 解密失败被跳过）的条目若也记进基线，下次同步会因「本地没有 + 基线有」误判成
    // 「本机删除了它」，从而给它打墓碑——那会删掉别的设备上真实的会话。不记基线，
    // 下次会重新尝试拉取。
    const finalLocalSessions = await local.listSessionMeta();
    const localSessionIds = new Set(finalLocalSessions.map((s) => s.id));
    const sessionsBaseline: Record<string, number> = {};
    for (const [id, meta] of Object.entries(nextIndex.sessions)) {
      if (localSessionIds.has(id)) sessionsBaseline[id] = meta.updatedAt;
    }

    await saveState({
      deviceId,
      lastSyncAt: startedAt,
      lastAttemptAt: startedAt,
      lastError: null,
      lastErrorDetail: null,
      sessions: sessionsBaseline,
      settings: settingsBaseline,
      credentials: credBaseline,
      lastStats: stats,
    });

    log(`[sync] ${reason} sync done`, stats);
    return { ok: true, stats, lastSyncAt: startedAt };
  } catch (err) {
    const code = toErrorCode(err);
    const detail = `${phase}: ${errorDetail(err)}`;
    log(`[sync] ${reason} sync failed (${code})`, err);
    // 失败也记 lastAttemptAt，但保留上次成功的基线与 lastSyncAt——基线丢了会导致
    // 下次退化成盲目覆盖。
    await saveState({
      ...prevState,
      deviceId,
      lastAttemptAt: startedAt,
      lastError: code,
      lastErrorDetail: detail,
    });
    return { ok: false, code, detail };
  }
}
