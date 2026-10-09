import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';
import { GoogleProxyChecker } from '../../core/proxy-pool/google-checker';
import { ChromiumDriver } from '../../core/browser-manager/driver';
import { acceptSearchCookies } from '../../core/google-consent';
import { parseProxyList } from '../../core/proxy-api';
import { DEFAULT_SETTINGS, type Diagnostic, type EventSink, type Observation, type RankingRecord, type Worker } from '../../shared/types';
import { fixtureServer, forwardingProxy } from '../fixtures/server';

const wait = (check: () => void) => vi.waitFor(check, { timeout: 20000, interval: 25 });
const memoryUsage = () => ({ usedBytes: 0, totalBytes: 100 });
describe('automatic search cookie consent', () => {
  it.each(['/cookie-home', '/cookie-delayed', '/cookie-localized', '/cookie-iframe'])('accepts %s with a real trusted click before admitting a proxy', async path => {
    const site = await fixtureServer(), proxy = await forwardingProxy();
    const checker = new GoogleProxyChecker({ memoryUsage });
    try {
      expect(await checker.check(parseProxyList(proxy.server)[0], { ...DEFAULT_SETTINGS, mode: 'controlled', controlledSearchUrl: site.origin + path }, new AbortController().signal)).toEqual({ reachable: true });
      await wait(() => expect(site.logs.some(log => log.path === '/consent-event')).toBe(true));
      expect(site.logs.filter(log => log.path === '/consent-event').map(log => log.body)).toEqual([expect.objectContaining({ choice: 'accept', trusted: true })]);
      expect(checker.contextCount).toBe(0);
    } finally { await checker.close(); await proxy.close(); await site.close(); }
  });
  it('submits the standalone Accept all form and follows its redirect back to the search box', async () => {
    const site = await fixtureServer(), proxy = await forwardingProxy();
    const checker = new GoogleProxyChecker({ memoryUsage });
    try {
      expect(await checker.check(parseProxyList(proxy.server)[0], { ...DEFAULT_SETTINGS, mode: 'controlled', controlledSearchUrl: site.origin + '/cookie-redirect' }, new AbortController().signal)).toEqual({ reachable: true });
      expect(site.logs.find(log => log.path === '/cookie-save')?.body).toEqual({ choice: 'accept' });
      expect(site.logs.find(log => log.path === '/cookie-home')?.cookie).toContain('consent=accepted');
      expect(checker.contextCount).toBe(0);
    } finally { await checker.close(); await proxy.close(); await site.close(); }
  });
  it('preserves challenge detection before and after the cookie action', async () => {
    const site = await fixtureServer(), proxy = await forwardingProxy();
    const checker = new GoogleProxyChecker({ memoryUsage });
    try {
      for (const path of ['/cookie-challenge', '/cookie-after-challenge']) {
        expect(await checker.check(parseProxyList(proxy.server)[0], { ...DEFAULT_SETTINGS, mode: 'controlled', controlledSearchUrl: site.origin + path }, new AbortController().signal)).toEqual({ reachable: false, challenged: true });
      }
      await wait(() => expect(site.logs.filter(log => log.path === '/consent-event')).toHaveLength(1));
      expect(site.logs.find(log => log.path === '/consent-event')?.body?.path).toBe('/cookie-after-challenge');
    } finally { await checker.close(); await proxy.close(); await site.close(); }
  });
  it('bounds an undismissable prompt and cancels active consent cleanly', async () => {
    const site = await fixtureServer(), proxy = await forwardingProxy();
    const checker = new GoogleProxyChecker({ memoryUsage, timeoutMs: 500 });
    const settings = { ...DEFAULT_SETTINGS, mode: 'controlled' as const, controlledSearchUrl: site.origin + '/cookie-stuck' };
    try {
      expect(await checker.check(parseProxyList(proxy.server)[0], settings, new AbortController().signal)).toEqual({ reachable: false });
      expect(checker.contextCount).toBe(0);
      const start = site.logs.length, stop = new AbortController();
      const task = checker.check(parseProxyList(proxy.server)[0], settings, stop.signal);
      await wait(() => expect(site.logs.slice(start).some(log => log.path === '/consent-event')).toBe(true));
      stop.abort(); expect(await task).toEqual({ reachable: false }); expect(checker.contextCount).toBe(0);
    } finally { await checker.close(); await proxy.close(); await site.close(); }
  });
  it('accepts independently in fresh research contexts and on later result pages, preserving rankings', async () => {
    const site = await fixtureServer(), proxies = await Promise.all([forwardingProxy(), forwardingProxy()]);
    const driver = new ChromiumDriver(), stops = [new AbortController(), new AbortController()];
    const observations: Observation[] = [], rankings: RankingRecord[] = [], logs: Diagnostic[] = [];
    const sink: EventSink = { session: () => {}, ranking: value => rankings.push(value), observation: value => observations.push(value), log: value => logs.push(value), navigation: () => {} };
    const settings = { ...DEFAULT_SETTINGS, mode: 'controlled' as const, controlledSearchUrl: site.origin + '/cookie-home', target: site.origin };
    const workers: Worker[] = [], runs: Promise<void>[] = [];
    try {
      await driver.launch(settings);
      for (let i = 0; i < 2; i++) workers.push(await driver.create(`consent-${i}`, 1, `cookie-keyword-${i}`, parseProxyList(proxies[i].server)[0], settings, sink));
      runs.push(...workers.map((worker, i) => worker.run(stops[i].signal)));
      await wait(() => expect(observations.filter(value => value.outcome === 'FOUND')).toHaveLength(2));
      await wait(() => expect(site.logs.filter(log => log.path === '/consent-event')).toHaveLength(4));
      expect(site.logs.filter(log => log.path === '/consent-event').every(log => log.body?.choice === 'accept' && log.body?.trusted)).toBe(true);
      expect(logs.filter(log => log.message.includes('Accept all cookies'))).toHaveLength(4);
      for (let i = 0; i < 2; i++) {
        expect(rankings.filter(value => value.sessionId === `consent-${i}`).map(value => value.organicPosition)).toEqual([2, 5]);
        const page = (workers[i] as unknown as { page: Page }).page;
        expect((await page.context().cookies()).find(cookie => cookie.name === 'consent')?.value).toBe('accepted');
        expect((await page.context().cookies()).find(cookie => cookie.name === 'identity')?.value).toBe(`cookie-keyword-${i}`);
      }
    } finally {
      stops.forEach(stop => stop.abort()); await Promise.allSettled(runs); await driver.close(); await Promise.all(proxies.map(proxy => proxy.close())); await site.close();
    }
    expect(driver.contextCount).toBe(0);
  });
  it('handles the separate consent.google.com origin and accepts again in a new Google research context', async () => {
    const proxy = await forwardingProxy(), driver = new ChromiumDriver();
    const settings = { ...DEFAULT_SETTINGS, mode: 'google' as const, target: 'example.test', searchDepth: 1 };
    const accepted: string[] = [], observations: Observation[] = [], rankings: RankingRecord[] = [];
    const sink: EventSink = { session: () => {}, log: () => {}, navigation: () => {}, observation: value => observations.push(value), ranking: value => rankings.push(value) };
    try {
      await driver.launch(settings);
      for (const id of ['first', 'fresh']) {
        const worker = await driver.create(id, 1, id, parseProxyList(proxy.server)[0], settings, sink);
        const page = (worker as unknown as { page: Page }).page;
        await page.route('**/*', async route => {
          const request = route.request(), url = new URL(request.url());
          if (url.hostname === 'consent.google.com') {
            if (url.pathname === '/save') {
              const choice = new URLSearchParams(request.postData() ?? '').get('choice');
              expect(choice).toBe('accept'); accepted.push(id);
              await route.fulfill({ contentType: 'text/html', headers: { 'set-cookie': 'fixture_consent=accepted; Domain=.google.com; Path=/; Secure; SameSite=Lax' }, body: '<script>location.replace("https://www.google.com/")</script>' });
            } else await route.fulfill({ contentType: 'text/html', body: '<h1>Before you continue to Google</h1><form action="/save" method="post"><button name="choice" value="reject">Reject all</button><button name="choice" value="accept">Accept all</button></form>' });
          } else if (url.hostname === 'www.google.com' && url.pathname === '/search') {
            expect(url.searchParams.get('q')).toBe(id);
            await route.fulfill({ contentType: 'text/html', body: '<main id="search"><a href="https://example.test/article"><h3>Target result</h3></a></main>' });
          } else if (url.hostname === 'www.google.com') {
            const cookies = await page.context().cookies('https://www.google.com');
            // Playwright URL routes do not intercept HTTP redirect hops; separate document
            // navigations keep these simulated Google hosts entirely offline.
            if (!cookies.some(cookie => cookie.name === 'fixture_consent')) await route.fulfill({ contentType: 'text/html', body: '<script>location.replace("https://consent.google.com/m")</script>' });
            else await route.fulfill({ contentType: 'text/html', body: '<form action="/search"><input name="q"><button>Search</button></form>' });
          } else await route.abort();
        });
        const stop = new AbortController(), run = worker.run(stop.signal);
        void run.catch(() => {});
        try {
          await wait(() => expect(observations.some(value => value.sessionId === id && value.outcome === 'FOUND')).toBe(true));
          expect(accepted).toContain(id); expect(new URL(page.url()).origin).toBe('https://www.google.com');
        } finally { stop.abort(); await run; await worker.close(); }
      }
      expect(accepted).toEqual(['first', 'fresh']); expect(rankings).toHaveLength(2);
    } finally { await driver.close(); await proxy.close(); }
  });
  it('leaves a cookie control outside the configured Google provider untouched', async () => {
    const site = await fixtureServer(), proxy = await forwardingProxy(), driver = new ChromiumDriver();
    try {
      await driver.launch(DEFAULT_SETTINGS);
      const worker = await driver.create('outside', 1, 'outside', parseProxyList(proxy.server)[0], DEFAULT_SETTINGS, { session: () => {}, log: () => {}, navigation: () => {}, ranking: () => {}, observation: () => {} });
      const page = (worker as unknown as { page: Page }).page;
      await page.goto(site.origin + '/cookie-home');
      await acceptSearchCookies(page, 'https://www.google.com/', new AbortController().signal);
      expect(await page.locator('#L2AGLb').isVisible()).toBe(true); expect(site.logs.some(log => log.path === '/consent-event')).toBe(false);
    } finally { await driver.close(); await proxy.close(); await site.close(); }
  });
});
