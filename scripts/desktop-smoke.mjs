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
const api = http.createServer((_req, res) => { apiCalls++; res.end(proxies.map(p => p.server).join('\n')); });
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
try {
  application = await _electron.launch(options);
  let page = await application.firstWindow(); page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => window.dom && document.querySelector('button'));
  assert.match(await page.title(), /DOM/);
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  const defaults = await page.evaluate(() => window.dom.settings());
  const configured = { ...defaults, keywords: 'desktop fixture A, desktop fixture B', target: site.origin, proxyApiUrl: `http://127.0.0.1:${api.address().port}/proxies`, mode: 'controlled', controlledSearchUrl: site.origin, rotationSeconds: 120, searchDepth: 2 };
  await page.evaluate(settings => window.dom.saveSettings(settings), configured);
  await page.reload();
  await page.getByRole('button', { name: /^start research$/i }).waitFor();
  await page.getByRole('button', { name: /^start research$/i }).click();
  await until(async () => { const s = await page.evaluate(() => window.dom.snapshot()); return s.status === 'RUNNING' && s.sessions.length === 10; });
  await until(async () => (await page.evaluate(() => window.dom.snapshot())).observations.filter(o => o.outcome === 'FOUND').length === 10, 45000);
  const running = await page.evaluate(() => window.dom.snapshot());
  assert.equal(running.rankings.length, 20); assert.equal(apiCalls, 1);
  const csvPath = join(data, 'rankings.csv');
  await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, csvPath);
  assert.equal(await page.evaluate(() => window.dom.exportRankings('csv')), csvPath);
  const csv = await readFile(csvPath, 'utf8'); assert.equal(csv.trim().split('\r\n').length, 21); assert.match(csv, /organicPosition/);
  const xlsxPath = join(data, 'rankings.xlsx');
  await application.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, xlsxPath);
  assert.equal(await page.evaluate(() => window.dom.exportRankings('xlsx')), xlsxPath);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(xlsxPath); assert.equal(workbook.worksheets[0].rowCount, 21);
  await page.screenshot({ path: 'test-results/desktop-dashboard.png', fullPage: true });
  const preview = await page.evaluate(() => window.dom.preview('Browser 01')); assert.ok(preview?.startsWith('data:image/'));
  await page.getByRole('button', { name: /^pause$/i }).click();
  await until(async () => { const s = await page.evaluate(() => window.dom.snapshot()); return s.status === 'PAUSED' && s.assignedProxies === 0; });
  await until(() => page.getByRole('button', { name: /^resume$/i }).isEnabled());
  assert.equal((await page.evaluate(() => window.dom.snapshot())).assignedProxies, 0);
  await page.getByRole('button', { name: /^resume$/i }).click();
  await until(async () => (await page.evaluate(() => window.dom.snapshot())).status === 'RUNNING');
  assert.equal(apiCalls, 2);
  await page.getByRole('button', { name: /^stop$/i }).click();
  await until(async () => (await page.evaluate(() => window.dom.snapshot())).status === 'STOPPED');
  const stopped = await page.evaluate(() => window.dom.snapshot()); assert.equal(stopped.assignedProxies, 0);
  assert.ok(stopped.sessions.every(s => s.state === 'STOPPED'));
  await application.close(); application = undefined;
  application = await _electron.launch(options); page = await application.firstWindow();
  await page.waitForFunction(() => window.dom && document.querySelector('button'));
  assert.equal((await page.evaluate(() => window.dom.settings())).keywords, configured.keywords);
  assert.ok((await page.evaluate(() => window.dom.snapshot())).rankings.length >= 20);
  assert.deepEqual(errors, []);
  await writeFile('test-results/desktop-smoke.json', JSON.stringify({ platform: process.platform, packaged: !!process.env.DOM_EXECUTABLE_PATH, sessions: 10, rankings: running.rankings.length, apiCalls, persistedSettings: true, persistedRankings: true, pauseResumeStop: true, csvRows: 21, xlsxRows: 21, rendererErrors: errors }, null, 2));
  console.log('Desktop smoke passed: 10 proxied sessions, real controls, 20 rankings, screenshots, pause/resume fresh fetch, STOP, settings/history reopen.');
} finally {
  await application?.close().catch(() => {}); await Promise.all(proxies.map(p => p.close())); await site.close();
  await devServer?.close();
  await new Promise(r => api.close(r)); await rm(data, { recursive: true, force: true });
}
