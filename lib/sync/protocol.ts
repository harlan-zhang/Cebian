// 同步的 IPC 契约。
//
// 放在 lib/ 下（而不是 background 目录），因为设置页与侧边栏都要发这条消息，
// 而 components 不允许 import entrypoints。

import type { SyncErrorCode } from './types';

/** 请求立即同步。 */
export const SYNC_NOW = 'sync:now';

/** 同步请求。`reason` 影响节流：`panel` 是打开侧边栏触发的，会做最小间隔限制。 */
export interface SyncNowRequest {
  type: typeof SYNC_NOW;
  reason?: 'manual' | 'panel';
}

/** 同步响应。与 background 的 SyncRunResult 同形。 */
export interface SyncNowResponse {
  ok: boolean;
  code?: SyncErrorCode;
  /** 失败时的原始错误摘要（排障用，不含凭据）。 */
  detail?: string;
  lastSyncAt?: number;
}

/** 类型守卫：判断一条 runtime 消息是否是同步请求。 */
export function isSyncNowRequest(msg: unknown): msg is SyncNowRequest {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as { type?: unknown }).type === SYNC_NOW
  );
}
