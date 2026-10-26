import { useCallback, useEffect, useRef, useState } from 'react';
import { CloudCog, FolderOpen, Loader2, PlugZap, RefreshCw, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import { Switch } from '@/components/ui/switch';
import { useStorageItem } from '@/hooks/useStorageItem';
import { syncConfig, syncState } from '@/lib/persistence/storage';
import { assertValidBaseUrl, testConnection, webdavErrorMessage } from '@/lib/backup/webdav';
import { triggerSync } from '@/lib/sync/client';
import {
  folderPermission,
  isFolderSyncSupported,
  loadFolderHandle,
  pickSyncFolder,
  requestFolderPermission,
} from '@/lib/sync/folder-store';
import { syncErrorText, syncErrorTextWithDetail, syncRelativeTime } from '@/lib/sync/messages';
import {
  DEFAULT_SYNC_INTERVAL_MINUTES,
  SYNC_INTERVAL_OPTIONS,
  emptySyncState,
  type SyncConfig,
  type SyncErrorCode,
  type SyncTransport,
} from '@/lib/sync/types';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';

/** 文件夹授权状态：none = 还没选过。 */
type FolderState = 'none' | 'granted' | 'prompt' | 'denied';

/** 新建配置时的默认值。Chrome 上优先选本地文件夹（同机多配置最常见）。 */
function defaultConfig(): SyncConfig {
  return {
    enabled: true,
    transport: isFolderSyncSupported() ? 'folder' : 'webdav',
    folderName: '',
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
 * 两种介质：
 * - **本地文件夹**：同一台电脑的多个 Chrome 配置文件之间同步，不需要账号，读写就是
 *   本地文件操作。只能在扩展页面里跑，所以是「打开时 + 手动」触发。
 * - **WebDAV**：跨电脑 / 跨浏览器，后台每 N 分钟自动同步。
 *
 * 配置（含 WebDAV 账号与端到端口令）只存本机，不进备份、不同步到远端；
 * 新设备需要在这里重新填一次。
 */
export function SyncPanel() {
  const [config, setConfig] = useStorageItem<SyncConfig | null>(syncConfig, null);
  const [state] = useStorageItem(syncState, emptySyncState());
  const [draft, setDraft] = useState<SyncConfig>(defaultConfig);
  // 配置首次从存储加载 / 外部变更时，把草稿对齐一次。用户正在输入时不再覆盖。
  const initialized = useRef(false);
  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [testing, setTesting] = useState(false);
  const [folderState, setFolderState] = useState<FolderState>('none');

  useEffect(() => {
    if (initialized.current) return;
    // 还没读出来
    if (config === null) return;
    initialized.current = true;
    setDraft({
      ...defaultConfig(),
      ...config,
      // 老配置没有 transport 字段：有 WebDAV 地址就按 WebDAV 处理
      transport: config.transport ?? 'webdav',
    });
  }, [config]);

  const refreshFolderState = useCallback(async () => {
    const handle = await loadFolderHandle();
    if (!handle) {
      setFolderState('none');
      return;
    }
    setFolderState(await folderPermission(handle));
  }, []);

  useEffect(() => {
    if (draft.transport !== 'folder') return;
    void refreshFolderState();
  }, [draft.transport, refreshFolderState]);

  const update = <K extends keyof SyncConfig>(key: K, value: SyncConfig[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const persist = async (value: SyncConfig): Promise<boolean> => {
    // 保存前校验地址：带账号 / 参数的 URL 会被原样存储并显示，必须挡住。
    if (value.transport === 'webdav') {
      try {
        if (value.url.trim()) assertValidBaseUrl(value.url.trim());
      } catch (err) {
        toast.error(webdavErrorMessage(err));
        return false;
      }
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
      const result = await triggerSync('manual');
      if (result.ok) toast.success(t('settings.sync.success'));
      else toast.error(syncErrorTextWithDetail(result.code ?? 'unknown', result.detail));
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

  /** 选文件夹：必须由点击直接触发（浏览器要求用户手势）。 */
  const handlePickFolder = async () => {
    try {
      const handle = await pickSyncFolder();
      // 用户取消
      if (!handle) return;
      update('folderName', handle.name);
      setFolderState(await folderPermission(handle));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  /** 重新授权：同样必须在点击里调 requestPermission。 */
  const handleGrant = async () => {
    const handle = await loadFolderHandle();
    if (!handle) {
      setFolderState('none');
      return;
    }
    const next = await requestFolderPermission(handle);
    setFolderState(next);
    if (next === 'granted') toast.success(t('settings.sync.folderGranted'));
  };

  const configured = config !== null;
  const lastError = state.lastError ? syncErrorText(state.lastError as SyncErrorCode) : null;
  const isFolder = draft.transport === 'folder';
  const folderSupported = isFolderSyncSupported();

  const transportOption = (value: SyncTransport, label: string) => (
    <button
      type="button"
      onClick={() => update('transport', value)}
      className={cn(
        'flex-1 rounded-md border px-3 py-2 text-sm transition-colors',
        draft.transport === value
          ? 'border-primary bg-primary/5 font-medium'
          : 'border-border text-muted-foreground hover:bg-muted/50',
      )}
    >
      {label}
    </button>
  );

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
        <Label className="text-xs">{t('settings.sync.transportLabel')}</Label>
        <div className="flex gap-2">
          {transportOption('folder', t('settings.sync.transportFolder'))}
          {transportOption('webdav', t('settings.sync.transportWebdav'))}
        </div>
        {!folderSupported && (
          <p className="text-xs text-muted-foreground">{t('settings.sync.folderUnsupported')}</p>
        )}
      </div>

      {isFolder ? (
        <div className="space-y-2">
          <Label className="text-xs">{t('settings.sync.folderLabel')}</Label>
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1 truncate rounded-md border border-border px-3 py-1.5 text-sm">
              {draft.folderName || t('settings.sync.folderNone')}
            </div>
            <Button size="sm" variant="outline" onClick={handlePickFolder} disabled={!folderSupported}>
              <FolderOpen className="size-4" />
              {draft.folderName ? t('settings.sync.folderChange') : t('settings.sync.folderPick')}
            </Button>
          </div>
          {folderState !== 'granted' && folderState !== 'none' && (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={handleGrant}>
                <ShieldCheck className="size-4" />
                {t('settings.sync.folderGrant')}
              </Button>
              <span className="text-xs text-muted-foreground">
                {t('settings.sync.folderPermissionNeeded')}
              </span>
            </div>
          )}
          <p className="text-xs text-muted-foreground">{t('settings.sync.folderHint')}</p>
        </div>
      ) : (
        <>
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
        </>
      )}

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

      <div className="flex flex-wrap gap-2 pt-1">
        {!isFolder && (
          <Button size="sm" variant="outline" onClick={handleTest} disabled={!draft.url.trim() || testing}>
            {testing ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
            {t('settings.backup.webdav.test')}
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={handleSave} disabled={saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : null}
          {t('common.save')}
        </Button>
        <Button
          size="sm"
          onClick={handleSyncNow}
          disabled={syncing || !draft.syncPassword || (isFolder ? !draft.folderName : !draft.url.trim())}
        >
          <RefreshCw className={cn('size-4', syncing && 'animate-spin')} />
          {t('settings.sync.syncNow')}
        </Button>
      </div>
    </section>
  );
}
