// 多设备同步的后台接线：定时调度 + IPC 触发。
//
// 触发时机：
// - **周期 alarm**：按配置的间隔（默认 15 分钟）跑一次。MV3 的 SW 会休眠，alarm 是
//   唯一可靠的「定期唤醒」手段。
// - **浏览器启动**：`runtime.onStartup` 补一次（alarm 不跨浏览器重启持久化）。
// - **打开侧边栏**：面板侧发 `sync:now` 且 reason=panel，带最小间隔节流——频繁开关
//   面板不该反复发请求。
// - **手动按钮**：reason=manual，不节流。
//
// 所有触发都汇到 engine 的同一个 runSync；engine 内部有并发闸，不会同时跑两次。

import { isExtensionPageSender } from '@/lib/ipc/sender';
import { syncConfig } from '@/lib/persistence/storage';
import { isSyncNowRequest, type SyncNowResponse } from '@/lib/sync/protocol';
import { DEFAULT_SYNC_INTERVAL_MINUTES, OPEN_TRIGGER_MIN_INTERVAL_MS, SYNC_INTERVAL_OPTIONS } from '@/lib/sync/types';
import { runSync } from './engine';

/** alarm 名称。改名会让老版本残留的 alarm 继续触发（它们按名字过滤，故无副作用）。 */
const SYNC_ALARM = 'cebian-sync';

/** 把配置里的间隔收成允许的档位；非法值回退默认。 */
function clampInterval(minutes: number): number {
  return (SYNC_INTERVAL_OPTIONS as readonly number[]).includes(minutes)
    ? minutes
    : DEFAULT_SYNC_INTERVAL_MINUTES;
}

/** 按当前配置重建周期 alarm。关闭同步时清掉已有 alarm。 */
async function scheduleAlarm(): Promise<void> {
  const config = await syncConfig.getValue();
  await chrome.alarms.clear(SYNC_ALARM);
  if (!config?.enabled) return;
  // 文件夹介质只能在扩展页面里跑（service worker 没有 File System Access），
  // 没有后台定时这回事；页面会在打开时自行触发。
  if (config.transport === 'folder') return;
  const minutes = clampInterval(config.intervalMinutes);
  chrome.alarms.create(SYNC_ALARM, {
    delayInMinutes: minutes,
    periodInMinutes: minutes,
  });
}

/** 注册同步的 alarm 与消息处理器。在 background 入口调用一次。 */
export function setupSync(): void {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!isSyncNowRequest(msg)) return false;
    // 只接受扩展自身页面（侧边栏 / 设置页）的请求：同步会写会话与密钥，
    // 不能让内容脚本触发。
    if (!isExtensionPageSender(sender)) {
      sendResponse({ ok: false, code: 'unknown' } satisfies SyncNowResponse);
      return true;
    }
    const reason = msg.reason === 'panel' ? 'panel' : 'manual';
    void runSync(reason, reason === 'panel' ? OPEN_TRIGGER_MIN_INTERVAL_MS : 0).then(
      (result) => {
        sendResponse({
          ok: result.ok,
          ...(result.code ? { code: result.code } : {}),
          ...(result.detail ? { detail: result.detail } : {}),
          ...(result.lastSyncAt !== undefined ? { lastSyncAt: result.lastSyncAt } : {}),
        } satisfies SyncNowResponse);
      },
      // 兜底：任何逃逸的异常也要回包，否则页面侧拿到 undefined，只能报「同步失败」
      (err: unknown) => {
        sendResponse({
          ok: false,
          code: 'unknown',
          detail: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        } satisfies SyncNowResponse);
      },
    );
    return true;
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== SYNC_ALARM) return;
    void runSync('alarm');
  });

  chrome.runtime.onStartup.addListener(() => {
    void runSync('startup');
  });

  // 配置变化（开关 / 间隔）时重排 alarm。
  syncConfig.watch(() => {
    void scheduleAlarm();
  });

  // SW 每次启动都按当前配置校准一次（alarm 不跨浏览器重启持久化）。
  void scheduleAlarm();
}
