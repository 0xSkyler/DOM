import type { ErrorKind } from '../../shared/types';

export class BrowserFailure extends Error {
  constructor(public readonly kind: ErrorKind, message: string) { super(message); this.name = 'BrowserFailure'; }
}
export function aborted(signal: AbortSignal): void {
  if (signal.aborted) throw new BrowserFailure('CANCELLED', 'Session stopped');
}
export function pause(ms: number, signal: AbortSignal): Promise<void> {
  aborted(signal);
  return new Promise((resolve, reject) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); resolve(); };
    const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(new BrowserFailure('CANCELLED', 'Session stopped')); };
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', cancel, { once: true });
  });
}
export function classifyBrowserError(error: unknown): BrowserFailure {
  if (error instanceof BrowserFailure) return error;
  const message = error instanceof Error ? error.message : String(error);
  if (/ERR_PROXY|ERR_TUNNEL|SOCKS_CONNECTION|proxy authentication/i.test(message)) return new BrowserFailure('PROXY_CONNECTION', 'Proxy connection failed');
  if (/Timeout|timed out/i.test(message)) return new BrowserFailure('NAVIGATION_TIMEOUT', 'Page navigation timed out');
  if (/Target.*closed|browser.*closed|context.*closed/i.test(message)) return new BrowserFailure('CANCELLED', 'Browser context closed');
  return new BrowserFailure('NETWORK', 'Browser navigation failed');
}
