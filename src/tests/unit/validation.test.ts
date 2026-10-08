import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/types';
import { SettingsValidationError, validateSettings } from '../../shared/validation';

const valid = () => ({ ...DEFAULT_SETTINGS, keywords: 'A, B', target: 'example.com' });
describe('settings validation', () => {
  it('supports the complete 10–50 context range and safe migration defaults', () => {
    for (const sessionCount of [10, 20, 30, 40, 50]) expect(validateSettings({ ...valid(), sessionCount }).sessionCount).toBe(sessionCount);
    expect(validateSettings({ keywords: 'A', target: 'example.com' }).rotationSeconds).toBe(120);
  });
  it('rejects malformed and unsafe numeric settings', () => {
    for (const sessionCount of [9, 51, 10.5, NaN, Infinity, '10', null]) expect(() => validateSettings({ ...valid(), sessionCount })).toThrow(SettingsValidationError);
    expect(() => validateSettings({ ...valid(), retryBudget: -1 })).toThrow();
    expect(() => validateSettings({ ...valid(), rotationSeconds: 0 })).toThrow();
  });
  it('permits empty saved settings, but requires a valid target and keyword for START', () => {
    expect(validateSettings(DEFAULT_SETTINGS, { forRun: false })).toEqual(DEFAULT_SETTINGS);
    expect(() => validateSettings(DEFAULT_SETTINGS)).toThrow();
    expect(() => validateSettings({ ...valid(), keywords: ',\n ' })).toThrow();
  });
  it('restricts URL schemes, credentials, navigation origins and explicit authorization scope', () => {
    for (const proxyApiUrl of ['file:///etc/passwd', 'ftp://example.com', 'http://user:pass@api.test', 'api.test'])
      expect(() => validateSettings({ ...valid(), proxyApiUrl })).toThrow();
    expect(() => validateSettings({ ...valid(), authorizedNavigation: true })).toThrow(/origin/);
    expect(() => validateSettings({ ...valid(), allowedOrigins: ['https://example.com/article'] })).toThrow();
    expect(() => validateSettings({ ...valid(), allowedOrigins: 'https://example.com' })).toThrow();
    expect(() => validateSettings({ ...valid(), allowedPathPrefixes: ['//evil.test'] })).toThrow();
    expect(() => validateSettings({ ...valid(), mode: 'controlled' })).toThrow(/Controlled search/);
    expect(validateSettings({ ...valid(), authorizedNavigation: true, allowedOrigins: ['https://example.com/'], allowedPathPrefixes: ['/articles'] }).allowedOrigins).toEqual(['https://example.com']);
  });
  it('returns an independent settings copy with no unexpected properties', () => {
    const source = { ...valid(), allowedOrigins: ['https://example.com'], injected: 'anything' };
    const settings = validateSettings(source);
    source.allowedOrigins.push('https://evil.test');
    expect(settings.allowedOrigins).toEqual(['https://example.com']);
    expect(settings).not.toHaveProperty('injected');
    expect(() => validateSettings({ ...valid(), authorizedNavigation: 'true' })).toThrow();
  });
});
