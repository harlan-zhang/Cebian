// 同步仓库的传输接口。
//
// 远端仓库的布局与加密方式与具体介质无关：WebDAV 和本地文件夹只是同一套文件放在
// 不同地方。把「怎么读写」抽成接口后，合并 / 加密 / 索引那套逻辑可以完全复用，
// 也保证两种传输写出来的仓库格式一致——把文件夹放进 OneDrive，跨机同步照旧成立。

import type { SyncKeyMeta } from './types';

export interface SyncStore {
  /** 确保仓库根目录可用（WebDAV 建目录；文件夹校验授权）。 */
  ensureReady(): Promise<void>;
  readMeta(): Promise<SyncKeyMeta | null>;
  writeMeta(meta: SyncKeyMeta): Promise<void>;
  /** 读仓库内文件；不存在返回 null。 */
  readFile(path: string): Promise<Uint8Array | null>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  removeFile(path: string): Promise<void>;
  readSession(id: string): Promise<Uint8Array | null>;
  writeSession(id: string, bytes: Uint8Array): Promise<void>;
  removeSession(id: string): Promise<void>;
}
