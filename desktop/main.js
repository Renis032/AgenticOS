'use strict';
// Agentic OS desktop app (Electron) for macOS, Windows and Linux. It starts the office's server on Electron's own
// Node (no Node install needed), opens the window over it, and does what the GTK window (app/agentos-window.py) does:
// tray, notifications, closing to the background, start at login. The page and the server are the same as ever.
const { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, session, shell } = require('electron');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { officeRoot, syncOffice } = require('./office-files');

const PORT = Number(process.env.WORKPLACE_PORT) || 4747;
const BASE = `http://127.0.0.1:${PORT}`;
const BACKGROUND = process.argv.includes('--background');
const MAC = process.platform === 'darwin', WIN = process.platform === 'win32';
const ROOT = officeRoot({ packaged: app.isPackaged, userData: app.getPath('userData'), checkout: path.join(__dirname, '..') });
const BUNDLE = path.join(process.resourcesPath || '', 'office');
const ICON = path.join(ROOT, 'app', 'icon.png');
const PREFS_FILE = path.join(app.getPath('userData'), 'window.json');

let win = null, tray = null, quitting = false, trayTimer = null;

// ---------------------------------------------------------------- prefs (window size, zoom, what closing does)

function readPrefs() { try { return JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')); } catch { return {}; } }
let prefs = readPrefs();
function setPref(k, v) {
  prefs[k] = v;
  try { fs.mkdirSync(path.dirname(PREFS_FILE), { recursive: true }); fs.writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2)); } catch {}
}

// ---------------------------------------------------------------- the environment agents need

// Apps started from the Dock, Finder or a desktop launcher get a bare PATH, so `claude` (often in ~/.local/bin or
// /opt/homebrew/bin) is not found. Ask the user's login shell for the PATH it would give a terminal.
function loginPath() {
  if (WIN) return process.env.PATH;
  const shellBin = process.env.SHELL || (MAC ? '/bin/zsh' : '/bin/bash');
  const r = spawnSync(shellBin, ['-ilc', 'printf "__PATH__%s__PATH__" "$PATH"'], { encoding: 'utf8', timeout: 5000 });
  const m = /__PATH__(.*)__PATH__/.exec(r.stdout || '');
  const extra = [path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin'];
  return [...new Set([...(m ? m[1] : process.env.PATH || '').split(path.delimiter), ...extra].filter(Boolean))].join(path.delimiter);
}
const ENV = { ...process.env, PATH: loginPath() };

function claudeVersion() {
  const bin = process.env.CLAUDE_BIN || 'claude';
  const r = spawnSync(bin, ['--version'], { env: ENV, encoding: 'utf8', timeout: 15000, shell: WIN });
  return r.status === 0 ? (r.stdout || '').trim() : null;
}

// ---------------------------------------------------------------- the server

const token = () => { try { return fs.readFileSync(path.join(ROOT, 'data', 'app-token'), 'utf8').trim(); } catch { return ''; } };

function call(method, p, timeout = 4000) {
  return new Promise((resolve) => {
    const req = http.request(BASE + p, { method, timeout, headers: { 'x-agentos-token': token(), 'content-type': 'application/json' } }, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch {} resolve({ code: res.statusCode, body: j }); });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ code: 0, body: null }));
    if (method === 'POST') req.write('{}');
    req.end();
  });
}
const serverUp = async () => (await call('GET', '/api/limits')).code === 200;

// 'ours' when our office answers, 'other' when something else holds the port, null when it is free.
async function portState() {
  if (await serverUp()) return 'ours';
  return (await call('GET', '/api/limits')).code ? 'other' : null;
}

function startServer() {
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });
  const log = fs.openSync(path.join(ROOT, 'data', 'server.log'), 'a');
  // Detached: the office keeps working when the window closes to the background, like ./agentos.
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT, detached: true, stdio: ['ignore', log, log], windowsHide: true,
    env: { ...ENV, ELECTRON_RUN_AS_NODE: '1', WORKPLACE_PORT: String(PORT) },
  });
  child.unref();
}

