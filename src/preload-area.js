'use strict';

const { contextBridge, ipcRenderer } = require('electron/renderer');

/*
 * Minimal bridge for the region selector overlay.
 *
 * That window previously ran with nodeIntegration enabled and context isolation off,
 * which handed a screen-covering, always-on-top renderer unrestricted Node access. It only
 * ever needed these three calls.
 */
contextBridge.exposeInMainWorld('rp4Area', {
  getDisplayData: () => ipcRenderer.invoke('area-selector:data'),
  complete: (rect) => ipcRenderer.send('area-selector:complete', rect),
  cancel: () => ipcRenderer.send('area-selector:cancel')
});
