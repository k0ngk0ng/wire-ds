import { app, BrowserWindow, WebContentsView, Menu, Tray, nativeImage, globalShortcut, ipcMain, nativeTheme, screen, shell, dialog, session, type WebContents, type IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SettingsStore, sanitizeSettings } from './settings';
import type { AppState, Result, Settings, WindowMode, SavedBounds } from '../shared';

const projectRoot = path.resolve(__dirname, '../..');
const testing = !app.isPackaged && process.env.WIRE_DS_TEST === '1';
// Keep the historical profile directory and appId so renaming preserves login state.
const dataDirectory = process.env.WIRE_DS_DATA_DIR || (app.isPackaged ? path.join(app.getPath('appData'), 'Wire DeepSeek') : path.join(projectRoot, '.runtime', 'development'));
for (const directory of [dataDirectory, path.join(dataDirectory, 'logs'), path.join(dataDirectory, 'crashes'), path.join(dataDirectory, 'sessions')]) fs.mkdirSync(directory, { recursive: true });
app.setName('ChatDeepSeek');
app.setPath('userData', dataDirectory);
app.setPath('sessionData', path.join(dataDirectory, 'sessions'));
app.setPath('logs', path.join(dataDirectory, 'logs'));
app.setPath('crashDumps', path.join(dataDirectory, 'crashes'));
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');
const website = testing ? process.env.WIRE_DS_TEST_URL! : 'https://chat.deepseek.com';
const siteOrigin = new URL(website).origin;
const localPage = (name: string) => path.join(__dirname, '../renderer', `${name}.html`);
const preload = path.join(__dirname, '../preload/app.js');
const pagePreload = path.join(__dirname, '../preload/page.js');

let controller: Desktop;
let quitting = false;
let tray: Tray | undefined;
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();

function isOfficial(url: string): boolean {
  try { const target = new URL(url); return target.origin === siteOrigin; } catch { return false; }
}
function safeExternal(url: string) {
  try { const target = new URL(url); if (['https:', 'http:'].includes(target.protocol)) void shell.openExternal(target.href); } catch { /* unsupported URLs stay blocked */ }
}

class Desktop {
  store = new SettingsStore(dataDirectory);
  mode: WindowMode = this.store.value.defaultMode;
  host: 'chat' | 'login' = 'chat';
  loadState: AppState['loadState'] = 'loading';
  error = '';
  shortcutRegistered = false;
  shortcutError = '';
  sidebarCollapsed = false;
  main: BrowserWindow;
  login?: BrowserWindow;
  preferences?: BrowserWindow;
  view: WebContentsView;
  private resizing = false;
  private saveTimer?: NodeJS.Timeout;
  private failureTimer?: NodeJS.Timeout;
  private lastForeground = false;
  private lastURL = website + this.store.value.lastChatPath;
  private contentHeight = 360;
  private webSession = session.fromPartition('persist:deepseek');

  constructor() {
    nativeTheme.themeSource = this.store.value.theme;
    this.main = this.createHost('shell', this.fittedBounds(this.store.value[this.mode === 'quick' ? 'quickBounds' : 'fullBounds']));
    this.main.setAlwaysOnTop(this.store.value.alwaysOnTop, 'floating');
    // Allows the companion to appear above macOS fullscreen spaces.
    if (process.platform === 'darwin') this.main.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.view = new WebContentsView({ webPreferences: {
      session: this.webSession, preload: pagePreload, nodeIntegration: false,
      contextIsolation: true, sandbox: true, webSecurity: true,
      backgroundThrottling: false, navigateOnDragDrop: false,
    } });
    this.view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#15171b' : '#ffffff');
    this.attach('chat');
    this.configureRemote();
    this.configureIPC();
    this.registerShortcut(this.store.value.shortcut);
    this.buildMenu();
    this.main.on('resize', () => { this.layout(); this.scheduleBoundsSave(); });
    this.main.on('move', () => this.scheduleBoundsSave());
    this.main.on('focus', () => { this.lastForeground = true; });
    this.main.on('blur', () => { this.lastForeground = false; });
    this.main.on('close', event => { if (!quitting) { event.preventDefault(); this.hide(); } });
    screen.on('display-removed', () => this.keepVisible());
    screen.on('display-metrics-changed', () => this.keepVisible());
    nativeTheme.on('updated', () => {
      this.view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#15171b' : '#ffffff');
      for (const win of this.windows()) win.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#15171b' : '#ffffff');
      if (process.platform === 'win32') for (const win of this.windows()) win.setTitleBarOverlay(this.overlayOptions());
      this.broadcast();
    });
    this.main.once('ready-to-show', () => this.show(false));
    void this.navigate(this.lastURL);
  }

