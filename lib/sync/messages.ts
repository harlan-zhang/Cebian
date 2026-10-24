// 同步错误码的本地化文案。
//
// 设置页与侧边栏按钮共用同一份映射，避免两处各写一套导致口径漂移。

import { t } from '@/lib/i18n';
import type { SyncErrorCode } from './types';

/** 错误码 → 可展示文案。 */
export function syncErrorText(code: SyncErrorCode): string {
  switch (code) {
    case 'notConfigured':
      return t('settings.sync.error.notConfigured');
    case 'disabled':
      return t('settings.sync.error.disabled');
    case 'wrongPassword':
      return t('settings.sync.error.wrongPassword');
    case 'incompatible':
      return t('settings.sync.error.incompatible');
    case 'network':
      return t('settings.sync.error.network');
    case 'unauthorized':
      return t('settings.sync.error.unauthorized');
    case 'forbidden':
      return t('settings.sync.error.forbidden');
    case 'server':
      return t('settings.sync.error.server');
    case 'busy':
      return t('settings.sync.error.busy');
    default:
      return t('settings.sync.error.unknown');
  }
}

/** 时间戳 → 「刚刚 / x 分钟前 / x 小时前 / x 天前」。 */
export function syncRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return t('settings.sync.justNow');
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return t('settings.sync.minutesAgo', [minutes]);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('settings.sync.hoursAgo', [hours]);
  return t('settings.sync.daysAgo', [Math.floor(hours / 24)]);
}
