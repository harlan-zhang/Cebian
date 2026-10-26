// 多设备同步在 background 里的入口（WebDAV 介质）。
//
// 真正的合并逻辑在 lib/sync/engine-core.ts，这里只做三件与上下文相关的事：
// 1. 读配置 / 状态；
// 2. 构造 WebDAV 传输与「直接操作 Dexie」的本机适配器（background 是唯一写者）；
// 3. keepalive + 并发闸。
//
// 文件夹介质不走这里——File System Access API 在 service worker 里不存在，
// 那条路在扩展页面里跑（lib/sync/client.ts）。

import { listSessions } from '@/lib/persistence/db';
import { readSessionRecordForBackup } from '@/lib/backup/sources/sessions';
import { syncConfig, syncState } from '@/lib/persistence/storage';
import { errorDetail, runSyncCore, type SyncLocalAdapter } from '@/lib/sync/engine-core';
import { createStorageAdapter } from '@/lib/sync/local-storage-adapter';
import { SyncRemote } from '@/lib/sync/remote';
import type { SyncReason, SyncRunResult } from '@/lib/sync/types';
import { sessionManager } from '../chat/session-manager';
import { sessionStore } from '../chat/session-store';
import { acquireKeepAlive, releaseKeepAlive } from '../lifecycle/keepalive';

export type { SyncReason, SyncRunResult } from '@/lib/sync/types';

/** 正在进行的同步。并发调用（alarm 与手动同时到达）直接返回 busy，不排队。 */
let inFlight: Promise<SyncRunResult> | null = null;

/** 当前是否有同步在跑。 */
export function isSyncing(): boolean {
  return inFlight !== null;
}

/**
 * background 的本机适配器：直接读写 Dexie。
 *
 * 这里是唯一能直接写会话的地方（`sessionStore` 是 Dexie 的唯一写者），所以不需要
 * 像页面那样走备份 IPC。
 */
function createBackgroundAdapter(): SyncLocalAdapter {
  return {
    async listSessionMeta() {
      // 先把在途的树写落定，否则读到的会话可能是几毫秒前的旧状态
      await sessionManager.flushAll();
      const rows = await listSessions();
      return rows.map((s) => ({ id: s.id, updatedAt: s.updatedAt }));
    },
    readSessionRecord: readSessionRecordForBackup,
    async applySessionRecords(records) {
      // merge 语义与备份恢复一致：只写比本地更新的
      await sessionStore.applyAll(records, 'merge');
    },
    async deleteSessions(ids) {
      // 先摘掉活会话，否则它的下一次树写会把刚删的行重建出来
      for (const id of ids) sessionManager.destroySession(id);
      await sessionStore.deleteMany(ids);
    },
    ...createStorageAdapter(),
  };
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
  inFlight = execute(reason)
    // 兜底：runSync 永不 reject。一旦 reject，消息监听器不会回包，
    // UI 只能显示一句无从下手的「同步失败」。
    .catch((err: unknown) => ({ ok: false, code: 'unknown' as const, detail: errorDetail(err) }))
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

async function execute(reason: SyncReason): Promise<SyncRunResult> {
  const config = await syncConfig.getValue();
  if (!config) return { ok: false, code: 'notConfigured' };
  if (!config.enabled) return { ok: false, code: 'disabled' };
  // 文件夹介质只能在扩展页面里跑。后台被 alarm 唤醒时直接放过——
  // 真正的同步由页面在打开时触发。
  if (config.transport === 'folder') {
    console.log('[sync] folder transport is page-only, skipping background run');
    return { ok: true };
  }
  if (!config.url.trim() || !config.syncPassword) return { ok: false, code: 'notConfigured' };

  const state = await syncState.getValue();
  acquireKeepAlive();
  try {
    const store = new SyncRemote(config);
    return await runSyncCore({
      config,
      state,
      store,
      local: createBackgroundAdapter(),
      saveState: (next) => syncState.setValue(next),
      reason,
    });
  } finally {
    releaseKeepAlive();
  }
}
