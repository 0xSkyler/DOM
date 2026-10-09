import { contextBridge, ipcRenderer } from 'electron';
import type { BrowserFrame, DesktopAPI, Snapshot } from '../shared/types';
const api: DesktopAPI = {
  onBrowserFrame: fn => { const listener = (_event: unknown, frame: BrowserFrame) => fn(frame); ipcRenderer.on('dom:browser-frame', listener); return () => ipcRenderer.removeListener('dom:browser-frame', listener); },
  liveView: (id, cycle) => ipcRenderer.invoke('dom:liveView', id, cycle),
  browserInput: (id, cycle, input) => ipcRenderer.invoke('dom:browserInput', id, cycle, input),
  settings: () => ipcRenderer.invoke('dom:settings'),
  saveSettings: settings => ipcRenderer.invoke('dom:saveSettings', settings),
  command: (command, settings) => ipcRenderer.invoke('dom:command', command, settings),
  snapshot: () => ipcRenderer.invoke('dom:snapshot'),
  onSnapshot: fn => { const listener = (_event: unknown, snapshot: Snapshot) => fn(snapshot); ipcRenderer.on('dom:state', listener); return () => ipcRenderer.removeListener('dom:state', listener); },
  importKeywords: () => ipcRenderer.invoke('dom:importKeywords'),
  exportRankings: format => ipcRenderer.invoke('dom:exportRankings', format),
  preview: id => ipcRenderer.invoke('dom:preview', id),
  openResult: (id, url) => ipcRenderer.invoke('dom:openResult', id, url)
};
contextBridge.exposeInMainWorld('dom', api);
