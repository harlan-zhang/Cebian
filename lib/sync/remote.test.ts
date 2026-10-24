import { describe, it, expect, vi, afterEach } from 'vitest';
import { assertSafeDirectory, assertValidBaseUrl, SyncRemote, SyncRemoteError } from './remote';

describe('同步服务器地址校验', () => {
  it('接受干净的 http(s) 地址', () => {
    expect(() => assertValidBaseUrl('https://dav.example.com/remote.php/dav/files/u')).not.toThrow();
    expect(() => assertValidBaseUrl('http://192.168.1.2:5244/dav')).not.toThrow();
  });

  it('拒绝非 http(s)、带账号、带 query / fragment 的地址', () => {
    for (const url of [
      'ftp://example.com',
      'https://user:pass@example.com',
      'https://example.com/dav?x=1',
      'https://example.com/dav#top',
      'not-a-url',
    ]) {
      expect(() => assertValidBaseUrl(url)).toThrow(SyncRemoteError);
    }
  });
});

describe('远程目录校验', () => {
  it('接受多级普通目录', () => {
    expect(() => assertSafeDirectory('/cebian-sync')).not.toThrow();
    expect(() => assertSafeDirectory('a/b/c')).not.toThrow();
    expect(() => assertSafeDirectory('')).not.toThrow();
  });

  it('拒绝路径逃逸片段', () => {
    for (const dir of ['../etc', 'a/../../b', 'a\\b']) {
      expect(() => assertSafeDirectory(dir)).toThrow(SyncRemoteError);
    }
  });
});

describe('SyncRemote 构造', () => {
  it('构造时即校验地址与目录', () => {
    expect(
      () =>
        new SyncRemote({
          url: 'https://dav.example.com/dav',
          username: 'u',
          password: 'p',
          directory: '/cebian-sync',
        }),
    ).not.toThrow();
    expect(
      () =>
        new SyncRemote({
          url: 'https://dav.example.com/dav',
          username: 'u',
          password: 'p',
          directory: '../escape',
        }),
    ).toThrow(SyncRemoteError);
  });
});

describe('ensureDirectories', () => {
  const config = {
    url: 'https://dav.example.com/dav',
    username: 'u',
    password: 'p',
    directory: '/cebian',
  };

  /** 用假 fetch 记录请求序列，按 handler 返回状态码。 */
  function stubFetch(handler: (url: string, method: string) => number) {
    const calls: Array<{ url: string; method: string }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        calls.push({ url, method });
        return new Response(null, { status: handler(url, method) });
      }),
    );
    return calls;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('目录都已存在时只探测、不发 MKCOL（服务端对已存在目录 MKCOL 返回 403 时不会误报鉴权失败）', async () => {
    const calls = stubFetch(() => 207);
    await new SyncRemote(config).ensureDirectories();

    expect(calls.every((c) => c.method === 'PROPFIND')).toBe(true);
    // 配置目录 + sync + sessions，共三级
    expect(calls).toHaveLength(3);
  });

  it('缺失的层级才创建', async () => {
    const calls = stubFetch((url, method) => {
      if (method === 'PROPFIND') {
        // /cebian 已存在，其下的 sync / sessions 不存在
        return url.endsWith('/cebian') ? 207 : 404;
      }
      return 201;
    });
    await new SyncRemote(config).ensureDirectories();

    const mkcol = calls.filter((c) => c.method === 'MKCOL').map((c) => c.url);
    expect(mkcol).toHaveLength(2);
    expect(mkcol[0]).toContain('/cebian/sync');
    expect(mkcol[1]).toContain('/cebian/sync/sessions');
    // 不能出现 sync/sync —— 早先按段拼接时多建的一层
    expect(calls.some((c) => c.url.includes('/sync/sync'))).toBe(false);
  });

  it('MKCOL 返回 403 但复查发现目录其实已存在 → 视为成功', async () => {
    let probedSessions = false;
    stubFetch((url, method) => {
      if (method === 'PROPFIND') {
        if (url.endsWith('/sessions')) {
          // 第一次探测说不存在，MKCOL 被拒后复查说存在
          if (!probedSessions) {
            probedSessions = true;
            return 404;
          }
          return 207;
        }
        return 207;
      }
      return 403;
    });

    await expect(new SyncRemote(config).ensureDirectories()).resolves.toBeUndefined();
  });

  it('MKCOL 返回 403 且复查仍不存在 → 抛 forbidden（不再谎报成认证失败）', async () => {
    stubFetch((url, method) => {
      if (method === 'PROPFIND') return url.endsWith('/cebian') ? 207 : 404;
      return 403;
    });

    await expect(new SyncRemote(config).ensureDirectories()).rejects.toMatchObject({
      code: 'forbidden',
    });
  });
});
