import { chromium, type Browser, type BrowserContext } from 'playwright-core';
import type { ProxyEntry, Settings } from '../../shared/types';
import { resolveChromiumPath, type ChromiumDriverOptions } from '../browser-manager/driver';
import { challengeKind } from '../serp-inspector';
import type { ProxyChecker, CheckResult } from './background';
import { actualMemoryUsage } from '../../shared/memory';
import { acceptSearchCookies } from '../google-consent';
import { BrowserFailure } from '../browser-manager/errors';

/** Checks use isolated disposable Chromium contexts with the candidate proxy applied. */
export class GoogleProxyChecker implements ProxyChecker {
  private browser?: Browser;
  private launching?: Promise<Browser>;
  private generation = 0;
  private readonly contexts = new Set<BrowserContext>();
  private readonly disposals = new WeakMap<BrowserContext, Promise<void>>();
  private readonly cancellations = new Set<() => void>();
  constructor(private readonly options: ChromiumDriverOptions & { timeoutMs?: number; memoryUsage?: typeof actualMemoryUsage } = {}) {}
  get contextCount(): number { return this.contexts.size; }
  private dispose(context: BrowserContext): Promise<void> {
    let task = this.disposals.get(context);
    if (!task) { task = context.close().catch(() => {}); this.disposals.set(context, task); }
    return task;
  }
  private async launch(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (this.launching) return this.launching;
    const generation = this.generation;
    const task = chromium.launch({ executablePath: resolveChromiumPath(this.options.executablePath), headless: true,
      chromiumSandbox: this.options.chromiumSandbox ?? process.env.DOM_DISABLE_CHROMIUM_SANDBOX !== '1' }).then(async browser => {
      if (generation !== this.generation) { await browser.close(); throw new Error('Check launch cancelled'); }
      this.browser = browser; return browser;
    });
    this.launching = task;
    try { return await task; } finally { if (this.launching === task) this.launching = undefined; }
  }
  async check(proxy: ProxyEntry, settings: Settings, signal: AbortSignal): Promise<CheckResult> {
    if (signal.aborted) return { reachable: false };
    // Keep background checks bounded on machines already near the user's RAM limit.
    const memory = (this.options.memoryUsage ?? actualMemoryUsage)();
    if (memory.usedBytes / memory.totalBytes * 100 >= settings.maxMemoryPercent) return { reachable: false, deferred: true };
    const generation = this.generation;
    let context: BrowserContext | undefined;
    let cancelled!: (result: CheckResult) => void;
    const cancellation = new Promise<CheckResult>(resolve => { cancelled = resolve; });
    let cancelledCheck = false;
    const abort = () => { cancelledCheck = true; if (context) void this.dispose(context); cancelled({ reachable: false }); };
    this.cancellations.add(abort);
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, (this.options.timeoutMs ?? 12000) + 3000);
    const operation = async (): Promise<CheckResult> => {
      try {
        const browser = await this.launch();
        if (signal.aborted || cancelledCheck || generation !== this.generation) return { reachable: false };
        context = await browser.newContext({ proxy: { server: proxy.server, username: proxy.username, password: proxy.password, bypass: '<-loopback>' },
          locale: settings.locale, serviceWorkers: 'block', acceptDownloads: false });
        this.contexts.add(context);
        if (signal.aborted || cancelledCheck || generation !== this.generation) { this.contexts.delete(context); await this.dispose(context); return { reachable: false }; }
        const page = await context.newPage();
        if (signal.aborted || cancelledCheck || generation !== this.generation) return { reachable: false };
        const url = settings.mode === 'controlled' ? settings.controlledSearchUrl : `https://www.google.com/?hl=${encodeURIComponent(settings.locale)}`;
        const timeout = this.options.timeoutMs ?? 12000;
        let response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
        response = await acceptSearchCookies(page, url, signal, { response }) ?? response;
        if (await challengeKind(page, response?.status())) return { reachable: false, challenged: true };
        if (!response?.ok() || new URL(page.url()).origin !== new URL(url).origin) return { reachable: false };
        await page.locator('textarea[name="q"], input[name="q"], [data-search-input]').first().waitFor({ state: 'visible', timeout: Math.min(3000, timeout) });
        if (await challengeKind(page, response.status())) return { reachable: false, challenged: true };
        return { reachable: !signal.aborted && !cancelledCheck && generation === this.generation };
      } catch (error) {
        return { reachable: false, ...(error instanceof BrowserFailure && ['CAPTCHA', 'UNUSUAL_TRAFFIC', 'ACCESS_DENIED'].includes(error.kind) ? { challenged: true } : {}) };
      }
    };
    try { return await Promise.race([operation(), cancellation]); }
    finally {
      clearTimeout(timer); this.cancellations.delete(abort); signal.removeEventListener('abort', abort);
      if (context) { this.contexts.delete(context); await this.dispose(context); }
    }
  }
  async close(): Promise<void> {
    this.generation++;
    for (const cancel of this.cancellations) cancel();
    await Promise.allSettled([...this.contexts].map(c => this.dispose(c))); this.contexts.clear();
    const browser = this.browser; this.browser = undefined; await browser?.close().catch(() => {});
    await this.launching?.catch(() => undefined);
  }
}
