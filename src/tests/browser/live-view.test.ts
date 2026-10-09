import { describe, expect, it, vi } from 'vitest';
import { ChromiumDriver } from '../../core/browser-manager/driver';
import { parseProxyList } from '../../core/proxy-api';
import { DEFAULT_SETTINGS, type BrowserFrame, type EventSink, type Observation, type Worker } from '../../shared/types';
import { fixtureServer, forwardingProxy } from '../fixtures/server';

const wait = (check: () => void) => vi.waitFor(check, { timeout: 15000, interval: 25 });
describe('live Chromium streams and mouse control', () => {
  it.each(['desktop', 'mobile'] as const)('streams every %s session, changes with real clicks/drag/scroll, and stops on close', async device => {
    const site = await fixtureServer(), proxies = await Promise.all([forwardingProxy(), forwardingProxy()]);
    const driver = new ChromiumDriver(), stops = [new AbortController(), new AbortController()];
    const frames: BrowserFrame[] = [], observations: Observation[] = [], workers: Worker[] = [], runs: Promise<void>[] = [];
    const sink: EventSink = { frame: frame => frames.push(frame), session: () => {}, observation: value => observations.push(value), ranking: () => {}, log: () => {}, navigation: () => {} };
    const settings = { ...DEFAULT_SETTINGS, device, mode: 'controlled' as const, controlledSearchUrl: site.origin + '/?action=/live-search', target: site.origin, searchDepth: 1 };
    try {
      await driver.launch(settings);
      for (let i = 0; i < 2; i++) workers.push(await driver.create(`live-${i}`, 7, `stream-${i}`, parseProxyList(proxies[i].server)[0], settings, sink));
      runs.push(...workers.map((worker, i) => worker.run(stops[i].signal)));
      await wait(() => expect(observations.filter(value => value.outcome === 'FOUND')).toHaveLength(2));
      await wait(() => expect(new Set(frames.map(frame => frame.sessionId)).size).toBe(2));
      expect(frames.every(frame => frame.cycle === 7 && frame.image.startsWith('data:image/jpeg;base64,') && frame.viewportWidth >= (device === 'mobile' ? 390 : 1280))).toBe(true);
      const baseline = frames.length;
      await workers[0].setLiveView!(true);
      await workers[0].interact!({ type: 'down', x: 100, y: 100 });
      await workers[0].interact!({ type: 'up', x: 100, y: 100 });
      await wait(() => expect(site.logs.some(log => log.path === '/live-event' && log.body?.type === 'click' && log.body?.trusted)).toBe(true));
      await wait(() => expect(frames.slice(baseline).some(frame => frame.sessionId === 'live-0')).toBe(true));
      await workers[0].interact!({ type: 'down', x: 100, y: 160 });
      await workers[0].interact!({ type: 'move', x: 240, y: 220 });
      await workers[0].interact!({ type: 'up', x: 240, y: 220 });
      await wait(() => {
        const event = site.logs.find(log => log.path === '/live-event' && log.body?.type === 'drag')?.body;
        expect(event?.trusted).toBe(true);
        expect(Math.abs(Number(event?.x) - 240)).toBeLessThanOrEqual(1);
        expect(Math.abs(Number(event?.y) - 220)).toBeLessThanOrEqual(1);
      });
      await workers[0].interact!({ type: 'wheel', x: 100, y: 240, deltaY: 400 });
      await wait(() => {
        const event = site.logs.find(log => log.path === '/live-event' && log.body?.type === 'wheel')?.body;
        expect(event?.trusted).toBe(true);
        const width = frames.filter(frame => frame.sessionId === 'live-0').at(-1)!.viewportWidth;
        expect(Math.abs(Number(event?.delta) - 400 * width / (device === 'mobile' ? 390 : 1280))).toBeLessThan(2);
      });
      stops.forEach(stop => stop.abort()); await Promise.all(runs); await driver.close();
      const afterClose = frames.length; await new Promise(resolve => setTimeout(resolve, 550));
      expect(frames).toHaveLength(afterClose); expect(driver.contextCount).toBe(0);
    } finally { stops.forEach(stop => stop.abort()); await driver.close(); await Promise.allSettled(runs); await Promise.all(proxies.map(proxy => proxy.close())); await site.close(); }
  });
});
