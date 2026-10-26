// 「本机设置 / 密钥」这部分适配器：background 与扩展页面用法完全相同
//（WXT storage 在两种上下文都能直接读写），所以抽成一份共用实现。

import { BACKUP_REGISTRY } from '@/lib/backup/registry';
import { providerCredentials, type ProviderCredentials } from '@/lib/persistence/storage';
import type { SyncLocalAdapter } from './engine-core';

type StorageSlice = Pick<
  SyncLocalAdapter,
  'readSettings' | 'writeSetting' | 'readCredentials' | 'writeCredentials'
>;

/** 采集全部普通设置项（与备份同一分类口径：settings-class，含混合 item 的完整值）。 */
async function readSettings(): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const entry of BACKUP_REGISTRY) {
    if (entry.storageClass !== 'settings') continue;
    out[entry.item.key] = await entry.item.getValue();
  }
  return out;
}

/** 写回一个设置项。未知 key（仓库里有、当前版本已删除的项）直接忽略。 */
async function writeSetting(key: string, value: unknown): Promise<boolean> {
  const entry = BACKUP_REGISTRY.find((e) => e.item.key === key && e.storageClass === 'settings');
  if (!entry) return false;
  await entry.item.setValue(value);
  return true;
}

export function createStorageAdapter(): StorageSlice {
  return {
    readSettings,
    writeSetting,
    readCredentials: () => providerCredentials.getValue(),
    writeCredentials: (next: ProviderCredentials) => providerCredentials.setValue(next),
  };
}
