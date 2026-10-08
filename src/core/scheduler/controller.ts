import type { BrowserDriver, Clock, Diagnostic, ErrorKind, EventSink, NavigationRecord, Observation, ProxyEntry, RankingRecord, RepositoryStore, SessionView, Settings, Snapshot, Worker } from '../../shared/types';
import { validateSettings } from '../../shared/validation';
import { parseKeywords } from '../target-matcher';
import { abortError, fetchProxyList, redactSecrets } from '../proxy-api';
import { ProxyPool } from '../proxy-pool';
import type { BackgroundProxyPool, ProxyAllocator } from '../proxy-pool/background';
import { actualMemoryUsage } from '../../shared/memory';

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const onAbort = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, Math.max(0, ms));
    signal?.addEventListener('abort', onAbort, { once: true });
  })
};

type ProxyFetcher = (url: string, options: { signal: AbortSignal; timeoutMs: number }) => Promise<ProxyEntry[]>;
const CHALLENGES = new Set<ErrorKind>(['CAPTCHA', 'UNUSUAL_TRAFFIC', 'ACCESS_DENIED']);
const RECOVERABLE = new Set<ErrorKind>(['NETWORK', 'PROXY_CONNECTION', 'NAVIGATION_TIMEOUT']);
const HISTORY_LIMIT = 1000;
const idFor = (index: number) => `Browser ${String(index + 1).padStart(2, '0')}`;
type MemoryUsage = { usedBytes: number; totalBytes: number };

/** One cycle deadline; an injected app-lifetime pool supplies checked reservations across rotations. */
export class Controller {
  private readonly driver: BrowserDriver;
  private readonly store: RepositoryStore;
  private readonly clock: Clock;
  private readonly fetchProxies: ProxyFetcher;
  private readonly nextCycle?: () => number;
  private readonly memoryUsage: () => MemoryUsage;
  private settings?: Settings;
  private keywords: string[] = [];
  private state: Snapshot['status'] = 'STOPPED';
  private cycle = 0;
  private keywordIndex = 0;
  private startedAt?: number;
  private deadline?: number;
  private duration = 0;
  private lastApiFetchAt?: number;
  private error?: string;
  private pool?: ProxyAllocator;
  private readonly backgroundProxies?: BackgroundProxyPool;
  private filling = false;
  private readonly views = new Map<string, SessionView>();
  private readonly workers = new Map<string, Worker>();
  private readonly challenges = new Map<string, { kind?: ErrorKind; reason?: string }>();
  private readonly reportedOutcomes = new Set<string>();
  private readonly listeners = new Set<(snapshot: Snapshot) => void>();
  private rankings: RankingRecord[] = [];
  private observations: Observation[] = [];
  private logs: Diagnostic[] = [];
  private lifecycle?: AbortController;
  private cycleAbort?: AbortController;
  private task?: Promise<void>;
  private workerTasks = new Set<Promise<void>>();
  private ready?: () => void;
  private runSerial = 0;
  private cleanupPromise?: Promise<void>;
  private ending = false;
  private cycleSavedAt?: number;
  private browserStarted = false;

  constructor(options: { driver: BrowserDriver; store: RepositoryStore; clock?: Clock; fetchProxies?: ProxyFetcher; nextCycle?: () => number; memoryUsage?: () => MemoryUsage; backgroundProxies?: BackgroundProxyPool }) {
    this.driver = options.driver; this.store = options.store;
    this.clock = options.clock ?? systemClock;
    this.fetchProxies = options.fetchProxies ?? fetchProxyList;
    this.nextCycle = options.nextCycle;
    this.memoryUsage = options.memoryUsage ?? actualMemoryUsage;
    this.backgroundProxies = options.backgroundProxies;
    this.backgroundProxies?.onChange(() => this.emit());
  }

