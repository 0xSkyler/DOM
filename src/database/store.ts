import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_SETTINGS, type Settings, type RepositoryStore, type RankingRecord, type Observation, type Diagnostic, type NavigationRecord, type SessionView, type ProxyEntry } from '../shared/types';

export interface SettingsCodec { encode(value: Settings): string; decode(value: string): Settings; }
const plainCodec: SettingsCodec = { encode: JSON.stringify, decode: JSON.parse };
/** Native, on-disk SQLite WAL. Each completed measurement commits before browser disposal. */
export class Store implements RepositoryStore {
  private closed = false;
  private recordedCycle = 0;
  private constructor(private db: DatabaseSync, private codec: SettingsCodec) {}
  static async open(file: string, codec: SettingsCodec = plainCodec): Promise<Store> {
    mkdirSync(dirname(file), { recursive: true });
    const store = new Store(new DatabaseSync(file), codec);
    store.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cycles (cycle INTEGER PRIMARY KEY, keyword TEXT, started_at INTEGER, ended_at INTEGER);
      CREATE TABLE IF NOT EXISTS rankings (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS observations (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS diagnostics (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS navigation (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS allocations (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL);`);
    store.db.exec('CREATE TABLE IF NOT EXISTS sequence (id INTEGER PRIMARY KEY CHECK(id=1), next_cycle INTEGER NOT NULL)');
    store.recordedCycle = store.nextCycle() - 1;
    return store;
  }
  private append(table: string, value: unknown, retention?: number): void {
    this.db.prepare(`INSERT INTO ${table}(value) VALUES (?)`).run(JSON.stringify(value));
    if (retention) this.db.prepare(`DELETE FROM ${table} WHERE id <= (SELECT COALESCE(MAX(id),0)-${retention} FROM ${table})`).run();
  }
  settings(): Settings {
    const result = this.db.prepare('SELECT value FROM settings WHERE id=1').get();
    if (!result) return structuredClone(DEFAULT_SETTINGS);
    return { ...DEFAULT_SETTINGS, ...this.codec.decode(String(result.value)) };
  }
  saveSettings(settings: Settings): void { this.db.prepare('INSERT OR REPLACE INTO settings(id,value) VALUES (1,?)').run(this.codec.encode(settings)); }
  nextCycle(): number { return Math.max(Number(this.db.prepare('SELECT COALESCE(MAX(cycle),0)+1 AS next FROM cycles').get()?.next), Number(this.db.prepare('SELECT next_cycle FROM sequence WHERE id=1').get()?.next_cycle ?? 1)); }
  private trackCycle(cycle?: number): void {
    if (!cycle || cycle <= this.recordedCycle) return;
    this.recordedCycle = cycle;
    this.db.prepare('INSERT INTO sequence VALUES (1,?) ON CONFLICT(id) DO UPDATE SET next_cycle=MAX(next_cycle,excluded.next_cycle)').run(cycle + 1);
  }
  saveCycle(cycle: number, keyword: string, startedAt: number, endedAt?: number): void {
    this.trackCycle(cycle);
    this.db.prepare('INSERT INTO cycles VALUES (?,?,?,?) ON CONFLICT(cycle) DO UPDATE SET ended_at=excluded.ended_at').run(cycle, keyword, startedAt, endedAt ?? null);
  }
  saveRanking(record: RankingRecord): void { this.append('rankings', record); }
  saveObservation(record: Observation): void { this.append('observations', record); }
  saveDiagnostic(record: Diagnostic): void { this.trackCycle(record.cycle); this.append('diagnostics', record, 5000); }
  saveNavigation(record: NavigationRecord): void { this.append('navigation', record, 20000); }
  saveSession(record: SessionView): void {
    this.trackCycle(record.cycle);
    const { thumbnail: _, ...small } = record;
    this.db.prepare('INSERT OR REPLACE INTO sessions VALUES (?,?)').run(record.id, JSON.stringify(small));
  }
  saveAllocation(proxy: ProxyEntry, cycle: number): void {
    this.append('allocations', { cycle, proxyId: proxy.id, server: proxy.server, state: proxy.state, sessionId: proxy.sessionId, timestamp: new Date().toISOString() }, 20000);
  }
  history<T>(table: 'rankings' | 'observations' | 'diagnostics' | 'navigation', limit = 200, offset = 0): T[] {
    return this.db.prepare(`SELECT id,value FROM ${table} ORDER BY id DESC LIMIT ? OFFSET ?`).all(limit, offset)
      .map(row => ({ ...JSON.parse(String(row.value)), id: Number(row.id) }) as T);
  }
  allRankings(): RankingRecord[] { return this.history<RankingRecord>('rankings', -1).reverse(); }
  flush(): void { if (!this.closed) this.db.exec('PRAGMA wal_checkpoint(PASSIVE)'); }
  close(): void { if (this.closed) return; this.flush(); this.db.close(); this.closed = true; }
}