  private createHost(page: string, bounds: SavedBounds) {
    const win = new BrowserWindow({
      ...bounds, minWidth: 460, minHeight: 360, show: false,
      title: page === 'login' ? '登录 DeepSeek' : 'ChatDeepSeek',
      titleBarStyle: process.platform === 'win32' ? 'hidden' : 'hiddenInset', trafficLightPosition: { x: 17, y: 20 },
      ...(process.platform === 'win32' ? { titleBarOverlay: this.overlayOptions() } : {}),
      icon: path.join(projectRoot, 'assets/icon.png'),
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#15171b' : '#ffffff',
      roundedCorners: true, fullscreenable: page !== 'login',
      webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
    });
    void win.loadFile(localPage(page));
    this.configureKeys(win.webContents);
    win.webContents.setWindowOpenHandler(({ url }) => { safeExternal(url); return { action: 'deny' }; });
    win.webContents.on('will-navigate', (event, url) => { if (url !== pathToFileURL(localPage(page)).href) event.preventDefault(); });
    return win;
  }

  private windows() { return [this.main, this.login, this.preferences].filter((win): win is BrowserWindow => !!win && !win.isDestroyed()); }
  private overlayOptions() { return { height: 58, color: nativeTheme.shouldUseDarkColors ? '#17191e' : '#ffffff', symbolColor: nativeTheme.shouldUseDarkColors ? '#d8dde8' : '#242b38' }; }
  private owner() { return this.host === 'login' && this.login && !this.login.isDestroyed() ? this.login : this.main; }
  private trusted(event: IpcMainInvokeEvent) {
    const win = this.windows().find(w => w.webContents.id === event.sender.id);
    if (!win || event.senderFrame !== event.sender.mainFrame) return false;
    return ['shell', 'login', 'settings'].some(name => event.senderFrame?.url === pathToFileURL(localPage(name)).href);
  }

  private configureIPC() {
    ipcMain.handle('wire:state', event => { if (!this.trusted(event)) throw new Error('Untrusted sender'); return this.state(); });
    ipcMain.handle('wire:action', (event, name: unknown) => { if (!this.trusted(event) || typeof name !== 'string') return { ok: false }; return this.action(name); });
    ipcMain.handle('wire:settings', (event, patch: unknown) => { if (!this.trusted(event)) return { ok: false }; return this.updateSettings(patch); });
    ipcMain.on('wire:page-state', (event, payload: unknown) => {
      if (event.sender.id !== this.view.webContents.id || !isOfficial(event.senderFrame?.url || '') || event.senderFrame !== event.sender.mainFrame) return;
      const info = payload as { auth?: string; sidebarCollapsed?: boolean; contentHeight?: number };
      if (info.auth === 'login' && this.loadState !== 'error') this.attach('login');
      if (info.auth === 'chat') this.attach('chat');
      if (typeof info.sidebarCollapsed === 'boolean') this.sidebarCollapsed = info.sidebarCollapsed;
      if (Number.isFinite(info.contentHeight) && info.contentHeight! > 0) {
        this.contentHeight = info.contentHeight!;
        this.adjustQuickHeight();
      }
      this.broadcast();
    });
    ipcMain.on('wire:page-escape', event => {
      if (event.sender.id === this.view.webContents.id && isOfficial(event.senderFrame?.url || '') && this.host === 'chat') this.hide();
    });
    ipcMain.on('wire:page-command', (event, command: unknown) => {
      if (event.sender.id !== this.view.webContents.id || event.senderFrame !== event.sender.mainFrame || !isOfficial(event.senderFrame?.url || '')) return;
      if (typeof command === 'string' && ['new-chat', 'hide', 'settings', 'toggle-mode'].includes(command)) void this.action(command);
    });
    ipcMain.on('wire:page-notice', (event, message: unknown) => {
      if (event.sender.id === this.view.webContents.id && typeof message === 'string') this.notice(message.slice(0, 180));
    });
  }

