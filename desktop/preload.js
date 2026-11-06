'use strict';
// The page talks to its native window through window.webkit.messageHandlers.agentos (the GTK window's bridge, see
// public/ui/os/shell.js). Here the same bridge carries the messages to Electron's main process, so the page is unchanged.
const { contextBridge, ipcRenderer } = require('electron');

const info = ipcRenderer.sendSync('agentos:info');

contextBridge.exposeInMainWorld('webkit', {
  messageHandlers: { agentos: { postMessage: (msg) => ipcRenderer.send('agentos:msg', String(msg)) } },
});
contextBridge.exposeInMainWorld('osNativeInfo', info);

const mark = () => {
  const el = document.documentElement;
  if (!el) return;
  el.dataset.native = '1';
  el.dataset.platform = info.platform;
};
mark();
window.addEventListener('DOMContentLoaded', mark);
