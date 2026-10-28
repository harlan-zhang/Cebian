// 本地文件夹传输（Chrome 的 File System Access API）。
//
// 用途：同一台电脑上的多个 Chrome 配置文件。配置文件之间是完全隔离的
//（storage / IndexedDB / BroadcastChannel 都按 profile 分区），所以仍然需要一个
// 外部介质——但「一个本地文件夹」比「每次绕一圈网盘」轻得多：没有账号、没有网络
// 往返，读写就是几次本地文件操作。
//
// 两个必须知道的约束：
//
// 1. **只能在扩展页面里用**。File System Access API 不在 service worker 里，
//    所以文件夹模式下没有后台定时同步，改为「打开侧边栏 / 设置页时 + 手动」。
// 2. **目录句柄存在 IndexedDB 里**，浏览器重启后权限可能退回 prompt，需要用户
//    再点一次授权（Chrome 的安全策略，扩展绕不过去）。`ensureReady` 会把这种情况
//    报成 `permission`，由 UI 引导重新授权。
//
// 仓库布局与 WebDAV 完全一致，所以把文件夹选成 OneDrive / 坚果云的同步目录时，
// 跨机同步同样成立。

import { isValidSessionId } from '@/lib/utils';
import { SYNC_FILES } from './remote';
import { SYNC_ROOT } from './types';
import type { SyncStore } from './store';
import type { SyncKeyMeta } from './types';

/** 文件夹传输的错误码。 */
export type SyncFolderErrorCode = 'unsupported' | 'permission' | 'missing' | 'io' | 'invalid';

export class SyncFolderError extends Error {
  constructor(
    readonly code: SyncFolderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SyncFolderError';
  }
}

// ─── 句柄持久化（IndexedDB） ───

const DB_NAME = 'cebian-sync-fs';
const DB_VERSION = 1;
const STORE_NAME = 'handles';
const HANDLE_KEY = 'root';

/** 打开句柄库。FileSystemDirectoryHandle 可被结构化克隆，直接存。 */
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open sync folder database'));
  });
}

async function withStore<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const req = fn(tx.objectStore(STORE_NAME));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('Sync folder handle request failed'));
    });
  } finally {
    db.close();
  }
}

/** 保存用户选的文件夹句柄。 */
export async function saveFolderHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  await withStore('readwrite', (store) => store.put(handle, HANDLE_KEY) as IDBRequest<IDBValidKey>);
}

/** 读取已保存的文件夹句柄；没选过返回 null。 */
export async function loadFolderHandle(): Promise<FileSystemDirectoryHandle | null> {
  const value = await withStore<FileSystemDirectoryHandle | undefined>('readonly', (store) =>
    store.get(HANDLE_KEY) as IDBRequest<FileSystemDirectoryHandle | undefined>,
  );
  return value ?? null;
}

/** 忘掉已选的文件夹。 */
export async function clearFolderHandle(): Promise<void> {
  await withStore('readwrite', (store) => store.delete(HANDLE_KEY) as unknown as IDBRequest<undefined>);
}

// ─── 能力与权限 ───

interface DirectoryPickerWindow {
  showDirectoryPicker?: (options?: {
    id?: string;
    mode?: 'read' | 'readwrite';
    startIn?: string;
  }) => Promise<FileSystemDirectoryHandle>;
}

/** 当前浏览器是否支持文件夹同步（Firefox 不支持）。 */
export function isFolderSyncSupported(): boolean {
  return typeof (globalThis as DirectoryPickerWindow).showDirectoryPicker === 'function';
}

/**
 * 弹出目录选择器。用户取消返回 null（不抛错）。必须由点击事件直接调用——
 * 浏览器要求用户手势。
 */
export async function pickSyncFolder(): Promise<FileSystemDirectoryHandle | null> {
  const picker = (globalThis as DirectoryPickerWindow).showDirectoryPicker;
  if (!picker) {
    throw new SyncFolderError('unsupported', 'This browser does not support folder access');
  }
  try {
    const handle = await picker({ id: 'cebian-sync', mode: 'readwrite', startIn: 'documents' });
    await saveFolderHandle(handle);
    return handle;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null;
    throw err;
  }
}

/** 当前对文件夹的授权状态。 */
export async function folderPermission(
  handle: FileSystemDirectoryHandle,
): Promise<'granted' | 'prompt' | 'denied'> {
  const query = (handle as FileSystemDirectoryHandle & {
    queryPermission?: (o: { mode: 'readwrite' }) => Promise<'granted' | 'prompt' | 'denied'>;
  }).queryPermission;
  if (typeof query !== 'function') return 'granted';
  return query.call(handle, { mode: 'readwrite' });
}

/** 请求授权。必须在点击事件里调用。 */
export async function requestFolderPermission(
  handle: FileSystemDirectoryHandle,
): Promise<'granted' | 'prompt' | 'denied'> {
  const request = (handle as FileSystemDirectoryHandle & {
    requestPermission?: (o: { mode: 'readwrite' }) => Promise<'granted' | 'prompt' | 'denied'>;
  }).requestPermission;
  if (typeof request !== 'function') return 'granted';
  return request.call(handle, { mode: 'readwrite' });
}

/** 当前是否处在用户手势的有效期内（只有这时才能弹权限框）。 */
export function hasUserActivation(): boolean {
  const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
  return activation?.isActive ?? false;
}

