// 页面侧的同步入口。
//
// 为什么要分两条路：
// - **WebDAV** 交给 background 跑：它能用 chrome.alarms 定时同步，而且 Dexie 的
//   唯一写者就在那儿，读写都直接。
// - **本地文件夹** 只能在页面跑：File System Access API 不存在于 service worker。
//   会话的读写在页面侧走已有的备份 IPC（`flushSessions` / `restoreSessions` /
//   `deleteSessions`），最终仍由 background 落库，写入语义与备份恢复完全一致。
//
// 调用方（侧边栏按钮、设置面板、打开面板时的自动触发）统一走 `triggerSync`，
// 不需要关心当前是哪种介质。

import { listSessions } from '@/lib/persistence/db';
import {
  deleteSessions,
  flushSessions,
  readSessionRecordForBackup,
  restoreSessions,
} from '@/lib/backup/sources/sessions';
import { syncConfig, syncState } from '@/lib/persistence/storage';
import { errorDetail, runSyncCore, type SyncLocalAdapter } from './engine-core';
import { FolderStore, loadFolderHandle } from './folder-store';
import { createStorageAdapter } from './local-storage-adapter';
import { SYNC_NOW, type SyncNowResponse } from './protocol';
import type { SyncReason, SyncRunResult } from './types';

/** 页面侧的同步串行闸：手动点击与打开面板同时到达时只跑一次。 */
let inFlight: Promise<SyncRunResult> | null = null;

/** 页面上下文的本机适配器：会话走备份 IPC，设置 / 密钥直接读写 storage。 */
export function createPageAdapter(): SyncLocalAdapter {
  return {
    async listSessionMeta() {
      // 先让 background 的在途树写落定，否则可能读到几毫秒前的旧状态
      await flushSessions();
      const rows = await listSessions();
      return rows.map((s) => ({ id: s.id, updatedAt: s.updatedAt }));
    },
    readSessionRecord: readSessionRecordForBackup,
    async applySessionRecords(records) {
      // merge 语义与备份恢复一致：只写比本地更新的
      await restoreSessions(records, 'merge');
    },
    async deleteSessions(ids) {
      await deleteSessions(ids);
    },
    ...createStorageAdapter(),
  };
}

/**
 * 触发一次同步。会根据配置里的介质自动选择执行位置。
 *
 * `minIntervalMs > 0` 时（打开侧边栏触发）距上次成功同步不足该间隔就跳过。
 */
export async function triggerSync(reason: SyncReason, minIntervalMs = 0): Promise<SyncRunResult> {
  const config = await syncConfig.getValue();
  if (!config) return { ok: false, code: 'notConfigured' };
  if (!config.enabled) return { ok: false, code: 'disabled' };

  // ─ WebDAV：交给 background ─
  if (config.transport !== 'folder') {
    const resp = (await chrome.runtime.sendMessage({
      type: SYNC_NOW,
      reason: reason === 'panel' ? 'panel' : 'manual',
    })) as SyncNowResponse | undefined;
    if (!resp) return { ok: false, code: 'noResponse' };
    return {
      ok: resp.ok,
      ...(resp.code ? { code: resp.code } : {}),
      ...(resp.detail ? { detail: resp.detail } : {}),
      ...(resp.lastSyncAt !== undefined ? { lastSyncAt: resp.lastSyncAt } : {}),
    };
  }

  // ─ 本地文件夹：在页面里跑 ─
  if (inFlight) return { ok: false, code: 'busy' };

  const state = await syncState.getValue();
  if (minIntervalMs > 0 && state.lastSyncAt !== null && Date.now() - state.lastSyncAt < minIntervalMs) {
    return { ok: true, lastSyncAt: state.lastSyncAt };
  }

  inFlight = (async (): Promise<SyncRunResult> => {
    const handle = await loadFolderHandle();
    if (!handle) return { ok: false, code: 'noFolder' };
    const store = new FolderStore(handle);
    return runSyncCore({
      config,
      state,
      store,
      local: createPageAdapter(),
      saveState: (next) => syncState.setValue(next),
      reason,
      log: (message, err) => console.warn(message, err),
    });
  })()
    .catch((err: unknown) => ({ ok: false, code: 'unknown' as const, detail: errorDetail(err) }))
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}
