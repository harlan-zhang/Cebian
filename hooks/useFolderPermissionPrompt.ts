// 文件夹授权的「无感续期」。
//
// 背景：Chrome 的文件句柄权限默认只对「本次会话」有效，关掉所有同源页面就失效。
// 从 Chrome 122 起支持永久权限，但**必须在下一次访问里主动调用 requestPermission()**
// 才会弹出「仅允许这次 / 每次访问时允许 / 不允许」三选一——只调 queryPermission()
// 的话永远停在「仅本次」。
//
// 用户不会去读这些文档，他们只会觉得「每次打开都要重新授权很烦」。所以这里做两件事：
// 1. 面板打开时先探一次权限；
// 2. 如果权限不是 granted，就把「下一次点击」当成授权时机——用户点面板里任何地方
//    （输入框、按钮、消息）都会顺手弹一次权限框，选「每次访问时允许」后就再也不用管。
//
// 为什么不能在面板打开时直接弹：浏览器要求 transient user activation，打开面板
// 不算用户手势，`requestPermission()` 会被直接拒绝。

import { useEffect } from 'react';
import { syncConfig } from '@/lib/persistence/storage';
import { triggerSync } from '@/lib/sync/client';
import { folderPermission, loadFolderHandle, requestFolderPermission } from '@/lib/sync/folder-store';

/**
 * 在侧边栏挂载：权限缺失时，把用户的第一次点击变成授权时机。
 * 授权成功后立刻同步一次，避免用户还要再点一次同步按钮。
 */
export function useFolderPermissionPrompt(): void {
  useEffect(() => {
    let handle: FileSystemDirectoryHandle | null = null;
    let needed = false;
    let busy = false;
    let disposed = false;

    const refresh = async (): Promise<void> => {
      const config = await syncConfig.getValue();
      if (disposed) return;
      if (!config?.enabled || config.transport !== 'folder') {
        needed = false;
        handle = null;
        return;
      }
      handle = await loadFolderHandle();
      if (disposed) return;
      needed = handle ? (await folderPermission(handle)) !== 'granted' : false;
    };

    void refresh();
    // 设置里刚选了文件夹 / 换了介质时重新探测
    const unwatch = syncConfig.watch(() => {
      void refresh();
    });

    const onClick = () => {
      if (disposed || busy || !needed || !handle) return;
      busy = true;
      // 同步调用：requestPermission 必须在点击的同一任务里发起，await 之后再调可能
      // 已经被判为「没有用户手势」。
      void requestFolderPermission(handle)
        .then((state) => {
          if (state === 'granted') {
            needed = false;
            void triggerSync('auto');
          }
        })
        .catch((err) => {
          console.warn('[sync] folder permission request failed', err);
        })
        .finally(() => {
          busy = false;
        });
    };

    // capture：先于业务处理器执行，避免被 stopPropagation 拦掉
    window.addEventListener('click', onClick, true);
    return () => {
      disposed = true;
      window.removeEventListener('click', onClick, true);
      unwatch();
    };
  }, []);
}
