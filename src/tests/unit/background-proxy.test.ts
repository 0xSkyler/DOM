import { describe, expect, it, vi } from 'vitest';
import { BackgroundProxyPool, type ProxyChecker } from '../../core/proxy-pool/background';
import { parseProxyList } from '../../core/proxy-api';
import { DEFAULT_SETTINGS } from '../../shared/types';

const createPool = (checker: ProxyChecker, options: NonNullable<ConstructorParameters<typeof BackgroundProxyPool>[1]> = {}) =>
  new BackgroundProxyPool(checker, { memoryUsage: () => ({ usedBytes: 0, totalBytes: 100 }), ...options });

const entries = parseProxyList('http://u:private@one.test:8080\nhttp://two.test:8080\nhttp://three.test:8080');
const settings = { ...DEFAULT_SETTINGS, validateProxies: true, keywords: 'A,B', target: 'example.com' };
const wait = (check: () => void) => vi.waitFor(check, { timeout: 3000, interval: 5 });
describe('background checked proxy pool', () => {
  it('assigns every fetched proxy by default without Google checks, validation expiry or check-memory limits', async () => {
    let now = 0;
    const checker: ProxyChecker = { check: vi.fn(async () => ({ reachable: false })), close: async () => {} };
    const service = createPool(checker, { fetcher: async () => entries, capacity: 2, ttlMs: 10, tickMs: 5, now: () => now, memoryUsage: () => ({ usedBytes: 99, totalBytes: 100 }) });
    try {
      await service.configure({ ...settings, validateProxies: false });
      await wait(() => expect(service.snapshot()).toMatchObject({ validationEnabled: false, fetched: 3, ready: 3, checking: 0, deferred: 0, pauseReason: undefined }));
      const first = service.cyclePool(), second = service.cyclePool();
      const allocated = [first.allocate('A'), first.allocate('B'), second.allocate('C')];
      expect(new Set(allocated.map(proxy => proxy?.id)).size).toBe(3); expect(second.allocate('D')).toBeUndefined();
      first.releaseAll(); second.releaseAll(); now = 1000;
      expect(service.snapshot()).toMatchObject({ ready: 3, expired: 0, assigned: 0 });
      expect(checker.check).not.toHaveBeenCalled();
    } finally { await service.close(); }
  });
  it('clears unchecked eligibility when enabled and cancels an in-flight check when disabled again', async () => {
    let cancelled = false;
    const checker: ProxyChecker = { check: vi.fn(async (proxy, _settings, signal) => {
      if (proxy.id === entries[0].id) return { reachable: true };
      return new Promise<{ reachable: boolean }>(resolve => { signal.addEventListener('abort', () => { cancelled = true; resolve({ reachable: false }); }, { once: true }); });
    }), close: async () => {} };
    const service = createPool(checker, { fetcher: async () => entries, concurrency: 1, tickMs: 5 });
    try {
      await service.configure({ ...settings, validateProxies: false });
      await wait(() => expect(service.snapshot().ready).toBe(3));
      await service.configure(settings);
      await wait(() => expect(service.snapshot()).toMatchObject({ validationEnabled: true, ready: 1, checking: 1 }));
      const reservations = service.cyclePool(); expect(reservations.allocate('A')?.id).toBe(entries[0].id); expect(reservations.allocate('B')).toBeUndefined(); reservations.releaseAll();
      await service.configure({ ...settings, validateProxies: false });
      await wait(() => expect(service.snapshot()).toMatchObject({ validationEnabled: false, ready: 3, checking: 0 }));
      expect(cancelled).toBe(true); expect(checker.check).toHaveBeenCalledTimes(2);
    } finally { await service.close(); }
  });
  it('reports memory deferral, keeps fetching, and checks saved candidates when memory recovers', async () => {
    let usedBytes = 85, now = 0;
    const checker: ProxyChecker = { check: vi.fn(async () => ({ reachable: true })), close: async () => {} };
    const fetcher = vi.fn(async () => entries);
    const service = createPool(checker, { fetcher, memoryUsage: () => ({ usedBytes, totalBytes: 100 }), now: () => now, refreshMs: 100, tickMs: 5 });
    try {
      await service.configure(settings);
      await wait(() => expect(service.snapshot()).toMatchObject({ fetched: 3, deferred: 3, pending: 0, checking: 0, ready: 0 }));
      expect(service.snapshot().pauseReason).toContain('85.0%'); expect(service.snapshot().pauseReason).toContain('80%');
      expect(checker.check).not.toHaveBeenCalled(); now = 101;
      await wait(() => expect(fetcher).toHaveBeenCalledTimes(2));
      usedBytes = 50;
      await wait(() => expect(service.snapshot()).toMatchObject({ ready: 3, deferred: 0, pauseReason: undefined }));
      expect(service.cyclePool().allocate('recovered')).toBeDefined();
    } finally { await service.close(); }
  });
  it('does not let immediate retries starve untouched provider candidates', async () => {
    const seen: string[] = [];
    const service = createPool({ check: async proxy => { seen.push(proxy.id); return { reachable: proxy.id === entries[2].id }; }, close: async () => {} },
      { fetcher: async () => entries, concurrency: 1, retryMs: 0, tickMs: 5 });
    try {
      await service.configure(settings); await wait(() => expect(service.snapshot().ready).toBe(1));
      expect(seen.slice(0, 3)).toEqual(entries.map(x => x.id));
    } finally { await service.close(); }
  });
  it('replaces failed candidates in full pools with later provider entries while retaining cooldowns', async () => {
    let now = 0;
    const service = createPool({ check: async proxy => ({ reachable: proxy.id === entries[2].id }), close: async () => {} },
      { fetcher: async () => entries, capacity: 2, now: () => now, refreshMs: 100, retryMs: 10000, tickMs: 5 });
    try {
      await service.configure(settings); await wait(() => expect(service.snapshot().failed).toBe(2));
      now = 101; await wait(() => expect(service.snapshot().ready).toBe(1));
      expect(service.cyclePool().allocate('later')?.id).toBe(entries[2].id);
      expect(service.snapshot().checking).toBe(0);
    } finally { await service.close(); }
  });
  it('retains assigned healthy proxies when later entries replace failures in a full pool', async () => {
    let now = 0;
    const service = createPool({ check: async proxy => ({ reachable: proxy.id !== entries[1].id }), close: async () => {} },
      { fetcher: async () => entries, capacity: 2, now: () => now, refreshMs: 100, retryMs: 10000, tickMs: 5 });
    try {
      await service.configure(settings); await wait(() => expect(service.snapshot()).toMatchObject({ ready: 1, failed: 1 }));
      const first = service.cyclePool(); expect(first.allocate('held')?.id).toBe(entries[0].id);
      now = 101; await wait(() => expect(service.snapshot()).toMatchObject({ assigned: 1, ready: 1 }));
      expect(service.cyclePool().allocate('later')?.id).toBe(entries[2].id);
      expect(first.assigned).toBe(1); expect(service.snapshot().assigned).toBe(2);
    } finally { await service.close(); }
  });
  it('admits only passed proxies, reserves exclusively, reuses across cycle pools, and hides credentials', async () => {
    const checker: ProxyChecker = { check: vi.fn(async proxy => ({ reachable: proxy.id === entries[0].id, challenged: proxy.id === entries[1].id })), close: vi.fn(async () => {}) };
    const fetcher = vi.fn(async () => entries);
    const service = createPool(checker, { fetcher, tickMs: 5 });
    try {
      await service.configure(settings);
      await wait(() => expect(service.snapshot()).toMatchObject({ ready: 1, failed: 1, challenged: 1 }));
      const first = service.cyclePool(), second = service.cyclePool();
      expect(first.allocate('A')?.id).toBe(entries[0].id); expect(first.allocate('A')).toBeUndefined();
      expect(second.allocate('B')).toBeUndefined(); expect(service.snapshot().assigned).toBe(1);
      first.releaseAll(); expect(second.allocate('B')?.id).toBe(entries[0].id);
      second.release('B', true); expect(first.allocate('C')).toBeUndefined();
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(service.snapshot())).not.toContain('private');
    } finally { await service.close(); }
    expect(service.snapshot()).toMatchObject({ running: false, ready: 0, checking: 0, assigned: 0 });
  });
  it('expires checks before assignment, rechecks idle entries, and keeps assigned ones exclusive', async () => {
    let now = 0; let pass = true;
    const service = createPool({ check: vi.fn(async () => ({ reachable: pass })), close: async () => {} }, {
      fetcher: async () => entries.slice(0, 1), now: () => now, ttlMs: 100, tickMs: 5
    });
    try {
      await service.configure(settings); await wait(() => expect(service.snapshot().ready).toBe(1));
      const pool = service.cyclePool(); now = 101;
      expect(pool.allocate('expired')).toBeUndefined();
      await wait(() => expect(service.snapshot().ready).toBe(1));
      expect(pool.allocate('held')).toBeDefined(); now = 250; pass = false;
      expect(service.cyclePool().allocate('duplicate')).toBeUndefined();
      pool.release('held'); expect(pool.allocate('unchecked')).toBeUndefined();
      await wait(() => expect(service.snapshot().failed).toBe(1));
    } finally { await service.close(); }
  });
  it('bounds simultaneous checks and cancels in-flight work when configuration changes', async () => {
    let active = 0, peak = 0;
    const checker: ProxyChecker = {
      check: async (_proxy, _settings, signal) => {
        active++; peak = Math.max(peak, active);
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
        active--; return { reachable: true };
      }, close: async () => {}
    };
    const service = createPool(checker, { fetcher: async () => entries, concurrency: 2, tickMs: 5 });
    try {
      await service.configure(settings); await wait(() => expect(active).toBe(2));
      await service.configure({ ...settings, proxyApiUrl: 'http://new.test/proxies' });
      expect(service.snapshot().ready).toBe(0); expect(peak).toBe(2);
    } finally { await service.close(); }
    expect(active).toBe(0); expect(service.snapshot().checking).toBe(0);
  });
  it('refreshes API independently of allocations, drops removed candidates, and retries API failures', async () => {
    let now = 0, response = entries, broken = false;
    const fetcher = vi.fn(async () => { if (broken) throw new Error('http://u:private@api.test/?token=secret'); return response; });
    const service = createPool({ check: async () => ({ reachable: true }), close: async () => {} }, { fetcher, now: () => now, refreshMs: 100, tickMs: 5 });
    try {
      await service.configure(settings); await wait(() => expect(service.snapshot().ready).toBe(3));
      const pool = service.cyclePool(); const held = pool.allocate('A')!;
      response = entries.filter(x => x.id !== held.id); now = 101;
      await wait(() => expect(fetcher).toHaveBeenCalledTimes(2)); pool.release('A');
      expect(service.snapshot().ready).toBe(2);
      broken = true; now = 202;
      await wait(() => expect(service.snapshot().error).toContain('[redacted]'));
      expect(service.snapshot().error).not.toContain('private'); expect(service.snapshot().error).not.toContain('secret');
      broken = false; now = 303; await wait(() => expect(fetcher).toHaveBeenCalledTimes(4));
      expect(service.snapshot().error).toBeUndefined();
    } finally { await service.close(); }
  });
});
