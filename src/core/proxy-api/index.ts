import { createHash } from 'node:crypto';
import type { ProxyEntry } from '../../shared/types';

/** A credential-safe diagnostic string, also used for API and driver errors. */
export function redactSecrets(input: unknown, secrets: readonly string[] = []): string {
  let text = input instanceof Error ? input.message : String(input);
  for (const secret of [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length))
    text = text.split(secret).join('[redacted]');
  return text
    .replace(/([a-z][a-z\d+.-]*:\/\/)[^\s/]*@/gi, '$1[redacted]@')
    .replace(/([?&](?:token|key|api_?key|password|secret|authorization|access_token)=)[^&#\s]*/gi, '$1[redacted]')
    .slice(0, 2000);
}

/** Provider URLs, plain host:port lists and common JSON proxy records. */
export function parseProxyList(text: string): ProxyEntry[] {
  const entries = new Map<string, ProxyEntry>();
  let raw: unknown = text;
  if (/^[\s]*[\[{]/.test(text) && !/^\s*\[[\da-f:]+\]:\d+/i.test(text)) { try { raw = JSON.parse(text); } catch { return []; } }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) raw = (raw as Record<string, unknown>).proxies ?? (raw as Record<string, unknown>).data;
  const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[\s,]+/) : [];
  for (const value of values.slice(0, 100000)) {
    const record = value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
    const address = record?.url ?? record?.proxy ?? record?.server;
    let input = typeof value === 'string' ? value : typeof address === 'string' ? address : undefined;
    const protocols = record ? record.protocols ?? record.protocol ?? record.scheme ?? 'http' : 'http';
    if (record && !input) {
      const host = record.ip ?? record.host ?? record.hostname;
      if (typeof host !== 'string' || !/^[\da-z.:\[\]-]+$/i.test(host) || !['string', 'number'].includes(typeof record.port)) continue;
      input = `${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${record.port}`;
    }
    if (typeof input !== 'string' || input.length > 4096) continue;
    for (const protocol of Array.isArray(protocols) ? protocols.slice(0, 4) : [protocols]) {
      try {
        const normalized = input.includes('://') ? input.trim() : `${String(protocol).toLowerCase().replace(/:$/, '')}://${input.trim()}`;
        const url = new URL(normalized);
        const explicitPort = normalized.match(/^[a-z][a-z\d+.-]*:\/\/(?:[^/@]*@)?(?:\[[^\]]+\]|[^/:?#]+):(\d+)\/?$/i)?.[1];
        const portText = url.port || explicitPort;
        if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(url.protocol) || !url.hostname || !portText ||
          url.pathname && url.pathname !== '/' || url.search || url.hash || /\s/.test(input)) continue;
        const port = Number(portText);
        if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
        const username = url.username ? decodeURIComponent(url.username) : typeof record?.username === 'string' ? record.username : undefined;
        const password = url.password ? decodeURIComponent(url.password) : typeof record?.password === 'string' ? record.password : undefined;
        if (url.protocol.startsWith('socks') && (username || password)) continue; // Chromium does not support SOCKS authentication.
        const server = `${url.protocol}//${url.hostname.toLowerCase()}:${port}`;
        const identity = JSON.stringify([server, username ?? '', password ?? '']);
        const id = `proxy-${createHash('sha256').update(identity).digest('hex').slice(0, 16)}`;
        entries.set(id, { id, server, ...(username ? { username } : {}), ...(password ? { password } : {}), state: 'AVAILABLE' });
      } catch { /* Malformed records never reach assignment and never enter diagnostics. */ }
    }
  }
  return [...entries.values()];
}

export class ProxyApiError extends Error { constructor(message: string) { super(message); this.name = 'ProxyApiError'; } }
export function abortError(): Error { return Object.assign(new Error('Operation cancelled.'), { name: 'AbortError', kind: 'CANCELLED' }); }

export async function fetchProxyList(url: string, options: { signal?: AbortSignal; timeoutMs?: number; fetch?: typeof fetch } = {}): Promise<ProxyEntry[]> {
  const abort = new AbortController();
  if (options.signal?.aborted) throw abortError();
  const onAbort = () => abort.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; abort.abort(); }, options.timeoutMs ?? 15000);
  try {
    const response = await (options.fetch ?? fetch)(url, { signal: abort.signal, cache: 'no-store', redirect: 'follow', headers: { Accept: 'text/plain, application/json' } });
    if (!response.ok) throw new ProxyApiError(`Proxy API returned HTTP ${response.status}.`);
    const reader = response.body?.getReader();
    let body = '';
    if (reader) {
      const decoder = new TextDecoder(); let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (size > 5 * 1024 * 1024) { await reader.cancel(); throw new ProxyApiError('Proxy API response exceeds the 5 MB limit.'); }
          body += decoder.decode(value, { stream: true });
        }
        body += decoder.decode();
      } finally { reader.releaseLock(); }
    } else body = await response.text();
    if (options.signal?.aborted) throw abortError();
    const proxies = parseProxyList(body);
    if (!proxies.length) throw new ProxyApiError('Proxy API returned no usable proxy entries. Expected proxy URLs, host:port lines, or JSON proxy records (HTTP, HTTPS, SOCKS4 or SOCKS5).');
    return proxies;
  } catch (error) {
    if (options.signal?.aborted) throw abortError();
    if (timedOut) throw new ProxyApiError('Proxy API request timed out.');
    throw new ProxyApiError(redactSecrets(error));
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); }
}
