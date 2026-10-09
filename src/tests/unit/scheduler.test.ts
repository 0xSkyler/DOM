import { describe, expect, it, vi } from 'vitest';
import { Controller } from '../../core/scheduler/controller';
import { parseProxyList } from '../../core/proxy-api';
import { BackgroundProxyPool } from '../../core/proxy-pool/background';
import { DEFAULT_SETTINGS, type BrowserDriver, type Clock, type EventSink, type ProxyEntry, type RepositoryStore, type SessionView, type Settings, type Worker } from '../../shared/types';

async function flush() { for (let i = 0; i < 100; i++) await Promise.resolve(); }
class FakeClock implements Clock {
  time = 1700000000000;
  waits = new Set<{ until: number; finish: () => void }>();
  now() { return this.time; }
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })); return; }
      const item = { until: this.time + ms, finish: () => { signal?.removeEventListener('abort', abort); this.waits.delete(item); resolve(); } };
      const abort = () => { this.waits.delete(item); reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })); };
      signal?.addEventListener('abort', abort, { once: true }); this.waits.add(item);
    });
  }
  async advance(ms: number) { this.time += ms; for (const item of [...this.waits]) if (item.until <= this.time) item.finish(); await flush(); }
}
function store(): RepositoryStore {
  return { saveCycle: vi.fn(), saveRanking: vi.fn(), saveObservation: vi.fn(), saveDiagnostic: vi.fn(), saveNavigation: vi.fn(), saveSession: vi.fn(), saveAllocation: vi.fn() };
}
const settings = (overrides: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, keywords: 'A, B, C', target: 'example.com', rotationSeconds: 1, apiRetries: 0, ...overrides });
function proxies(generation: number, count = 12) { return parseProxyList(Array.from({ length: count }, (_, i) => `http://pool${generation}-${i}.test:8080`).join('\n')); }
interface Created { worker: Worker; id: string; cycle: number; keyword: string; proxy: ProxyEntry; sink: EventSink; closed: boolean; }
function driver(run?: (created: Created, signal: AbortSignal) => Promise<void>) {
  const created: Created[] = [];
  const instance: BrowserDriver = {
    launch: vi.fn(async () => {}), close: vi.fn(async () => {}),
    create: vi.fn(async (id, cycle, keyword, proxy, _settings, sink) => {
      const view: SessionView = { id, cycle, keyword, proxyId: proxy.id, state: 'READY', url: '', lastAction: '', retryCount: 0, startedAt: 1700000000000, navigationCount: 0 };
      const record = { id, cycle, keyword, proxy, sink, closed: false } as Created;
      const worker: Worker = { view,
        run: async signal => {
          if (run) return run(record, signal);
          sink.ranking({ keyword, target: 'example.com', url: 'https://example.com/post', title: 'Article', organicPosition: 1, elementPosition: 2, resultPage: 1, sessionId: id, proxyId: proxy.id, device: 'desktop', searchLocation: 'fixture', cycle, timestamp: '2023-11-14T22:13:20.000Z' });
          await untilAbort(signal);
        },
        close: vi.fn(async () => { record.closed = true; }), preview: vi.fn(async () => 'data:image/png;base64,test'), openResult: vi.fn(async () => {}), setLiveView: vi.fn(async () => {}), interact: vi.fn(async () => {}) };
      record.worker = worker; created.push(record); return worker;
    })
  };
  return { instance, created };
}
function untilAbort(signal: AbortSignal): Promise<void> { return new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); }); }