async function ensureServer() {
  const st = await portState();
  if (st === 'ours') return true;
  if (st === 'other') {
    dialog.showErrorBox('Port in use', `Something else is using port ${PORT}, or another Agentic OS from a different folder is running there. Stop it, or start this one with WORKPLACE_PORT set to a free port.`);
    return false;
  }
  startServer();
  for (let i = 0; i < 80; i++) { if (await serverUp()) return true; await new Promise((r) => setTimeout(r, 250)); }
  dialog.showErrorBox('The office did not start', `See ${path.join(ROOT, 'data', 'server.log')}.`);
  return false;
}

// ---------------------------------------------------------------- the window

// Electron moves a frameless window by CSS regions rather than the GTK window's "drag" message.
const DRAG_CSS = `#top { -webkit-app-region: drag; }
#top :is(button, input, select, textarea, a, kbd, .meter, .searchpill, [data-act], #leadsBar *, .wctl *) { -webkit-app-region: no-drag; }
${MAC ? 'html[data-platform="darwin"] #top { padding-left: 78px; }' : ''}`;

function pushState() {
  if (!win || win.isDestroyed()) return;
  const st = { maximized: win.isMaximized(), fullscreen: win.isFullScreen(), active: win.isFocused(), zoom: win.webContents.getZoomFactor() };
  win.webContents.executeJavaScript(`window.osNativeState && osNativeState(${JSON.stringify(st)})`).catch(() => {});
}

async function createWindow() {
  const b = prefs.bounds || {};
  win = new BrowserWindow({
    width: b.width || 1440, height: b.height || 900, x: b.x, y: b.y, minWidth: 900, minHeight: 600,
    show: false, title: 'Agentic OS', icon: ICON, backgroundColor: '#1c1b1f',
    frame: MAC, titleBarStyle: MAC ? 'hiddenInset' : undefined,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: true },
  });
  if (prefs.maximized) win.maximize();
  // The same cookie the GTK window gets from /__app: the token never goes in a URL.
  await session.defaultSession.cookies.set({ url: BASE, name: 'agentos', value: token(), httpOnly: true, sameSite: 'strict' });
  win.webContents.on('dom-ready', () => { win.webContents.insertCSS(DRAG_CSS); pushState(); });
  win.webContents.on('did-finish-load', () => { if (prefs.zoom) win.webContents.setZoomFactor(prefs.zoom); });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(BASE)) return { action: 'allow', overrideBrowserWindowOptions: { icon: ICON, autoHideMenuBar: true } };
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (ev, url) => { if (!url.startsWith(BASE)) { ev.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  win.webContents.on('before-input-event', (ev, input) => {
    const mod = MAC ? input.meta : input.control;
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); ev.preventDefault(); }
    else if (input.key === 'F5' || (mod && input.key.toLowerCase() === 'r')) { win.webContents.reload(); ev.preventDefault(); }
    else if (mod && input.key.toLowerCase() === 'q') { win.close(); ev.preventDefault(); }
  });
  for (const e of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur']) win.on(e, pushState);
  const saveBounds = () => { if (!win.isMaximized() && !win.isFullScreen()) setPref('bounds', win.getBounds()); setPref('maximized', win.isMaximized()); };
  win.on('resized', saveBounds);
  win.on('moved', saveBounds);
  win.on('close', onClose);
  win.on('closed', () => { win = null; });
  win.once('ready-to-show', () => { if (!BACKGROUND) win.show(); });
  win.loadURL(`${BASE}/`);
}