  snapshot(): Snapshot {
    return structuredClone({
      status: this.state, cycle: this.cycle, keyword: this.keywords[this.keywordIndex] ?? '',
      cycleStartedAt: this.startedAt, remainingMs: this.deadline === undefined ? this.duration : Math.max(0, this.deadline - this.clock.now()),
      sessions: [...this.views.values()], assignedProxies: this.pool?.assigned ?? 0, availableProxies: this.pool?.available ?? this.backgroundProxies?.snapshot().ready ?? 0,
      lastApiFetchAt: this.backgroundProxies?.snapshot().lastFetchAt ?? this.lastApiFetchAt,
      proxyPool: this.backgroundProxies?.snapshot(), rankings: this.rankings, observations: this.observations, logs: this.logs, error: this.error
    });
  }
  onChange(callback: (snapshot: Snapshot) => void): () => void { this.listeners.add(callback); return () => this.listeners.delete(callback); }
  private emit(): void {
    for (const callback of this.listeners) {
      try { callback(this.snapshot()); } catch { /* A UI observer cannot stop workers. */ }
    }
  }
  private safe(input: unknown): string { return redactSecrets(input, this.pool?.secrets ?? []); }
  private log(level: Diagnostic['level'], message: string, sessionId?: string): void {
    const record: Diagnostic = { level, message: this.safe(message), sessionId, cycle: this.cycle, timestamp: new Date(this.clock.now()).toISOString() };
    this.logs.push(record); if (this.logs.length > HISTORY_LIMIT) this.logs.splice(0, this.logs.length - HISTORY_LIMIT);
    this.store.saveDiagnostic(record); this.emit();
  }
  private persistAllocation(proxy: ProxyEntry): void {
    const { username: _username, password: _password, ...safe } = proxy;
    this.store.saveAllocation(safe, this.cycle);
  }
  private update(view: SessionView): void {
    const safe = { ...view, url: this.safe(view.url), lastAction: this.safe(view.lastAction), lastError: view.lastError ? this.safe(view.lastError) : undefined };
    this.views.set(safe.id, safe); this.store.saveSession(safe); this.emit();
  }

  async start(input: Settings): Promise<void> {
    const settings = validateSettings(input);
    await this.stop();
    this.settings = settings; this.keywords = parseKeywords(settings.keywords);
    this.keywordIndex = 0; this.cycle = this.nextCycle?.() ?? this.cycle + 1; this.duration = settings.rotationSeconds * 1000;
    this.startedAt = undefined; this.cycleSavedAt = undefined; this.deadline = undefined;
    this.error = undefined; this.lastApiFetchAt = undefined; this.challenges.clear(); this.views.clear(); this.reportedOutcomes.clear();
    this.rankings = []; this.observations = []; this.logs = [];
    return this.begin();
  }

  private begin(): Promise<void> {
    if (!this.settings) return Promise.resolve();
    const serial = ++this.runSerial, abort = new AbortController();
    this.lifecycle = abort; this.state = 'STARTING'; this.ending = false; this.error = undefined;
    const ready = new Promise<void>(resolve => { this.ready = resolve; });
    this.emit();
    this.task = this.run(abort.signal, serial).catch(error => {
      if (!abort.signal.aborted && serial === this.runSerial) {
        this.state = 'ERROR'; this.error = this.safe(error); this.log('error', this.error);
      }
    }).finally(() => { this.ready?.(); this.ready = undefined; });
    return ready;
  }

  private async run(signal: AbortSignal, serial: number): Promise<void> {
    try {
      while (!signal.aborted && serial === this.runSerial) {
        const initialized = await this.initialize(signal);
        if (!initialized || signal.aborted) break;
        this.state = 'RUNNING'; this.error = undefined;
        this.startedAt = this.clock.now(); this.deadline = this.startedAt + this.duration;
        if (this.cycleSavedAt === undefined) this.cycleSavedAt = this.startedAt;
        this.store.saveCycle(this.cycle, this.keywords[this.keywordIndex], this.cycleSavedAt);
        this.emit(); this.ready?.(); this.ready = undefined;
        const cycleSignal = this.cycleAbort!.signal;
        for (const worker of this.workers.values()) this.trackWorker(this.runWorker(worker, cycleSignal));
        // Tick the dashboard against the same absolute deadline; retries never reset it.
        while (!signal.aborted && this.deadline !== undefined && this.clock.now() < this.deadline) {
          if (this.backgroundProxies && !this.filling) this.trackWorker(this.fillWaiting(cycleSignal));
          await this.clock.sleep(Math.min(1000, this.deadline - this.clock.now()), signal);
          this.emit();
        }
        if (signal.aborted) break;
        this.ending = true;
        await this.cleanupCycle();
        this.store.saveCycle(this.cycle, this.keywords[this.keywordIndex], this.cycleSavedAt!, this.clock.now());
        this.cycleSavedAt = undefined;
        this.keywordIndex = (this.keywordIndex + 1) % this.keywords.length;
        this.cycle++; this.duration = this.settings!.rotationSeconds * 1000;
        this.startedAt = undefined; this.deadline = undefined; this.ending = false;
        this.state = 'STARTING'; this.emit();
      }
    } finally {
      this.ending = true;
      await this.cleanupCycle();
      await this.closeDriver();
    }
  }

