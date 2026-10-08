import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchProxyList, parseProxyList, redactSecrets } from '../../core/proxy-api';
import { ProxyPool } from '../../core/proxy-pool';

afterEach(() => vi.useRealTimers());
describe('proxy parsing and allocation', () => {
  it('normalizes formats and credentials, deduplicates, and ignores malformed records', () => {
    const entries = parseProxyList('http://HOST.test:8080\nhttp://host.test:8080/\nhttps://secure.test:443\nsocks5://[::1]:1080\nhttp://user:p%40ss@auth.test:80\ninvalid\nftp://ftp.test:21\nhttp://host.test:0\nhttp://host.test:99999\nhttp://host.test:80/path\nsocks5://user:pass@host.test:1080');
    expect(entries).toHaveLength(4);
    expect(entries[0].server).toBe('http://host.test:8080');
    expect(entries[1].server).toBe('https://secure.test:443');
    expect(entries[2].server).toBe('socks5://[::1]:1080');
    expect(entries[3]).toMatchObject({ server: 'http://auth.test:80', username: 'user', password: 'p@ss' });
    expect(entries[3].id).not.toContain('user'); expect(entries[3].id).not.toContain('p@ss');
    expect(parseProxyList('http://user:p%40ss@auth.test:80')[0].id).toBe(entries[3].id);
    expect(parseProxyList('{"proxies":["http://host.test:80", {"url":"https://host.test:443"}]}')).toHaveLength(2);
    expect(parseProxyList('{malformed')).toEqual([]);
  });
  it('never silently reuses failed/released allocations or permits direct fallback', () => {
    const pool = new ProxyPool(parseProxyList('http://one.test:8080\nhttp://two.test:8080'));
    expect(pool.allocate('one')?.server).toBe('http://one.test:8080');
    expect(pool.allocate('two')?.server).toBe('http://two.test:8080');
    expect(pool.allocate('three')).toBeUndefined();
    expect(pool.release('one', true)?.state).toBe('FAILED');
    expect(pool.release('two')?.state).toBe('RELEASED');
    expect(pool.available).toBe(0); expect(pool.assigned).toBe(0);
    expect(pool.allocate('new')).toBeUndefined();
    expect(new ProxyPool([]).allocate('empty')).toBeUndefined();
  });
  it('does not mutate the API response and exposes no credentials in snapshots', () => {
    const entries = parseProxyList('http://user:secret@one.test:8080');
    const pool = new ProxyPool(entries);
    pool.allocate('one');
    expect(entries[0].state).toBe('AVAILABLE');
    expect(JSON.stringify(pool.snapshot())).not.toContain('secret');
  });
});
describe('fresh API fetching', () => {
  it('makes exactly one fresh no-store request each time without proxy prevalidation', async () => {
    const requests = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('http://proxy.test:8080'));
    await fetchProxyList('http://api.test/proxies', { fetch: requests });
    await fetchProxyList('http://api.test/proxies', { fetch: requests });
    expect(requests).toHaveBeenCalledTimes(2);
    expect(requests.mock.calls.every(call => call[0] === 'http://api.test/proxies')).toBe(true);
    expect(requests).toHaveBeenCalledWith('http://api.test/proxies', expect.objectContaining({ cache: 'no-store', redirect: 'error' }));
  });
  it('rejects HTTP and empty-pool failures without exposing response data', async () => {
    await expect(fetchProxyList('http://api.test', { fetch: async () => new Response('user:password', { status: 503 }) })).rejects.toThrow('HTTP 503');
    await expect(fetchProxyList('http://api.test', { fetch: async () => new Response('') })).rejects.toThrow('no usable');
  });
  it('interrupts hanging fetches at a bounded timeout and on STOP', async () => {
    vi.useFakeTimers();
    const hanging: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
    const request = fetchProxyList('http://api.test', { fetch: hanging, timeoutMs: 100 });
    const result = expect(request).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(100); await result;
    const stop = new AbortController();
    const cancelled = fetchProxyList('http://api.test', { fetch: hanging, signal: stop.signal });
    stop.abort(); await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('redacts URL credentials, sensitive API parameters and known proxy passwords', () => {
    const text = redactSecrets(new Error('http://user:p@ss@host.test:80?api_key=abc&token=xyz secretpass'), ['secretpass']);
    expect(text).not.toContain('secretpass'); expect(text).not.toContain('abc'); expect(text).not.toContain('xyz');
    expect(redactSecrets('http://user:pass@host.test')).toBe('http://[redacted]@host.test');
  });
});
