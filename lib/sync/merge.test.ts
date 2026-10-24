import { describe, it, expect } from 'vitest';
import {
  canonicalJson,
  hashValue,
  isEmptyCredential,
  isEmptyValue,
  mergeEntries,
  mergeIndexPatch,
  planEntrySync,
  planSessionSync,
} from './merge';

const NOW = 1_800_000_000_000;
const TTL = 90 * 24 * 60 * 60 * 1000;

/** 会话合并的默认输入，用例只覆盖关心的字段。 */
function sessionInput(over: Partial<Parameters<typeof planSessionSync>[0]> = {}) {
  return planSessionSync({
    local: [],
    remote: {},
    tombstones: {},
    baseline: {},
    now: NOW,
    tombstoneTtlMs: TTL,
    ...over,
  });
}

describe('planSessionSync', () => {
  it('本地独有 → 上传', () => {
    const plan = sessionInput({ local: [{ id: 'a', updatedAt: 100 }] });
    expect(plan.push).toEqual(['a']);
    expect(plan.pull).toEqual([]);
  });

  it('远端独有且无基线 → 下载（别的设备新建）', () => {
    const plan = sessionInput({ remote: { a: { updatedAt: 100 } } });
    expect(plan.pull).toEqual(['a']);
    expect(plan.push).toEqual([]);
  });

  it('远端独有但基线有 → 本机删掉了，打墓碑', () => {
    const plan = sessionInput({
      remote: { a: { updatedAt: 100 } },
      baseline: { a: 100 },
    });
    expect(plan.tombstone).toEqual({ a: NOW });
    expect(plan.pull).toEqual([]);
  });

  it('只有本地变 → 上传', () => {
    const plan = sessionInput({
      local: [{ id: 'a', updatedAt: 200 }],
      remote: { a: { updatedAt: 100 } },
      baseline: { a: 100 },
    });
    expect(plan.push).toEqual(['a']);
  });

  it('只有远端变 → 下载', () => {
    const plan = sessionInput({
      local: [{ id: 'a', updatedAt: 100 }],
      remote: { a: { updatedAt: 200 } },
      baseline: { a: 100 },
    });
    expect(plan.pull).toEqual(['a']);
  });

  it('两边都变 → updatedAt 大的赢', () => {
    const localWins = sessionInput({
      local: [{ id: 'a', updatedAt: 300 }],
      remote: { a: { updatedAt: 200 } },
      baseline: { a: 100 },
    });
    expect(localWins.push).toEqual(['a']);

    const remoteWins = sessionInput({
      local: [{ id: 'a', updatedAt: 150 }],
      remote: { a: { updatedAt: 200 } },
      baseline: { a: 100 },
    });
    expect(remoteWins.pull).toEqual(['a']);
  });

  it('都没变 → 不动作', () => {
    const plan = sessionInput({
      local: [{ id: 'a', updatedAt: 100 }],
      remote: { a: { updatedAt: 100 } },
      baseline: { a: 100 },
    });
    expect(plan.push).toEqual([]);
    expect(plan.pull).toEqual([]);
  });

  it('远端墓碑晚于本地修改 → 本机删除', () => {
    const plan = sessionInput({
      local: [{ id: 'a', updatedAt: 100 }],
      remote: { a: { updatedAt: 100 } },
      tombstones: { a: 200 },
      baseline: { a: 100 },
    });
    expect(plan.deleteLocal).toEqual(['a']);
  });

  it('本地修改晚于远端墓碑 → 复活并上传', () => {
    const plan = sessionInput({
      local: [{ id: 'a', updatedAt: 300 }],
      tombstones: { a: 200 },
      baseline: { a: 100 },
    });
    expect(plan.push).toEqual(['a']);
    expect(plan.deleteLocal).toEqual([]);
  });

  it('墓碑已在本机生效（本地也没有）→ 不再动作', () => {
    const plan = sessionInput({ tombstones: { a: 200 }, baseline: {} });
    expect(plan.push).toEqual([]);
    expect(plan.pull).toEqual([]);
    expect(plan.deleteLocal).toEqual([]);
    expect(plan.tombstone).toEqual({});
  });

  it('过期墓碑进入清理列表', () => {
    const plan = sessionInput({ tombstones: { a: NOW - TTL - 1, b: NOW - 1000 } });
    expect(plan.pruneTombstones).toEqual(['a']);
  });
});

