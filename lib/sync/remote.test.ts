import { describe, it, expect } from 'vitest';
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
