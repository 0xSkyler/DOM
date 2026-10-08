import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import net from 'node:net';
import type { Page } from 'playwright-core';
import { ChromiumDriver } from '../../core/browser-manager/driver';
import { DEFAULT_SETTINGS, type EventSink, type NavigationRecord, type Observation, type RankingRecord, type SessionView, type Settings, type Worker } from '../../shared/types';
import { fixtureServer, forwardingProxy } from '../fixtures/server';
import { inNavigationScope, safeArticleLink } from '../../core/dom-matcher';

const waitFor = async (check: () => boolean, timeout = 20000) => {
  const deadline = Date.now() + timeout;
  while (!check()) { if (Date.now() > deadline) throw new Error('Browser condition timed out'); await new Promise(resolve => setTimeout(resolve, 25)); }
};
function capture() {
  const sessions: SessionView[] = [], rankings: RankingRecord[] = [], observations: Observation[] = [], navigation: NavigationRecord[] = [];
  const sink: EventSink = { session: value => sessions.push({ ...value }), ranking: value => rankings.push(value), observation: value => observations.push(value), navigation: value => navigation.push(value), log: () => undefined };
  return { sessions, rankings, observations, navigation, sink };
}

describe('real Chromium research contexts', () => {
  let fixture: Awaited<ReturnType<typeof fixtureServer>>;
  let proxy: Awaited<ReturnType<typeof forwardingProxy>>;
  let driver: ChromiumDriver;
  const settings = (overrides: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, mode: 'controlled', sessionCount: 10, controlledSearchUrl: fixture.origin, target: fixture.origin, scrollDelayMs: 20, navigationDepth: 1, allowedOrigins: [fixture.origin], allowedPathPrefixes: ['/article'], ...overrides });
  const create = (id: string, options: Partial<Settings> = {}, events = capture()): Promise<Worker> => driver.create(id, 1, id, { id: `proxy-${id}`, server: proxy.server, state: 'ASSIGNED' }, settings(options), events.sink);
  beforeAll(async () => { fixture = await fixtureServer(); proxy = await forwardingProxy(); driver = new ChromiumDriver(); await driver.launch(settings()); });
  afterAll(async () => { await driver?.close(); await proxy?.close(); await fixture?.close(); });

  test('ten simultaneous contexts isolate cookies and both storage types, route each assigned proxy, screenshot, and cancel cleanly', async () => {
    const proxies = await Promise.all(Array.from({ length: 10 }, () => forwardingProxy()));
    const controllers = Array.from({ length: 10 }, () => new AbortController());
    const events = Array.from({ length: 10 }, () => capture());
    const workers = await Promise.all(proxies.map((assigned, index) => driver.create(`isolated-${index}`, 1, `isolated-${index}`, { id: `assigned-${index}`, server: assigned.server, state: 'ASSIGNED' }, settings(), events[index].sink)));
    const runs = workers.map((worker, index) => worker.run(controllers[index].signal));
    try {
      await waitFor(() => events.every(event => event.observations.length === 1));
      expect(driver.contextCount).toBe(10);
      await waitFor(() => fixture.logs.filter(log => log.path === '/probe' && String(log.body?.keyword).startsWith('isolated-')).length >= 10);
      for (let index = 0; index < 10; index++) {
        expect(events[index].rankings.map(record => record.organicPosition)).toEqual([2, 5]);
        expect(events[index].rankings[0].elementPosition).toBe(3);
        expect(events[index].observations[0]).toMatchObject({ outcome: 'FOUND', pagesInspected: 2, resultsInspected: 5 });
        const first = fixture.logs.find(log => log.path === '/probe' && log.body?.keyword === `isolated-${index}`)!;
        expect(first.body).toMatchObject({ previous: { local: null, session: null, cookie: '' }, local: `isolated-${index}`, session: `isolated-${index}`, cookie: `identity=isolated-${index}` });
        expect(proxies[index].requests.some(url => url.includes(`q=isolated-${index}`))).toBe(true);
        expect(proxies[index].requests.some(url => /q=isolated-/.test(url) && !url.includes(`q=isolated-${index}`))).toBe(false);
      }
      expect(await workers[0].preview()).toMatch(/^data:image\/jpeg;base64,/);
      expect(events[0].sessions.some(view => view.pointer && view.pointer.x > 0)).toBe(true);
    } finally {
      controllers.forEach(controller => controller.abort());
      await Promise.all(runs); await Promise.all(workers.map(worker => worker.close())); await Promise.all(proxies.map(assigned => assigned.close()));
    }
    expect(driver.contextCount).toBe(0);
  });

  test('dynamic results and early stop preserve organic rank, then scroll twice and follow only a scoped article', async () => {
    const events = capture(), abort = new AbortController();
    const worker = await create('dynamic-match', { controlledSearchUrl: `${fixture.origin}/?action=/dynamic`, target: `${fixture.origin}/article/one`, matchMode: 'exact', earlyStop: true, authorizedNavigation: true }, events);
    const start = fixture.logs.length;
    const run = worker.run(abort.signal);
    try {
      await waitFor(() => events.navigation.some(record => record.action === 'internal-article'));
      expect(events.observations[0]).toMatchObject({ outcome: 'FOUND', pagesInspected: 1, resultsInspected: 3 });
      expect(events.rankings).toHaveLength(1); expect(events.rankings[0].organicPosition).toBe(2);
      expect(events.navigation.filter(record => record.action === 'internal-article')).toHaveLength(1);
      expect(events.navigation.find(record => record.action === 'internal-article')?.url).toBe(`${fixture.origin}/article/two`);
      const scrolls = fixture.logs.slice(start).filter(log => log.path === '/scroll' && log.body?.path === '/article/one').map(log => Number(log.body?.y));
      const ascents = scrolls.filter((y, index) => index > 0 && y < scrolls[index - 1]);
      expect(ascents.length).toBeGreaterThanOrEqual(2);
      expect(fixture.logs.slice(start).some(log => /^\/(login|checkout|article\/remove|article\/download)/.test(log.path))).toBe(false);
      await waitFor(() => worker.view.state === 'WAITING_FOR_ROTATION');
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(events.navigation.filter(record => record.action === 'internal-article')).toHaveLength(1);
    } finally { abort.abort(); await run; await worker.close(); }
    expect(driver.contextCount).toBe(0);
  });

  test('an earlier-page controlled match returns to its observed SERP and reaches the article through an actual trusted anchor click', async () => {
    const events = capture(), abort = new AbortController();
    const worker = await create('earlier-page-click', { target: `${fixture.origin}/article/one`, matchMode: 'exact', earlyStop: false, searchDepth: 2, authorizedNavigation: true }, events);
    const start = fixture.logs.length;
    const run = worker.run(abort.signal);
    try {
      await waitFor(() => events.navigation.some(record => record.action === 'open-result'));
      await waitFor(() => fixture.logs.slice(start).some(log => log.path === '/clicked' && log.body?.href === `${fixture.origin}/article/one`));
      expect(events.observations[0]).toMatchObject({ outcome: 'FOUND', pagesInspected: 2, resultsInspected: 5 });
      const requests = fixture.logs.slice(start);
      expect(requests.filter(log => log.path === '/search?q=earlier-page-click')).toHaveLength(2);
      expect(requests.some(log => log.path === '/search?q=earlier-page-click&page=2')).toBe(true);
      expect(requests.find(log => log.path === '/clicked' && log.body?.href === `${fixture.origin}/article/one`)?.body?.trusted).toBe(true);
    } finally { abort.abort(); await run; await worker.close(); }
  });

  test('click pointer visibly outlines the clicked element and restores its existing outline', async () => {
    const worker = await create('click-highlight');
    const internal = worker as unknown as { page: Page; point(x: number, y: number, click?: boolean): Promise<void> };
    try {
      await internal.page.goto(fixture.origin);
      const input = internal.page.locator('input[name="q"]');
      await input.evaluate(element => { (element as HTMLElement).style.outline = '1px dotted blue'; });
      const originalOutline = await input.evaluate(element => (element as HTMLElement).style.outline);
      const box = await input.boundingBox();
      if (!box) throw new Error('Search input is not rendered');
      await internal.point(box.x + box.width / 2, box.y + box.height / 2, true);
      expect(await input.getAttribute('data-dom-click-highlight')).toBe('true');
      expect(await input.evaluate(element => ({ width: (element as HTMLElement).style.outlineWidth, style: (element as HTMLElement).style.outlineStyle }))).toEqual({ width: '3px', style: 'solid' });
      expect(await worker.preview()).toMatch(/^data:image\/jpeg;base64,/);
      await input.page().waitForTimeout(750);
      expect(await input.getAttribute('data-dom-click-highlight')).toBeNull();
      expect(await input.evaluate(element => (element as HTMLElement).style.outline)).toBe(originalOutline);
    } finally { await worker.close(); }
  });

  test('explicit Google result opening returns after entry and keeps scrolling through multiple scoped articles until abort', async () => {
    const events = capture(), abort = new AbortController();
    const worker = await create('manual-keep-alive', { earlyStop: true, navigationDepth: 2 }, events);
    const run = worker.run(abort.signal);
    // Use the real controlled provider to record results, then exercise the Google manual-entry branch.
    const internal = worker as unknown as { settings: Settings; page: Page; manualTask?: Promise<void> };
    try {
      await waitFor(() => events.observations.length === 1);
      internal.settings.mode = 'google'; internal.settings.authorizedNavigation = true;
      const acceptedAt = Date.now(); await worker.openResult(`${fixture.origin}/article/one`, abort.signal);
      expect(Date.now() - acceptedAt).toBeLessThan(2000);
      await expect(worker.openResult(`${fixture.origin}/article/two`, abort.signal)).rejects.toMatchObject({ kind: 'UNSUPPORTED_DOM' });
      await waitFor(() => events.navigation.filter(record => record.action === 'internal-article').length === 2);
      await waitFor(() => worker.view.state === 'WAITING_FOR_ROTATION');
      expect(events.navigation.filter(record => record.action === 'internal-article').map(record => record.url)).toEqual([`${fixture.origin}/article/two`, `${fixture.origin}/article/three`]);
      expect(events.navigation.filter(record => record.action === 'scroll-down-up')).toHaveLength(3);
      expect(internal.manualTask).toBeDefined();
    } finally { abort.abort(); await run; await worker.close(); }
    expect(internal.manualTask).toBeUndefined(); expect(driver.contextCount).toBe(0);
  });

  test('a challenge during background manual Keep Alive emits a suspended observation and closes its context without self-join', async () => {
    const events = capture(), abort = new AbortController();
    const worker = await create('manual-background-challenge', { earlyStop: true, navigationDepth: 2 }, events);
    const run = worker.run(abort.signal);
    const internal = worker as unknown as { settings: Settings; page: Page; manualTask?: Promise<void> };
    try {
      await waitFor(() => events.observations.length === 1);
      internal.settings.mode = 'google'; internal.settings.authorizedNavigation = true;
      await worker.openResult(`${fixture.origin}/article/one`, abort.signal);
      await internal.page.locator('a[href="/article/two"]').evaluate(link => link.setAttribute('href', '/article/challenge'));
      await waitFor(() => events.sessions.some(view => view.state === 'CHALLENGED' && view.errorKind === 'UNUSUAL_TRAFFIC'));
      await worker.close();
      expect(events.observations.some(record => record.outcome === 'CHALLENGED')).toBe(true);
      expect(events.navigation.some(record => record.action === 'authorized-keep-alive' && !record.passed)).toBe(true);
      expect(internal.manualTask).toBeUndefined(); expect(driver.contextCount).toBe(0);
    } finally { abort.abort(); await run; await worker.close(); }
  });

  test.each([['/challenge', 'UNUSUAL_TRAFFIC'], ['/captcha', 'CAPTCHA'], ['/denied', 'ACCESS_DENIED']] as const)('suspends %s without result navigation', async (path, kind) => {
    const events = capture(), abort = new AbortController();
    const worker = await create(`challenge-${kind}`, { controlledSearchUrl: `${fixture.origin}${path}` }, events);
    try { await worker.run(abort.signal); expect(worker.view).toMatchObject({ state: 'CHALLENGED', errorKind: kind }); expect(events.observations[0].outcome).toBe('CHALLENGED'); expect(events.navigation).toHaveLength(0); }
    finally { await worker.close(); }
  });

  test('unsupported result structure records inconclusive rather than absent', async () => {
    const events = capture(), abort = new AbortController();
    const worker = await create('unsupported-results', { controlledSearchUrl: `${fixture.origin}/?action=/unsupported` }, events);
    const run = worker.run(abort.signal);
    try { await waitFor(() => events.observations.length > 0); expect(events.observations[0].outcome).toBe('INCONCLUSIVE'); }
    finally { abort.abort(); await run; await worker.close(); }
  });

  test('Google-style heading selectors and next-page fallbacks handle delayed DOM and changing containers', async () => {
    const events = capture(), abort = new AbortController();
    const worker = await create('google-fallback', { controlledSearchUrl: `${fixture.origin}/?action=/google-layout` }, events);
    const start = fixture.logs.length;
    const run = worker.run(abort.signal);
    try {
      await waitFor(() => events.observations.length > 0);
      expect(events.rankings.map(record => record.organicPosition)).toEqual([2, 5]);
      expect(events.observations[0]).toMatchObject({ outcome: 'FOUND', pagesInspected: 2, resultsInspected: 5 });
      expect(fixture.logs.slice(start).some(log => log.path.startsWith('/article/'))).toBe(false);
    } finally { abort.abort(); await run; await worker.close(); }
  });

  test('abort interrupts a stalled real navigation and joins context closure promptly', async () => {
    const events = capture(), abort = new AbortController();
    const worker = await create('stalled-navigation', { controlledSearchUrl: `${fixture.origin}/slow` }, events);
    const run = worker.run(abort.signal);
    await waitFor(() => fixture.logs.some(log => log.path === '/slow'));
    const stoppedAt = Date.now(); abort.abort(); await run; await worker.close();
    expect(Date.now() - stoppedAt).toBeLessThan(2000);
    expect(driver.contextCount).toBe(0);
    expect(events.observations[0].outcome).toBe('CANCELLED');
  });

  test('hidden headings and sponsored blocks do not count toward organic rank', async () => {
    const events = capture(), abort = new AbortController();
    const worker = await create('hidden-results', { controlledSearchUrl: `${fixture.origin}/?action=/hidden-layout` }, events);
    const run = worker.run(abort.signal);
    try { await waitFor(() => events.observations.length > 0); expect(events.rankings).toHaveLength(1); expect(events.rankings[0]).toMatchObject({ organicPosition: 2, elementPosition: 4 }); expect(events.observations[0].resultsInspected).toBe(2); }
    finally { abort.abort(); await run; await worker.close(); }
  });

  test('a result redirect outside the authorized scope is blocked before contacting its destination', async () => {
    const events = capture(), abort = new AbortController();
    const worker = await create('blocked-redirect', { controlledSearchUrl: `${fixture.origin}/?action=/redirect-results`, authorizedNavigation: true }, events);
    const start = proxy.requests.length;
    try { await expect(worker.run(abort.signal)).rejects.toMatchObject({ kind: 'UNSUPPORTED_DOM' }); expect(proxy.requests.slice(start).some(url => url.includes('outside.invalid'))).toBe(false); }
    finally { abort.abort(); await worker.close(); }
    expect(driver.contextCount).toBe(0);
  });

  test('STOP during pending Chromium launch closes the late browser and permits a clean restart', async () => {
    const pendingDriver = new ChromiumDriver();
    const launch = pendingDriver.launch(settings());
    const checked = expect(launch).rejects.toMatchObject({ kind: 'CANCELLED' });
    await pendingDriver.close(); await checked;
    expect(pendingDriver.contextCount).toBe(0);
    await pendingDriver.launch(settings());
    expect(pendingDriver.contextCount).toBe(0);
    await pendingDriver.close();
  });

  test('scope rejects sibling paths, transactional and credential-bearing navigation', () => {
    const config = settings({ authorizedNavigation: true });
    expect(inNavigationScope(`${fixture.origin}/article/one`, config)).toBe(true);
    expect(inNavigationScope(`${fixture.origin}/articles/sibling`, config)).toBe(false);
    expect(safeArticleLink(`${fixture.origin}/article/login`, `${fixture.origin}/article/one`, config)).toBe(false);
    expect(safeArticleLink(`${fixture.origin}/article/%6cogin`, `${fixture.origin}/article/one`, config)).toBe(false);
    expect(inNavigationScope(`${fixture.origin}/article/%2f..%2flogin`, config)).toBe(false);
    expect(safeArticleLink(`${fixture.origin}/article/read?token=secret`, `${fixture.origin}/article/one`, config)).toBe(false);
    expect(inNavigationScope(`http://user:password@127.0.0.1:${new URL(fixture.origin).port}/article/one`, config)).toBe(false);
  });

  test('proxy supports an actual HTTP CONNECT tunnel', async () => {
    const authority = new URL(fixture.origin).host;
    const client = net.connect(proxy.port, '127.0.0.1');
    const response = await new Promise<string>((resolve, reject) => {
      let result = ''; let sent = false;
      client.on('connect', () => client.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
      client.on('error', reject);
      client.on('data', chunk => { result += chunk.toString(); if (!sent && result.includes('200 Connection Established')) { sent = true; client.write(`GET / HTTP/1.1\r\nHost: ${authority}\r\nConnection: close\r\n\r\n`); } if (result.includes('Controlled search provider')) { client.destroy(); resolve(result); } });
    });
    expect(response).toContain('200 Connection Established'); expect(proxy.connects).toContain(authority);
  });
});