  private async initialize(signal: AbortSignal): Promise<boolean> {
    const settings = this.settings!;
    this.state = 'WAITING_FOR_PROXIES'; this.startedAt = undefined; this.deadline = undefined;
    this.views.clear();
    this.reportedOutcomes.clear();
    for (let i = 0; i < settings.sessionCount; i++) {
      const id = idFor(i), challenge = this.challenges.get(id);
      this.update({ id, cycle: this.cycle, keyword: this.keywords[this.keywordIndex], proxyId: '', state: challenge ? 'CHALLENGED' : 'INITIALIZING',
        url: '', lastAction: challenge ? 'Suspended until a new START after access challenge.' : this.backgroundProxies ? 'Waiting for a checked proxy from the background pool.' : 'Waiting for a fresh proxy pool.',
        startedAt: this.clock.now(), retryCount: 0, navigationCount: 0, lastError: challenge?.reason, errorKind: challenge?.kind });
    }
    let entries: ProxyEntry[] | undefined;
    if (this.backgroundProxies) {
      await this.backgroundProxies.configure(settings);
      // The Start button becomes responsive while the background worker replenishes an empty pool.
      this.ready?.(); this.ready = undefined;
      while (!signal.aborted && this.backgroundProxies.snapshot().ready === 0) {
        this.error = this.backgroundProxies.snapshot().error; this.emit();
        await this.clock.sleep(1000, signal);
      }
      if (signal.aborted) return false;
      this.pool = this.backgroundProxies.cyclePool();
    } else {
      for (let attempt = 0; attempt <= settings.apiRetries && !signal.aborted; attempt++) {
        try {
          entries = await this.fetchProxies(settings.proxyApiUrl, { signal, timeoutMs: settings.apiTimeoutMs });
          if (signal.aborted) return false;
          if (!entries.length) throw new Error('Proxy API returned no usable proxy entries.');
          this.lastApiFetchAt = this.clock.now(); this.error = undefined; break;
        } catch (error) {
          if (signal.aborted) return false;
          this.error = this.safe(error); this.log('warn', `Proxy fetch attempt ${attempt + 1}/${settings.apiRetries + 1}: ${this.error}`);
          if (attempt < settings.apiRetries) await this.clock.sleep(Math.min(1000 * 2 ** attempt, 10000), signal);
        }
      }
      if (!entries) {
        this.state = 'WAITING_FOR_PROXIES'; this.emit(); this.ready?.(); this.ready = undefined;
        return false; // Bounded attempts for direct-fetch test/embedding clients.
      }
      this.pool = new ProxyPool(entries);
    }
    this.cycleAbort = new AbortController();
    const onAbort = () => this.cycleAbort?.abort();
    signal.addEventListener('abort', onAbort, { once: true });
    this.cycleAbort.signal.addEventListener('abort', () => signal.removeEventListener('abort', onAbort), { once: true });
    this.state = 'STARTING'; this.emit();
    // Fetch first: an unavailable API must not launch an unneeded browser or any direct session.
    if (!this.browserStarted) { await this.driver.launch(settings); this.browserStarted = true; }
    if (signal.aborted) return false;
    // Bound initialization fan-out while still preparing every requested logical context before the timer starts.
    const pending: Array<() => Promise<void>> = [];
    for (const [id, view] of this.views) {
      if (this.challenges.has(id)) continue;
      const proxy = this.pool.allocate(id);
      if (!proxy) {
        this.update({ ...view, state: 'WAITING_FOR_ROTATION', lastAction: this.backgroundProxies ? 'Waiting for a checked proxy; will start when the background pool replenishes.' : 'No unique unused proxy available; direct connections are disabled.' });
        continue;
      }
      this.persistAllocation(proxy); this.update({ ...view, proxyId: proxy.id });
      pending.push(() => this.createWorker(id, proxy, 0, this.cycleAbort!.signal));
    }
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(8, pending.length) }, async () => {
      while (!signal.aborted && cursor < pending.length) await pending[cursor++]();
    }));
    return !signal.aborted;
  }

  private async fillWaiting(signal: AbortSignal): Promise<void> {
    this.filling = true;
    try {
      const waiting = [...this.views.values()].filter(view => view.state === 'WAITING_FOR_ROTATION' && !view.proxyId && !view.errorKind && !this.challenges.has(view.id)).slice(0, 3);
      for (const view of waiting) {
        if (signal.aborted || this.ending) break;
        const proxy = this.pool?.allocate(view.id); if (!proxy) break;
        this.persistAllocation(proxy); this.update({ ...view, proxyId: proxy.id });
        await this.createWorker(view.id, proxy, 0, signal);
        const worker = this.workers.get(view.id);
        if (worker && !signal.aborted && !this.ending) this.trackWorker(this.runWorker(worker, signal));
      }
    } finally { this.filling = false; }
  }

  private sink(id: string, cycle: number, signal: AbortSignal): EventSink {
    const active = () => !signal.aborted && cycle === this.cycle && !this.ending;
    const recordable = () => cycle === this.cycle && this.pool !== undefined;
    return {
      session: view => {
        if (!active() || view.id !== id) return;
        if (view.state === 'CHALLENGED' || view.errorKind && CHALLENGES.has(view.errorKind)) {
          this.challenges.set(id, { kind: view.errorKind, reason: this.safe(view.lastError ?? 'Access challenge detected.') });
          this.update({ ...view, state: 'CHALLENGED' });
          // A challenge can also arrive from a manually started navigation loop.
          void this.closeWorker(id, true).catch(error => this.log('warn', `Challenge cleanup: ${this.safe(error)}`, id));
        } else if (!this.challenges.has(id)) this.update(view);
      },
      ranking: record => {
        if (!active() || record.sessionId !== id) return;
        const safe = { ...record, url: this.safe(record.url), title: this.safe(record.title) };
        this.store.saveRanking(safe); this.rankings.push(safe);
        if (this.rankings.length > HISTORY_LIMIT) this.rankings.splice(0, this.rankings.length - HISTORY_LIMIT);
        this.emit();
      },
      observation: record => {
        // Cancellation outcomes arrive during disposal and remain persistent evidence.
        if ((!active() && !(recordable() && record.outcome === 'CANCELLED')) || record.sessionId !== id) return;
        const safe = { ...record, reason: record.reason ? this.safe(record.reason) : undefined };
        this.reportedOutcomes.add(id);
        if (record.outcome === 'CHALLENGED') {
          this.challenges.set(id, { kind: this.views.get(id)?.errorKind, reason: safe.reason });
          this.update({ ...this.views.get(id)!, state: 'CHALLENGED', lastError: safe.reason, lastAction: 'Access challenge; suspended until a new START.' });
        }
        this.store.saveObservation(safe); this.observations.push(safe);
        if (this.observations.length > HISTORY_LIMIT) this.observations.splice(0, this.observations.length - HISTORY_LIMIT);
        this.emit();
      },
      log: record => {
        if (!recordable()) return;
        const safe = { ...record, message: this.safe(record.message), sessionId: id, cycle };
        this.store.saveDiagnostic(safe); this.logs.push(safe);
        if (this.logs.length > HISTORY_LIMIT) this.logs.splice(0, this.logs.length - HISTORY_LIMIT);
        this.emit();
      },
      navigation: record => { if (recordable() && record.sessionId === id) this.store.saveNavigation({ ...record, url: this.safe(record.url), action: this.safe(record.action) }); }
    };
  }

  private async createWorker(id: string, proxy: ProxyEntry, retryCount: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.ending) return;
    const view = this.views.get(id)!;
    const memory = this.memoryUsage();
    if (memory.totalBytes > 0 && memory.usedBytes / memory.totalBytes * 100 >= this.settings!.maxMemoryPercent) {
      this.update({ ...view, proxyId: proxy.id, state: 'WAITING_FOR_ROTATION', errorKind: 'RESOURCE_LIMIT',
        lastError: `Measured memory use reached the ${this.settings!.maxMemoryPercent}% limit.`, lastAction: 'Requested session retained; context deferred until another rotation.' });
      const released = this.pool?.release(id); if (released) this.persistAllocation(released);
      this.log('warn', `Context deferred because measured memory use reached the configured ${this.settings!.maxMemoryPercent}% limit.`, id);
      return;
    }
    this.reportedOutcomes.delete(id);
    this.update({ ...view, proxyId: proxy.id, state: retryCount ? 'RESTARTING' : 'INITIALIZING', retryCount,
      lastAction: retryCount ? 'Creating clean context with another unused proxy.' : 'Creating isolated Chromium context.' });
    try {
      const worker = await this.driver.create(id, this.cycle, this.keywords[this.keywordIndex], proxy, this.settings!, this.sink(id, this.cycle, signal));
      if (signal.aborted || this.ending) { await worker.close(); return; }
      if (this.challenges.has(id)) {
        await worker.close(); const released = this.pool?.release(id); if (released) this.persistAllocation(released); return;
      }
      // The driver emits copies of its view during run; keep retry metadata authoritative there too.
      worker.view.retryCount = retryCount;
      this.workers.set(id, worker);
      this.update({ ...worker.view, cycle: this.cycle, keyword: this.keywords[this.keywordIndex], proxyId: proxy.id, retryCount, state: 'READY', lastAction: 'Context ready.' });
    } catch (error) {
      if (signal.aborted || this.ending) return;
      const released = this.pool?.release(id, true); if (released) this.persistAllocation(released);
      const kind = this.errorKind(error);
      if (CHALLENGES.has(kind)) this.challenges.set(id, { kind, reason: this.safe(error) });
      this.update({ ...this.views.get(id)!, state: CHALLENGES.has(kind) ? 'CHALLENGED' : 'NETWORK_ERROR', lastError: this.safe(error), errorKind: kind, lastAction: 'Context initialization failed; isolated from other sessions.' });
      this.log('error', this.safe(error), id);
      if (!this.challenges.has(id) && RECOVERABLE.has(kind) && this.settings!.mode === 'controlled' && this.settings!.authorizedNavigation && retryCount < this.settings!.retryBudget && !signal.aborted && !this.ending) {
        const replacement = this.pool?.allocate(id);
        if (replacement) {
          this.persistAllocation(replacement);
          await this.createWorker(id, replacement, retryCount + 1, signal);
        }
      }
    }
  }
  private trackWorker(task: Promise<void>): void {
    this.workerTasks.add(task); void task.finally(() => this.workerTasks.delete(task));
  }
  private errorKind(error: unknown): ErrorKind {
    const kind = error && typeof error === 'object' && 'kind' in error ? (error as { kind: unknown }).kind : undefined;
    if (typeof kind === 'string' && ['CAPTCHA', 'UNUSUAL_TRAFFIC', 'ACCESS_DENIED', 'NAVIGATION_TIMEOUT', 'PROXY_CONNECTION', 'NETWORK', 'SERP_LOADING', 'EMPTY_RESULTS', 'UNSUPPORTED_DOM', 'CANCELLED', 'RESOURCE_LIMIT'].includes(kind)) return kind as ErrorKind;
    return 'NETWORK';
  }
  private async runWorker(initial: Worker, signal: AbortSignal): Promise<void> {
    let worker: Worker | undefined = initial;
    const id = initial.view.id;
    while (worker && !signal.aborted && !this.ending) {
      try {
        await worker.run(signal);
        if (!signal.aborted && !this.ending && !this.challenges.has(id)) this.update({ ...this.views.get(id)!, state: 'WAITING_FOR_ROTATION', lastAction: 'Work completed; waiting for central rotation.' });
        if (this.challenges.has(id)) await this.closeWorker(id, true);
        return;
      } catch (error) {
        if (signal.aborted || this.ending) return;
        const kind = this.errorKind(error), reason = this.safe(error), view = this.views.get(id)!;
        const challenge = this.challenges.has(id) || CHALLENGES.has(kind);
        const effectiveKind = challenge ? this.challenges.get(id)?.kind ?? kind : kind;
        if (challenge) this.challenges.set(id, { kind: effectiveKind, reason });
        this.update({ ...view, state: challenge ? 'CHALLENGED' : 'NETWORK_ERROR', lastError: reason, errorKind: effectiveKind, lastAction: challenge ? 'Access challenge; session suspended until a new START.' : 'Ordinary worker error.' });
        this.log(challenge ? 'warn' : 'error', reason, id);
        const observation: Observation = { sessionId: id, cycle: this.cycle, keyword: this.keywords[this.keywordIndex], outcome: challenge ? 'CHALLENGED' : kind === 'UNSUPPORTED_DOM' ? 'INCONCLUSIVE' : 'ERROR', pagesInspected: 0, resultsInspected: 0, reason, timestamp: new Date(this.clock.now()).toISOString() };
        if (!this.reportedOutcomes.has(id)) {
          this.store.saveObservation(observation); this.observations.push(observation); this.reportedOutcomes.add(id);
          if (this.observations.length > HISTORY_LIMIT) this.observations.splice(0, this.observations.length - HISTORY_LIMIT);
        }
        await this.closeWorker(id, true);
        if (challenge || !RECOVERABLE.has(kind) || !this.settings!.authorizedNavigation || this.settings!.mode !== 'controlled' || view.retryCount >= this.settings!.retryBudget || signal.aborted || this.ending) return;
        const proxy = this.pool?.allocate(id);
        if (!proxy) { this.update({ ...this.views.get(id)!, lastAction: 'Recovery budget available, but no unused proxy remains.' }); return; }
        this.persistAllocation(proxy);
        await this.createWorker(id, proxy, view.retryCount + 1, signal);
        worker = this.workers.get(id);
      }
    }
  }

  private async closeWorker(id: string, failed = false): Promise<void> {
    const worker = this.workers.get(id); this.workers.delete(id);
    if (worker) { try { await worker.close(); } catch (error) { this.log('warn', `Context cleanup: ${this.safe(error)}`, id); } }
    const proxy = this.pool?.release(id, failed); if (proxy) this.persistAllocation(proxy);
    this.emit();
  }
  private async cleanupCycle(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleanupPromise = (async () => {
      this.cycleAbort?.abort();
      await Promise.allSettled([...this.workers.keys()].map(id => this.closeWorker(id)));
      // Context closure interrupts Playwright calls; every worker is joined before the pool disappears.
      await Promise.allSettled([...this.workerTasks]);
      for (const proxy of this.pool?.releaseAll() ?? []) this.persistAllocation(proxy);
      this.pool = undefined; this.cycleAbort = undefined;
      this.emit();
    })();
    try { await this.cleanupPromise; } finally { this.cleanupPromise = undefined; }
  }
  private async closeDriver(): Promise<void> {
    try { await this.driver.close(); } catch (error) { this.log('warn', `Browser cleanup: ${this.safe(error)}`); }
    finally { this.browserStarted = false; }
  }

  async stop(): Promise<void> {
    if (!this.task && this.state === 'STOPPED') return;
    this.state = 'STOPPING'; this.ending = true;
    const remaining = this.deadline === undefined ? this.duration : Math.max(0, this.deadline - this.clock.now());
    this.duration = remaining; this.deadline = undefined;
    this.lifecycle?.abort(); this.cycleAbort?.abort(); this.emit();
    // Close the browser immediately even during launch/create, then join late initialization and cleanup.
    await this.closeDriver();
    await this.task; this.task = undefined; this.lifecycle = undefined;
    await this.cleanupCycle();
    if (this.cycleSavedAt !== undefined) this.store.saveCycle(this.cycle, this.keywords[this.keywordIndex], this.cycleSavedAt, this.clock.now());
    this.cycleSavedAt = undefined;
    for (const view of this.views.values()) this.update({ ...view, state: 'STOPPED', lastAction: 'Stopped; disposable context closed.' });
    this.state = 'STOPPED'; this.duration = 0; this.error = undefined; this.emit();
  }

  async pause(): Promise<void> {
    if (['STOPPED', 'STOPPING', 'PAUSED', 'ERROR'].includes(this.state)) return;
    this.duration = this.deadline === undefined ? this.duration : Math.max(0, this.deadline - this.clock.now());
    this.deadline = undefined; this.state = 'PAUSED'; this.ending = true;
    this.lifecycle?.abort(); this.cycleAbort?.abort(); this.emit();
    await this.closeDriver(); await this.task; this.task = undefined; this.lifecycle = undefined;
    await this.cleanupCycle();
    for (const view of this.views.values()) {
      if (this.challenges.has(view.id)) continue;
      this.update({ ...view, state: 'WAITING_FOR_ROTATION', lastAction: this.backgroundProxies ? 'Paused; context closed, reservation released, background checks continue.' : 'Paused; context closed and old pool discarded.' });
    }
    this.state = 'PAUSED'; this.emit();
  }

  async resume(): Promise<void> {
    if (!this.settings || !['PAUSED', 'WAITING_FOR_PROXIES'].includes(this.state)) return;
    if (this.backgroundProxies && this.state === 'WAITING_FOR_PROXIES' && this.task) {
      this.backgroundProxies.requestRefresh(); this.emit(); return;
    }
    await this.task; this.task = undefined;
    if (this.duration <= 0) {
      if (this.cycleSavedAt !== undefined) this.store.saveCycle(this.cycle, this.keywords[this.keywordIndex], this.cycleSavedAt, this.clock.now());
      this.keywordIndex = (this.keywordIndex + 1) % this.keywords.length; this.cycle++;
      this.cycleSavedAt = undefined; this.duration = this.settings.rotationSeconds * 1000;
    }
    await this.begin();
  }
  async preview(id: string): Promise<string | undefined> {
    const worker = this.workers.get(id);
    if (!worker || this.state !== 'RUNNING') return undefined;
    try { return await worker.preview(); } catch (error) { this.log('warn', `Preview unavailable: ${this.safe(error)}`, id); return undefined; }
  }
  async openResult(id: string, url: string): Promise<void> {
    const worker = this.workers.get(id);
    if (!worker || this.state !== 'RUNNING' || !this.cycleAbort || this.challenges.has(id)) throw new Error('Session is not available for navigation.');
    if (!this.settings?.authorizedNavigation) throw new Error('Enable authorized navigation and configure its scope first.');
    try { await worker.openResult(url, this.cycleAbort.signal); }
    catch (error) {
      if (!this.cycleAbort?.signal.aborted && this.state === 'RUNNING') {
        const kind = this.errorKind(error), reason = this.safe(error);
        if (CHALLENGES.has(kind)) {
          this.challenges.set(id, { kind, reason });
          this.update({ ...this.views.get(id)!, state: 'CHALLENGED', errorKind: kind, lastError: reason, lastAction: 'Access challenge; suspended until a new START.' });
          const observation: Observation = { sessionId: id, cycle: this.cycle, keyword: this.keywords[this.keywordIndex], outcome: 'CHALLENGED', pagesInspected: 0, resultsInspected: 0, reason, timestamp: new Date(this.clock.now()).toISOString() };
          this.store.saveObservation(observation); this.observations.push(observation);
          if (this.observations.length > HISTORY_LIMIT) this.observations.splice(0, this.observations.length - HISTORY_LIMIT);
          await this.closeWorker(id, true);
        }
        this.log(CHALLENGES.has(kind) ? 'warn' : 'error', reason, id);
      }
      throw new Error(this.safe(error));
    }
  }
}
