import type { MatchMode } from '../../shared/types';

/** CSV and text keyword input, preserving phrases, case, and first occurrence. */
export function parseKeywords(input: string): string[] {
  const values: string[] = [];
  let value = '', quoted = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === '"') {
      if (quoted && input[i + 1] === '"') { value += '"'; i++; }
      else if (quoted || value.trim() === '') quoted = !quoted;
      else value += char;
    } else if (!quoted && (char === ',' || char === '\n' || char === '\r')) {
      values.push(value.trim()); value = '';
    } else value += char;
  }
  values.push(value.trim());
  return [...new Set(values.filter(Boolean))];
}

export function parseTarget(input: string): URL {
  const text = input.trim();
  if (!text || /\s/.test(text)) throw new Error('Enter a valid target domain or HTTP(S) URL.');
  const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password)
    throw new Error('Target must be an HTTP(S) domain or URL without credentials.');
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  url.hash = '';
  return url;
}

export function normalizeUrl(input: string): string { return parseTarget(input).href; }

/** Domain matching includes child subdomains, with a dot boundary. Exact matching preserves paths and queries. */
export function matchesTarget(candidate: string, target: string, mode: MatchMode): boolean {
  try {
    const actual = parseTarget(candidate), expected = parseTarget(target);
    const domain = actual.hostname === expected.hostname || actual.hostname.endsWith(`.${expected.hostname}`);
    const exact = actual.href === expected.href;
    return mode === 'exact' ? exact : mode === 'domain' ? domain : mode === 'both' && (domain || exact);
  } catch { return false; }
}