  private configureRemote() {
    const wc = this.view.webContents;
    this.configureKeys(wc);
    // Keep the site's normal Chromium environment while removing the shell's product token.
    wc.setUserAgent(wc.getUserAgent().replace(/\sElectron\/[\d.]+/g, '').replace(/\sWire[\w-]*\/[\d.]+/g, ''));
    wc.setWindowOpenHandler(({ url }) => {
      if (isOfficial(url)) { void this.navigate(url); return { action: 'deny' }; }
      // Authentication popups remain isolated, share the same session and retain their opener.
      if (this.host === 'login' && this.authPopupURL(url)) return { action: 'allow', overrideBrowserWindowOptions: {
        width: 520, height: 720, parent: this.login, autoHideMenuBar: true,
        webPreferences: { session: this.webSession, nodeIntegration: false, contextIsolation: true, sandbox: true },
      } };
      safeExternal(url); return { action: 'deny' };
    });
    wc.on('did-create-window', popup => {
      popup.webContents.on('will-navigate', (event, url) => {
        if (!isOfficial(url) && !this.authPopupURL(url)) { event.preventDefault(); safeExternal(url); }
      });
      popup.webContents.setWindowOpenHandler(({ url }) => { safeExternal(url); return { action: 'deny' }; });
    });
    wc.on('will-navigate', (event, url) => {
      if (!isOfficial(url) && !this.authPopupURL(url)) { event.preventDefault(); safeExternal(url); }
    });
    wc.on('will-redirect', (event, url) => {
      if (!isOfficial(url) && !this.authPopupURL(url)) { event.preventDefault(); safeExternal(url); }
    });
    wc.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (!isMainFrame || isInPlace) return;
      this.loadState = 'loading'; this.error = ''; this.broadcast();
      clearTimeout(this.failureTimer);
      this.failureTimer = setTimeout(() => { if (this.loadState === 'loading') this.fail('连接超时，请检查网络后重试。'); }, 35_000);
    });
    wc.on('dom-ready', () => {
      // Embedded widgets can keep the load event pending after the chat is usable.
      if (isOfficial(wc.getURL()) && this.loadState !== 'error') {
        clearTimeout(this.failureTimer); this.loadState = 'ready'; this.error = '';
        this.rememberURL(wc.getURL()); this.layout(); this.broadcast();
      }
      this.configurePage(true);
    });
    wc.on('did-finish-load', () => {
      if (this.loadState === 'error') return;
      clearTimeout(this.failureTimer); this.loadState = 'ready'; this.error = '';
      if (isOfficial(wc.getURL())) this.rememberURL(wc.getURL());
      this.configurePage(true); this.layout(); this.broadcast();
    });
    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => { if (isMainFrame && isOfficial(url)) this.rememberURL(url); });
    wc.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3) this.fail(code === -106 ? '网络已断开，请检查连接后重试。' : `页面加载失败（${code}）：${description}`);
    });
    wc.on('render-process-gone', (_event, details) => this.fail(`网页进程已停止（${details.reason}），可重新加载恢复。`));
    wc.on('unresponsive', () => this.notice('网页暂时没有响应，可从菜单重新加载。'));
    wc.on('context-menu', (_event, params) => {
      const items: Electron.MenuItemConstructorOptions[] = [];
      if (params.isEditable) items.push({ role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' });
      else if (params.selectionText) items.push({ role: 'copy', label: '复制' });
      if (params.linkURL && /^https?:/.test(params.linkURL)) items.push({ label: '在浏览器中打开链接', click: () => safeExternal(params.linkURL) });
      if (items.length) Menu.buildFromTemplate(items).popup({ window: this.owner() });
    });
    this.webSession.setPermissionCheckHandler((_wc, permission, origin) => {
      return origin === siteOrigin && ['clipboard-sanitized-write', 'fullscreen'].includes(permission);
    });
    this.webSession.setPermissionRequestHandler(async (contents, permission, callback, details) => {
      if (!isOfficial(details.requestingUrl || contents.getURL())) { callback(false); return; }
      if (['clipboard-sanitized-write', 'fullscreen'].includes(permission)) { callback(true); return; }
      const names: Record<string, string> = { media: '摄像头或麦克风', notifications: '系统通知', 'clipboard-read': '剪贴板内容', geolocation: '位置信息' };
      if (!names[permission]) { callback(false); return; }
      const answer = await dialog.showMessageBox(this.owner(), { type: 'question', title: 'DeepSeek 网页权限', message: `允许 DeepSeek 访问${names[permission]}？`, detail: '仅在本次应用运行期间允许。', buttons: ['不允许', '允许'], defaultId: 0, cancelId: 0 });
      callback(answer.response === 1);
    });
    this.webSession.on('will-download', (_event, item) => {
      item.setSaveDialogOptions({ title: '保存 DeepSeek 文件', defaultPath: item.getFilename() });
      item.once('done', (_event, state) => { if (state !== 'completed' && state !== 'cancelled') this.notice('文件下载失败，请重试。'); });
    });
  }

  private authPopupURL(url: string) {
    try { const u = new URL(url); return u.protocol === 'https:' && ['accounts.deepseek.com', 'open.weixin.qq.com', 'passport.weibo.com', 'appleid.apple.com', 'account.apple.com', 'idmsa.apple.com'].includes(u.hostname); } catch { return false; }
  }

  private rememberURL(url: string) {
    this.lastURL = url;
    const pathname = new URL(url).pathname;
    const lastChatPath = /^\/a\/chat\/s\/[a-z0-9-]+$/i.test(pathname) ? pathname : pathname === '/' ? '' : undefined;
    if (lastChatPath !== undefined && lastChatPath !== this.store.value.lastChatPath) this.store.save({ ...this.store.value, lastChatPath });
  }

  private configureKeys(contents: WebContents) {
    contents.on('before-input-event', (event, input) => {
      const modifier = process.platform === 'darwin' ? input.meta : input.control;
      if (input.type !== 'keyDown' || !modifier || input.alt || input.isComposing || input.isAutoRepeat) return;
      const key = input.key.toLowerCase();
      if (key === 'n' && !input.shift) {
        event.preventDefault(); this.show(); this.pageAction('new-chat');
      } else if (key === 'w' && !input.shift) {
        event.preventDefault();
        if (this.preferences && !this.preferences.isDestroyed() && contents.id === this.preferences.webContents.id) this.preferences.close();
        else this.hide();
      } else if (key === ',' && !input.shift) {
        event.preventDefault(); this.openSettings();
      } else if (key === 'e' && input.shift) {
        event.preventDefault(); this.setMode(this.mode === 'quick' ? 'full' : 'quick');
      }
    });
  }

  private configurePage(focus = false) {
    if (!this.view.webContents.isDestroyed()) this.view.webContents.send('wire:page-config', { quick: this.mode === 'quick' && this.host === 'chat', focus: focus && this.host === 'chat', theme: this.store.value.theme });
  }

  private attach(next: 'chat' | 'login') {
    if (this.host === next && (next === 'chat' ? this.main.contentView.children.includes(this.view) : this.login?.contentView.children.includes(this.view))) return;
    const previous = this.owner();
    if (previous.contentView.children.includes(this.view)) previous.contentView.removeChildView(this.view);
    this.host = next;
    if (next === 'login') {
      if (!this.login || this.login.isDestroyed()) {
        this.login = this.createHost('login', this.fittedBounds({ width: 520, height: 730 }));
        this.login.on('resize', () => this.layout());
        this.login.on('close', event => { if (!quitting) { event.preventDefault(); this.login?.hide(); } });
      }
      this.login.contentView.addChildView(this.view);
      this.main.hide();
      this.login.show();
    } else {
      this.main.contentView.addChildView(this.view);
      this.login?.hide();
      this.main.show();
    }
    this.layout(); this.configurePage(true); this.broadcast();
  }

  private layout() {
    const win = this.owner();
    if (!win || win.isDestroyed()) return;
    const [width, height] = win.getContentSize();
    this.view.setBounds({ x: 0, y: 58, width, height: Math.max(0, height - 58) });
    this.view.setVisible(this.loadState !== 'error');
  }

  private adjustQuickHeight() {
    if (this.host !== 'chat' || this.mode !== 'quick' || !this.store.value.quickAutoSize || this.main.isFullScreen() || this.main.isMaximized()) return;
    const current = this.main.getBounds();
    const area = screen.getDisplayMatching(current).workArea;
    const maximum = Math.max(360, Math.floor(area.height * this.store.value.quickMaxHeightRatio));
    const height = Math.min(maximum, Math.max(360, Math.ceil(this.contentHeight)));
    if (Math.abs(current.height - height) < 3) return;
    this.resizing = true;
    this.main.setBounds({ ...current, height, y: Math.max(area.y, Math.min(current.y, area.y + area.height - height)) });
    this.resizing = false;
    this.layout();
  }

  private fittedBounds(saved: SavedBounds, recenter = false): Electron.Rectangle {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const area = display.workArea;
    const width = Math.min(saved.width, area.width), height = Math.min(saved.height, area.height);
    let x = saved.x ?? Math.round(area.x + (area.width - width) / 2);
    let y = saved.y ?? Math.round(area.y + (area.height - height) / 2);
    const target = screen.getDisplayMatching({ x, y, width, height }).workArea;
    if (recenter || x + width < target.x + 60 || y + height < target.y + 60 || x > target.x + target.width - 60 || y > target.y + target.height - 60) {
      x = Math.round(area.x + (area.width - width) / 2); y = Math.round(area.y + (area.height - height) / 2);
    } else {
      x = Math.max(target.x, Math.min(x, target.x + target.width - width));
      y = Math.max(target.y, Math.min(y, target.y + target.height - height));
    }
    return { x, y, width, height };
  }

  private keepVisible() {
    for (const win of [this.main, this.login]) if (win && !win.isDestroyed()) win.setBounds(this.fittedBounds(win.getBounds()));
  }

  private scheduleBoundsSave() {
    if (this.resizing || this.main.isFullScreen() || this.main.isMaximized()) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveBounds(), 250);
  }
  private saveBounds() {
    if (this.main.isDestroyed() || this.resizing || this.main.isFullScreen() || this.main.isMaximized()) return;
    const key = this.mode === 'quick' ? 'quickBounds' : 'fullBounds';
    this.store.save({ ...this.store.value, [key]: this.main.getBounds() });
  }

  setMode(mode: WindowMode) {
    if (mode === this.mode) return;
    clearTimeout(this.saveTimer); this.saveBounds();
    this.mode = mode; this.resizing = true;
    if (this.main.isFullScreen()) this.main.setFullScreen(false);
    if (this.main.isMaximized()) this.main.unmaximize();
    this.main.setBounds(this.fittedBounds(this.store.value[mode === 'quick' ? 'quickBounds' : 'fullBounds']));
    this.resizing = false; this.layout(); this.configurePage(true); this.adjustQuickHeight(); this.broadcast(); this.buildMenu();
  }

  show(fromShortcut = false) {
    if (fromShortcut && this.host === 'chat' && this.mode !== this.store.value.defaultMode) this.setMode(this.store.value.defaultMode);
    const win = this.owner();
    if (win.isMinimized()) win.restore();
    if (!win.isVisible() || fromShortcut) {
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      const current = screen.getDisplayMatching(win.getBounds());
      if (fromShortcut || current.id !== display.id) win.setBounds(this.fittedBounds(win.getBounds(), true));
    }
    if (process.platform === 'darwin') app.focus({ steal: true });
    win.show(); win.focus(); this.lastForeground = true;
    if (this.host === 'chat') { this.view.webContents.focus(); this.configurePage(true); }
    if (fromShortcut && this.host === 'chat' && this.store.value.summonBehavior === 'new') this.pageAction('new-chat');
    this.broadcast();
  }
  hide() { this.owner().hide(); this.lastForeground = false; this.broadcast(); }
  shortcut() {
    const win = this.owner();
    if (win.isVisible() && win.isFocused()) this.hide();
    else this.show(true);
  }

  private registerShortcut(shortcut: string) {
    try { this.shortcutRegistered = globalShortcut.register(shortcut, () => this.shortcut()); }
    catch { this.shortcutRegistered = false; }
    this.shortcutError = this.shortcutRegistered ? '' : `快捷键 ${shortcut} 无法注册，可能已被其他应用占用。请在设置中更换。`;
  }

  async updateSettings(patch: unknown): Promise<Result> {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, message: '设置无效。' };
    const allowed = ['shortcut', 'theme', 'alwaysOnTop', 'launchAtLogin', 'summonBehavior', 'defaultMode', 'quickAutoSize', 'quickMaxHeightRatio'];
    const changes = Object.fromEntries(Object.entries(patch).filter(([key]) => allowed.includes(key)));
    const old = this.store.value;
    const next = sanitizeSettings({ ...old, ...changes });
    const changingShortcut = 'shortcut' in changes && (next.shortcut !== old.shortcut || !this.shortcutRegistered);
    if (changingShortcut) {
      if (!this.validShortcut(next.shortcut)) return { ok: false, message: '请使用功能键或包含修饰键的组合键。' };
      let registered = false;
      try { registered = globalShortcut.register(next.shortcut, () => this.shortcut()); } catch { /* invalid accelerator */ }
      if (!registered) return { ok: false, message: `快捷键 ${next.shortcut} 已被占用或系统不支持，原快捷键仍然保留。` };
    }
    try {
      if (next.launchAtLogin !== old.launchAtLogin) {
        if (!app.isPackaged && !testing) throw new Error('开机启动需要使用已安装的应用。');
        if (!testing) app.setLoginItemSettings({ openAtLogin: next.launchAtLogin, args: ['--hidden'] });
      }
      this.store.save(next);
    } catch (error) {
      if (changingShortcut) globalShortcut.unregister(next.shortcut);
      return { ok: false, message: `无法保存设置：${(error as Error).message}` };
    }
    if (changingShortcut) {
      if (old.shortcut !== next.shortcut) globalShortcut.unregister(old.shortcut);
      this.shortcutRegistered = true; this.shortcutError = '';
    }
    nativeTheme.themeSource = next.theme;
    this.main.setAlwaysOnTop(next.alwaysOnTop, 'floating');
    this.configurePage(); this.adjustQuickHeight(); this.broadcast(); this.buildMenu();
    return { ok: true, message: changingShortcut ? '快捷键已更新' : '设置已保存' };
  }

  private validShortcut(value: string) {
    return /^(?:(?:CommandOrControl|Command|Control|Alt|Option|Shift|Super)\+)*(?:F(?:[1-9]|1\d|2[0-4])|[A-Z0-9]|Space|Tab|Enter|Backspace|Up|Down|Left|Right)$/i.test(value)
      && (/F\d+$/i.test(value) || /(?:CommandOrControl|Command|Control|Alt|Option|Super)\+/i.test(value));
  }

  private pageAction(name: string) { this.view.webContents.send('wire:page-action', name); }
  async action(name: string): Promise<Result> {
    switch (name) {
      case 'settings': this.openSettings(); break;
      case 'toggle-mode': this.setMode(this.mode === 'quick' ? 'full' : 'quick'); break;
      case 'new-chat': this.show(); this.pageAction('new-chat'); break;
      case 'sidebar': this.pageAction('toggle-sidebar'); break;
      case 'hide': this.hide(); break;
      case 'pin': return this.updateSettings({ alwaysOnTop: !this.store.value.alwaysOnTop });
      case 'retry': await this.navigate(this.lastURL || website); break;
      case 'reload': await this.navigate(this.view.webContents.getURL() || website); break;
      case 'website': safeExternal(website); break;
      case 'quit': app.quit(); break;
      default: return { ok: false, message: '未知操作。' };
    }
    return { ok: true };
  }

  openSettings() {
    if (this.preferences && !this.preferences.isDestroyed()) { this.preferences.show(); this.preferences.focus(); return; }
    this.preferences = new BrowserWindow({ width: 640, height: 740, minWidth: 540, minHeight: 580, show: false, resizable: true,
      title: 'ChatDeepSeek 设置', titleBarStyle: process.platform === 'win32' ? 'hidden' : 'hiddenInset', trafficLightPosition: { x: 17, y: 20 },
      ...(process.platform === 'win32' ? { titleBarOverlay: this.overlayOptions() } : {}),
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#15171b' : '#f7f8fb',
      webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
    });
    void this.preferences.loadFile(localPage('settings'));
    this.configureKeys(this.preferences.webContents);
    this.preferences.once('ready-to-show', () => { this.preferences?.show(); this.preferences?.focus(); });
    this.preferences.webContents.on('will-navigate', event => event.preventDefault());
    this.preferences.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  }

  async navigate(url: string) {
    if (!isOfficial(url)) return;
    try { await this.view.webContents.loadURL(url); } catch { /* did-fail-load renders a recoverable state */ }
  }
  private fail(message: string) {
    clearTimeout(this.failureTimer); this.loadState = 'error'; this.error = message; this.layout(); this.broadcast();
  }
  private notice(message: string) { for (const win of this.windows()) win.webContents.send('wire:notice', message); }
  state(): AppState {
    return { settings: this.store.value, mode: this.mode, host: this.host, loadState: this.loadState, error: this.error,
      shortcutRegistered: this.shortcutRegistered, shortcutError: this.shortcutError,
      settingsWarning: this.store.warning, sidebarCollapsed: this.sidebarCollapsed, version: app.getVersion(), packaged: app.isPackaged, testing, platform: process.platform };
  }
  broadcast() { for (const win of this.windows()) win.webContents.send('wire:state', this.state()); }

  buildMenu() {
    const template: Electron.MenuItemConstructorOptions[] = [
      { label: 'ChatDeepSeek', submenu: [
        { role: 'about', label: '关于 ChatDeepSeek' }, { type: 'separator' },
        { label: '设置…', accelerator: 'CommandOrControl+,', click: () => this.openSettings() },
        { type: 'separator' }, { role: 'hide', label: '隐藏 ChatDeepSeek' }, { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '显示全部' }, { type: 'separator' }, { role: 'quit', label: '退出 ChatDeepSeek' },
      ] },
      { label: '对话', submenu: [
        { label: '新对话', accelerator: 'CommandOrControl+N', click: () => { this.show(); this.pageAction('new-chat'); } },
        { label: '显示窗口', click: () => this.show() },
        { label: this.mode === 'quick' ? '展开窗口' : '切换到快捷窗口', accelerator: 'CommandOrControl+Shift+E', click: () => this.setMode(this.mode === 'quick' ? 'full' : 'quick') },
        { label: '收起窗口', accelerator: 'CommandOrControl+W', click: () => this.hide() },
      ] },
      { label: '编辑', submenu: [ { role: 'undo', label: '撤销' }, { role: 'redo', label: '重做' }, { type: 'separator' }, { role: 'cut', label: '剪切' }, { role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' } ] },
      { label: '显示', submenu: [
        { label: '重新加载', accelerator: 'CommandOrControl+R', click: () => void this.action('reload') },
        { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' },
        { role: 'togglefullscreen', label: '进入/退出全屏' },
      ] },
      { label: '帮助', submenu: [ { label: '打开 DeepSeek 官网', click: () => safeExternal('https://chat.deepseek.com/') } ] },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    tray?.setContextMenu(Menu.buildFromTemplate([
      { label: '打开 ChatDeepSeek', click: () => this.show() },
      { label: '新对话', click: () => { this.show(); this.pageAction('new-chat'); } },
      { label: `快捷键：${this.store.value.shortcut}${this.shortcutRegistered ? '' : '（不可用）'}`, enabled: false },
      { type: 'separator' }, { label: '设置…', click: () => this.openSettings() }, { label: '退出', click: () => app.quit() },
    ]));
  }

  async shutdown() {
    clearTimeout(this.saveTimer); clearTimeout(this.failureTimer); this.saveBounds();
    globalShortcut.unregisterAll();
    this.webSession.flushStorageData();
    await this.webSession.cookies.flushStore();
  }

  testAPI() {
    return {
      state: () => ({ ...this.state(), visible: this.owner().isVisible(), alwaysOnTop: this.main.isAlwaysOnTop(), pageId: this.view.webContents.id, bounds: this.main.getBounds(), focused: this.owner().isFocused() }),
      action: async (name: string, value?: unknown) => {
        if (name === 'shortcut') { this.shortcut(); return; }
        if (name === 'close') { this.main.close(); return; }
        if (name === 'show') { this.show(); return; }
        if (name === 'hide') { this.hide(); return; }
        if (name === 'navigate') { await this.navigate(value as string); return; }
        if (name === 'occupyShortcut') { return globalShortcut.register(value as string, () => {}); }
        return this.action(name);
      },
      untrustedIPC: () => this.trusted({ sender: this.view.webContents, senderFrame: this.view.webContents.mainFrame } as IpcMainInvokeEvent),
    };
  }
}

if (hasLock) {
  app.whenReady().then(() => {
    const trayIcon = nativeImage.createFromPath(path.join(projectRoot, process.platform === 'darwin' ? 'assets/trayTemplate.png' : 'assets/icon.png')).resize({ width: process.platform === 'darwin' ? 18 : 20, height: process.platform === 'darwin' ? 18 : 20 });
    if (!trayIcon.isEmpty()) { if (process.platform === 'darwin') trayIcon.setTemplateImage(true); tray = new Tray(trayIcon); tray.setToolTip('ChatDeepSeek'); }
    controller = new Desktop();
    tray?.on('click', () => controller.show());
    app.setAboutPanelOptions({ applicationName: 'ChatDeepSeek', applicationVersion: app.getVersion(), copyright: '独立桌面客户端 · 非 DeepSeek 官方应用', website: 'https://chat.deepseek.com/' });
    const icon = nativeImage.createFromPath(path.join(projectRoot, 'assets/icon.png'));
    if (!icon.isEmpty()) app.dock?.setIcon(icon);
    if (testing) (globalThis as any).__wireTest = controller.testAPI();
    if (process.argv.includes('--hidden')) { setTimeout(() => controller.hide(), 800); }
  }).catch(error => { console.error(error); app.quit(); });
  app.on('second-instance', () => controller?.show());
  app.on('activate', () => controller?.show());
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault(); quitting = true;
    void (controller ? controller.shutdown() : Promise.resolve()).catch(console.error).finally(() => app.quit());
  });
  app.on('window-all-closed', () => { /* the menu bar companion remains running */ });
}
