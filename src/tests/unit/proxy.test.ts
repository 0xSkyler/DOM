import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchProxyList, parseProxyList, redactSecrets } from '../../core/proxy-api';
import { ProxyPool } from '../../core/proxy-pool';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

afterEach(() => vi.useRealTimers());
describe('proxy parsing and allocation', () => {
  it('accepts a ProxyScrape protocolipport response including SOCKS4 without changing protocols', () => {
    const list = parseProxyList('http://192.0.2.1:80\r\nsocks4://192.0.2.2:1080\r\nsocks5://192.0.2.3:1080\nhttps://192.0.2.4:443');
    expect(list.map(x => x.server)).toEqual(['http://192.0.2.1:80', 'socks4://192.0.2.2:1080', 'socks5://192.0.2.3:1080', 'https://192.0.2.4:443']);
    expect(parseProxyList('socks4://u:secret@192.0.2.1:1080')).toEqual([]);
  });
  it('accepts plain IPv4, host and IPv6 addresses as HTTP and deduplicates against URLs', () => {
    const list = parseProxyList('192.0.2.1:8080\nhttp://192.0.2.1:8080\nhost.test:3128\n[::1]:80\nhttp://host.test:3128\ninvalid:port\n192.0.2.2:99999');
    expect(list.map(x => x.server)).toEqual(['http://192.0.2.1:8080', 'http://host.test:3128', 'http://[::1]:80']);
    expect(parseProxyList('[::1]:80')[0].server).toBe('http://[::1]:80');
  });
  it('accepts common JSON provider rows, protocol arrays and credentials without exposing them in IDs', () => {
    const list = parseProxyList(JSON.stringify({ data: [
      { ip: '192.0.2.1', port: '8080', protocols: ['http', 'socks4'] },
      { host: 'proxy.test', port: 443, protocol: 'https', username: 'u', password: 'secret' },
      { proxy: 'socks5://192.0.2.2:1080' }, { server: '192.0.2.3:80' },
      { ip: '192.0.2.4', port: 1080, protocol: 'socks5', username: 'unsupported' },
      { ip: '192.0.2.5', port: 8080, protocol: 'ftp' }
    ] }));
    expect(list.map(x => x.server)).toEqual(['http://192.0.2.1:8080', 'socks4://192.0.2.1:8080', 'https://proxy.test:443', 'socks5://192.0.2.2:1080', 'http://192.0.2.3:80']);
    expect(list[2]).toMatchObject({ username: 'u', password: 'secret' });
    expect(list[2].id).not.toContain('secret');
  });
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
  it('follows a real provider redirect and imports mixed proxy formats', async () => {
    const server = http.createServer((request, response) => {
      if (request.url === '/redirect') { response.writeHead(302, { Location: '/list' }); response.end(); }
      else response.end('192.0.2.1:80\nsocks4://192.0.2.2:1080\nsocks5://192.0.2.3:1080');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const list = await fetchProxyList(`http://127.0.0.1:${(server.address() as AddressInfo).port}/redirect`);
      expect(list).toHaveLength(3); expect(list[1].server).toBe('socks4://192.0.2.2:1080');
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it('makes exactly one fresh no-store request each time for background intake', async () => {
    const requests = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('http://proxy.test:8080'));
    await fetchProxyList('http://api.test/proxies', { fetch: requests });
    await fetchProxyList('http://api.test/proxies', { fetch: requests });
    expect(requests).toHaveBeenCalledTimes(2);
    expect(requests.mock.calls.every(call => call[0] === 'http://api.test/proxies')).toBe(true);
    expect(requests).toHaveBeenCalledWith('http://api.test/proxies', expect.objectContaining({ cache: 'no-store', redirect: 'follow' }));
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