function showWindow() {
  if (!win) return createWindow().then(() => win.show());
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// ---------------------------------------------------------------- closing: the same choices as the GTK window

async function busy() {
  const r = await call('GET', '/api/state');
  if (!r.body) return null;
  const work = (r.body.agents || []).filter((a) => ['running', 'delegating', 'queued'].includes(a.status) || (a.resident && a.current));
  const jobs = (r.body.tickets || []).filter((t) => ['open', 'paused'].includes(t.status));
  return { work, jobs };
}

const stopServer = () => call('POST', '/api/shutdown');

function toBackground() {
  win.hide();
  if (!prefs.trayHintShown && Notification.isSupported()) {
    setPref('trayHintShown', true);
    new Notification({ title: 'Agentic OS keeps working in the background', body: 'Open it again from the tray icon. Quit from the tray menu to stop everything.', icon: ICON }).show();
  }
}

async function finish(stop) {
  if (stop) await stopServer();
  quitting = true;
  app.quit();
}

async function onClose(ev) {
  if (quitting) return;
  ev.preventDefault();
  const b = await busy();
  if (!b) return finish(false);
  if (!b.work.length && !b.jobs.length) return finish(true);
  const choice = prefs.closeAction || 'ask';
  if (choice === 'background') return toBackground();
  if (choice === 'stop') return finish(true);
  const n = b.jobs.length || 1;
  const names = [...new Set(b.work.map((a) => a.persona || a.id))].sort().slice(0, 6).join(', ');
  const r = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Keep running in background', 'Stop them and quit', 'Cancel'], defaultId: 0, cancelId: 2,
    message: `${n} job${n === 1 ? '' : 's'} still running`,
    detail: `${names ? `Working now: ${names}.\n\n` : ''}Stop them and quit Agentic OS, or close the window and let them finish in the background? You can reopen the window any time from the tray.`,
    checkboxLabel: "Don't ask again (change it in Preferences)",
  });
  if (r.response === 2) return;
  if (r.checkboxChecked) setPref('closeAction', r.response === 1 ? 'stop' : 'background');
  if (r.response === 1) return finish(true);
  toBackground();
}

// ---------------------------------------------------------------- tray

async function updateTray() {
  if (!tray) return;
  const r = await call('GET', '/api/state');
  let label = 'Agentic OS · backend not running';
  if (r.body) {
    const work = (r.body.agents || []).filter((a) => ['running', 'delegating'].includes(a.status) || (a.resident && a.current));
    const needs = (r.body.tickets || []).filter((t) => t.waiting || (t.plan && t.plan.status === 'pending') || (t.commands || []).some((c) => c.status === 'pending'));
    label = `Agentic OS · ${work.length ? `${work.length} working` : 'idle'}${needs.length ? ` · ${needs.length} need${needs.length === 1 ? 's' : ''} you` : ''}`;
  }
  tray.setToolTip(label);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label, enabled: false },
    { type: 'separator' },
    { label: 'Open Agentic OS', click: showWindow },
    { label: 'Quit', click: () => { showWindow(); setImmediate(() => win && win.close()); } },
  ]));
}

function setupTray() {
  const img = nativeImage.createFromPath(ICON).resize({ width: MAC ? 18 : 22, height: MAC ? 18 : 22 });
  tray = new Tray(img);
  tray.on('click', showWindow);
  updateTray();
  trayTimer = setInterval(updateTray, 10000);
}

// ---------------------------------------------------------------- start at login

const LINUX_AUTOSTART = path.join(os.homedir(), '.config', 'autostart', 'agentos-desktop.desktop');
function autostartOn() {
  if (process.platform === 'linux') return fs.existsSync(LINUX_AUTOSTART);
  return app.getLoginItemSettings({ args: ['--background'] }).openAtLogin;
}
function setAutostart(on) {
  if (process.platform !== 'linux') return app.setLoginItemSettings({ openAtLogin: !!on, openAsHidden: true, args: ['--background'] });
  if (!on) return fs.rmSync(LINUX_AUTOSTART, { force: true });
  const exec = process.env.APPIMAGE || process.execPath;
  fs.mkdirSync(path.dirname(LINUX_AUTOSTART), { recursive: true });
  fs.writeFileSync(LINUX_AUTOSTART, `[Desktop Entry]\nType=Application\nName=Agentic OS\nComment=Your permanent team of Claude agents\nExec="${exec}"${app.isPackaged ? '' : ` "${path.join(__dirname)}"`} --background\nIcon=${ICON}\nTerminal=false\nX-GNOME-Autostart-enabled=true\n`);
}

// ---------------------------------------------------------------- messages from the page (the GTK window's set)

