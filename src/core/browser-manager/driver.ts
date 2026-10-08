import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Page } from 'playwright-core';
import type { BrowserDriver, Settings, ProxyEntry, EventSink, Worker, SessionView, Observation, SessionState } from '../../shared/types';
import { BrowserFailure, aborted, classifyBrowserError, pause } from './errors';
import { displayUrl, inNavigationScope, matchesTarget } from '../dom-matcher';
import { assertNotChallenged, inspectSerp } from '../serp-inspector';
import { keepAlive, verifyArticleContent, type KeepAliveHooks } from '../keep-alive';

export interface ChromiumDriverOptions { executablePath?: string; chromiumSandbox?: boolean; }
export function resolveChromiumPath(override?: string): string {
  const path = override ?? process.env.DOM_CHROMIUM_PATH ?? [resolve('.cache/portable-chromium', process.platform === 'win32' ? 'chrome.exe' : 'chrome'), chromium.executablePath(), '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(existsSync);
  if (!path) throw new BrowserFailure('RESOURCE_LIMIT', 'Chromium runtime is missing; install the documented runtime or set DOM_CHROMIUM_PATH');
  return path;
}
const pointerScript = () => {
  const insert = () => {
    if (document.getElementById('dom-research-pointer')) return;
    const cursor = document.createElement('div');
    cursor.id = 'dom-research-pointer'; cursor.setAttribute('aria-hidden', 'true');
    Object.assign(cursor.style, { position: 'fixed', left: '80px', top: '80px', width: '20px', height: '20px', border: '2px solid #facc15', borderRadius: '50%', background: '#facc1555', boxShadow: '0 0 0 3px #0008', zIndex: '2147483647', pointerEvents: 'none', transform: 'translate(-50%, -50%)' });
    document.documentElement.appendChild(cursor);
  };
  if (document.documentElement) insert();
  else document.addEventListener('DOMContentLoaded', insert, { once: true });
};

export class ChromiumDriver implements BrowserDriver {
  private browser?: Browser;
  private generation = 0;
  private launching?: Promise<void>;
  private readonly workers = new Set<ChromiumWorker>();
  constructor(private readonly options: ChromiumDriverOptions = {}) {}

  async launch(settings: Settings): Promise<void> {
    if (this.browser?.isConnected()) return;
    if (this.launching) return this.launching;
    const executablePath = resolveChromiumPath(this.options.executablePath);
    const generation = this.generation;
    const task = (async () => {
      try {
        const browser = await chromium.launch({ executablePath, headless: settings.headless, chromiumSandbox: this.options.chromiumSandbox ?? process.env.DOM_DISABLE_CHROMIUM_SANDBOX !== '1' });
        if (generation !== this.generation) { await browser.close(); throw new BrowserFailure('CANCELLED', 'Browser launch cancelled'); }
        this.browser = browser;
      } catch (error) {
        if (error instanceof BrowserFailure) throw error;
        if (/sandbox|Operation not permitted|No usable sandbox/i.test(String(error))) throw new BrowserFailure('RESOURCE_LIMIT', 'Chromium OS sandbox is unavailable. Configure a supported sandbox or explicitly use the isolated cloud test runtime option.');
        throw new BrowserFailure('RESOURCE_LIMIT', 'Chromium could not start; verify the runtime path and required operating system libraries');
      }
    })();
    this.launching = task;
    try { await task; } finally { if (this.launching === task) this.launching = undefined; }
  }

  async create(id: string, cycle: number, keyword: string, proxy: ProxyEntry, settings: Settings, sink: EventSink): Promise<Worker> {
    if (!this.browser?.isConnected()) throw new BrowserFailure('RESOURCE_LIMIT', 'Chromium is not running');
    const generation = this.generation;
    let context: BrowserContext | undefined;
    try {
      context = await this.browser.newContext({
        proxy: { server: proxy.server, username: proxy.username, password: proxy.password, bypass: '<-loopback>' },
        locale: settings.locale,
        viewport: settings.device === 'mobile' ? { width: 390, height: 844 } : { width: 1280, height: 800 },
        isMobile: settings.device === 'mobile', hasTouch: settings.device === 'mobile',
        userAgent: settings.device === 'mobile' ? `Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${this.browser.version()} Mobile Safari/537.36` : undefined,
        acceptDownloads: false,
        serviceWorkers: 'block'
      });
      const page = await context.newPage();
      if (generation !== this.generation) throw new BrowserFailure('CANCELLED', 'Context creation cancelled');
      const worker = new ChromiumWorker(context, page, id, cycle, keyword, proxy, settings, sink, () => this.workers.delete(worker));
      this.workers.add(worker);
      await worker.initialize();
      if (generation !== this.generation) { await worker.close(); throw new BrowserFailure('CANCELLED', 'Context creation cancelled'); }
      return worker;
    } catch (error) { await context?.close().catch(() => undefined); throw classifyBrowserError(error); }
  }

  async close(): Promise<void> {
    this.generation++;
    const browser = this.browser;
    this.browser = undefined;
    await Promise.allSettled([...this.workers].map(worker => worker.close()));
    await browser?.close().catch(() => undefined);
  }

  get contextCount(): number { return this.browser?.contexts().length ?? 0; }
  get version(): string | undefined { return this.browser?.version(); }
}

class ChromiumWorker implements Worker {
  view: SessionView;
  private closed = false;
  private closePromise?: Promise<void>;
  private authorizedPhase = false;
  private scopeViolation = false;
  private readonly results = new Set<string>();
  private readonly resultSources = new Map<string, string>();
  private readonly observedSerpPages = new Set<string>();
  private providerOrigin?: string;
  private approvedResultBridge?: string;
  private pagesInspected = 0;
  private resultsInspected = 0;
  private outcomeSaved = false;
  private manualNavigation = false;
  private manualTask?: Promise<void>;
  private manualAbort?: AbortController;
  private interceptor?: CDPSession;
  private interceptListener?: (event: { requestId: string; frameId: string; request: { url: string } }) => void;
  private readonly pageListener: (page: Page) => void;
  private readonly closeListener: () => void;

  constructor(private readonly context: BrowserContext, private readonly page: Page, id: string, cycle: number, keyword: string, proxy: ProxyEntry, private readonly settings: Settings, private readonly sink: EventSink, private readonly dispose: () => void) {
    this.view = { id, cycle, keyword, proxyId: proxy.id, state: 'INITIALIZING', url: '', lastAction: 'Initialize isolated Chromium context', startedAt: Date.now(), retryCount: 0, navigationCount: 0 };
    this.pageListener = popup => { if (popup !== this.page) void popup.close().catch(() => undefined); };
    this.closeListener = () => { this.closed = true; this.dispose(); };
  }

  async initialize(): Promise<void> {
    this.context.on('page', this.pageListener);
    this.context.on('close', this.closeListener);
    await this.page.addInitScript(pointerScript);
    // CDP intercepts every redirect hop; Playwright URL routes cover only the first hop.
    const interceptor = await this.context.newCDPSession(this.page);
    this.interceptor = interceptor;
    const frameTree = await interceptor.send('Page.getFrameTree');
    const rootFrameId: string = frameTree.frameTree.frame.id;
    this.interceptListener = event => {
      let blocked = false;
      if (event.frameId === rootFrameId) {
        if (this.authorizedPhase) blocked = !inNavigationScope(event.request.url, this.settings) && event.request.url !== this.approvedResultBridge;
        else if (this.settings.mode === 'controlled' && this.providerOrigin) {
          try { blocked = new URL(event.request.url).origin !== this.providerOrigin; } catch { blocked = true; }
        }
      }
      if (blocked) this.scopeViolation = true;
      const decision = blocked ? interceptor.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }) : interceptor.send('Fetch.continueRequest', { requestId: event.requestId });
      void decision.catch(() => undefined).finally(() => { if (blocked) void this.close(); });
    };
    interceptor.on('Fetch.requestPaused', this.interceptListener);
    await interceptor.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] });
    this.update('READY', 'Isolated context ready');
  }

  private update(state: SessionState, action: string): void {
    this.view.state = state; this.view.lastAction = action; this.view.url = displayUrl(this.page.url());
    this.sink.session({ ...this.view });
  }

  private saveOutcome(outcome: Observation['outcome'], reason?: string, additional = false): void {
    if (this.outcomeSaved && !additional) return;
    this.outcomeSaved = true;
    this.sink.observation({ sessionId: this.view.id, cycle: this.view.cycle, keyword: this.view.keyword, outcome, pagesInspected: this.pagesInspected, resultsInspected: this.resultsInspected, reason, timestamp: new Date().toISOString() });
  }

  private hooks(): KeepAliveHooks {
    return {
      state: (state, action) => this.update(state, action),
      point: (x, y, click) => this.point(x, y, click),
      navigate: (url, action) => {
        if (action === 'internal-article' || action === 'open-result') this.view.navigationCount++;
        this.sink.navigation({ sessionId: this.view.id, cycle: this.view.cycle, url: displayUrl(url), action, passed: true, timestamp: new Date().toISOString() });
        this.update(this.view.state, this.view.lastAction);
      }
    };
  }

  private async point(x: number, y: number, click = false): Promise<void> {
    await this.page.mouse.move(x, y, { steps: 3 });
    await this.page.evaluate(({ x, y, click }) => {
      const pointer = document.getElementById('dom-research-pointer');
      if (!pointer) return;
      pointer.style.left = `${x}px`; pointer.style.top = `${y}px`;
      pointer.style.borderColor = click ? '#fb7185' : '#facc15'; pointer.style.background = click ? '#fb718599' : '#facc1555';
      if (click) {
        setTimeout(() => { pointer.style.borderColor = '#facc15'; pointer.style.background = '#facc1555'; }, 700);
        const hit = document.elementFromPoint(x, y);
        const element = (hit?.closest('a, button, input, textarea, [role="button"]') ?? hit) as (HTMLElement & { __domClickHighlight?: { outline: string; offset: string; marker: string | null; timer: number } }) | null;
        if (element && !element.closest('#dom-research-pointer')) {
          const previous = element.__domClickHighlight ?? { outline: element.style.outline, offset: element.style.outlineOffset, marker: element.getAttribute('data-dom-click-highlight'), timer: 0 };
          window.clearTimeout(previous.timer);
          element.style.outline = '3px solid #fb7185'; element.style.outlineOffset = '3px'; element.setAttribute('data-dom-click-highlight', 'true');
          previous.timer = window.setTimeout(() => {
            element.style.outline = previous.outline; element.style.outlineOffset = previous.offset;
            if (previous.marker === null) element.removeAttribute('data-dom-click-highlight'); else element.setAttribute('data-dom-click-highlight', previous.marker);
            delete element.__domClickHighlight;
          }, 700);
          element.__domClickHighlight = previous;
        }
      }
    }, { x, y, click });
    this.view.pointer = { x: Math.round(x), y: Math.round(y) };
  }

  async run(signal: AbortSignal): Promise<void> {
    const stop = () => { void this.close(); };
    signal.addEventListener('abort', stop, { once: true });
    try {
      aborted(signal);
      this.update('SEARCHING', 'Open search provider and submit keyword');
      const searchUrl = this.settings.mode === 'controlled' ? this.settings.controlledSearchUrl : `https://www.google.com/?hl=${encodeURIComponent(this.settings.locale)}`;
      this.providerOrigin = new URL(searchUrl).origin;
      const response = await this.page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await assertNotChallenged(this.page, response?.status());
      const search = this.page.locator('textarea[name="q"], input[name="q"], [data-search-input]').first();
      await search.waitFor({ state: 'visible', timeout: 10000 });
      const box = await search.boundingBox();
      if (box) await this.point(box.x + box.width / 2, box.y + box.height / 2, true);
      await search.click(); await search.fill(this.view.keyword); await search.press('Enter');
      await this.page.waitForLoadState('domcontentloaded', { timeout: 15000 });
      let found = false;
      let unsupported = false;
      let firstMatch: string | undefined;
      const visitedPages = new Set<string>();
      for (let resultPage = 1; resultPage <= Math.max(1, Math.min(100, this.settings.searchDepth)); resultPage++) {
        aborted(signal);
        this.update('INSPECTING_SERP', `Inspect organic result page ${resultPage}`);
        const serp = await inspectSerp(this.page, signal);
        this.pagesInspected++;
        visitedPages.add(this.page.url());
        this.observedSerpPages.add(this.page.url());
        if (!serp.supported || !serp.results.length && !serp.empty) { unsupported = true; break; }
        for (const [index, result] of serp.results.entries()) {
          this.results.add(result.url);
          if (!this.resultSources.has(result.url)) this.resultSources.set(result.url, this.page.url());
          const organicPosition = this.resultsInspected + index + 1;
          if (!matchesTarget(result.url, this.settings.target, this.settings.matchMode)) continue;
          found = true; firstMatch ??= result.url;
          this.view.rank ??= organicPosition;
          this.sink.ranking({ keyword: this.view.keyword, target: displayUrl(this.settings.target) || this.settings.target, url: displayUrl(result.url), title: result.title, organicPosition, elementPosition: result.elementPosition, resultPage, sessionId: this.view.id, proxyId: this.view.proxyId, device: this.settings.device, searchLocation: this.settings.searchLocation, cycle: this.view.cycle, timestamp: new Date().toISOString() });
        }
        this.resultsInspected += serp.results.length;
        if (found && this.settings.earlyStop || !serp.next || resultPage >= this.settings.searchDepth) break;
        const next = new URL(serp.next);
        if (next.origin !== new URL(this.page.url()).origin || visitedPages.has(next.href)) { unsupported = true; break; }
        const response = await this.page.goto(next.href, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await assertNotChallenged(this.page, response?.status());
      }
      this.saveOutcome(found ? 'FOUND' : unsupported ? 'INCONCLUSIVE' : 'NOT_FOUND', unsupported ? 'Organic result DOM could not be completely interpreted' : undefined);
      this.update(found ? 'TARGET_FOUND' : 'TARGET_NOT_FOUND', found ? 'Matching organic results recorded' : unsupported ? 'Search inspection inconclusive' : 'Target absent from inspected result pages');
      if (this.settings.mode === 'controlled' && firstMatch && inNavigationScope(firstMatch, this.settings)) {
        await this.navigateResult(firstMatch, signal);
        await keepAlive(this.page, this.settings, signal, this.hooks());
      } else {
        if (this.settings.mode === 'controlled' && firstMatch) this.update('WAITING_FOR_ROTATION', 'Navigation requires an explicitly authorized origin and path scope');
        await pause(2_147_000_000, signal);
      }
    } catch (error) {
      const failure = signal.aborted ? new BrowserFailure('CANCELLED', 'Session stopped') : this.scopeViolation ? new BrowserFailure('UNSUPPORTED_DOM', 'Navigation redirected outside the authorized scope') : classifyBrowserError(error);
      this.view.errorKind = failure.kind; this.view.lastError = failure.message;
      if (['CAPTCHA', 'UNUSUAL_TRAFFIC', 'ACCESS_DENIED'].includes(failure.kind)) {
        this.update('CHALLENGED', failure.message); this.saveOutcome('CHALLENGED', failure.message);
        return;
      }
      if (failure.kind === 'CANCELLED') { this.saveOutcome('CANCELLED', 'Session stopped before inspection completed'); this.update('STOPPED', 'Session stopped'); return; }
      this.update('NETWORK_ERROR', failure.message); this.saveOutcome(failure.kind === 'UNSUPPORTED_DOM' ? 'INCONCLUSIVE' : 'ERROR', failure.message, failure.kind === 'UNSUPPORTED_DOM' && this.outcomeSaved);
      throw failure;
    } finally { signal.removeEventListener('abort', stop); if (signal.aborted) await this.close(); }
  }

  private async navigateResult(url: string, signal: AbortSignal): Promise<void> {
    aborted(signal);
    if (!this.results.has(url) || !inNavigationScope(url, this.settings)) throw new BrowserFailure('UNSUPPORTED_DOM', 'Result navigation requires an observed result and explicitly authorized scope');
    this.scopeViolation = false;
    if (this.settings.mode === 'controlled') {
      const source = this.resultSources.get(url);
      if (!source || !this.observedSerpPages.has(source) || new URL(source).origin !== this.providerOrigin) throw new BrowserFailure('UNSUPPORTED_DOM', 'Recorded result has no permitted observed provider page');
      if (source !== this.page.url()) {
        this.authorizedPhase = false;
        this.update('INSPECTING_SERP', 'Return to the observed result page for a real result click');
        const response = await this.page.goto(source, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await assertNotChallenged(this.page, response?.status());
        const revisited = await inspectSerp(this.page, signal);
        if (!revisited.results.some(result => result.url === url)) throw new BrowserFailure('UNSUPPORTED_DOM', 'Recorded organic result is absent after revisiting its provider page');
      }
    }
    this.authorizedPhase = true;
    this.update('NAVIGATING', 'Open explicitly authorized result');
    const anchor = this.page.locator('a[href]').filter({ hasText: '' });
    const index = await anchor.evaluateAll((anchors, wanted) => anchors.findIndex(link => {
      try {
        let candidate = new URL((link as HTMLAnchorElement).href);
        if (/\/url$/.test(candidate.pathname) && (candidate.searchParams.has('q') || candidate.searchParams.has('url'))) candidate = new URL(candidate.searchParams.get('q') ?? candidate.searchParams.get('url')!);
        return candidate.href === wanted;
      } catch { return false; }
    }), url);
    // A result found on an earlier inspected page remains available for explicit navigation.
    if (index >= 0) {
      const result = anchor.nth(index);
      await result.scrollIntoViewIfNeeded();
      const box = await result.boundingBox();
      if (box) await this.point(box.x + box.width / 2, box.y + box.height / 2, true);
      const href = await result.getAttribute('href');
      if (href && (this.settings.mode === 'controlled' || new URL(href, this.page.url()).origin === new URL(url).origin)) {
        const clickUrl = new URL(href, this.page.url());
        if (!inNavigationScope(clickUrl.href, this.settings)) {
          if (clickUrl.origin !== this.providerOrigin) throw new BrowserFailure('UNSUPPORTED_DOM', 'Result anchor has no permitted provider redirect');
          this.approvedResultBridge = clickUrl.href;
        }
        await result.evaluate(element => element.removeAttribute('target'));
        const previous = this.page.url();
        await Promise.all([
          this.page.waitForURL(next => next.href !== previous && inNavigationScope(next.href, this.settings), { waitUntil: 'domcontentloaded', timeout: 15000 }),
          result.click({ timeout: 10000, noWaitAfter: true })
        ]);
      } else await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    } else {
      if (this.settings.mode === 'controlled') throw new BrowserFailure('UNSUPPORTED_DOM', 'Recorded organic result anchor is absent; navigation inspection is inconclusive');
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    }
    this.approvedResultBridge = undefined;
    aborted(signal);
    if (!inNavigationScope(this.page.url(), this.settings)) throw new BrowserFailure('UNSUPPORTED_DOM', 'Result redirected outside the authorized scope');
    await assertNotChallenged(this.page);
    await verifyArticleContent(this.page, signal);
    this.hooks().navigate(this.page.url(), 'open-result');
  }

  async openResult(url: string, signal: AbortSignal): Promise<void> {
    if (this.closed || this.manualNavigation || this.settings.mode !== 'google') throw new BrowserFailure('UNSUPPORTED_DOM', 'This session cannot open another result now');
    this.manualNavigation = true;
    const abort = new AbortController();
    this.manualAbort = abort;
    const cancel = () => abort.abort();
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) abort.abort();
    try {
      await this.navigateResult(url, abort.signal);
      // IPC resolves once entry is verified. The bounded article loop belongs to this context.
      const task = keepAlive(this.page, this.settings, abort.signal, this.hooks()).catch(error => {
        const failure = this.scopeViolation ? new BrowserFailure('UNSUPPORTED_DOM', 'Navigation redirected outside the authorized scope') : abort.signal.aborted ? new BrowserFailure('CANCELLED', 'Authorized Keep Alive stopped') : classifyBrowserError(error);
        const challenged = ['CAPTCHA', 'UNUSUAL_TRAFFIC', 'ACCESS_DENIED'].includes(failure.kind);
        this.sink.log({ level: failure.kind === 'CANCELLED' ? 'info' : challenged ? 'warn' : 'error', sessionId: this.view.id, cycle: this.view.cycle, message: failure.message, timestamp: new Date().toISOString() });
        if (failure.kind === 'CANCELLED') return;
        this.view.errorKind = failure.kind; this.view.lastError = failure.message;
        this.update(challenged ? 'CHALLENGED' : 'NETWORK_ERROR', failure.message);
        this.saveOutcome(challenged ? 'CHALLENGED' : failure.kind === 'UNSUPPORTED_DOM' ? 'INCONCLUSIVE' : 'ERROR', failure.message, true);
        this.sink.navigation({ sessionId: this.view.id, cycle: this.view.cycle, url: displayUrl(this.page.url()), action: 'authorized-keep-alive', passed: false, timestamp: new Date().toISOString() });
        // Do not await close here: close joins this task after the catch has settled.
        void this.close();
      }).finally(() => {
        signal.removeEventListener('abort', cancel);
        if (this.manualTask === task) this.manualTask = undefined;
        if (this.manualAbort === abort) this.manualAbort = undefined;
        this.manualNavigation = false;
      });
      this.manualTask = task;
    } catch (error) {
      signal.removeEventListener('abort', cancel); this.manualAbort = undefined; this.manualNavigation = false;
      throw signal.aborted ? new BrowserFailure('CANCELLED', 'Session stopped') : this.scopeViolation ? new BrowserFailure('UNSUPPORTED_DOM', 'Navigation redirected outside the authorized scope') : classifyBrowserError(error);
    }
  }

  async preview(): Promise<string | undefined> {
    if (this.closed) return undefined;
    try { return `data:image/jpeg;base64,${(await this.page.screenshot({ type: 'jpeg', quality: 65, timeout: 4000 })).toString('base64')}`; }
    catch { return undefined; }
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeContext();
    return this.closePromise;
  }

  private async closeContext(): Promise<void> {
    const manualTask = this.manualTask;
    this.manualAbort?.abort();
    if (this.closed) { await manualTask; return; }
    this.closed = true;
    this.update('STOPPING', 'Close isolated Chromium context');
    this.context.off('page', this.pageListener); this.context.off('close', this.closeListener);
    if (this.interceptor && this.interceptListener) this.interceptor.off('Fetch.requestPaused', this.interceptListener);
    await this.context.close().catch(() => undefined);
    this.dispose(); this.update('STOPPED', 'Isolated context closed');
    await manualTask;
  }
}

export { BrowserFailure } from './errors';
