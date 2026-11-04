import { contextBridge, ipcRenderer } from 'electron';
import type { AppState, WireAPI } from '../shared';

const api: WireAPI = {
  getState: () => ipcRenderer.invoke('wire:state'),
  action: action => ipcRenderer.invoke('wire:action', action),
  updateSettings: patch => ipcRenderer.invoke('wire:settings', patch),
  onState(callback) {
    const listener = (_event: Electron.IpcRendererEvent, state: AppState) => callback(state);
    ipcRenderer.on('wire:state', listener);
    return () => { ipcRenderer.removeListener('wire:state', listener); };
  },
  onNotice(callback) {
    const listener = (_event: Electron.IpcRendererEvent, message: string) => callback(message);
    ipcRenderer.on('wire:notice', listener);
    return () => { ipcRenderer.removeListener('wire:notice', listener); };
  },
};
contextBridge.exposeInMainWorld('wire', api);
