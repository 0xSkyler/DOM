import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopAPI, Snapshot } from '../shared/types';
const api: DesktopAPI = {
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
