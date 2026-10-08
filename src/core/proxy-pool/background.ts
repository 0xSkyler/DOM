import type { ProxyEntry, Settings, ProxyPoolStatus } from '../../shared/types';
import { fetchProxyList, redactSecrets } from '../proxy-api';

export interface CheckResult { reachable: boolean; challenged?: boolean; deferred?: boolean; }
export interface ProxyChecker {
  check(proxy: ProxyEntry, settings: Settings, signal: AbortSignal): Promise<CheckResult>;
  close(): Promise<void>;
}
export interface ProxyAllocator {
  allocate(sessionId: string): ProxyEntry | undefined;
  release(sessionId: string, failed?: boolean): ProxyEntry | undefined;
  releaseAll(): ProxyEntry[];
  readonly available: number;
  readonly assigned: number;
  readonly secrets: string[];
}
type Candidate = { proxy: ProxyEntry; state: 'pending' | 'checking' | 'ready' | 'assigned' | 'failed' | 'challenged'; checkedAt?: number; retryAt: number; present: boolean };

/** App-lifetime, credential-private ready pool. Cycle pools only own reservations. */
export class BackgroundProxyPool {
  private candidates = new Map<string, Candidate>();
  private abort?: AbortController;
  private task?: Promise<void>;
  private key?: string;
  private lastFetchAt?: number;
  private nextFetchAt = 0;
  private fetched = 0;
  private error?: string;
  private cursor = 0;
  private readonly listeners = new Set<() => void>();
  private transition = Promise.resolve();
  private readonly now: () => number;
  private readonly fetcher: typeof fetchProxyList;
  private readonly concurrency: number;
  private readonly ttlMs: number;
  private readonly refreshMs: number;
  private readonly retryMs: number;
  private readonly tickMs: number;
  private readonly capacity: number;
  constructor(private readonly checker: ProxyChecker, options: {
    now?: () => number; fetcher?: typeof fetchProxyList; concurrency?: number; ttlMs?: number;
    refreshMs?: number; retryMs?: number; tickMs?: number; capacity?: number;
  } = {}) {
    this.now = options.now ?? Date.now; this.fetcher = options.fetcher ?? fetchProxyList;
    this.concurrency = options.concurrency ?? 3; this.ttlMs = options.ttlMs ?? 120000;
    this.refreshMs = options.refreshMs ?? 60000; this.retryMs = options.retryMs ?? 60000;
    this.tickMs = options.tickMs ?? 1000; this.capacity = options.capacity ?? 500;
  }
  onChange(fn: () => void): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit(): void { for (const fn of this.listeners) { try { fn(); } catch {} } }
  private fresh(item: Candidate): boolean { return item.checkedAt !== undefined && this.now() - item.checkedAt < this.ttlMs; }
  snapshot(): ProxyPoolStatus {
    const values = [...this.candidates.values()];
    return { running: !!this.abort && !this.abort.signal.aborted, fetched: this.fetched,
      ready: values.filter(x => x.state === 'ready' && x.present && this.fresh(x)).length,
      checking: values.filter(x => x.state === 'checking').length, assigned: values.filter(x => x.state === 'assigned').length,
      failed: values.filter(x => x.state === 'failed').length, challenged: values.filter(x => x.state === 'challenged').length,
      expired: values.filter(x => x.state === 'ready' && !this.fresh(x)).length,
      lastFetchAt: this.lastFetchAt, error: this.error };
  }
  /** Changes serialize teardown so late checks can never contaminate another configuration. */
  configure(settings: Settings): Promise<void> {
    const key = JSON.stringify([settings.proxyApiUrl, settings.mode, settings.controlledSearchUrl, settings.locale, settings.apiTimeoutMs, settings.maxMemoryPercent]);
    const change = this.transition.then(async () => {
      if (key === this.key && this.abort && !this.abort.signal.aborted) return;
      await this.stop(); this.key = key;
      this.candidates.clear(); this.fetched = 0; this.error = undefined; this.lastFetchAt = undefined; this.nextFetchAt = 0; this.cursor = 0;
      const abort = new AbortController(); this.abort = abort;
      this.task = this.run(settings, abort.signal); this.emit();
    });
    this.transition = change.catch(() => {}); return change;
  }
  private async refresh(settings: Settings, signal: AbortSignal): Promise<void> {
    this.nextFetchAt = this.now() + this.refreshMs;
    try {
      const entries = await this.fetcher(settings.proxyApiUrl, { signal, timeoutMs: settings.apiTimeoutMs });
      if (signal.aborted) return;
      const present = new Set(entries.map(x => x.id));
      for (const [id, item] of this.candidates) {
        item.present = present.has(id);
        if (!item.present && item.state !== 'assigned' && item.state !== 'checking') this.candidates.delete(id);
      }
      // Rotate through large provider responses instead of permanently testing only their first page.
      for (let i = 0; i < entries.length && this.candidates.size < this.capacity; i++) {
        const proxy = entries[(this.cursor + i) % entries.length];
        if (!this.candidates.has(proxy.id)) this.candidates.set(proxy.id, { proxy: { ...proxy }, state: 'pending', retryAt: 0, present: true });
      }
      this.cursor = (this.cursor + this.capacity) % Math.max(1, entries.length);
      this.fetched = entries.length; this.lastFetchAt = this.now(); this.error = undefined;
    } catch (error) {
      if (!signal.aborted) this.error = redactSecrets(error, this.secrets);
    }
    this.emit();
  }
  private async run(settings: Settings, signal: AbortSignal): Promise<void> {
    const active = new Set<Promise<void>>();
    try {
      while (!signal.aborted) {
        if (this.now() >= this.nextFetchAt) await this.refresh(settings, signal);
        if (signal.aborted) break;
        for (const [id, item] of this.candidates) {
          if (active.size >= this.concurrency) break;
          if (!item.present || item.state === 'assigned' || item.state === 'checking') continue;
          if (item.state === 'ready' && this.fresh(item) || item.retryAt > this.now()) continue;
          // Make room for later provider candidates when the candidate limit has been reached.
          if (this.candidates.size >= this.capacity && (item.state === 'failed' || item.state === 'challenged')) {
            this.candidates.delete(id); continue;
          }
          item.state = 'checking'; this.emit();
          const task = this.checker.check({ ...item.proxy }, settings, signal).then(result => {
            if (signal.aborted) return;
            if (result.deferred) { item.state = 'pending'; item.checkedAt = undefined; item.retryAt = this.now() + 5000; }
            else {
              item.checkedAt = this.now(); item.state = result.reachable ? 'ready' : result.challenged ? 'challenged' : 'failed';
              item.retryAt = result.reachable ? 0 : this.now() + this.retryMs;
            }
          }).catch(() => {
            if (!signal.aborted) { item.state = 'failed'; item.retryAt = this.now() + this.retryMs; }
          }).finally(() => { active.delete(task); this.emit(); });
          active.add(task);
        }
        await new Promise<void>(resolve => {
          const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
          const timer = setTimeout(finish, this.tickMs); signal.addEventListener('abort', finish, { once: true });
          if (signal.aborted) finish();
        });
      }
    } finally { await Promise.allSettled(active); }
  }
  private take(sessionId: string): ProxyEntry | undefined {
    if (!this.abort || this.abort.signal.aborted) return;
    const item = [...this.candidates.values()].find(x => x.present && x.state === 'ready' && this.fresh(x));
    if (!item) return;
    item.state = 'assigned'; this.emit();
    return { ...item.proxy, state: 'ASSIGNED', sessionId };
  }
  private giveBack(proxy: ProxyEntry, failed: boolean): void {
    const item = this.candidates.get(proxy.id);
    if (!item) return;
    if (!item.present) this.candidates.delete(proxy.id);
    else if (failed) { item.state = 'failed'; item.checkedAt = undefined; item.retryAt = this.now() + this.retryMs; }
    else item.state = this.fresh(item) ? 'ready' : 'pending';
    this.emit();
  }
  get secrets(): string[] { return [...this.candidates.values()].flatMap(x => [x.proxy.username, x.proxy.password].filter((s): s is string => !!s)); }
  requestRefresh(): void { this.nextFetchAt = 0; }
  cyclePool(): ProxyAllocator {
    const reservations = new Map<string, ProxyEntry>(); const owner = this;
    return {
      allocate(sessionId) {
        if (reservations.has(sessionId)) return;
        const proxy = owner.take(sessionId); if (proxy) reservations.set(sessionId, proxy); return proxy;
      },
      release(sessionId, failed = false) {
        const proxy = reservations.get(sessionId); if (!proxy) return;
        reservations.delete(sessionId); owner.giveBack(proxy, failed);
        return { ...proxy, state: failed ? 'FAILED' : 'RELEASED' };
      },
      releaseAll() { return [...reservations.keys()].map(id => this.release(id)!).filter(Boolean); },
      get available() { return owner.snapshot().ready; }, get assigned() { return reservations.size; },
      get secrets() { return owner.secrets; }
    };
  }
  async stop(): Promise<void> {
    this.abort?.abort(); await this.checker.close(); await this.task;
    this.task = undefined; this.abort = undefined; this.candidates.clear(); this.emit();
  }
  async close(): Promise<void> { await this.transition; await this.stop(); }
}
