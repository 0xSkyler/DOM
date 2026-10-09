import type { Locator, Page, Response } from 'playwright-core';
import { aborted, BrowserFailure, pause } from '../browser-manager/errors';
import { assertNotChallenged } from '../serp-inspector';

/** Accept the user's chosen cookie setting within this isolated search context. */
export async function acceptSearchCookies(page: Page, providerUrl: string, signal: AbortSignal, options: {
  timeoutMs?: number; waitForPromptMs?: number; response?: Response | null; onAccept?: () => void;
} = {}): Promise<Response | undefined> {
  aborted(signal);
  const provider = new URL(providerUrl);
  const google = provider.protocol === 'https:' && /^(?:www\.)?google\.com$/.test(provider.hostname);
  const trusted = (url: string): boolean => {
    try {
      const parsed = new URL(url);
      return parsed.origin === provider.origin || google && parsed.origin === 'https://consent.google.com';
    } catch { return false; }
  };
  if (!trusted(page.url())) return;
  const deadline = Date.now() + (options.timeoutMs ?? 5000);
  const remaining = () => Math.max(1, deadline - Date.now());
  const visibleButton = async (): Promise<Locator | undefined> => {
    for (const frame of page.frames().filter(frame => trusted(frame.url()))) {
      // Google's stable ID works with localized labels; exact text covers the standalone form.
      for (const button of [frame.locator('#L2AGLb'), frame.getByRole('button', { name: /^Accept all$/i })]) {
        for (let i = 0, count = await button.count().catch(() => 0); i < count; i++) {
          if (await button.nth(i).isVisible().catch(() => false)) return button.nth(i);
        }
      }
    }
    return;
  };
  let response: Response | undefined = options.response ?? undefined;
  const navigationResponse = (incoming: Response) => {
    if (incoming.request().isNavigationRequest() && incoming.frame() === page.mainFrame()) response = incoming;
  };
  page.on('response', navigationResponse);
  const stableDocument = async () => {
    while (Date.now() < deadline) {
      aborted(signal);
      try {
        await page.waitForLoadState('domcontentloaded', { timeout: remaining() });
        await assertNotChallenged(page, response?.status());
        return;
      } catch (error) {
        // Consent scripts can replace the document after the click resolves.
        if (!/Execution context was destroyed|Cannot find context with specified id/i.test(String(error))) throw error;
        await pause(Math.min(100, remaining()), signal);
      }
    }
    throw new BrowserFailure('NAVIGATION_TIMEOUT', 'Cookie consent navigation did not settle within its deadline');
  };
  try {
    await stableDocument();
    let button = await visibleButton();
    // Give prompts inserted by provider JavaScript a bounded opportunity to appear.
    const appearBy = Math.min(deadline, Date.now() + (options.waitForPromptMs ?? 1000));
    while (!button && Date.now() < appearBy) {
      await pause(Math.min(100, appearBy - Date.now()), signal);
      button = await visibleButton();
    }
    if (!button) {
      if (new URL(page.url()).origin !== provider.origin) throw new BrowserFailure('UNSUPPORTED_DOM', 'Google cookie consent has no supported Accept all control');
      return;
    }
    await stableDocument(); aborted(signal);
    options.onAccept?.();
    await button.click({ timeout: remaining() });
    while (Date.now() < deadline) {
      aborted(signal);
      if (!trusted(page.url())) throw new BrowserFailure('UNSUPPORTED_DOM', 'Cookie consent redirected outside the search provider');
      await stableDocument();
      if (new URL(page.url()).origin === provider.origin && !await visibleButton()) return response;
      await pause(Math.min(100, remaining()), signal);
    }
    throw new BrowserFailure('UNSUPPORTED_DOM', 'Google cookie consent did not finish within its deadline');
  } finally { page.removeListener('response', navigationResponse); }
}
