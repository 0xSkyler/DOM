import assert from 'node:assert/strict';
import { _electron } from 'playwright-core';
import { build } from 'esbuild';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import ExcelJS from 'exceljs';
import { readFile } from 'node:fs/promises';

await mkdir('test-results', { recursive: true });
await build({ entryPoints: ['src/tests/fixtures/server.ts'], outfile: 'test-results/fixture-server.mjs', platform: 'node', format: 'esm', bundle: true });
const { fixtureServer, forwardingProxy } = await import(pathToFileURL(resolve('test-results/fixture-server.mjs')).href);
const site = await fixtureServer(); const proxies = await Promise.all(Array.from({ length: 10 }, () => forwardingProxy()));
let apiCalls = 0;
const api = http.createServer((req, res) => {
  apiCalls++;
  if (req.url === '/json') res.end(JSON.stringify({ data: proxies.map(p => ({ ip: '127.0.0.1', port: p.port, protocols: ['http'] })) }));
  else res.end(proxies.map((p, index) => index % 2 ? p.server : p.server.replace('http://', '')).join('\n'));
});
await new Promise(r => api.listen(0, '127.0.0.1', r));
const data = await mkdtemp(join(tmpdir(), 'dom-desktop-'));
const env = { ...process.env, DOM_DATA_DIR: data, XDG_CACHE_HOME: join(data, 'cache') };
delete env.ELECTRON_RUN_AS_NODE; delete env.DOM_DEV_URL;
let devServer;
if (process.env.DOM_SMOKE_DEV === '1') {
  if (process.env.DOM_EXECUTABLE_PATH) throw new Error('Development smoke cannot target a packaged app');
  const { createServer } = await import('vite'); devServer = await createServer(); await devServer.listen();
  env.DOM_DEV_URL = 'http://127.0.0.1:5173';
}
const args = process.env.DOM_EXECUTABLE_PATH ? [] : [resolve('dist/main.cjs')];
if (process.platform === 'linux' && !process.env.DISPLAY) args.push('--ozone-platform=headless');
if (process.platform === 'linux' && process.env.DOM_DISABLE_CHROMIUM_SANDBOX === '1') args.push('--no-sandbox');
const options = { args, env, timeout: 30000, ...(process.env.DOM_EXECUTABLE_PATH ? { executablePath: process.env.DOM_EXECUTABLE_PATH } : {}) };
let application;
const errors = [];
async function until(check, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) { if (Date.now() > deadline) throw new Error('Desktop readiness deadline exceeded'); await new Promise(r => setTimeout(r, 100)); }
}
async function closeApplication() {
  if (!application) return;
  // Exercise the actual window-close path and keep the main inspector connected
  // until async cleanup completes; ElectronApplication.close disconnects it immediately.
  const closed = application.waitForEvent('close', { timeout: 30000 });
  await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows().forEach(window => window.close()); }).catch(() => {});
  await closed; application = undefined;
}
try {
  application = await _electron.launch(options);
  let page = await application.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.dom && document.querySelector('button'));
  assert.match(await page.title(), /DOM/);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  const defaults = await page.evaluate(() => window.dom.settings());
  assert.equal(defaults.validateProxies, false);
  assert.equal(await page.getByRole('checkbox', { name: 'Validate proxies for Google', includeHidden: true }).isChecked(), false);
  const configured = { ...defaults, validateProxies: false, keywords: 'desktop fixture A, desktop fixture B', target: site.origin, proxyApiUrl: `http://127.0.0.1:${api.address().port}/proxies`, mode: 'controlled', controlledSearchUrl: site.origin + '/cookie-home', rotationSeconds: 120, searchDepth: 2 };
  // Reproduce the user's fetched-but-idle screenshot without requiring an overloaded host.
  await application.evaluate(() => {
    const os = process.getBuiltinModule('os');
    globalThis.domSmokeMemory = { totalmem: os.totalmem, freemem: os.freemem };
    os.totalmem = () => 1000000; os.freemem = () => 150000;
  });
  await page.evaluate(settings => window.dom.saveSettings(settings), configured);
  await page.reload();
  await page.getByRole('button', { name: /^start research$/i }).waitFor();
  await until(async () => { const s = await page.evaluate(() => window.dom.snapshot()); return s.proxyPool.ready === 10 && !s.proxyPool.validationEnabled; });
  assert.equal(site.logs.filter(log => log.path.startsWith('/cookie')).length, 0);
  await page.locator('summary').filter({ hasText: 'Proxy connection' }).click();
  await page.getByRole('checkbox', { name: 'Validate proxies for Google' }).check();
  await page.getByRole('button', { name: /^save configuration$/i }).click();
  await until(async () => (await page.evaluate(() => window.dom.settings())).validateProxies);
  await page.getByRole('button', { name: /^start research$/i }).click();
  await until(async () => { const s = await page.evaluate(() => window.dom.snapshot()); return s.status === 'WAITING_FOR_PROXIES' && s.proxyPool.deferred === 10; });
  const deferred = await page.evaluate(() => window.dom.snapshot());
  assert.equal(deferred.proxyPool.fetched, 10); assert.equal(deferred.proxyPool.checking, 0); assert.equal(deferred.assignedProxies, 0);
  const background = page.getByRole('region', { name: 'Background proxy checks' });
  await until(async () => (await background.innerText()).includes('Paused for memory'));
  assert.match(await background.innerText(), /85\.0%/);
  assert.match(await page.locator('.metric').filter({ hasText: 'Live sessions' }).locator('.metric-value').innerText(), /^0/);
  await until(async () => (await page.locator('.live-status-strip > div').filter({ hasText: 'Waiting sessions' }).locator('dd').innerText()) === '10');
  await application.evaluate(() => { Object.assign(process.getBuiltinModule('os'), globalThis.domSmokeMemory); delete globalThis.domSmokeMemory; });
  await until(async () => { const s = await page.evaluate(() => window.dom.snapshot()); return s.status === 'RUNNING' && s.sessions.length === 10; });
  await until(async () => (await page.evaluate(() => window.dom.snapshot())).observations.filter(o => o.outcome === 'FOUND').length === 10, 45000);
  const running = await page.evaluate(() => window.dom.snapshot());
  assert.equal(running.rankings.length, 20); assert.equal(apiCalls, 2);
  await until(() => site.logs.filter(log => log.path === '/consent-event' && log.body?.choice === 'accept' && log.body?.trusted).length === 30);
  assert.ok(site.logs.filter(log => log.path === '/consent-event').every(log => log.body?.choice === 'accept'));
  assert.equal(running.proxyPool.assigned, 10); assert.ok(running.proxyPool.running);
  await page.getByRole('region', { name: 'Background proxy checks' }).waitFor();
  const csvPath = join(data, 'rankings.csv');
  await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, csvPath);
  assert.equal(await page.evaluate(() => window.dom.exportRankings('csv')), csvPath);
  const csv = await readFile(csvPath, 'utf8'); assert.equal(csv.trim().split('\r\n').length, 21); assert.match(csv, /organicPosition/);
  const xlsxPath = join(data, 'rankings.xlsx');
  await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, xlsxPath);
  assert.equal(await page.evaluate(() => window.dom.exportRankings('xlsx')), xlsxPath);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(xlsxPath); assert.equal(workbook.worksheets[0].rowCount, 21);
  await page.screenshot({ path: 'test-results/desktop-dashboard.png', fullPage: true });
  await until(() => page.locator('.session-grid .live-browser img').evaluateAll(images => images.length === 10 && images.every(image => image.complete && image.naturalWidth > 0)));
  await page.reload();
  await until(() => page.locator('.session-grid .live-browser img').evaluateAll(images => images.length === 10 && images.every(image => image.complete && image.naturalWidth > 0)));
  await page.getByRole('button', { name: 'Inspect session Browser 01', exact: true }).click();
  const liveImage = page.getByRole('dialog').getByRole('img', { name: 'Live browser Browser 01', exact: true });
  await until(() => liveImage.evaluate(image => image.complete && image.naturalWidth === 1280));
  const beforeClick = await liveImage.getAttribute('src');
  const bounds = await liveImage.boundingBox(); assert.ok(bounds);
  const point = (x, y) => ({ x: bounds.x + x / 1280 * bounds.width, y: bounds.y + y / 800 * bounds.height });
  await page.mouse.click(point(100, 100).x, point(100, 100).y);
  await until(() => site.logs.some(log => log.path === '/live-event' && log.body?.type === 'click' && log.body?.trusted));
  await until(async () => (await liveImage.getAttribute('src')) !== beforeClick);
  await page.mouse.move(point(100, 160).x, point(100, 160).y); await page.mouse.down();
  await page.mouse.move(point(240, 220).x, point(240, 220).y, { steps: 8 }); await page.mouse.up();
  await until(() => site.logs.some(log => log.path === '/live-event' && log.body?.type === 'drag' && log.body?.trusted && Math.abs(log.body.x - 240) <= 1));
  await page.mouse.wheel(0, 400);
  await until(() => site.logs.some(log => log.path === '/live-event' && log.body?.type === 'wheel' && log.body?.trusted));
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: /^pause$/i }).click();
  await until(async () => { const s = await page.evaluate(() => window.dom.snapshot()); return s.status === 'PAUSED' && s.assignedProxies === 0; });
  await until(() => page.getByRole('button', { name: /^resume$/i }).isEnabled());
  assert.equal((await page.evaluate(() => window.dom.snapshot())).assignedProxies, 0);
  await page.getByRole('button', { name: /^resume$/i }).click();
  await until(async () => (await page.evaluate(() => window.dom.snapshot())).status === 'RUNNING');
  assert.equal(apiCalls, 2); // Resume reserves checked proxies; it does not restart the API worker.
  await page.getByRole('button', { name: /^stop$/i }).click();
  await until(async () => (await page.evaluate(() => window.dom.snapshot())).status === 'STOPPED');
  const stopped = await page.evaluate(() => window.dom.snapshot()); assert.equal(stopped.assignedProxies, 0);
  assert.equal(stopped.proxyPool.assigned, 0); assert.equal(stopped.proxyPool.running, true);
  assert.ok(stopped.sessions.every(s => s.state === 'STOPPED'));
  await page.locator('summary').filter({ hasText: 'Proxy connection' }).click();
  await page.getByRole('checkbox', { name: 'Validate proxies for Google' }).uncheck();
  await page.getByRole('button', { name: /^save configuration$/i }).click();
  await until(async () => { const s = await page.evaluate(() => window.dom.snapshot()); return !s.proxyPool.validationEnabled && s.proxyPool.ready === 10; });
  const consentBeforeDirect = site.logs.filter(log => log.path === '/consent-event').length;
  await page.getByRole('button', { name: /^start research$/i }).click();
  await until(async () => { const s = await page.evaluate(() => window.dom.snapshot()); return s.status === 'RUNNING' && s.observations.filter(o => o.outcome === 'FOUND').length === 10; }, 45000);
  await until(() => site.logs.filter(log => log.path === '/consent-event').length === consentBeforeDirect + 20);
  assert.equal((await page.evaluate(() => window.dom.snapshot())).proxyPool.checking, 0);
  await page.getByRole('button', { name: /^stop$/i }).click();
  await until(async () => (await page.evaluate(() => window.dom.snapshot())).status === 'STOPPED');
  await page.evaluate(settings => window.dom.saveSettings(settings), { ...configured, proxyApiUrl: `http://127.0.0.1:${api.address().port}/json` });
  await until(async () => (await page.evaluate(() => window.dom.snapshot())).proxyPool.ready === 10);
  await closeApplication();
  application = await _electron.launch(options); page = await application.firstWindow();
  await page.waitForFunction(() => window.dom && document.querySelector('button'));
  assert.equal((await page.evaluate(() => window.dom.settings())).keywords, configured.keywords);
  assert.equal((await page.evaluate(() => window.dom.settings())).validateProxies, false);
  assert.ok((await page.evaluate(() => window.dom.snapshot())).rankings.length >= 20);
  assert.deepEqual(errors, []);
  await writeFile('test-results/desktop-smoke.json', JSON.stringify({ platform: process.platform, packaged: !!process.env.DOM_EXECUTABLE_PATH, sessions: 10, rankings: running.rankings.length, apiCalls, providerFormats: ['url', 'host:port', 'json'], googleValidationDefaultOff: true, validationToggleAndPersistence: true, liveStreams: 10, liveMouseClickDragScroll: true, cookieConsentAccepted: true, consentClicks: site.logs.filter(log => log.path === '/consent-event' && log.body?.choice === 'accept').length, memoryPauseAndRecovery: true, persistedSettings: true, persistedRankings: true, pauseResumeStop: true, csvRows: 21, xlsxRows: 21, rendererErrors: errors }, null, 2));
  console.log('Desktop smoke passed: default-off validation, UI enable/disable and persistence, real Accept all clicks with and without checks, ten live streams, real mouse clicks/drag/scroll, URL/plain/JSON providers, memory recovery, rankings/exports, pause/resume/stop and reopen.');
} finally {
  await closeApplication(); await Promise.all(proxies.map(p => p.close())); await site.close();
  await devServer?.close();
  await new Promise(r => api.close(r)); await rm(data, { recursive: true, force: true });
}
