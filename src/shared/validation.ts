import { DEFAULT_SETTINGS, type Settings } from './types';
import { parseKeywords, parseTarget } from '../core/target-matcher';

export { parseKeywords } from '../core/target-matcher';
export class SettingsValidationError extends Error {
  constructor(public readonly issues: string[]) { super(issues.join('\n')); this.name = 'SettingsValidationError'; }
}

/** Merge safe defaults for older settings while validating every field before IPC/browser use. */
export function validateSettings(input: unknown, options: { forRun?: boolean } = {}): Settings {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new SettingsValidationError(['Settings must be an object.']);
  const source = input as Record<string, unknown>, issues: string[] = [];
  const result = structuredClone(DEFAULT_SETTINGS);
  const numeric = (key: keyof Settings, min: number, max: number) => {
    const value = source[key] === undefined ? DEFAULT_SETTINGS[key] : source[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max)
      issues.push(`${key} must be an integer between ${min} and ${max}.`);
    else (result as unknown as Record<string, unknown>)[key] = value;
  };
  const string = (key: keyof Settings, max = 4096) => {
    const value = source[key] === undefined ? DEFAULT_SETTINGS[key] : source[key];
    if (typeof value !== 'string' || value.length > max) issues.push(`${key} must be text of at most ${max} characters.`);
    else (result as unknown as Record<string, unknown>)[key] = value.trim();
  };
  const boolean = (key: keyof Settings) => {
    const value = source[key] === undefined ? DEFAULT_SETTINGS[key] : source[key];
    if (typeof value !== 'boolean') issues.push(`${key} must be true or false.`);
    else (result as unknown as Record<string, unknown>)[key] = value;
  };
  numeric('sessionCount', 10, 50); numeric('rotationSeconds', 1, 86400);
  numeric('searchDepth', 1, 100); numeric('retryBudget', 0, 10); numeric('apiRetries', 0, 10);
  numeric('apiTimeoutMs', 100, 120000); numeric('scrollPasses', 2, 10);
  numeric('scrollStepPx', 100, 2000); numeric('scrollDelayMs', 10, 10000);
  numeric('navigationDepth', 1, 100); numeric('maxMemoryPercent', 10, 95); numeric('thumbnailSeconds', 5, 3600);
  string('keywords', 1000000); string('target'); string('proxyApiUrl'); string('controlledSearchUrl');
  string('locale', 100); string('searchLocation', 300);
  boolean('earlyStop'); boolean('authorizedNavigation'); boolean('headless'); boolean('validateProxies');
  for (const [key, allowed] of [['matchMode', ['domain', 'exact', 'both']], ['mode', ['google', 'controlled']], ['device', ['desktop', 'mobile']]] as const) {
    const value = source[key] === undefined ? DEFAULT_SETTINGS[key] : source[key];
    if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) issues.push(`${key} is invalid.`);
    else (result as unknown as Record<string, unknown>)[key] = value;
  }
  for (const key of ['allowedOrigins', 'allowedPathPrefixes'] as const) {
    const value = source[key] === undefined ? DEFAULT_SETTINGS[key] : source[key];
    if (!Array.isArray(value) || value.length > 1000 || value.some(x => typeof x !== 'string' || x.length > 4096))
      issues.push(`${key} must be a list of strings.`);
    else result[key] = [...new Set(value.map(x => x.trim()).filter(Boolean))];
  }
  const checkHttp = (value: string, label: string) => {
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error();
    } catch { issues.push(`${label} must be an absolute HTTP(S) URL without credentials.`); }
  };
  checkHttp(result.proxyApiUrl, 'Proxy API URL');
  if (result.controlledSearchUrl || options.forRun !== false && result.mode === 'controlled') checkHttp(result.controlledSearchUrl, 'Controlled search URL');
  if (result.target || options.forRun !== false) {
    try { parseTarget(result.target); } catch { issues.push('Enter a valid target domain or HTTP(S) URL.'); }
  }
  if (options.forRun !== false && !parseKeywords(result.keywords).length) issues.push('Enter at least one keyword.');
  try { new Intl.Locale(result.locale); } catch { issues.push('Locale must be a valid language tag such as en-US.'); }
  for (const origin of result.allowedOrigins) {
    try {
      const url = new URL(origin);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error();
    } catch { issues.push('Allowed origins must be HTTP(S) origins without paths or credentials.'); }
  }
  result.allowedOrigins = result.allowedOrigins.map(x => { try { return new URL(x).origin; } catch { return x; } });
  if (result.allowedPathPrefixes.some(x => !x.startsWith('/') || x.startsWith('//') || /[?#\\]/.test(x)))
    issues.push('Allowed path prefixes must begin with / and contain no query, fragment, or backslash.');
  if (options.forRun !== false && result.authorizedNavigation && (!result.allowedOrigins.length || !result.allowedPathPrefixes.length))
    issues.push('Authorized navigation requires at least one allowed origin and path prefix.');
  if (issues.length) throw new SettingsValidationError(issues);
  return result;
}