describe('planEntrySync', () => {
  const base = (hash: string, updatedAt: number) => ({ hash, updatedAt });

  it('没有基线 + 采纳远端 → 下载（新设备继承云端配置）', () => {
    const plan = planEntrySync<unknown>({
      local: { theme: 'dark' },
      remote: { theme: { value: 'light', updatedAt: 100 } },
      baseline: {},
      localHashes: { theme: 'h-dark' },
      now: NOW,
      adoptRemoteWhenUnseen: true,
    });
    expect(plan.pull).toEqual({ theme: 'light' });
  });

  it('没有基线 + 不采纳远端 + 本地非空 → 保留本地并上传（密钥）', () => {
    const localCred = { authType: 'apiKey', apiKey: 'sk-local', verified: true };
    const remoteCred = { authType: 'apiKey', apiKey: 'sk-remote', verified: true };
    const plan = planEntrySync<unknown>({
      local: { openai: localCred },
      remote: { openai: { value: remoteCred, updatedAt: 100 } },
      baseline: {},
      localHashes: { openai: 'h-local' },
      now: NOW,
      adoptRemoteWhenUnseen: false,
      isEmpty: isEmptyCredential,
    });
    expect(plan.push.openai.value).toEqual(localCred);
    expect(plan.pull).toEqual({});
  });

  it('没有基线 + 不采纳远端 + 本地是空 key → 下载远端密钥', () => {
    const remoteCred = { authType: 'apiKey', apiKey: 'sk-remote', verified: true };
    const plan = planEntrySync<unknown>({
      local: { openai: { authType: 'apiKey', apiKey: '', verified: false } },
      remote: { openai: { value: remoteCred, updatedAt: 100 } },
      baseline: {},
      localHashes: { openai: 'h-empty' },
      now: NOW,
      adoptRemoteWhenUnseen: false,
      isEmpty: isEmptyCredential,
    });
    expect(plan.pull).toEqual({ openai: remoteCred });
  });

  it('哈希变了 = 本地改过 → 上传', () => {
    const plan = planEntrySync<unknown>({
      local: { theme: 'light' },
      remote: { theme: { value: 'dark', updatedAt: 100 } },
      baseline: { theme: base('h-old', 100) },
      localHashes: { theme: 'h-new' },
      now: NOW,
      adoptRemoteWhenUnseen: true,
    });
    expect(plan.push.theme).toEqual({ value: 'light', updatedAt: NOW });
  });

  it('远端时间戳变大 = 远端改过 → 下载', () => {
    const plan = planEntrySync<unknown>({
      local: { theme: 'dark' },
      remote: { theme: { value: 'light', updatedAt: 200 } },
      baseline: { theme: base('h-dark', 100) },
      localHashes: { theme: 'h-dark' },
      now: NOW,
      adoptRemoteWhenUnseen: true,
    });
    expect(plan.pull).toEqual({ theme: 'light' });
  });

  it('两边都改 → 保留本地并记冲突', () => {
    const plan = planEntrySync<unknown>({
      local: { theme: 'light' },
      remote: { theme: { value: 'dark', updatedAt: 200 } },
      baseline: { theme: base('h-old', 100) },
      localHashes: { theme: 'h-new' },
      now: NOW,
      adoptRemoteWhenUnseen: true,
    });
    expect(plan.conflicts).toEqual(['theme']);
    expect(plan.push.theme.value).toBe('light');
    expect(plan.pull).toEqual({});
  });

  it('远端没有该 key → 上传', () => {
    const plan = planEntrySync<unknown>({
      local: { custom: 1 },
      remote: {},
      baseline: {},
      localHashes: { custom: 'h' },
      now: NOW,
      adoptRemoteWhenUnseen: true,
    });
    expect(plan.push.custom.value).toBe(1);
  });

  it('本地没有该 key、远端有 → 下载', () => {
    const plan = planEntrySync<unknown>({
      local: {},
      remote: { custom: { value: 1, updatedAt: 100 } },
      baseline: {},
      localHashes: {},
      now: NOW,
      adoptRemoteWhenUnseen: true,
    });
    expect(plan.pull).toEqual({ custom: 1 });
  });
});

