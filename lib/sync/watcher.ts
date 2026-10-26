// 本地文件夹介质的「准实时」同步。
//
// 能做到什么：侧边栏开着的时候，本机改动约 2 秒后推到文件夹；别的配置文件写入后
// 约 3–6 秒内拉过来。
//
// 为什么是轮询而不是监听：File System Access **没有 watch API**（没有 inotify /
// FSEvents 那种能力），只能定时看文件的修改时间。代价很小——每 3 秒读一次
// `index.enc` 的文件元数据，不解密、不读内容。
//
// 为什么只能在这个页面里跑：文件 API 不在 service worker 里。所以面板关掉就停止，
// 这是这个方案的天花板，不是实现偷懒。
//
// 防止自我循环：同步核心**只在真有变化时**才重写索引（见 engine-core 的 indexDirty），
// 否则「A 写索引 → B 看到 mtime 变了 → B 同步又写索引 → A 又看到」会无限互相触发。
// 即便如此，每次同步后仍要刷新一次基线 mtime，因为自己写索引同样会改 mtime。

import { getMaxSessionUpdatedAt } from '@/lib/persistence/db';
import { syncConfig, syncState } from '@/lib/persistence/storage';
import { triggerSync } from './client';
import { FolderStore, loadFolderHandle } from './folder-store';

/** 轮询间隔。3 秒是「够快」与「几乎不耗电」的折中。 */
const POLL_INTERVAL_MS = 3000;
/** 本地改动的静默期：等流式输出停下来再推，避免每条消息都同步一次。 */
const PUSH_DEBOUNCE_MS = 1500;
/** 同步失败后的冷却，避免权限失效时每 3 秒重试一次。 */
const FAILURE_COOLDOWN_MS = 30_000;

/** 当前正在运行的监听器（一个页面只应有一个）。 */
let stopCurrent: (() => void) | null = null;
/**
 * 启动序号。`startSyncWatcher` 是异步的（要读配置、读句柄），期间页面可能已经
 * 卸载并调用了 `stopSyncWatcher`。每次启动/停止都自增，异步段结束时发现序号变了
 * 就直接放弃，避免卸载后还留下一个定时器。
 */
let generation = 0;

/** 停掉当前监听器（切换配置、页面卸载时调用）。 */
export function stopSyncWatcher(): void {
  generation++;
  stopCurrent?.();
  stopCurrent = null;
}

/**
 * 启动监听器。返回停止函数；不适用（未启用 / 非文件夹介质 / 没选文件夹）时
 * 返回一个只解除配置订阅的函数。
 *
 * 配置变化会自动重启监听器，调用方不必自己盯。
 */
export async function startSyncWatcher(): Promise<() => void> {
  stopSyncWatcher();
  const myGen = ++generation;

  // 先挂配置监听：即使当前配置不适用，之后切回文件夹也能自动启动。
  const unwatch = syncConfig.watch(() => {
    void startSyncWatcher();
  });
  const inertStop = () => unwatch();

  const config = await syncConfig.getValue();
  if (myGen !== generation) return inertStop;
  if (!config?.enabled || config.transport !== 'folder') return inertStop;

  const handle = await loadFolderHandle();
  if (myGen !== generation) return inertStop;
  if (!handle) return inertStop;

  const store = new FolderStore(handle);
  let stopped = false;
  let polling = false;
  let timer: number | null = null;
  /** 上次看到的索引 mtime。null = 索引还不存在。 */
  let lastMtime: number | null = null;
  /** 上次看到的本地最大 updatedAt。 */
  let lastLocalMax = 0;
  /** 本地有未推送的改动。 */
  let localDirty = false;
  /** 最近一次观察到本地改动的时间（用于静默期）。 */
  let lastLocalChangeAt = 0;
  /** 失败冷却截止时间。 */
  let cooldownUntil = 0;

  // 基线：先把当前状态记下来，避免刚启动就无谓同步一次。
  try {
    lastMtime = await store.indexMtime();
    lastLocalMax = await getMaxSessionUpdatedAt();
  } catch (err) {
    console.warn('[sync] watcher baseline failed', err);
  }
  if (myGen !== generation) return inertStop;

  // 面板关着的时候可能聊过天：本地最大 updatedAt 晚于上次同步时间，说明有改动没推。
  const state = await syncState.getValue();
  if (lastLocalMax > (state.lastSyncAt ?? 0)) {
    localDirty = true;
    // 立刻可以推
    lastLocalChangeAt = 0;
  }

  const tick = async (): Promise<void> => {
    if (stopped || polling) return;
    if (Date.now() < cooldownUntil) return;
    polling = true;
    try {
      const mtime = await store.indexMtime();
      const localMax = await getMaxSessionUpdatedAt();

      if (localMax > lastLocalMax) {
        lastLocalMax = localMax;
        localDirty = true;
        lastLocalChangeAt = Date.now();
      }

      // 远端变化：别的配置文件写过索引
      const remoteChanged = mtime !== null && lastMtime !== null && mtime !== lastMtime;
      // 本地变化：已经静默了足够久，可以推
      const localReady = localDirty && Date.now() - lastLocalChangeAt >= PUSH_DEBOUNCE_MS;

      if (remoteChanged || localReady) {
        const result = await triggerSync('auto');
        // 无论成功与否都刷新基线：自己写索引也会改 mtime，不刷新会立刻再触发一次
        lastMtime = await store.indexMtime().catch(() => lastMtime);
        lastLocalMax = await getMaxSessionUpdatedAt().catch(() => lastLocalMax);
        if (result.ok) {
          localDirty = false;
        } else if (result.code !== 'busy') {
          // 失败后冷却一段时间，避免权限失效时每 3 秒重试
          cooldownUntil = Date.now() + FAILURE_COOLDOWN_MS;
        }
      } else {
        // 没有变化时也同步基线（mtime 可能被外部程序碰过但内容没变）
        lastMtime = mtime;
      }
    } catch (err) {
      console.warn('[sync] watcher tick failed', err);
      cooldownUntil = Date.now() + FAILURE_COOLDOWN_MS;
    } finally {
      polling = false;
    }
  };

  timer = setInterval(() => {
    void tick();
  }, POLL_INTERVAL_MS) as unknown as number;

  const stop = () => {
    stopped = true;
    if (timer !== null) clearInterval(timer);
    timer = null;
    unwatch();
  };
  stopCurrent = stop;
  return stop;
}
