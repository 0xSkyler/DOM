import { app, BrowserWindow, ipcMain, dialog, safeStorage } from 'electron';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';
import { Store, type SettingsCodec } from '../database/store';
import { Controller } from '../core/scheduler/controller';
import { ChromiumDriver } from '../core/browser-manager/driver';
import { BackgroundProxyPool } from '../core/proxy-pool/background';
import { GoogleProxyChecker } from '../core/proxy-pool/google-checker';
import { validateSettings } from '../shared/validation';
import { ResourceMonitor } from './resource-monitor';
import type { Settings, Snapshot } from '../shared/types';

let win: BrowserWindow | undefined, store: Store, controller: Controller;
let proxyService: BackgroundProxyPool;
let commandSerial = 0;
let quitting = false, monitoring: ReturnType<typeof setInterval> | undefined;
let latestResources: Snapshot['resources'];
let sendTimer: ReturnType<typeof setTimeout> | undefined;
const codec: SettingsCodec = {
  encode(settings) {
    const url = new URL(settings.proxyApiUrl);
    const sensitive = !!url.username || !!url.password || [...url.searchParams.keys()].some(k => /token|key|password|secret|auth/i.test(k));
    if (sensitive) {
      if (!safeStorage.isEncryptionAvailable() || (process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text')) throw new Error('An OS credential store is required to persist an authenticated proxy API URL. Configure a desktop keyring.');
      return JSON.stringify({ ...settings, proxyApiUrl: `encrypted:${safeStorage.encryptString(settings.proxyApiUrl).toString('base64')}` });
    }
    return JSON.stringify(settings);
  },
  decode(value) {
    const settings = JSON.parse(value) as Settings;
    if (settings.proxyApiUrl.startsWith('encrypted:')) settings.proxyApiUrl = safeStorage.decryptString(Buffer.from(settings.proxyApiUrl.slice(10), 'base64'));
    return settings;
  }
};
function snapshot(): Snapshot {
  const current = controller.snapshot();
  return { ...current, resources: latestResources,
    rankings: store.history('rankings', 1000), observations: store.history('observations', 1000), logs: store.history('diagnostics', 200) };
}
function send(): void {
  if (sendTimer) return;
  sendTimer = setTimeout(() => { sendTimer = undefined; if (win && !win.isDestroyed()) win.webContents.send('dom:state', snapshot()); }, 250);
}
function handle(name: string, fn: (...args: any[]) => unknown): void {
  ipcMain.handle(`dom:${name}`, (event, ...args) => {
    if (event.sender !== win?.webContents) throw new Error('Untrusted renderer');
    return fn(...args);
  });
}
async function initialize(): Promise<void> {
  if (process.env.DOM_DATA_DIR) app.setPath('userData', process.env.DOM_DATA_DIR);
  store = await Store.open(join(app.getPath('userData'), 'dom.sqlite'), codec);
  const browserOptions = app.isPackaged ? { executablePath: join(process.resourcesPath, 'chromium', process.platform === 'win32' ? 'chrome.exe' : 'chrome') } : {};
  proxyService = new BackgroundProxyPool(new GoogleProxyChecker(browserOptions));
  controller = new Controller({ driver: new ChromiumDriver(browserOptions), store, nextCycle: () => store.nextCycle(), backgroundProxies: proxyService });
  const saved = store.settings();
  if (saved.keywords && saved.target && (saved.mode === 'google' || saved.controlledSearchUrl)) await proxyService.configure(saved);
  win = new BrowserWindow({ width: 1440, height: 980, minWidth: 1024, minHeight: 700, backgroundColor: '#0b111b', title: 'DOM',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  handle('settings', () => store.settings());
  handle('saveSettings', async (settings: Settings) => {
    if (!['STOPPED', 'PAUSED'].includes(controller.snapshot().status)) throw new Error('Stop research before changing configuration.');
    const valid = validateSettings(settings, { forRun: false }); store.saveSettings(valid);
    if (valid.mode === 'google' || valid.controlledSearchUrl) await proxyService.configure(valid);
  });
  handle('snapshot', snapshot);
  handle('command', async (command: string, settings?: Settings) => {
    switch (command) {
      case 'start': {
        const serial = ++commandSerial;
        const valid = validateSettings(settings ?? store.settings()); await controller.stop();
        if (serial !== commandSerial) break;
        store.saveSettings(valid); await proxyService.configure(valid);
        if (serial !== commandSerial) break;
        await controller.start(valid); break;
      }
      case 'stop': ++commandSerial; await controller.stop(); store.flush(); break;
      case 'pause': await controller.pause(); store.flush(); break;
      case 'resume': await controller.resume(); break;
      default: throw new Error('Unknown command');
    }
    send();
  });
  handle('preview', (id: string) => controller.preview(id));
  handle('liveView', (id, cycle) => controller.liveView(id, cycle));
  handle('browserInput', (id, cycle, input) => controller.browserInput(id, cycle, input));
  handle('openResult', (id: string, url: string) => controller.openResult(id, url));
  handle('importKeywords', async () => {
    const result = await dialog.showOpenDialog(win!, { filters: [{ name: 'Keyword list', extensions: ['txt', 'csv'] }], properties: ['openFile'] });
    if (result.canceled) return;
    const text = await readFile(result.filePaths[0], 'utf8');
    if (text.length > 1024 * 1024) throw new Error('Keyword import exceeds 1 MB');
    // Parse CSV quote escaping before passing the words to the shared keyword parser.
    let quoted = false;
    for (let i = 0; i < text.length; i++) { const ch = text[i];
      if (ch === '"') { if (quoted && text[i + 1] === '"') i++; else quoted = !quoted; }
    }
    if (quoted) throw new Error('Unterminated CSV quoted field');
    return text;
  });
  handle('exportRankings', async (format: 'csv' | 'xlsx') => {
    if (!['csv', 'xlsx'].includes(format)) throw new Error('Unknown export format');
    const result = await dialog.showSaveDialog(win!, { defaultPath: `DOM-rankings.${format}`, filters: [{ name: format.toUpperCase(), extensions: [format] }] });
    if (result.canceled || !result.filePath) return;
    const rows = store.allRankings();
    const headers = ['keyword', 'target', 'url', 'title', 'organicPosition', 'elementPosition', 'resultPage', 'sessionId', 'proxyId', 'device', 'searchLocation', 'cycle', 'timestamp'] as const;
    const safeCell = (value: unknown) => { const text = String(value ?? ''); return /^[=+@-]/.test(text) ? `'${text}` : text; };
    if (format === 'csv') {
      const escape = (value: unknown) => `"${safeCell(value).replaceAll('"', '""')}"`;
      await writeFile(result.filePath, '\uFEFF' + [headers.join(','), ...rows.map(row => headers.map(key => escape(row[key])).join(','))].join('\r\n'));
    } else {
      const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet('Rankings');
      sheet.addRow([...headers]); rows.forEach(row => sheet.addRow(headers.map(key => typeof row[key] === 'number' ? row[key] : safeCell(row[key]))));
      sheet.getRow(1).font = { bold: true }; sheet.views = [{ state: 'frozen', ySplit: 1 }];
      await book.xlsx.writeFile(result.filePath);
    }
    return result.filePath;
  });
  controller.onChange(send);
  controller.onFrame(frame => { if (win && !win.isDestroyed() && !quitting) win.webContents.send('dom:browser-frame', frame); });
  let sampling = false;
  const monitor = new ResourceMonitor();
  monitoring = setInterval(async () => {
    if (sampling) return; sampling = true;
    try {
      latestResources = await monitor.sample();
      send();
    } catch { /* Resource telemetry unavailable; do not invent values. */ }
    finally { sampling = false; }
  }, 2000);
  if (process.env.DOM_DEV_URL && !app.isPackaged) await win.loadURL(process.env.DOM_DEV_URL);
  else await win.loadFile(join(__dirname, 'renderer/index.html'));
  win.on('close', event => {
    if (quitting) return;
    event.preventDefault(); void shutdown();
  });
}
async function shutdown(): Promise<void> {
  if (quitting) return; quitting = true;
  clearInterval(monitoring);
  clearTimeout(sendTimer);
  try { await controller?.stop(); await proxyService?.close(); store?.close(); } finally { app.quit(); }
}
app.on('before-quit', event => { if (!quitting) { event.preventDefault(); void shutdown(); } });
app.whenReady().then(initialize).catch(error => { dialog.showErrorBox('DOM startup failed', String(error.message ?? error)); quitting = true; app.quit(); });
