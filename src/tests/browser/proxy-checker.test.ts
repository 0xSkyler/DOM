import { describe, expect, it } from 'vitest';
import { GoogleProxyChecker } from '../../core/proxy-pool/google-checker';
import { parseProxyList } from '../../core/proxy-api';
import { DEFAULT_SETTINGS } from '../../shared/types';
import { fixtureServer, forwardingProxy } from '../fixtures/server';

describe('real Chromium proxy reachability checks', () => {
  it('joins checks cancelled during context/page creation, including immediate checker shutdown', async () => {
    const site = await fixtureServer(), proxy = await forwardingProxy();
    const checker = new GoogleProxyChecker();
    const settings = { ...DEFAULT_SETTINGS, mode: 'controlled' as const, controlledSearchUrl: site.origin, maxMemoryPercent: 95 };
    try {
      expect((await checker.check(parseProxyList(proxy.server)[0], settings, new AbortController().signal)).reachable).toBe(true);
      const tasks = Array.from({ length: 3 }, () => checker.check(parseProxyList(proxy.server)[0], settings, new AbortController().signal));
      await checker.close();
      expect(await Promise.all(tasks)).toEqual(Array.from({ length: 3 }, () => ({ reachable: false })));
      expect(checker.contextCount).toBe(0);
    } finally { await checker.close(); await site.close(); await proxy.close(); }
  });
  it('uses the assigned proxy, requires a usable search form, rejects challenges and failures, and disposes every check context', async () => {
    const site = await fixtureServer(), proxy = await forwardingProxy();
    const checker = new GoogleProxyChecker({ timeoutMs: 1000 });
    const candidate = parseProxyList(proxy.server)[0];
    const settings = { ...DEFAULT_SETTINGS, mode: 'controlled' as const, controlledSearchUrl: site.origin, maxMemoryPercent: 95 };
    const signal = new AbortController().signal;
    try {
      expect(await checker.check(candidate, settings, signal)).toEqual({ reachable: true });
      expect(proxy.requests.some(url => url === `${site.origin}/`)).toBe(true);
      for (const path of ['/captcha', '/challenge', '/denied']) {
        expect(await checker.check(candidate, { ...settings, controlledSearchUrl: site.origin + path }, signal)).toEqual({ reachable: false, challenged: true });
      }
      expect(await checker.check(candidate, { ...settings, controlledSearchUrl: site.origin + '/unsupported' }, signal)).toEqual({ reachable: false });
      expect(await checker.check(candidate, { ...settings, controlledSearchUrl: site.origin + '/slow' }, signal)).toEqual({ reachable: false });
      expect(checker.contextCount).toBe(0);
      await proxy.close();
      expect(await checker.check(candidate, settings, signal)).toEqual({ reachable: false });
      expect(checker.contextCount).toBe(0);
    } finally { await checker.close(); await site.close(); await proxy.close(); }
  });
  it('cancels a stalled check and closes the browser on shutdown', async () => {
    const site = await fixtureServer(), proxy = await forwardingProxy();
    const checker = new GoogleProxyChecker(); const stop = new AbortController();
    try {
      const task = checker.check(parseProxyList(proxy.server)[0], { ...DEFAULT_SETTINGS, mode: 'controlled', controlledSearchUrl: site.origin + '/slow', maxMemoryPercent: 95 }, stop.signal);
      while (!site.logs.some(log => log.path === '/slow')) await new Promise(resolve => setTimeout(resolve, 10));
      stop.abort(); await checker.close(); expect(await task).toEqual({ reachable: false }); expect(checker.contextCount).toBe(0);
    } finally { stop.abort(); await checker.close(); await site.close(); await proxy.close(); }
  });
});
