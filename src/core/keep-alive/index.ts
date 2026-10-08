import type { Page } from 'playwright-core';
import type { Settings, SessionState } from '../../shared/types';
import { BrowserFailure, aborted, pause } from '../browser-manager/errors';
import { inNavigationScope, safeArticleLink } from '../dom-matcher';
import { assertNotChallenged } from '../serp-inspector';

export interface KeepAliveHooks {
  state(state: SessionState, action: string): void;
  navigate(url: string, action: string): void;
  point(x: number, y: number, click?: boolean): Promise<void>;
}

export async function verifyArticleContent(page: Page, signal: AbortSignal): Promise<void> {
  aborted(signal);
  await assertNotChallenged(page);
}

export async function scrollArticle(page: Page, settings: Settings, signal: AbortSignal, hooks: KeepAliveHooks): Promise<void> {
  await verifyArticleContent(page, signal);
  try {
    await page.waitForFunction(() => {
      const visible = (element: Element) => !!element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden';
      const article = [...document.querySelectorAll('article, main, [role="main"]')].find(element => visible(element) && ((element as HTMLElement).innerText ?? '').trim().length >= 40);
      const body = document.body;
      return !!article || !!(body && visible(body) && body.innerText.trim().length >= 80 && document.querySelector('h1, p'));
    }, undefined, { timeout: 6000 });
  } catch { throw new BrowserFailure('UNSUPPORTED_DOM', 'Authorized destination did not render meaningful article content'); }
  aborted(signal);
  await assertNotChallenged(page);
  const passes = Math.max(2, Math.min(10, settings.scrollPasses));
  const step = Math.max(100, Math.min(2000, settings.scrollStepPx));
  const delay = Math.max(10, Math.min(10000, settings.scrollDelayMs));
  hooks.state('SCROLLING', `Scroll down and up (${passes} passes)`);
  for (let pass = 0; pass < passes; pass++) {
    for (const direction of [1, -1]) {
      for (let count = 0; count < 100; count++) {
        aborted(signal);
        const box = await page.evaluate(() => ({ y: window.scrollY, height: Math.max(document.body?.scrollHeight ?? 0, document.documentElement.scrollHeight), viewport: window.innerHeight, width: window.innerWidth }));
        if (direction === 1 && box.y + box.viewport >= box.height - 2 || direction === -1 && box.y <= 0) break;
        await hooks.point(Math.round(box.width * 0.7), Math.round(box.viewport * 0.5));
        await page.mouse.wheel(0, step * direction);
        await pause(delay, signal);
      }
    }
  }
  hooks.navigate(page.url(), 'scroll-down-up');
}

export async function keepAlive(page: Page, settings: Settings, signal: AbortSignal, hooks: KeepAliveHooks): Promise<void> {
  const visited = new Set<string>([page.url().split('#')[0]]);
  const depth = Math.max(0, Math.min(100, settings.navigationDepth));
  let navigations = 0;
  for (;;) {
    aborted(signal);
    await assertNotChallenged(page);
    await scrollArticle(page, settings, signal, hooks);
    if (navigations >= depth) {
      hooks.state('WAITING_FOR_ROTATION', 'Navigation depth reached; waiting for rotation');
      await pause(2_147_000_000, signal);
      continue;
    }
    hooks.state('INTERNAL_LINK_TEST', 'Find safe article link in the authorized scope');
    const links = await page.locator('a[href]').evaluateAll(anchors => anchors.map((anchor, index) => ({ index, href: (anchor as HTMLAnchorElement).href, text: anchor.textContent ?? '', download: anchor.hasAttribute('download'), visible: !!(anchor as HTMLElement).getClientRects().length })));
    const candidate = links.find(link => link.visible && !link.download && !visited.has(link.href.split('#')[0]) && safeArticleLink(link.href, page.url(), settings, link.text));
    if (!candidate) {
      hooks.state('WAITING_FOR_ROTATION', 'No new safe article links; waiting before next scroll check');
      await pause(1000, signal);
      continue;
    }
    const link = page.locator('a[href]').nth(candidate.index);
    await link.scrollIntoViewIfNeeded();
    const box = await link.boundingBox();
    if (!box) { visited.add(candidate.href); continue; }
    hooks.state('NAVIGATING', 'Open authorized internal article');
    await hooks.point(box.x + box.width / 2, box.y + box.height / 2, true);
    await link.evaluate(element => element.removeAttribute('target'));
    const previous = page.url();
    await Promise.all([
      page.waitForURL(next => next.href !== previous && inNavigationScope(next.href, settings), { waitUntil: 'domcontentloaded', timeout: 15000 }),
      link.click({ timeout: 10000, noWaitAfter: true })
    ]);
    aborted(signal);
    await assertNotChallenged(page);
    if (!safeArticleLink(page.url(), [...visited][0], settings, candidate.text)) throw new Error('Internal link redirected outside the authorized article scope');
    visited.add(candidate.href.split('#')[0]); visited.add(page.url().split('#')[0]);
    navigations++; hooks.navigate(page.url(), 'internal-article');
  }
}
