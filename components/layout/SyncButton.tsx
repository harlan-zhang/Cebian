import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useStorageItem } from '@/hooks/useStorageItem';
import { syncConfig, syncState } from '@/lib/persistence/storage';
import { triggerSync } from '@/lib/sync/client';
import { syncErrorText, syncErrorTextWithDetail, syncRelativeTime } from '@/lib/sync/messages';
import { emptySyncState, type SyncConfig, type SyncErrorCode } from '@/lib/sync/types';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

/**
 * 侧边栏顶栏的「立即同步」按钮（在明暗切换与设置之间）。
 *
 * - 未配置同步：点击直接跳到设置页，而不是弹一个只能干瞪眼的错误。
 * - 已配置：发 `sync:now` 给 background，按结果给 toast。
 * - 进行中：图标旋转并禁用，避免连点。
 *
 * 这里不监听 background 的「周期同步进行中」——那条状态没有广播通道，而按钮自身的
 * 手动同步有明确的开始/结束边界，本地 busy 足够。上次同步结果从 syncState 读。
 */
export function SyncButton({ onOpenSettings }: { onOpenSettings: () => void }) {
  const [config] = useStorageItem<SyncConfig | null>(syncConfig, null);
  const [state] = useStorageItem(syncState, emptySyncState());
  const [busy, setBusy] = useState(false);

  const configured = Boolean(
    config?.syncPassword &&
      (config.transport === 'folder' ? config.folderName : config.url?.trim()),
  );

  const handleClick = async () => {
    if (!configured || !config?.enabled) {
      onOpenSettings();
      return;
    }
    setBusy(true);
    try {
      // 自动按配置里的介质选择执行位置：WebDAV 交给后台，文件夹在当前页面跑
      const result = await triggerSync('manual');
      if (result.ok) toast.success(t('settings.sync.success'));
      else toast.error(syncErrorTextWithDetail(result.code ?? 'unknown', result.detail));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const label = !configured
    ? t('settings.sync.notConfigured')
    : state.lastError
      ? syncErrorTextWithDetail(state.lastError as SyncErrorCode, state.lastErrorDetail)
      : state.lastSyncAt !== null
        ? t('settings.sync.lastSync', [syncRelativeTime(state.lastSyncAt)])
        : t('settings.sync.syncNow');

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={handleClick}
          disabled={busy}
          aria-label={t('settings.sync.syncNow')}
          className="relative"
        >
          <RefreshCw className={cn('size-4.5', busy && 'animate-spin')} />
          {/* Red dot when the last sync failed, so it is visible without opening settings */}
          {!busy && configured && state.lastError && (
            <span className="absolute right-1 top-1 size-1.5 rounded-full bg-destructive" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
