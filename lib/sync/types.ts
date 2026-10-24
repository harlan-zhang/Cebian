// 多设备同步的共享类型与常量。
//
// 同步与备份是两条独立的链路：备份产出「某个时间点的 zip 快照」，同步维护一个
// 「持续合并的远端仓库」。二者共用 WebDAV 传输思路与 AES-GCM 加密原语，但目录布局、
// 冲突语义、状态记录完全不同，故不复用 backup/types。
//
// 远端布局（相对配置里的 directory）：
//
//   sync/meta.json              明文：格式版本 + 派生密钥用的 salt / 迭代次数
//   sync/index.enc              加密：会话索引 + 墓碑 + 设备表
//   sync/settings.enc           加密：设置项（key → { value, updatedAt }）
//   sync/credentials.enc        加密：各 provider 的密钥（providerId → { value, updatedAt }）
//   sync/sessions/<id>.enc      加密：单个会话（SessionBackupRecord 的 JSON）
//
// 除 meta.json 外全部加密。meta.json 只含 salt 与迭代次数——它们是密码学意义上
// 的公开参数，不含任何用户数据。

/** 远端仓库的格式版本。高于当前值的仓库拒绝同步（避免旧版本写坏新格式）。 */
export const SYNC_SCHEMA_VERSION = 1;

/** 远端仓库在 WebDAV 目录下的固定子目录名。 */
export const SYNC_ROOT = 'sync';

/** 同步口令派生密钥的 PBKDF2 迭代次数。与备份一致；meta.json 里记录实际值，
 *  未来调大不影响老仓库。 */
export const SYNC_PBKDF2_ITERATIONS = 600_000;

/** 可选同步间隔（分钟）。 */
export const SYNC_INTERVAL_OPTIONS = [5, 15, 30, 60] as const;
export const DEFAULT_SYNC_INTERVAL_MINUTES = 15;

/** 墓碑保留时长：超过这个时间的删除记录可以从索引里清掉（各设备早已看到）。 */
export const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

/** 侧边栏打开时触发同步的最小间隔：避免频繁开关面板造成连续同步。 */
export const OPEN_TRIGGER_MIN_INTERVAL_MS = 60 * 1000;

// ─── 配置与状态（本机） ───

/**
 * 同步配置。整体属于「本机连接信息 + 密钥」，不进备份、不同步到远端——
 * 否则会把同步口令本身传到它自己要保护的仓库里。
 */
export interface SyncConfig {
  /** 总开关。关闭时不调度、不自动同步；手动按钮也不可用。 */
  enabled: boolean;
  /** WebDAV 端点。 */
  url: string;
  username: string;
  password: string;
  /** WebDAV 目录，同步仓库会建在它的 `sync/` 子目录下。 */
  directory: string;
  /** 端到端加密口令。只存本机，绝不上传。 */
  syncPassword: string;
  /** 自动同步间隔（分钟）。 */
  intervalMinutes: number;
  /** 设备名，仅用于在设备表里区分自己。 */
  deviceName: string;
}

/** 单次同步的统计，供设置页展示。 */
export interface SyncStats {
  pushedSessions: number;
  pulledSessions: number;
  deletedSessions: number;
  pushedSettings: number;
  pulledSettings: number;
  pushedCredentials: number;
  pulledCredentials: number;
  conflicts: number;
}

/** 同步运行态。只由 background 写；设置页与侧边栏响应式读取。 */
export interface SyncState {
  /** 本机标识（首次启用时生成，永久保留）。 */
  deviceId: string;
  lastSyncAt: number | null;
  lastAttemptAt: number | null;
  /** 上次失败的本地化错误码（成功时清空）。 */
  lastError: string | null;
  /** 上次成功同步时，远端各会话的 updatedAt —— 三方合并的基线。 */
  sessions: Record<string, number>;
  /** 上次成功同步后，本地设置值的哈希 —— 用来判断「本地是否改过」。 */
  settings: Record<string, BaselineEntry>;
  /** 同上，按 provider id。 */
  credentials: Record<string, BaselineEntry>;
  /** 上次同步的统计。 */
  lastStats: SyncStats | null;
}

/** 基线：某条目在上次成功同步时的哈希与远端时间戳。 */
export interface BaselineEntry {
  hash: string;
  updatedAt: number;
}

// ─── 远端仓库 ───

/** meta.json：派生密钥所需的公开参数。 */
export interface SyncKeyMeta {
  v: number;
  /** base64 编码的随机 salt（16 字节）。 */
  salt: string;
  iterations: number;
}

/** 一台设备的登记信息。 */
export interface SyncDeviceInfo {
  name: string;
  lastSyncAt: number;
}

/** 会话在索引里的元数据。 */
export interface SyncSessionMeta {
  updatedAt: number;
}

/** 远端索引（加密）。 */
export interface SyncIndex {
  version: number;
  updatedAt: number;
  devices: Record<string, SyncDeviceInfo>;
  sessions: Record<string, SyncSessionMeta>;
  /** 墓碑：已删除会话 id → 删除时间。删除必须显式传播，否则别的设备会把它推回来。 */
  tombstones: Record<string, number>;
}

/** 一个可合并条目的远端形态。 */
export interface SyncEntry<T> {
  value: T;
  updatedAt: number;
}

/** 设置 / 密钥的远端负载（加密）。 */
export interface SyncBlob<T> {
  entries: Record<string, SyncEntry<T>>;
}

/** 空索引。 */
export function emptySyncIndex(now: number): SyncIndex {
  return {
    version: SYNC_SCHEMA_VERSION,
    updatedAt: now,
    devices: {},
    sessions: {},
    tombstones: {},
  };
}

/** 空状态。 */
export function emptySyncState(): SyncState {
  return {
    deviceId: '',
    lastSyncAt: null,
    lastAttemptAt: null,
    lastError: null,
    sessions: {},
    settings: {},
    credentials: {},
    lastStats: null,
  };
}

/** 空统计。 */
export function emptySyncStats(): SyncStats {
  return {
    pushedSessions: 0,
    pulledSessions: 0,
    deletedSessions: 0,
    pushedSettings: 0,
    pulledSettings: 0,
    pushedCredentials: 0,
    pulledCredentials: 0,
    conflicts: 0,
  };
}

/** 同步失败的错误码（本地化文案由 UI 侧映射）。 */
export type SyncErrorCode =
  | 'notConfigured'
  | 'disabled'
  | 'wrongPassword'
  | 'incompatible'
  | 'network'
  | 'unauthorized'
  | 'server'
  | 'busy'
  | 'unknown';
