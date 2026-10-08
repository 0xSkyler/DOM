import type { ProxyEntry } from '../../shared/types';

/** Disposable cycle-local allocations. Releasing never makes an already used proxy available again. */
export class ProxyPool {
  private readonly entries: ProxyEntry[];
  constructor(entries: ProxyEntry[]) {
    this.entries = [...new Map(entries.map(entry => [entry.id, { ...entry, state: 'AVAILABLE' as const, sessionId: undefined }])).values()];
  }
  allocate(sessionId: string): ProxyEntry | undefined {
    const entry = this.entries.find(x => x.state === 'AVAILABLE');
    if (!entry) return undefined;
    entry.state = 'ASSIGNED'; entry.sessionId = sessionId;
    return entry;
  }
  release(sessionId: string, failed = false): ProxyEntry | undefined {
    const entry = this.entries.find(x => x.sessionId === sessionId && x.state === 'ASSIGNED');
    if (entry) entry.state = failed ? 'FAILED' : 'RELEASED';
    return entry;
  }
  releaseAll(): ProxyEntry[] {
    const released = this.entries.filter(x => x.state === 'ASSIGNED');
    for (const entry of released) entry.state = 'RELEASED';
    return released;
  }
  get available(): number { return this.entries.filter(x => x.state === 'AVAILABLE').length; }
  get assigned(): number { return this.entries.filter(x => x.state === 'ASSIGNED').length; }
  get secrets(): string[] { return this.entries.flatMap(x => [x.username, x.password].filter((value): value is string => Boolean(value))); }
  snapshot(): ProxyEntry[] { return this.entries.map(x => ({ ...x, username: undefined, password: undefined })); }
}