function onMessage(_ev, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (!win) return;
  switch (msg.cmd) {
    case 'minimize': win.minimize(); break;
    case 'maximize': if (win.isMaximized()) win.unmaximize(); else win.maximize(); break;
    case 'fullscreen': win.setFullScreen(!win.isFullScreen()); break;
    case 'close': win.close(); break;
    case 'zoom': { const z = Math.max(0.6, Math.min(2, Number(msg.level) || 1)); win.webContents.setZoomFactor(z); setPref('zoom', z); pushState(); break; }
    case 'prefs': for (const [k, v] of Object.entries(msg.prefs || {})) setPref(k, v); break;
    case 'notify': notify(msg); break;
    case 'about': dialog.showMessageBox(win, { type: 'info', message: 'Agentic OS', detail: `Version ${version()}\nA permanent team of Claude agents, run like an operating system.\n\n${ROOT}`, icon: ICON }); break;
    case 'autostart': setAutostart(!!msg.on); break;
    case 'capture': { // A screenshot of part of the page, for the job's preview (the page can't see into another origin's frame).
      const r = msg.rect || {}, z = win.webContents.getZoomFactor();
      win.webContents.capturePage({ x: Math.round(r.x * z), y: Math.round(r.y * z), width: Math.round(r.w * z), height: Math.round(r.h * z) })
        .then((img) => win && win.webContents.executeJavaScript(`window.osCaptured && osCaptured(${Number(msg.id)}, ${JSON.stringify(img.toDataURL())})`)).catch(() => {});
      break;
    }
    case 'openPath': {
      const p = path.resolve(String(msg.path || '').replace(/^~(?=$|[\\/])/, os.homedir()));
      if (p.startsWith(os.homedir() + path.sep) && fs.existsSync(p)) shell.openPath(p);
      break;
    }
    default: break; // 'drag' is handled by CSS regions
  }
}

function notify(msg) {
  if (!Notification.isSupported()) return;
  if (win && win.isVisible() && win.isFocused() && !msg.always) return; // in front, the page shows its own toast
  const n = new Notification({ title: String(msg.title || 'Agentic OS'), body: String(msg.body || '').slice(0, 300), icon: ICON,
    urgency: ['question', 'limit'].includes(msg.kind) ? 'critical' : 'normal' });
  if (msg.ticket) n.on('click', () => { showWindow(); win.webContents.executeJavaScript(`window.osOpenJob && osOpenJob(${JSON.stringify(String(msg.ticket))})`).catch(() => {}); });
  else n.on('click', showWindow);
  n.show();
}

function version() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { return app.getVersion(); }
}

ipcMain.on('agentos:info', (ev) => {
  ev.returnValue = { layout: MAC ? '' : ':minimize,maximize,close', version: version(), autostart: autostartOn(), tray: true, platform: process.platform, shell: 'electron' };
});
ipcMain.on('agentos:msg', onMessage);

// ---------------------------------------------------------------- start

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow); // macOS: the Dock icon
  app.on('window-all-closed', () => {}); // the tray keeps the app alive; quitting goes through the close choices
  app.on('before-quit', () => { quitting = quitting || !win; if (trayTimer) clearInterval(trayTimer); });
  app.whenReady().then(async () => {
    if (MAC) Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]));
    else Menu.setApplicationMenu(null);
    if (app.isPackaged) syncOffice(BUNDLE, ROOT, app.getVersion());
    if (!claudeVersion()) {
      const r = await dialog.showMessageBox({ type: 'warning', buttons: ['Get Claude Code', 'Continue anyway', 'Quit'], defaultId: 0, cancelId: 2,
        message: 'Agentic OS needs Claude Code', detail: 'Its agents run on Claude Code, which was not found on this computer. Install it, sign in once in a terminal (or add an API key in Preferences → Account), then open Agentic OS again.' });
      if (r.response === 0) { shell.openExternal('https://claude.com/claude-code'); app.quit(); return; }
      if (r.response === 2) { app.quit(); return; }
    }
    if (!(await ensureServer())) { app.quit(); return; }
    setupTray();
    await createWindow();
  });
}
