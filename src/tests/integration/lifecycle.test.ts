import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Controller } from '../../core/scheduler/controller';
import { ChromiumDriver } from '../../core/browser-manager/driver';
import { BackgroundProxyPool } from '../../core/proxy-pool/background';
import { GoogleProxyChecker } from '../../core/proxy-pool/google-checker';
import { Store } from '../../database/store';
import { ResourceMonitor } from '../../main/resource-monitor';
import { DEFAULT_SETTINGS, type RankingRecord, type Observation } from '../../shared/types';
import { fixtureServer, forwardingProxy } from '../fixtures/server';

async function until(check: () => boolean, timeoutMs = 30000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) { if (Date.now() > end) throw new Error('Readiness deadline exceeded'); await new Promise(r => setTimeout(r, 50)); }
}
describe('complete browser + proxy API + SQLite controller lifecycle', () => {
  it('rotates real contexts A→B→C→A using one checked background pool, preserves history, and releases all reservations', async () => {
    const site = await fixtureServer();
    const proxies = await Promise.all(Array.from({ length: 10 }, () => forwardingProxy()));
    const dir = await mkdtemp(join(tmpdir(), 'dom-cycles-'));
    let fetches = 0;
    const api = http.createServer((_req, res) => { fetches++; res.end(proxies.map(p => p.server).join('\n')); });
    await new Promise<void>(r => api.listen(0, '127.0.0.1', r));
    const apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}/proxies`;
    const store = await Store.open(join(dir, 'dom.sqlite'));
    const driver = new ChromiumDriver();
    const checker = new GoogleProxyChecker();
    const backgroundProxies = new BackgroundProxyPool(checker);
    const controller = new Controller({ driver, store, nextCycle: () => store.nextCycle(), backgroundProxies });
    const configured = { ...DEFAULT_SETTINGS, keywords: 'A,B,C', target: site.origin, sessionCount: 10, proxyApiUrl: apiUrl, rotationSeconds: 6,
      searchDepth: 2, mode: 'controlled' as const, controlledSearchUrl: site.origin, authorizedNavigation: false };
    const seen: string[] = [], firstCycle = new Map<number, number>();
    controller.onChange(state => { if (state.status === 'RUNNING' && state.keyword !== seen.at(-1)) { seen.push(state.keyword); firstCycle.set(state.cycle, Date.now()); } });
    try {
      await backgroundProxies.configure(configured);
      await until(() => backgroundProxies.snapshot().ready === 10);
      await controller.start(configured);
      await until(() => controller.snapshot().cycle >= 4 && controller.snapshot().status === 'RUNNING');
      await until(() => store.history<Observation>('observations', 1000).filter(o => o.cycle === 4).length === 10);
      await controller.stop();
      expect(seen.slice(0, 4)).toEqual(['A', 'B', 'C', 'A']); expect(fetches).toBe(1);
      expect(backgroundProxies.snapshot()).toMatchObject({ running: true, assigned: 0, ready: 10 });
      const probes = site.logs.filter(l => l.path === '/probe' && l.body?.previous && (l.body.previous as { local: unknown }).local === null);
      expect(probes.length).toBeGreaterThanOrEqual(40);
      const observations = store.history<Observation>('observations', 1000);
      for (let cycle = 1; cycle <= 4; cycle++) {
        const entries = observations.filter(o => o.cycle === cycle);
        expect(entries).toHaveLength(10); expect(new Set(entries.map(o => o.keyword)).size).toBe(1);
        expect(entries.every(o => o.outcome === 'FOUND' && o.pagesInspected === 2)).toBe(true);
      }
      const history = store.allRankings(); expect(history.length).toBe(80);
      await controller.stop(); expect(driver.contextCount).toBe(0); expect(controller.snapshot().assignedProxies).toBe(0);
      store.close(); const restored = await Store.open(join(dir, 'dom.sqlite'));
      expect(restored.allRankings()).toHaveLength(history.length); expect(restored.nextCycle()).toBe(5); restored.close();
      await mkdir('test-results', { recursive: true });
      await writeFile('test-results/cycles.json', JSON.stringify({ keywords: seen, fetches, cycles: 4, sessionsPerCycle: 10, rankings: history.length, starts: Object.fromEntries(firstCycle), contextsAfterStop: driver.contextCount }, null, 2));
    } finally { await controller.stop(); await backgroundProxies.close(); expect(checker.contextCount).toBe(0); store.close(); await Promise.all(proxies.map(p => p.close())); await site.close(); await new Promise<void>(r => api.close(() => r())); await rm(dir, { recursive: true, force: true }); }
  }, 120000);
  it('requests 50 logical sessions, measures active capacity within the memory budget, and cleans up', async () => {
    const site = await fixtureServer();
    const proxies = await Promise.all(Array.from({ length: 50 }, () => forwardingProxy()));
    const dir = await mkdtemp(join(tmpdir(), 'dom-capacity-'));
    const store = await Store.open(join(dir, 'dom.sqlite')); const driver = new ChromiumDriver();
    const { parseProxyList } = await import('../../core/proxy-api');
    const controller = new Controller({ driver, store, fetchProxies: async () => parseProxyList(proxies.map(p => p.server).join('\n')) });
    const monitor = new ResourceMonitor(); await monitor.sample(); const started = Date.now();
    try {
      await controller.start({ ...DEFAULT_SETTINGS, keywords: 'capacity fixture', target: site.origin, sessionCount: 50, rotationSeconds: 120,
        searchDepth: 1, mode: 'controlled', controlledSearchUrl: site.origin });
      const initializedMs = Date.now() - started;
      const activeSessions = driver.contextCount;
      const deferredSessions = controller.snapshot().sessions.filter(s => s.errorKind === 'RESOURCE_LIMIT').length;
      expect(controller.snapshot().sessions).toHaveLength(50);
      expect(activeSessions + deferredSessions).toBe(50);
      expect(activeSessions).toBeGreaterThanOrEqual(10);
      await until(() => store.history<Observation>('observations', 1000).length === activeSessions, 60000);
      const observations = store.history<Observation>('observations', 1000);
      expect(observations.every(o => o.outcome === 'FOUND')).toBe(true);
      expect(store.history<RankingRecord>('rankings', 1000)).toHaveLength(activeSessions);
      const resources = await monitor.sample();
      const browserVersion = driver.version;
      await controller.stop(); expect(driver.contextCount).toBe(0);
      await mkdir('test-results', { recursive: true });
      await writeFile('test-results/capacity.json', JSON.stringify({ requestedSessions: 50, activeSessions, deferredSessions, initializedMs, completedMs: Date.now() - started, observations: observations.length, resources, contextsAfterStop: driver.contextCount, platform: process.platform, browserVersion, chromiumPath: process.env.DOM_CHROMIUM_PATH ?? 'driver default' }, null, 2));
    } finally { await controller.stop(); store.close(); await Promise.all(proxies.map(p => p.close())); await site.close(); await rm(dir, { recursive: true, force: true }); }
  }, 120000);
});
