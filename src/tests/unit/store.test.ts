import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../../database/store';
import { DEFAULT_SETTINGS, type RankingRecord } from '../../shared/types';
const paths: string[] = [];
afterEach(async () => { for (const path of paths.splice(0)) await rm(path, { recursive: true, force: true }); });
describe('on-disk SQLite', () => {
  it('retains settings and completed measurements through close, reopen and later cycles', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dom-sqlite-')); paths.push(dir);
    const file = join(dir, 'dom.sqlite'); let store = await Store.open(file);
    expect(store.nextCycle()).toBe(1);
    store.saveSettings({ ...DEFAULT_SETTINGS, keywords: 'A, B, C', target: 'example.com' });
    const rank: RankingRecord = { keyword: 'A', target: 'example.com', url: 'https://example.com/article', title: 'Article', organicPosition: 3, elementPosition: 4, resultPage: 1, sessionId: 'Browser 01', proxyId: 'redacted-id', device: 'desktop', searchLocation: 'fixture', cycle: 1, timestamp: new Date().toISOString() };
    store.saveCycle(1, 'A', 1000); store.saveRanking(rank); store.saveCycle(1, 'A', 1000, 2000); store.close();
    store = await Store.open(file);
    expect(store.settings().keywords).toBe('A, B, C'); expect(store.nextCycle()).toBe(2);
    expect(store.allRankings()).toEqual([{ ...rank, id: 1 }]);
    store.saveCycle(2, 'B', 3000, 4000); expect(store.allRankings()).toHaveLength(1); store.close();
  });
  it('stores allocation metadata without proxy passwords or usernames', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dom-sqlite-')); paths.push(dir);
    const file = join(dir, 'dom.sqlite'); const store = await Store.open(file);
    store.saveAllocation({ id: 'proxy-1', server: 'http://proxy.example:8080', username: 'sensitive-user', password: 'sensitive-password', state: 'ASSIGNED', sessionId: 'Browser 01' }, 1);
    store.close();
    const bytes = await import('node:fs/promises').then(fs => fs.readFile(file));
    expect(bytes.includes(Buffer.from('sensitive-user'))).toBe(false);
    expect(bytes.includes(Buffer.from('sensitive-password'))).toBe(false);
  });
  it('reserves a distinct cycle after initialization fails before a cycle timer starts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dom-sqlite-')); paths.push(dir);
    const file = join(dir, 'dom.sqlite'); const store = await Store.open(file);
    store.saveDiagnostic({ cycle: 1, level: 'error', message: 'Proxy pool unavailable', timestamp: new Date().toISOString() });
    expect(store.nextCycle()).toBe(2); store.close();
    const reopened = await Store.open(file); expect(reopened.nextCycle()).toBe(2); reopened.close();
  });
});
