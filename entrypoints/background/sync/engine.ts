// 多设备同步引擎（只在 background service worker 里运行）。
//
// 为什么在 background：Dexie 的唯一写者是 background（见 chat/session-store.ts），
// 而同步既要读又要写会话。放在这里可以直接调用 sessionStore / sessionManager，
// 不必再为「同步写库」设计一套 IPC 协议。
//
// 一次同步的流程：
//   1. 读配置与基线状态，派生加密密钥（一次同步只派生一次）
//   2. 读远端索引 + 设置 / 密钥 blob
//   3. 用基线做三方合并，得到「推 / 拉 / 删」三份计划（纯逻辑在 lib/sync/merge）
//   4. 先应用拉取与删除（本地数据就位）
//   5. 再上传本地改动，最后写索引
//   6. 更新基线
//
// 顺序上的两个关键点：
// - **索引最后写**：索引一旦指向某个会话文件，文件必须已经在远端；反过来的短暂不一致
//   只会让别的设备多试一次。
// - **墓碑先入索引、再删远端文件**：先删文件再写索引，会让恰好在两者之间同步的设备
//   读到「索引说有、文件却没有」的悬空条目。

import {
  getSession,
  getSessionMutations,
  isValidSessionLike,
  listSessions,
  type SessionBackupRecord,
} from '@/lib/persistence/db';
import { projectMutationLog } from '@/lib/persistence/migrate-messages';
import {
  providerCredentials,
  syncConfig,
  syncState,
  type ProviderCredential,
  type ProviderCredentials,
} from '@/lib/persistence/storage';
import { BACKUP_REGISTRY } from '@/lib/backup/registry';
import { createKeyMeta, decryptJson, deriveSyncKey, encryptJson } from '@/lib/sync/crypto';
import {
  hashValue,
  isEmptyCredential,
  mergeEntries,
  mergeIndexPatch,
  planEntrySync,
  planSessionSync,
} from '@/lib/sync/merge';
import { SyncRemote, SyncRemoteError, SYNC_FILES } from '@/lib/sync/remote';
import {
  SYNC_SCHEMA_VERSION,
  TOMBSTONE_TTL_MS,
  emptySyncIndex,
  emptySyncStats,
  type BaselineEntry,
  type SyncBlob,
  type SyncErrorCode,
  type SyncIndex,
  type SyncState,
  type SyncStats,
} from '@/lib/sync/types';
import { sessionManager } from '../chat/session-manager';
import { sessionStore } from '../chat/session-store';
import { acquireKeepAlive, releaseKeepAlive } from '../lifecycle/keepalive';

/** 触发来源。仅用于日志与「打开面板触发」的节流判断。 */
export type SyncReason = 'manual' | 'alarm' | 'startup' | 'panel';

/** 一次同步的结果。失败不抛异常——调用方（消息处理器 / alarm）需要的是可序列化的结果。 */
export interface SyncRunResult {
  ok: boolean;
  code?: SyncErrorCode;
  stats?: SyncStats;
  lastSyncAt?: number;
}

/** 正在进行的同步。并发调用（alarm 与手动同时到达）直接返回 busy，不排队。 */
let inFlight: Promise<SyncRunResult> | null = null;

/** 当前是否有同步在跑。 */
export function isSyncing(): boolean {
  return inFlight !== null;
}

/**
 * 执行一次同步。并发调用返回 `busy`。
 *
 * `reason === 'panel'` 时，若距上次同步不足 `minIntervalMs` 则跳过——侧边栏每次打开
 * 都触发，不加节流会在频繁开关面板时反复发请求。
 */
export async function runSync(reason: SyncReason, minIntervalMs = 0): Promise<SyncRunResult> {
  if (inFlight) return { ok: false, code: 'busy' };
  if (minIntervalMs > 0) {
    const state = await syncState.getValue();
    if (state.lastSyncAt !== null && Date.now() - state.lastSyncAt < minIntervalMs) {
      return { ok: true, lastSyncAt: state.lastSyncAt };
    }
  }
  inFlight = execute(reason).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** 把未知异常翻译成同步错误码。 */
function toErrorCode(err: unknown): SyncErrorCode {
  if (err instanceof SyncRemoteError) {
    switch (err.code) {
      case 'network':
      case 'timeout':
        return 'network';
      case 'unauthorized':
        return 'unauthorized';
      case 'invalid':
      case 'notFound':
      case 'conflict':
      case 'server':
        return 'server';
    }
  }
  if (err instanceof Error && err.name === 'OperationError') {
    // AES-GCM 认证失败：口令错误，或密文被篡改
    return 'wrongPassword';
  }
  return 'unknown';
}

/** 读一个会话的同步形态：行 + mutation 日志投影（与备份采集同一口径）。 */
async function readSessionRecord(id: string): Promise<SessionBackupRecord | null> {
  const row = await getSession(id);
  if (!row) return null;
  // 迁移失败行没有日志，影子字段就是它的真相
  if (row.treeMigrationFailed) return row;
  const raw = (await getSessionMutations(id)).map((r) => r.mutation);
  const { messages, validPrefix } = projectMutationLog(raw);
  return {
    ...row,
    messages,
    ...(validPrefix.length > 0 ? { mutations: validPrefix } : {}),
  };
}

/** 采集全部普通设置项（与备份同一分类口径：settings-class，含混合 item 的完整值）。 */
async function collectLocalSettings(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const entry of BACKUP_REGISTRY) {
    if (entry.storageClass !== 'settings') continue;
    out[entry.item.key] = await entry.item.getValue();
  }
  return out;
}

