// 同步仓库的 WebDAV 传输层。
//
// 与备份用的 lib/backup/webdav.ts 分开，原因有二：
//
// 1. **必须在 background service worker 里能跑**。备份那条链路依赖 DOMParser 解析
//    PROPFIND 的 XML，而 SW 没有 DOM。同步改用「固定路径 + 索引文件」的布局：需要知道
//    远端有什么，读一个加密索引即可，完全不需要列目录。于是 MKCOL / PUT / GET / DELETE
//    四个方法就够，SW 里可直接运行。
// 2. **路径是程序生成的**（`sessions/<uuid>.enc`），不是用户填的快照名，校验口径不同：
//    这里只认 UUID 形态的会话 id，其余一律拒绝，防止畸形 id 拼出 `../` 逃逸。
//
// 这一层只做传输，不认识加密与合并语义。

import { isValidSessionId } from '@/lib/utils';
import { SYNC_ROOT } from './types';
import type { SyncKeyMeta } from './types';

/** 元数据操作超时（毫秒）。 */
const META_TIMEOUT_MS = 20_000;
/** 传输单个文件超时（毫秒）。会话可能带图片，给足时间。 */
const TRANSFER_TIMEOUT_MS = 2 * 60_000;

export type SyncRemoteErrorCode =
  | 'network'
  | 'timeout'
  | 'unauthorized'
  | 'notFound'
  | 'conflict'
  | 'invalid'
  | 'server';

/** 传输层错误。`code` 供上层翻译成本地化文案。 */
export class SyncRemoteError extends Error {
  constructor(
    readonly code: SyncRemoteErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SyncRemoteError';
  }
}

/** 连接参数。与备份的 WebDavConfig 同形，但独立配置（同步与备份可以是不同目录 / 账号）。 */
export interface SyncRemoteConfig {
  url: string;
  username: string;
  password: string;
  directory: string;
}

/** 仓库里的固定文件路径（相对 `sync/`）。 */
export const SYNC_FILES = {
  meta: 'meta.json',
  index: 'index.enc',
  settings: 'settings.enc',
  credentials: 'credentials.enc',
} as const;

/** 校验 base URL：必须是干净的绝对 http(s) 地址，不带 userinfo / query / hash。
 *  理由同备份层——凭据混进 URL 会被原样存储并显示，且拼接会产生错误目标。 */
export function assertValidBaseUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new SyncRemoteError('invalid', `Invalid sync server URL: ${JSON.stringify(url)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SyncRemoteError('invalid', `Sync server URL must use http(s): ${JSON.stringify(url)}`);
  }
  if (parsed.username || parsed.password) {
    throw new SyncRemoteError('invalid', 'Sync server URL must not embed credentials');
  }
  if (url.includes('?') || url.includes('#')) {
    throw new SyncRemoteError('invalid', 'Sync server URL must not contain a query or fragment');
  }
}

/** 校验目录路径：允许多级，但拒绝 `.` / `..` / 反斜杠 / 控制符。 */
export function assertSafeDirectory(directory: string): void {
  for (const seg of directory.split('/').filter(Boolean)) {
    // eslint-disable-next-line no-control-regex
    if (seg === '.' || seg === '..' || /[\\\x00-\x1f]/.test(seg)) {
      throw new SyncRemoteError('invalid', `Unsafe sync directory segment: ${JSON.stringify(seg)}`);
    }
  }
}

/** 把 base 与若干片段拼成绝对 URL；逐段 encode，空片段忽略。 */
function joinUrl(base: string, ...segments: string[]): string {
  const root = base.replace(/\/+$/, '');
  const path = segments
    .flatMap((s) => s.split('/'))
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
  return path ? `${root}/${path}` : root;
}

/** Basic 认证头，按 UTF-8 编码后 base64（支持非 ASCII 账号）。 */
function basicAuth(config: SyncRemoteConfig): string {
  const bytes = new TextEncoder().encode(`${config.username}:${config.password}`);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return `Basic ${btoa(binary)}`;
}

/** 给错误信息用的脱敏 URL。 */
function sanitizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return raw.split('?')[0];
  }
}

interface RequestOptions {
  method: string;
  body?: BodyInit;
  headers?: Record<string, string>;
  /** 视为成功的额外状态码。 */
  allowStatuses?: number[];
  timeoutMs?: number;
}

/** 发一个请求；非成功状态翻译成 SyncRemoteError。 */
async function request(url: string, config: SyncRemoteConfig, init: RequestOptions): Promise<Response> {
  const controller = new AbortController();
  const timeoutMs = init.timeoutMs ?? META_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method,
      headers: { Authorization: basicAuth(config), ...init.headers },
      body: init.body,
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new SyncRemoteError('timeout', `Sync request timed out after ${timeoutMs}ms`);
    }
    throw new SyncRemoteError(
      'network',
      `Failed to reach sync server: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (res.ok || init.allowStatuses?.includes(res.status)) return res;
  throw mapStatus(res.status, init.method, url);
}