describe('central scheduler', () => {
  it('controls only the focused current browser, rejects malformed/stale input and keeps frames out of stored state', async () => {
    const clock = new FakeClock(), browser = driver(), db = store();
    const controller = new Controller({ driver: browser.instance, store: db, clock, fetchProxies: async () => proxies(1, 10) });
    const frame = vi.fn(); controller.onFrame(frame);
    try {
      await controller.start(settings({ rotationSeconds: 10 })); await flush();
      const current = browser.created[0], input = { type: 'down' as const, x: 100, y: 100 };
      await expect(controller.browserInput(current.id, current.cycle, input)).rejects.toThrow(/Open/);
      await controller.liveView(current.id, current.cycle);
      await controller.browserInput(current.id, current.cycle, input); expect(current.worker.interact).toHaveBeenCalledWith(input);
      for (const bad of [{ ...input, x: NaN }, { ...input, type: 'script' }, { ...input, type: 'wheel', deltaY: Infinity }]) await expect(controller.browserInput(current.id, current.cycle, bad as typeof input)).rejects.toThrow(/Invalid/);
      await expect(controller.browserInput(current.id, current.cycle + 1, input)).rejects.toThrow(/Open/);
      const packet = { sessionId: current.id, cycle: current.cycle, image: 'data:image/jpeg;base64,frame', viewportWidth: 1280, viewportHeight: 800 };
      current.sink.frame!(packet); expect(frame).toHaveBeenCalledWith(packet);
      expect(JSON.stringify(controller.snapshot())).not.toContain('base64');
      await controller.stop(); current.sink.frame!(packet); expect(frame).toHaveBeenCalledTimes(1);
      await expect(controller.browserInput(current.id, current.cycle, input)).rejects.toThrow(/Open/);
    } finally { await controller.stop(); }
  });
  it('waits for checked proxies, retries without hanging, backfills sessions, and reuses reservations across rotations', async () => {
    const clock = new FakeClock(), browser = driver(); let readyCount = 0;
    const fetcher = vi.fn(async () => proxies(1, 10));
    const service = new BackgroundProxyPool({ check: async proxy => ({ reachable: Number(proxy.server.match(/-(\d+)\.test/)?.[1]) < readyCount }), close: async () => {} },
      { fetcher, now: () => clock.now(), tickMs: 5, retryMs: 0 });
    const controller = new Controller({ driver: browser.instance, store: store(), clock, backgroundProxies: service });
    try {
      await controller.start(settings({ rotationSeconds: 10, validateProxies: true })); await flush();
      expect(controller.snapshot().status).toBe('WAITING_FOR_PROXIES');
      await controller.resume(); // Must return even while the background worker has no ready entries.
      readyCount = 2;
      await vi.waitFor(() => expect(service.snapshot().ready).toBe(2), { interval: 5 });
      await clock.advance(1000); expect(controller.snapshot().status).toBe('RUNNING');
      expect(browser.created).toHaveLength(2);
      readyCount = 10;
      await vi.waitFor(() => expect(service.snapshot().ready).toBe(8), { interval: 5 });
      await clock.advance(1000); await clock.advance(1000); await clock.advance(1000);
      expect(browser.created).toHaveLength(10);
      await clock.advance(7000); expect(controller.snapshot().keyword).toBe('B');
      expect(browser.created.filter(x => x.cycle === 2)).toHaveLength(10);
      expect(browser.created.filter(x => x.cycle === 1).every(x => x.closed)).toBe(true);
      await controller.stop(); expect(service.snapshot()).toMatchObject({ running: true, assigned: 0, ready: 10 });
    } finally { await controller.stop(); await service.close(); }
  });
  it('rotates A B C A centrally, fetches distinct fresh pools, closes old contexts and preserves rankings', async () => {
    const clock = new FakeClock(), db = store(), browser = driver(); let calls = 0;
    const fetchProxies = vi.fn(async () => proxies(++calls));
    const controller = new Controller({ driver: browser.instance, store: db, clock, fetchProxies });
    await controller.start(settings());
    expect(controller.snapshot()).toMatchObject({ status: 'RUNNING', keyword: 'A', cycle: 1, assignedProxies: 10 });
    for (const [index, keyword] of ['A', 'B', 'C', 'A'].entries()) {
      if (index) await clock.advance(1000);
      const cycle = index + 1, group = browser.created.filter(x => x.cycle === cycle);
      expect(group).toHaveLength(10);
      expect(new Set(group.map(x => x.keyword))).toEqual(new Set([keyword]));
      expect(group.every(x => x.proxy.server.startsWith(`http://pool${cycle}-`))).toBe(true);
      expect(browser.created.filter(x => x.cycle < cycle).every(x => x.closed)).toBe(true);
      expect(fetchProxies).toHaveBeenCalledTimes(cycle);
      expect(controller.snapshot().rankings).toHaveLength(cycle * 10);
    }
    expect(db.saveRanking).toHaveBeenCalledTimes(40);
    await controller.stop();
    expect(browser.created.every(x => x.closed)).toBe(true);
    expect(controller.snapshot()).toMatchObject({ status: 'STOPPED', assignedProxies: 0, availableProxies: 0 });
    expect(clock.waits.size).toBe(0);
    expect(vi.mocked(db.saveAllocation).mock.calls.filter(([entry]) => entry.state === 'RELEASED')).toHaveLength(40);
  });

  it('fetches again even when every proxy address is identical to the preceding response', async () => {
    const clock = new FakeClock(), browser = driver();
    const fetchProxies = vi.fn(async () => proxies(1));
    const controller = new Controller({ driver: browser.instance, store: store(), clock, fetchProxies });
    await controller.start(settings()); await clock.advance(1000);
    expect(fetchProxies).toHaveBeenCalledTimes(2);
    expect(browser.created.filter(x => x.cycle === 1).every(x => x.closed)).toBe(true);
    expect(browser.created.filter(x => x.cycle === 2)).toHaveLength(10);
    await controller.stop();
  });

  it('never starts the deadline before all contexts are initialized and closes late initialization on STOP', async () => {
    const clock = new FakeClock(), browser = driver();
    const original = browser.instance.create;
    const gates: Array<() => void> = [];
    browser.instance.create = vi.fn(async (...args: Parameters<BrowserDriver['create']>) => {
      await new Promise<void>(resolve => gates.push(resolve)); return original(...args);
    });
    browser.instance.close = vi.fn(async () => { for (const release of gates.splice(0)) release(); });
    const controller = new Controller({ driver: browser.instance, store: store(), clock, fetchProxies: async () => proxies(1) });
    const starting = controller.start(settings()); await flush();
    expect(controller.snapshot().cycleStartedAt).toBeUndefined();
    expect(controller.snapshot().status).toBe('STARTING');
    await clock.advance(10000);
    expect(controller.snapshot().remainingMs).toBe(1000);
    await controller.stop(); await starting;
    expect(browser.created.every(x => x.closed)).toBe(true);
    expect(controller.snapshot().status).toBe('STOPPED');
  });

  it('starts its full duration after delayed initialization, independently of the fetch duration', async () => {
    const clock = new FakeClock(), browser = driver();
    let fetched!: (value: ProxyEntry[]) => void;
    const controller = new Controller({ driver: browser.instance, store: store(), clock,
      fetchProxies: () => new Promise(resolve => { fetched = resolve; }) });
    const starting = controller.start(settings()); await flush();
    await clock.advance(20000); fetched(proxies(1)); await starting;
    expect(controller.snapshot().cycleStartedAt).toBe(clock.now());
    expect(controller.snapshot().remainingMs).toBe(1000);
    await controller.stop();
  });

  it('bounds API attempts, waits without old pool/direct fallback, and supports STOP during retry waits', async () => {
    const clock = new FakeClock(), browser = driver();
    const fetchProxies = vi.fn(async () => { throw new Error('HTTP 503'); });
    const controller = new Controller({ driver: browser.instance, store: store(), clock, fetchProxies });
    const starting = controller.start(settings({ apiRetries: 2 })); await flush();
    expect(fetchProxies).toHaveBeenCalledTimes(1);
    await clock.advance(1000); expect(fetchProxies).toHaveBeenCalledTimes(2);
    await clock.advance(2000); await starting;
    expect(fetchProxies).toHaveBeenCalledTimes(3);
    expect(controller.snapshot()).toMatchObject({ status: 'WAITING_FOR_PROXIES', assignedProxies: 0 });
    expect(browser.created).toHaveLength(0);
    expect(browser.instance.launch).not.toHaveBeenCalled();
    const resuming = controller.resume(); await flush();
    expect(fetchProxies).toHaveBeenCalledTimes(4);
    await controller.stop(); await resuming;
    expect(controller.snapshot().status).toBe('STOPPED');
  });

  it('cancels an in-flight API request without spawning any context', async () => {
    const clock = new FakeClock(), browser = driver(); let cancelled = false;
    const controller = new Controller({ driver: browser.instance, store: store(), clock,
      fetchProxies: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => { cancelled = true; reject(new Error('cancelled')); }, { once: true })) });
    const starting = controller.start(settings()); await flush();
    await controller.stop(); await starting;
    expect(cancelled).toBe(true); expect(browser.created).toHaveLength(0);
  });

  it('discards the completed cycle pool before a failed rotation fetch and retries the pending keyword only on RESUME', async () => {
    const clock = new FakeClock(), browser = driver(), db = store(); let calls = 0;
    const controller = new Controller({ driver: browser.instance, store: db, clock, fetchProxies: async () => {
      calls++; if (calls === 2) throw new Error('API unavailable at rotation'); return proxies(calls);
    } });
    await controller.start(settings()); await clock.advance(1000);
    expect(controller.snapshot()).toMatchObject({ status: 'WAITING_FOR_PROXIES', keyword: 'B', cycle: 2, assignedProxies: 0, availableProxies: 0 });
    expect(browser.created).toHaveLength(10); expect(browser.created.every(x => x.closed)).toBe(true);
    expect(controller.snapshot().rankings).toHaveLength(10);
    await controller.resume();
    expect(calls).toBe(3); expect(controller.snapshot()).toMatchObject({ status: 'RUNNING', keyword: 'B', cycle: 2, remainingMs: 1000 });
    expect(browser.created.filter(x => x.cycle === 2).every(x => x.proxy.server.startsWith('http://pool3-'))).toBe(true);
    await controller.stop();
  });

  it('disposes paused contexts/pool and resumes the same keyword with remaining time and a fresh request', async () => {
    const clock = new FakeClock(), browser = driver(); let calls = 0;
    const controller = new Controller({ driver: browser.instance, store: store(), clock, fetchProxies: async () => proxies(++calls) });
    await controller.start(settings()); await clock.advance(400); await controller.pause();
    expect(controller.snapshot()).toMatchObject({ status: 'PAUSED', keyword: 'A', cycle: 1, remainingMs: 600, assignedProxies: 0, availableProxies: 0 });
    expect(browser.created.every(x => x.closed)).toBe(true);
    await clock.advance(10000); await controller.resume();
    expect(calls).toBe(2); expect(controller.snapshot()).toMatchObject({ keyword: 'A', cycle: 1, remainingMs: 600 });
    await clock.advance(600);
    expect(controller.snapshot()).toMatchObject({ keyword: 'B', cycle: 2, remainingMs: 1000 });
    await controller.stop();
  });

  it('isolates ordinary failures, recreates only the failed context, and leaves the central deadline unchanged', async () => {
    const clock = new FakeClock();
    const browser = driver(async (item, signal) => {
      if (item.id === 'Browser 01' && item.proxy.server === 'http://pool1-0.test:8080') throw Object.assign(new Error('ordinary proxy disconnect'), { kind: 'PROXY_CONNECTION' });
      await untilAbort(signal);
    });
    const controller = new Controller({ driver: browser.instance, store: store(), clock, fetchProxies: async () => proxies(1) });
    await controller.start(settings({ mode: 'controlled', controlledSearchUrl: 'http://fixture.test/search', authorizedNavigation: true, allowedOrigins: ['http://fixture.test'] }));
    await flush();
    expect(browser.created).toHaveLength(11);
    expect(browser.created[0].closed).toBe(true);
    expect(browser.created.find(x => x.id === 'Browser 02')?.closed).toBe(false);
    expect(browser.created.at(-1)?.proxy.server).toBe('http://pool1-10.test:8080');
    expect(controller.snapshot().sessions.find(x => x.id === 'Browser 01')?.retryCount).toBe(1);
    expect(controller.snapshot().remainingMs).toBe(1000);
    await controller.stop();
  });

  it('suspends challenges across later cycles and PAUSE/RESUME until an explicit new START', async () => {
    const clock = new FakeClock();
    const browser = driver(async (item, signal) => {
      if (item.id === 'Browser 01') { item.sink.session({ ...item.worker.view, state: 'CHALLENGED', errorKind: 'CAPTCHA', lastError: 'captcha' }); return; }
      await untilAbort(signal);
    });
    const controller = new Controller({ driver: browser.instance, store: store(), clock, fetchProxies: async () => proxies(1) });
    await controller.start(settings()); await flush();
    expect(controller.snapshot().sessions[0].state).toBe('CHALLENGED');
    await clock.advance(1000);
    expect(browser.created.filter(x => x.id === 'Browser 01')).toHaveLength(1);
    expect(controller.snapshot().sessions[0].state).toBe('CHALLENGED');
    await controller.pause(); await controller.resume();
    expect(browser.created.filter(x => x.id === 'Browser 01')).toHaveLength(1);
    await controller.start(settings()); await flush();
    expect(browser.created.filter(x => x.id === 'Browser 01')).toHaveLength(2);
    await controller.stop();
  });

  it('persists all records while bounding dashboard history and removing credential fields', async () => {
    const clock = new FakeClock(), db = store();
    const browser = driver(async (item, signal) => {
      if (item.id === 'Browser 01') for (let i = 0; i < 1005; i++) item.sink.log({ timestamp: '2023-01-01T00:00:00Z', level: 'warn', message: 'password=supersecret http://user:supersecret@proxy.test' });
      await untilAbort(signal);
    });
    const entries = parseProxyList(Array.from({ length: 10 }, (_, i) => `http://user:supersecret@proxy${i}.test:8080`).join('\n'));
    const controller = new Controller({ driver: browser.instance, store: db, clock, fetchProxies: async () => entries, nextCycle: () => 23 });
    await controller.start(settings()); await flush();
    expect(controller.snapshot().cycle).toBe(23);
    expect(controller.snapshot().logs).toHaveLength(1000);
    expect(db.saveDiagnostic).toHaveBeenCalledTimes(1005);
    expect(JSON.stringify(controller.snapshot())).not.toContain('supersecret');
    expect(JSON.stringify(vi.mocked(db.saveAllocation).mock.calls)).not.toContain('supersecret');
    await controller.stop();
  });

  it('retains every requested logical session while deferring contexts above the measured memory threshold', async () => {
    const clock = new FakeClock(), browser = driver();
    const controller = new Controller({ driver: browser.instance, store: store(), clock, fetchProxies: async () => proxies(1, 50),
      memoryUsage: () => ({ usedBytes: browser.created.length >= 10 ? 850 : 200, totalBytes: 1000 }) });
    await controller.start(settings({ sessionCount: 50, maxMemoryPercent: 80 }));
    expect(controller.snapshot().sessions).toHaveLength(50);
    expect(browser.created.length).toBeGreaterThanOrEqual(10);
    expect(browser.created.length).toBeLessThan(50);
    expect(controller.snapshot().sessions.some(x => x.errorKind === 'RESOURCE_LIMIT')).toBe(true);
    expect(controller.snapshot().assignedProxies).toBe(browser.created.length);
    await controller.stop();
  });

  it('preserves cancellation observations emitted when contexts close at a rotation boundary', async () => {
    const clock = new FakeClock(), db = store();
    const browser = driver(async (item, signal) => {
      await untilAbort(signal);
      item.sink.observation({ sessionId: item.id, cycle: item.cycle, keyword: item.keyword, outcome: 'CANCELLED',
        pagesInspected: 0, resultsInspected: 0, reason: 'Cycle boundary interrupted pending inspection', timestamp: '2023-11-14T22:13:20.000Z' });
    });
    const controller = new Controller({ driver: browser.instance, store: db, clock, fetchProxies: async () => proxies(1) });
    await controller.start(settings()); await clock.advance(1000);
    expect(vi.mocked(db.saveObservation).mock.calls.filter(([record]) => record.outcome === 'CANCELLED')).toHaveLength(10);
    await controller.stop();
    expect(vi.mocked(db.saveObservation).mock.calls.filter(([record]) => record.outcome === 'CANCELLED')).toHaveLength(20);
  });

  it('bounds repeated ordinary retries even when the driver emits a new view at every attempt', async () => {
    const clock = new FakeClock();
    const browser = driver(async (item, signal) => {
      item.sink.session({ ...item.worker.view, state: 'SEARCHING' });
      if (item.id === 'Browser 01') throw Object.assign(new Error('connection lost'), { kind: 'NETWORK' });
      await untilAbort(signal);
    });
    const controller = new Controller({ driver: browser.instance, store: store(), clock, fetchProxies: async () => proxies(1, 20) });
    await controller.start(settings({ mode: 'controlled', controlledSearchUrl: 'http://fixture.test/search', authorizedNavigation: true, allowedOrigins: ['http://fixture.test'], retryBudget: 2 }));
    await flush();
    expect(browser.created.filter(x => x.id === 'Browser 01')).toHaveLength(3);
    expect(controller.snapshot().sessions.find(x => x.id === 'Browser 01')?.retryCount).toBe(2);
    expect(controller.snapshot().sessions.find(x => x.id === 'Browser 01')?.state).toBe('NETWORK_ERROR');
    await controller.stop();
  });

  it('recovers permitted context initialization failures within the configured budget before starting the deadline', async () => {
    const clock = new FakeClock(), browser = driver();
    const original = browser.instance.create; let failed = false;
    browser.instance.create = vi.fn(async (...args: Parameters<BrowserDriver['create']>) => {
      if (args[0] === 'Browser 01' && !failed) { failed = true; throw Object.assign(new Error('proxy socket failed'), { kind: 'PROXY_CONNECTION' }); }
      return original(...args);
    });
    const controller = new Controller({ driver: browser.instance, store: store(), clock, fetchProxies: async () => proxies(1) });
    await controller.start(settings({ mode: 'controlled', controlledSearchUrl: 'http://fixture.test/search', authorizedNavigation: true, allowedOrigins: ['http://fixture.test'], retryBudget: 1 }));
    expect(browser.instance.create).toHaveBeenCalledTimes(11);
    expect(controller.snapshot().assignedProxies).toBe(10);
    expect(controller.snapshot().sessions.find(x => x.id === 'Browser 01')?.retryCount).toBe(1);
    expect(controller.snapshot().remainingMs).toBe(1000);
    await controller.stop();
  });

  it('latches a challenge in manually opened results without proxy recovery', async () => {
    const clock = new FakeClock(), browser = driver();
    const controller = new Controller({ driver: browser.instance, store: store(), clock, fetchProxies: async () => proxies(1) });
    await controller.start(settings({ authorizedNavigation: true, allowedOrigins: ['https://example.com'] }));
    browser.created[0].worker.openResult = vi.fn(async () => { throw Object.assign(new Error('access denied'), { kind: 'ACCESS_DENIED' }); });
    await expect(controller.openResult('Browser 01', 'https://example.com/post')).rejects.toThrow('access denied');
    expect(controller.snapshot().sessions[0].state).toBe('CHALLENGED');
    expect(browser.created[0].closed).toBe(true);
    await clock.advance(1000);
    expect(browser.created.filter(x => x.id === 'Browser 01')).toHaveLength(1);
    await controller.stop();
  });
});