/**
 * 在用户手势里尝试把「本次会话」的授权升级成持久授权。
 *
 * 为什么必须主动调 `requestPermission()`：Chrome 122 起支持文件句柄的永久权限，
 * 但**只有在后续访问中主动请求**时才会弹出「仅允许这次 / 每次访问时允许 / 不允许」
 * 三选一。只调 `queryPermission()` 的话永远停在「仅本次会话」，面板一关就失效——
 * 这正是「每次打开都要重新授权」的原因。
 *
 * 没有用户手势时返回当前状态，不弹框（浏览器不允许）。
 */
export async function upgradeFolderPermission(
  handle: FileSystemDirectoryHandle,
): Promise<'granted' | 'prompt' | 'denied'> {
  const current = await folderPermission(handle);
  if (current === 'granted') return current;
  if (!hasUserActivation()) return current;
  return requestFolderPermission(handle);
}

// ─── 仓库读写 ───

/** 把 DOMException 翻成可读的文件夹错误。 */
function mapFsError(err: unknown, what: string): SyncFolderError {
  if (err instanceof SyncFolderError) return err;
  if (err instanceof DOMException) {
    if (err.name === 'NotAllowedError') {
      return new SyncFolderError('permission', `Folder access was denied (${what})`);
    }
    if (err.name === 'NotFoundError') {
      return new SyncFolderError('missing', `Folder or file is gone (${what})`);
    }
  }
  return new SyncFolderError('io', `Folder I/O failed (${what}): ${err instanceof Error ? err.message : String(err)}`);
}

export class FolderStore implements SyncStore {
  constructor(private readonly root: FileSystemDirectoryHandle) {}

  /** 校验授权；未授权时抛 `permission`，由 UI 引导用户点一次「重新授权」。 */
  async ensureReady(): Promise<void> {
    const state = await folderPermission(this.root);
    if (state !== 'granted') {
      throw new SyncFolderError('permission', 'Folder permission is required before syncing');
    }
  }

  /** 定位仓库内的一个文件，按需创建中间目录。 */
  private async resolve(
    path: string,
    create: boolean,
  ): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
    const segs = path.split('/').filter(Boolean);
    if (segs.length === 0) throw new SyncFolderError('invalid', 'Empty sync file path');
    const name = segs.pop() as string;
    let dir = await this.root.getDirectoryHandle(SYNC_ROOT, { create });
    for (const seg of segs) {
      dir = await dir.getDirectoryHandle(seg, { create });
    }
    return { dir, name };
  }

  /**
   * 索引文件的修改时间（毫秒）；不存在返回 null。
   *
   * 实时同步靠它判断「别处有没有新写入」：File System Access 没有 watch API，
   * 只能轮询。读一次文件元数据很便宜，比每几秒解密整个索引划算得多。
   */
  async indexMtime(): Promise<number | null> {
    try {
      const { dir, name } = await this.resolve(SYNC_FILES.index, false);
      const handle = await dir.getFileHandle(name);
      const file = await handle.getFile();
      return file.lastModified;
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotFoundError') return null;
      throw mapFsError(err, 'stat index');
    }
  }

  async readMeta(): Promise<SyncKeyMeta | null> {
    const bytes = await this.readFile(SYNC_FILES.meta);
    if (!bytes) return null;
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as SyncKeyMeta;
    } catch {
      throw new SyncFolderError('io', 'Sync meta.json is not valid JSON');
    }
  }

  async writeMeta(meta: SyncKeyMeta): Promise<void> {
    await this.writeFile(SYNC_FILES.meta, new TextEncoder().encode(JSON.stringify(meta)));
  }

  async readFile(path: string): Promise<Uint8Array | null> {
    try {
      const { dir, name } = await this.resolve(path, false);
      const handle = await dir.getFileHandle(name);
      const file = await handle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch (err) {
      // 目录都还不存在 → 视为「文件不存在」，与 WebDAV 的 404 语义一致
      if (err instanceof DOMException && err.name === 'NotFoundError') return null;
      throw mapFsError(err, `read ${path}`);
    }
  }

  async writeFile(path: string, bytes: Uint8Array): Promise<void> {
    try {
      const { dir, name } = await this.resolve(path, true);
      const handle = await dir.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      // 复制到独立 ArrayBuffer：直接把可能被复用的 Uint8Array 交给写入流，
      // 在部分实现里会因 detached buffer 报错。
      await writable.write(bytes.slice().buffer as ArrayBuffer);
      await writable.close();
    } catch (err) {
      throw mapFsError(err, `write ${path}`);
    }
  }

  async removeFile(path: string): Promise<void> {
    try {
      const { dir, name } = await this.resolve(path, false);
      await dir.removeEntry(name);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotFoundError') return;
      throw mapFsError(err, `remove ${path}`);
    }
  }

  async readSession(id: string): Promise<Uint8Array | null> {
    return this.readFile(this.sessionPath(id));
  }

  async writeSession(id: string, bytes: Uint8Array): Promise<void> {
    await this.writeFile(this.sessionPath(id), bytes);
  }

  async removeSession(id: string): Promise<void> {
    await this.removeFile(this.sessionPath(id));
  }

  private sessionPath(id: string): string {
    if (!isValidSessionId(id)) {
      throw new SyncFolderError('invalid', `Invalid session id for sync path: ${JSON.stringify(id)}`);
    }
    return `sessions/${id}.enc`;
  }
}