/** 把某个设置项写回本机。未知 key（仓库里有、当前版本已删除的项）直接忽略。 */
async function writeLocalSetting(key: string, value: unknown): Promise<boolean> {
  const entry = BACKUP_REGISTRY.find((e) => e.item.key === key && e.storageClass === 'settings');
  if (!entry) return false;
  await entry.item.setValue(value);
  return true;
}

/** 计算一组值的哈希。 */
async function hashAll(values: Record<string, unknown>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    out[key] = await hashValue(value);
  }
  return out;
}

/** 真正的同步主体。 */
async function execute(reason: SyncReason): Promise<SyncRunResult> {
  const config = await syncConfig.getValue();
  if (!config) return { ok: false, code: 'notConfigured' };
  if (!config.enabled) return { ok: false, code: 'disabled' };
  if (!config.url.trim() || !config.syncPassword) return { ok: false, code: 'notConfigured' };

  const startedAt = Date.now();
  const prevState = await syncState.getValue();
  const deviceId = prevState.deviceId || crypto.randomUUID();
  const stats = emptySyncStats();

  acquireKeepAlive();
  try {
    const remote = new SyncRemote(config);
    await remote.ensureDirectories();

    // ─ 1. 密钥 ─
    let meta = await remote.readMeta();
    if (!meta) {
      meta = createKeyMeta();
      await remote.writeMeta(meta);
    }
    if (meta.v > SYNC_SCHEMA_VERSION) return { ok: false, code: 'incompatible' };
    const key = await deriveSyncKey(config.syncPassword, meta);

    // ─ 2. 读远端 ─
    const indexBytes = await remote.readFile(SYNC_FILES.index);
    const remoteIndex: SyncIndex = indexBytes
      ? await decryptJson<SyncIndex>(key, indexBytes)
      : emptySyncIndex(startedAt);
    if (remoteIndex.version > SYNC_SCHEMA_VERSION) return { ok: false, code: 'incompatible' };

    const settingsBytes = await remote.readFile(SYNC_FILES.settings);
    const remoteSettings: SyncBlob<unknown> = settingsBytes
      ? await decryptJson<SyncBlob<unknown>>(key, settingsBytes)
      : { entries: {} };

    const credsBytes = await remote.readFile(SYNC_FILES.credentials);
    const remoteCreds: SyncBlob<ProviderCredential> = credsBytes
      ? await decryptJson<SyncBlob<ProviderCredential>>(key, credsBytes)
      : { entries: {} };

    // ─ 3. 采集本地 + 规划 ─
    // 先把在途的树写落定，否则读到的会话可能是几毫秒前的旧状态。
    await sessionManager.flushAll();
    const localSessions = await listSessions();
    const localSettings = await collectLocalSettings();
    const localCreds = await providerCredentials.getValue();

    const sessionPlan = planSessionSync({
      local: localSessions.map((s) => ({ id: s.id, updatedAt: s.updatedAt })),
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
    // 分批：首次同步可能一次拉上百个会话，全攒在内存里再写库会占掉几十 MB（会话里
    // 常有 base64 图片）。每批 20 个直接落库，内存峰值与总数无关。
    const PULL_BATCH = 20;
    let batch: SessionBackupRecord[] = [];
    const flushPulls = async (): Promise<void> => {
      if (batch.length === 0) return;
      // merge 语义：只写比本地更新的，等于再兜一次 LWW 保护
      await sessionStore.applyAll(batch, 'merge');
      stats.pulledSessions += batch.length;
      batch = [];
    };

    for (const id of sessionPlan.pull) {
      const bytes = await remote.readSession(id);
      // 索引悬空（索引说有、文件却没有）：跳过，下次索引会修正
      if (!bytes) continue;
      const record = await decryptJson<SessionBackupRecord>(key, bytes);
      if (!isValidSessionLike(record) || record.id !== id) {
        console.warn(`[sync] skipping malformed remote session ${id}`);
        continue;
      }
      batch.push(record);
      if (batch.length >= PULL_BATCH) await flushPulls();
    }
    await flushPulls();

    if (sessionPlan.deleteLocal.length > 0) {
      for (const id of sessionPlan.deleteLocal) sessionManager.destroySession(id);
      stats.deletedSessions = await sessionStore.deleteMany(sessionPlan.deleteLocal);
    }

    for (const [settingKey, value] of Object.entries(settingsPlan.pull)) {
      if (await writeLocalSetting(settingKey, value)) stats.pulledSettings++;
    }

    if (Object.keys(credPlan.pull).length > 0) {
      const current = await providerCredentials.getValue();
      const next: ProviderCredentials = { ...current, ...credPlan.pull };
      await providerCredentials.setValue(next);
      stats.pulledCredentials = Object.keys(credPlan.pull).length;
    }

    // ─ 5. 上传本地改动 ─
    const pushedSessionMeta: Record<string, { updatedAt: number }> = {};
    for (const id of sessionPlan.push) {
      const record = await readSessionRecord(id);
      if (!record) continue;
      await remote.writeSession(id, await encryptJson(key, record));
      pushedSessionMeta[id] = { updatedAt: record.updatedAt };
      stats.pushedSessions++;
    }

    if (Object.keys(settingsPlan.push).length > 0) {
      // 写前重读远端，把「另一台设备刚写过」的窗口压到最小
      const fresh = await remote.readFile(SYNC_FILES.settings);
      const current: SyncBlob<unknown> = fresh
        ? await decryptJson<SyncBlob<unknown>>(key, fresh)
        : remoteSettings;
      const merged = mergeEntries(current.entries, settingsPlan.push);
      await remote.writeFile(SYNC_FILES.settings, await encryptJson(key, { entries: merged }));
      stats.pushedSettings = Object.keys(settingsPlan.push).length;
    }

    if (Object.keys(credPlan.push).length > 0) {
      const fresh = await remote.readFile(SYNC_FILES.credentials);
      const current: SyncBlob<ProviderCredential> = fresh
        ? await decryptJson<SyncBlob<ProviderCredential>>(key, fresh)
        : remoteCreds;
      const merged = mergeEntries(current.entries, credPlan.push);
      await remote.writeFile(SYNC_FILES.credentials, await encryptJson(key, { entries: merged }));
      stats.pushedCredentials = Object.keys(credPlan.push).length;
    }

    // ─ 6. 写索引（最后一步） ─
    const freshIndexBytes = await remote.readFile(SYNC_FILES.index);
    const freshIndex: SyncIndex = freshIndexBytes
      ? await decryptJson<SyncIndex>(key, freshIndexBytes)
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
    await remote.writeFile(SYNC_FILES.index, await encryptJson(key, nextIndex));

    // 索引已落盘，再删远端文件（先删会让别的设备读到悬空条目）
    for (const id of Object.keys(sessionPlan.tombstone)) {
      await remote.removeSession(id).catch((err) => {
        console.warn(`[sync] failed to remove tombstoned session file ${id}`, err);
      });
    }

    // ─ 7. 更新基线 ─
    // 设置 / 密钥的基线必须反映「同步后的本地值」：拉取后本地变了，推送后远端变了。
    const finalSettings = await collectLocalSettings();
    const finalSettingsHashes = await hashAll(finalSettings);
    const settingsBaseline: Record<string, BaselineEntry> = {};
    for (const [settingKey, hash] of Object.entries(finalSettingsHashes)) {
      const pushed = settingsPlan.push[settingKey];
      const remoteEntry = remoteSettings.entries[settingKey];
      const updatedAt = pushed?.updatedAt ?? remoteEntry?.updatedAt ?? startedAt;
      settingsBaseline[settingKey] = { hash, updatedAt };
    }

    const finalCreds = await providerCredentials.getValue();
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
    const finalLocalSessions = await listSessions();
    const localSessionIds = new Set(finalLocalSessions.map((s) => s.id));
    const sessionsBaseline: Record<string, number> = {};
    for (const [id, meta] of Object.entries(nextIndex.sessions)) {
      if (localSessionIds.has(id)) sessionsBaseline[id] = meta.updatedAt;
    }

    const nextState: SyncState = {
      deviceId,
      lastSyncAt: startedAt,
      lastAttemptAt: startedAt,
      lastError: null,
      sessions: sessionsBaseline,
      settings: settingsBaseline,
      credentials: credBaseline,
      lastStats: stats,
    };
    await syncState.setValue(nextState);

    console.log(`[sync] ${reason} sync done`, stats);
    return { ok: true, stats, lastSyncAt: startedAt };
  } catch (err) {
    const code = toErrorCode(err);
    console.warn(`[sync] ${reason} sync failed (${code})`, err);
    // 失败也记 lastAttemptAt，但保留上次成功的基线与 lastSyncAt——基线丢了会导致
    // 下次退化成盲目覆盖。
    const current = await syncState.getValue();
    await syncState.setValue({
      ...current,
      deviceId,
      lastAttemptAt: startedAt,
      lastError: code,
    });
    return { ok: false, code };
  } finally {
    releaseKeepAlive();
  }
}
