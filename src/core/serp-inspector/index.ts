import type { Page } from 'playwright-core';
import type { ErrorKind } from '../../shared/types';
import { BrowserFailure, aborted } from '../browser-manager/errors';

export interface OrganicResult { url: string; title: string; elementPosition: number; }
export interface SerpPage { results: OrganicResult[]; next?: string; supported: boolean; empty: boolean; }

export async function challengeKind(page: Page, status?: number): Promise<ErrorKind | undefined> {
  const data = await page.evaluate(() => ({ text: (document.body?.innerText ?? '').slice(0, 16000), captcha: !!document.querySelector('iframe[src*="recaptcha"], #captcha, form[action*="/sorry/"]') }));
  if (status === 429 || /\/sorry(?:\/|\?)/i.test(page.url()) || /unusual traffic|automated queries|automated requests|too many requests|rate limit exceeded/i.test(data.text)) return 'UNUSUAL_TRAFFIC';
  if (data.captcha || /verify (?:that )?you are (?:a )?human|complete the captcha|captcha verification|robot check/i.test(data.text)) return 'CAPTCHA';
  if (status === 403 || /access denied|request blocked|permission denied|forbidden access|(?:^|\n)\s*Forbidden\s*(?:\n|$)/i.test(data.text)) return 'ACCESS_DENIED';
  return undefined;
}

export async function assertNotChallenged(page: Page, status?: number): Promise<void> {
  const kind = await challengeKind(page, status);
  if (kind) throw new BrowserFailure(kind, kind === 'UNUSUAL_TRAFFIC' ? 'Search provider reported unusual traffic; session suspended' : kind === 'CAPTCHA' ? 'Human verification required; session suspended' : 'Access denied; session suspended');
}

export async function inspectSerp(page: Page, signal: AbortSignal): Promise<SerpPage> {
  aborted(signal);
  await assertNotChallenged(page);
  await page.locator('[data-organic-result], #search h3, #rso h3, main h3, [data-empty-results]').first().waitFor({ state: 'attached', timeout: 3500 }).catch(() => undefined);
  aborted(signal);
  await assertNotChallenged(page);
  return page.evaluate(() => {
    const controlled = !!document.querySelector('[data-serp-results]');
    const root = document.querySelector('[data-serp-results], #search, #rso, #main, main[role="main"]');
    const headings = controlled ? [...document.querySelectorAll('[data-organic-result]')] : [...(root ?? document).querySelectorAll('h3')];
    const results: OrganicResult[] = [];
    const seen = new Set<string>();
    let elementPosition = 0;
    for (const heading of headings) {
      elementPosition++;
      if (!(heading as HTMLElement).getClientRects().length || getComputedStyle(heading).visibility === 'hidden' || heading.closest('[hidden], [aria-hidden="true"]')) continue;
      if (heading.closest('[data-sponsored], [data-text-ad], [data-ad], .uEierd, #tads, #bottomads, [aria-label="Ads"]')) continue;
      const container = heading.closest('[data-organic-result], .MjjYud, .g, .tF2Cxc') ?? heading.parentElement;
      if (container && /^(?:Sponsored|Ad)\s*\n/i.test((container as HTMLElement).innerText ?? '')) continue;
      const anchor = heading.closest('a[href]') ?? heading.querySelector('a[href]') ?? container?.querySelector('a[href]');
      if (!anchor) continue;
      let url: URL;
      try { url = new URL(anchor.getAttribute('href') ?? '', location.href); } catch { continue; }
      if (/\/(?:url|imgres)$/.test(url.pathname) && (url.searchParams.has('q') || url.searchParams.has('url'))) { try { url = new URL(url.searchParams.get('q') ?? url.searchParams.get('url')!); } catch { continue; } }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
      if (!controlled && /(^|\.)google\.[a-z.]+$/.test(url.hostname) && /\/(search|preferences|accounts|setprefs)/.test(url.pathname)) continue;
      const title = (heading.querySelector('h3')?.textContent ?? heading.textContent ?? '').trim();
      if (!title || seen.has(url.href)) continue;
      seen.add(url.href); results.push({ url: url.href, title, elementPosition });
    }
    const nextAnchor = document.querySelector('a[data-next-page], a#pnnext, a[aria-label="Next"], a[aria-label="Next page"], a[rel="next"]');
    const next = nextAnchor?.getAttribute('href');
    const empty = !!document.querySelector('[data-empty-results]') || /did not match any documents|no results found|no search results/i.test(document.body?.innerText ?? '');
    return { results, next: next ? new URL(next, location.href).href : undefined, supported: controlled || !!root || empty, empty };
  });
}