describe('mergeEntries', () => {
  it('按 key 取 updatedAt 较大的那条', () => {
    const merged = mergeEntries(
      { a: { value: 'remote', updatedAt: 200 }, b: { value: 'remote-b', updatedAt: 100 } },
      { a: { value: 'local', updatedAt: 100 }, c: { value: 'local-c', updatedAt: 50 } },
    );
    expect(merged.a.value).toBe('remote');
    expect(merged.b.value).toBe('remote-b');
    expect(merged.c.value).toBe('local-c');
  });

  it('时间戳相等时本地覆盖（同一毫秒的重复写入以本次为准）', () => {
    const merged = mergeEntries(
      { a: { value: 'remote', updatedAt: 100 } },
      { a: { value: 'local', updatedAt: 100 } },
    );
    expect(merged.a.value).toBe('local');
  });
});

describe('mergeIndexPatch', () => {
  it('设备取 lastSyncAt 较新的，会话取 updatedAt 较大的，墓碑取较晚的', () => {
    const merged = mergeIndexPatch(
      {
        devices: { d1: { name: 'old', lastSyncAt: 100 } },
        sessions: { s1: { updatedAt: 100 }, s2: { updatedAt: 300 } },
        tombstones: { s3: 100 },
      },
      {
        devices: { d1: { name: 'new', lastSyncAt: 200 } },
        sessions: { s1: { updatedAt: 200 }, s2: { updatedAt: 200 } },
        tombstones: { s3: 200 },
      },
    );
    expect(merged.devices.d1).toEqual({ name: 'new', lastSyncAt: 200 });
    expect(merged.sessions.s1.updatedAt).toBe(200);
    expect(merged.sessions.s2.updatedAt).toBe(300);
    expect(merged.tombstones.s3).toBe(200);
  });
});

describe('哈希与规范序列化', () => {
  it('键序不同不影响哈希', async () => {
    const a = await hashValue({ x: 1, y: { b: 2, a: 3 } });
    const b = await hashValue({ y: { a: 3, b: 2 }, x: 1 });
    expect(a).toBe(b);
  });

  it('数组顺序有意义（不排序）', async () => {
    const a = await hashValue([1, 2]);
    const b = await hashValue([2, 1]);
    expect(a).not.toBe(b);
  });

  it('canonicalJson 丢弃 undefined 字段', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('isEmptyValue 识别空值', () => {
    expect(isEmptyValue('')).toBe(true);
    expect(isEmptyValue('  ')).toBe(true);
    expect(isEmptyValue({})).toBe(true);
    expect(isEmptyValue([])).toBe(true);
    expect(isEmptyValue(null)).toBe(true);
    expect(isEmptyValue({ apiKey: '' })).toBe(false); // 对象非空即视为「填过」
    expect(isEmptyValue('sk-x')).toBe(false);
  });

  it('isEmptyCredential 把「空 key 的对象」也算没填', () => {
    expect(isEmptyCredential({ authType: 'apiKey', apiKey: '', verified: false })).toBe(true);
    expect(isEmptyCredential({ authType: 'apiKey', apiKey: '  ', verified: false })).toBe(true);
    expect(isEmptyCredential({ authType: 'oauth', accessToken: '' })).toBe(true);
    expect(isEmptyCredential({ authType: 'apiKey', apiKey: 'sk-x', verified: true })).toBe(false);
    expect(isEmptyCredential({ authType: 'oauth', accessToken: 'tok' })).toBe(false);
  });
});
