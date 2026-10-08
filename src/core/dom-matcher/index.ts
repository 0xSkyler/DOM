import type { Settings } from '../../shared/types';
export { matchesTarget } from '../target-matcher';

export function displayUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = ''; url.password = ''; url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/(token|secret|password|credential|auth|api.?key|signature)/i.test(key)) url.searchParams.set(key, '[redacted]');
    return url.href;
  } catch { return ''; }
}

export function inNavigationScope(value: string, settings: Pick<Settings, 'authorizedNavigation' | 'allowedOrigins' | 'allowedPathPrefixes'>): boolean {
  if (!settings.authorizedNavigation || !settings.allowedOrigins.length || !settings.allowedPathPrefixes.length) return false;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
    if (/%(?:2f|5c|00)/i.test(url.pathname)) return false;
    const path = decodeURIComponent(url.pathname);
    if (!settings.allowedOrigins.some(origin => { try { return new URL(origin).origin === url.origin; } catch { return false; } })) return false;
    return settings.allowedPathPrefixes.some(prefix => prefix.startsWith('/') && (prefix === '/' || path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)));
  } catch { return false; }
}

const unsafeAction = /(?:^|[\/_?&=.;#-])(login|logout|sign.?in|sign.?up|register|auth|oauth|account|admin|cart|checkout|purchase|payment|pay|delete|remove|unsubscribe|subscribe|upload|download|submit|confirm|reset)(?:$|[\/_?&=.;#-])/i;
export function safeArticleLink(value: string, current: string, settings: Settings, text = ''): boolean {
  if (!inNavigationScope(value, settings)) return false;
  try {
    const next = new URL(value), previous = new URL(current);
    if (next.origin !== previous.origin || next.href.split('#')[0] === previous.href.split('#')[0]) return false;
    const path = decodeURIComponent(next.pathname);
    if (unsafeAction.test(`${path}${next.search}`) || /\.(pdf|zip|exe|dmg|deb|msi|docx?|xlsx?|mp[34]|png|jpe?g|gif|csv)(?:$|\?)/i.test(path)) return false;
    if (/\b(log ?in|log ?out|sign ?in|sign ?up|buy|purchase|checkout|delete|download|unsubscribe|subscribe)\b/i.test(text)) return false;
    if ([...next.searchParams.keys()].some(key => /^(action|do|cmd|method|token|password|auth|download)$/i.test(key))) return false;
    return true;
  } catch { return false; }
}