function mapStatus(status: number, method: string, url: string): SyncRemoteError {
  const where = `${method} ${sanitizeUrl(url)} → ${status}`;
  if (status === 401 || status === 403) {
    return new SyncRemoteError('unauthorized', `Sync server authentication failed (${where})`, status);
  }
  if (status === 404) {
    return new SyncRemoteError('notFound', `Sync path not found (${where})`, status);
  }
  if (status === 409) {
    return new SyncRemoteError('conflict', `Sync parent directory missing (${where})`, status);
  }
  return new SyncRemoteError('server', `Unexpected sync server response (${where})`, status);
}

/**
 * 同步仓库客户端。构造时不发请求；`ensureDirectories` 在首次写入前显式调用。
 */
export class SyncRemote {
  private readonly config: SyncRemoteConfig;

  constructor(config: SyncRemoteConfig) {
    this.config = config;
    assertValidBaseUrl(config.url);
    assertSafeDirectory(config.directory);
  }

  /** 仓库根 URL（`<base>/<directory>/sync`）。 */
  private get rootUrl(): string {
    return joinUrl(this.config.url, this.config.directory, SYNC_ROOT);
  }

  /** 某个仓库内文件的 URL。 */
  private fileUrl(path: string): string {
    return joinUrl(this.config.url, this.config.directory, SYNC_ROOT, path);
  }

  /** 会话文件路径。id 必须是 UUID 形态。 */
  private sessionPath(id: string): string {
    if (!isValidSessionId(id)) {
      throw new SyncRemoteError('invalid', `Invalid session id for sync path: ${JSON.stringify(id)}`);
    }
    return `sessions/${id}.enc`;
  }

  /**
   * 逐级创建目录（配置目录 → sync → sync/sessions）。
   *
   * 不用 PROPFIND 探测存在性：MKCOL 一个已存在的集合在 RFC 4918 下返回 405，
   * 各家服务端还会返回 301 / 409，这些一律当作「已存在」忽略。真正的失败会在
   * 随后的 PUT 上以 409 / 5xx 暴露出来。
   */
  async ensureDirectories(): Promise<void> {
    const segments = [this.config.directory, SYNC_ROOT, `${SYNC_ROOT}/sessions`]
      .flatMap((p) => p.split('/'))
      .filter(Boolean);
    // 去重（配置目录本身可能已经包含 sync，虽然不推荐）
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const seg of segments) {
      const key = `${ordered.join('/')}/${seg}`;
      if (seen.has(key)) continue;
      seen.add(key);
      ordered.push(seg);
    }
    let acc = this.config.url.replace(/\/+$/, '');
    for (const seg of ordered) {
      acc = `${acc}/${encodeURIComponent(seg)}`;
      await request(acc, this.config, {
        method: 'MKCOL',
        allowStatuses: [200, 201, 204, 301, 302, 405, 409],
      });
    }
  }

  /** 读 meta.json；不存在返回 null。 */
  async readMeta(): Promise<SyncKeyMeta | null> {
    const res = await request(this.fileUrl(SYNC_FILES.meta), this.config, {
      method: 'GET',
      allowStatuses: [404],
    });
    if (res.status === 404) return null;
    const text = await res.text();
    try {
      return JSON.parse(text) as SyncKeyMeta;
    } catch {
      throw new SyncRemoteError('server', 'Sync meta.json is not valid JSON');
    }
  }

  /** 写 meta.json。 */
  async writeMeta(meta: SyncKeyMeta): Promise<void> {
    await request(this.fileUrl(SYNC_FILES.meta), this.config, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(meta),
    });
  }

  /** 读一个二进制文件；不存在返回 null。 */
  async readFile(path: string): Promise<Uint8Array | null> {
    const res = await request(this.fileUrl(path), this.config, {
      method: 'GET',
      allowStatuses: [404],
      timeoutMs: TRANSFER_TIMEOUT_MS,
    });
    if (res.status === 404) return null;
    return new Uint8Array(await res.arrayBuffer());
  }

  /** 写一个二进制文件。 */
  async writeFile(path: string, bytes: Uint8Array): Promise<void> {
    await request(this.fileUrl(path), this.config, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes as BodyInit,
      timeoutMs: TRANSFER_TIMEOUT_MS,
    });
  }

  /** 删除一个文件；不存在也算成功（幂等）。 */
  async removeFile(path: string): Promise<void> {
    await request(this.fileUrl(path), this.config, {
      method: 'DELETE',
      allowStatuses: [404],
    });
  }

  /** 读单个会话的密文。 */
  async readSession(id: string): Promise<Uint8Array | null> {
    return this.readFile(this.sessionPath(id));
  }

  /** 写单个会话的密文。 */
  async writeSession(id: string, bytes: Uint8Array): Promise<void> {
    await this.writeFile(this.sessionPath(id), bytes);
  }

  /** 删除单个会话的密文。 */
  async removeSession(id: string): Promise<void> {
    await this.removeFile(this.sessionPath(id));
  }
}
