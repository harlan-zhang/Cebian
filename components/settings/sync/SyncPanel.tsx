import { useEffect, useRef, useState } from 'react';
import { CloudCog, Loader2, PlugZap, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import { Switch } from '@/components/ui/switch';
import { useStorageItem } from '@/hooks/useStorageItem';
import { syncConfig, syncState } from '@/lib/persistence/storage';
import { assertValidBaseUrl, testConnection, webdavErrorMessage } from '@/lib/backup/webdav';
import { SYNC_NOW, type SyncNowResponse } from '@/lib/sync/protocol';
import { syncErrorText, syncErrorTextWithDetail, syncRelativeTime } from '@/lib/sync/messages';
import {
  DEFAULT_SYNC_INTERVAL_MINUTES,
  SYNC_INTERVAL_OPTIONS,
  emptySyncState,
  type SyncConfig,
  type SyncErrorCode,
} from '@/lib/sync/types';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

/** 新建配置时的默认值。目录刻意与备份错开，避免两种用途互相覆盖。 */
function defaultConfig(): SyncConfig {
  return {
    enabled: true,
    url: '',
    username: '',
    password: '',
    directory: '/cebian-sync',
    syncPassword: '',
    intervalMinutes: DEFAULT_SYNC_INTERVAL_MINUTES,
    deviceName: '',
  };
}

/**
 * SyncPanel — 设置 → 数据 里的「多设备同步」区块。
 *
 * 同步配置（含 WebDAV 账号与端到端口令）只存本机，不进备份、不同步到远端；
 * 因此新设备需要在这里重新填一次。真正的同步在 background 里跑，本组件只负责
 * 编辑配置、触发一次同步、展示状态。
 */
export function SyncPanel() {
  const [config, setConfig] = useStorageItem<SyncConfig | null>(syncConfig, null);
  const [state] = useStorageItem(syncState, emptySyncState());
  const [draft, setDraft] = useState<SyncConfig>(defaultConfig);
  // 配置首次从存储加载 / 外部变更时，把草稿对齐一次。用户正在输入时不再覆盖
  //（用 ref 记录「是否已经初始化过」，避免每次 storage 事件都把输入清掉）。
  const initialized = useRef(false);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    if (initialized.current) return;
    // 还没读出来
    if (config === null) return;
    initialized.current = true;
    setDraft({ ...defaultConfig(), ...config });
  }, [config]);

  const update = <K extends keyof SyncConfig>(key: K, value: SyncConfig[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const persist = async (value: SyncConfig): Promise<boolean> => {
    // 保存前校验地址：带账号 / 参数的 URL 会被原样存储并显示，必须挡住。
    try {
      if (value.url.trim()) assertValidBaseUrl(value.url.trim());
    } catch (err) {
      toast.error(webdavErrorMessage(err));
      return false;
    }
    await setConfig(value);
    return true;
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      if (await persist(draft)) toast.success(t('settings.sync.saved'));
    } finally {
      setSaving(false);
    }
  };

  const handleSyncNow = async () => {
    setSyncing(true);
    try {
      if (!(await persist(draft))) return;
      const resp = (await chrome.runtime.sendMessage({
        type: SYNC_NOW,
        reason: 'manual',
      })) as SyncNowResponse | undefined;
      if (!resp) {
        toast.error(syncErrorText('noResponse'));
        return;
      }
      if (resp.ok) toast.success(t('settings.sync.success'));
      else toast.error(syncErrorTextWithDetail(resp.code ?? 'unknown', resp.detail));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      await testConnection({
        url: draft.url.trim(),
        username: draft.username.trim(),
        password: draft.password,
        directory: draft.directory.trim(),
      });
      toast.success(t('settings.backup.webdav.testSuccess'));
    } catch (err) {
      toast.error(webdavErrorMessage(err));
    } finally {
      setTesting(false);
    }
  };

  const configured = config !== null;
  const lastError = state.lastError ? syncErrorText(state.lastError as SyncErrorCode) : null;

  return (
    <section className="space-y-3 rounded-lg border border-border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <CloudCog className="size-4 text-muted-foreground" />
          <h4 className="text-sm font-medium">{t('settings.sync.title')}</h4>
        </div>
        <Switch
          id="sync-enabled"
          checked={draft.enabled}
          onCheckedChange={(enabled) => update('enabled', enabled)}
          className="shrink-0"
        />
      </div>

      <p className="text-xs text-muted-foreground">{t('settings.sync.description')}</p>

      {configured && state.lastSyncAt !== null && (
        <p className="text-xs text-muted-foreground">
          {t('settings.sync.lastSync', [syncRelativeTime(state.lastSyncAt)])}
        </p>
      )}
      {lastError && <p className="text-xs text-destructive">{lastError}</p>}
      {state.lastErrorDetail && (
        <p className="text-xs text-muted-foreground break-all">{state.lastErrorDetail}</p>
      )}

      <div className="space-y-1.5">
        <Label htmlFor="sync-url" className="text-xs">{t('settings.backup.webdav.urlLabel')}</Label>
        <Input
          id="sync-url"
          value={draft.url}
          onChange={(e) => update('url', e.target.value)}
          placeholder={t('settings.backup.webdav.urlPlaceholder')}
          className="h-8 text-sm"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="sync-user" className="text-xs">{t('settings.backup.webdav.usernameLabel')}</Label>
          <Input
            id="sync-user"
            value={draft.username}
            onChange={(e) => update('username', e.target.value)}
            placeholder={t('settings.backup.webdav.usernamePlaceholder')}
            className="h-8 text-sm"
            autoComplete="off"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sync-pass" className="text-xs">{t('settings.backup.webdav.passwordLabel')}</Label>
          <PasswordInput
            id="sync-pass"
            value={draft.password}
            onChange={(e) => update('password', e.target.value)}
            placeholder={t('settings.backup.webdav.passwordPlaceholder')}
            className="h-8 text-sm"
            autoComplete="off"
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="sync-dir" className="text-xs">{t('settings.sync.directoryLabel')}</Label>
          <Input
            id="sync-dir"
            value={draft.directory}
            onChange={(e) => update('directory', e.target.value)}
            placeholder="/cebian-sync"
            className="h-8 text-sm"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="sync-device" className="text-xs">{t('settings.sync.deviceLabel')}</Label>
          <Input
            id="sync-device"
            value={draft.deviceName}
            onChange={(e) => update('deviceName', e.target.value)}
            placeholder={t('settings.sync.devicePlaceholder')}
            className="h-8 text-sm"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="sync-secret" className="text-xs">{t('settings.sync.passwordLabel')}</Label>
        <PasswordInput
          id="sync-secret"
          value={draft.syncPassword}
          onChange={(e) => update('syncPassword', e.target.value)}
          placeholder={t('settings.sync.passwordPlaceholder')}
          className="h-8 text-sm"
          autoComplete="off"
        />
        <p className="text-xs text-muted-foreground">{t('settings.sync.passwordHint')}</p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="sync-interval" className="text-xs">{t('settings.sync.intervalLabel')}</Label>
        <select
          id="sync-interval"
          value={draft.intervalMinutes}
          onChange={(e) => update('intervalMinutes', Number(e.target.value))}
          className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
        >
          {SYNC_INTERVAL_OPTIONS.map((minutes) => (
            <option key={minutes} value={minutes}>
              {t('settings.sync.intervalMinutes', [minutes])}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap gap-2 pt-1">
        <Button size="sm" variant="outline" onClick={handleTest} disabled={!draft.url.trim() || testing}>
          {testing ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
          {t('settings.backup.webdav.test')}
        </Button>
        <Button size="sm" variant="outline" onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : null}
          {t('common.save')}
        </Button>
        <Button
          size="sm"
          onClick={handleSyncNow}
          disabled={syncing || !draft.url.trim() || !draft.syncPassword}
        >
          <RefreshCw className={cn('size-4', syncing && 'animate-spin')} />
          {t('settings.sync.syncNow')}
        </Button>
      </div>
    </section>
  );
}
