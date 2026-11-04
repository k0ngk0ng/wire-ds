import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startFixture } from './fixture';

const root = path.resolve(__dirname, '..');
let service: Awaited<ReturnType<typeof startFixture>>;
let desktop: ElectronApplication;
let shell: Page;
let web: Page;
let dataDir: string;

async function launch(name: string, existing = false) {
  dataDir = path.join(root, '.runtime', 'tests', name);
  if (!existing) await rm(dataDir, { recursive: true, force: true });
  await mkdir(dataDir, { recursive: true });
  desktop = await electron.launch({
    args: [path.join(root, 'dist/main/main.js')],
    colorScheme: null,
    chromiumSandbox: true,
    artifactsDir: path.join(root, 'artifacts', 'electron'),
    env: { ...process.env, WIRE_DS_TEST: '1', WIRE_DS_TEST_URL: service.url, WIRE_DS_DATA_DIR: dataDir, WIRE_DS_TEST_SHORTCUT: 'F6', TMPDIR: path.join(root, '.cache/tmp') },
    timeout: 30_000,
  });
  // BrowserWindow and WebContentsView targets can arrive in different orders on CI.
  // Select the shell by its actual document rather than assuming the first target.
  await expect.poll(() => desktop.windows().some(p => /\/shell\.html$/.test(p.url())), { timeout: 20_000 }).toBe(true);
  shell = desktop.windows().find(p => /\/shell\.html$/.test(p.url()))!;
  await shell.waitForLoadState('domcontentloaded');
  await expect.poll(async () => desktop.windows().some(p => p.url().startsWith(service.url))).toBe(true);
  web = desktop.windows().find(p => p.url().startsWith(service.url))!;
  await web.waitForLoadState('domcontentloaded');
}

async function state() { return desktop.evaluate(() => (globalThis as any).__wireTest.state()); }
async function action(name: string, value?: unknown) { return desktop.evaluate((_electron, { name, value }) => (globalThis as any).__wireTest.action(name, value), { name, value }); }
async function signIn() {
  await web.getByRole('button', { name: '登录', exact: true }).click();
  await expect.poll(async () => (await state()).host).toBe('chat');
}
async function settings() {
  await shell.getByRole('button', { name: '设置', exact: true }).click();
  await expect.poll(() => desktop.windows().some(p => /settings\.html/.test(p.url()))).toBe(true);
  return desktop.windows().find(p => /settings\.html/.test(p.url()))!;
}

test.beforeAll(async () => { service = await startFixture(); await mkdir(path.join(root, '.cache/tmp'), { recursive: true }); });
test.afterAll(async () => { await service.close(); });
test.afterEach(async ({}, info) => {
  if (desktop) {
    await info.attach('desktop-state', { body: JSON.stringify(await state().catch(() => ({ unavailable: true })), null, 2), contentType: 'application/json' });
    for (const [i, page] of desktop.windows().entries()) {
      const visible = !page.isClosed() && await page.evaluate(() => document.visibilityState === 'visible').catch(() => false);
      if (visible) await page.screenshot({ path: info.outputPath(`window-${i}.png`), timeout: 2000 }).catch(() => {});
    }
    await desktop.close().catch(() => {});
  }
});

test('官方登录独立承载，认证成功与过期时保持同一个网页实例', async () => {
  await launch('authentication');
  await expect.poll(async () => (await state()).host).toBe('login');
  const instance = await web.evaluate(() => (window as any).instanceId);
  expect(await web.evaluate(() => ({ node: typeof (window as any).require, bridge: typeof (window as any).wire }))).toEqual({ node: 'undefined', bridge: 'undefined' });
  await signIn();
  expect(await web.evaluate(() => (window as any).instanceId)).toBe(instance);
  await shell.getByRole('button', { name: '展开侧边栏' }).click();
  await web.getByRole('button', { name: '退出登录' }).click();
  await expect.poll(async () => (await state()).host).toBe('login');
  expect(await web.evaluate(() => (window as any).instanceId)).toBe(instance);
});

test('快速/完整窗口保留草稿、生成状态与网页实例，并可收起重开', async () => {
  await launch('window-modes'); await signIn();
  const instance = await web.evaluate(() => (window as any).instanceId);
  await web.getByRole('textbox', { name: '给 DeepSeek 发送消息' }).fill('保留这段中文草稿');
  await web.getByRole('button', { name: '发送', exact: true }).click();
  await shell.getByRole('button', { name: '展开窗口' }).click();
  await expect.poll(async () => (await state()).mode).toBe('full');
  await expect(web.getByRole('textbox', { name: '给 DeepSeek 发送消息' })).toHaveValue('保留这段中文草稿');
  expect(await web.evaluate(() => (window as any).instanceId)).toBe(instance);
  await expect(web.locator('#messages')).toContainText('回答片段 回答片段 回答片段');
  await shell.getByRole('button', { name: '切换到快捷窗口' }).click();
  await expect.poll(async () => (await state()).mode).toBe('quick');
  // CDP focus does not activate an OS window. Close through the real lifecycle,
  // then exercise the global-shortcut callback from a hidden background state.
  // Foreground F2 toggling is checked separately with native keyboard input.
  await action('close');
  await expect.poll(async () => (await state()).visible).toBe(false);
  await action('shortcut');
  await expect.poll(async () => (await state()).visible).toBe(true);
  expect(await web.evaluate(() => (window as any).instanceId)).toBe(instance);
  await expect(web.getByRole('textbox', { name: '给 DeepSeek 发送消息' })).toBeFocused();
});

test('配置快捷键即时注册；无效或冲突快捷键保留旧值；偏好重启持久化', async () => {
  await launch('preferences'); await signIn();
  const prefs = await settings();
  await prefs.getByRole('button', { name: '录制快捷键' }).click();
  await prefs.keyboard.press('Control+Alt+k');
  await prefs.getByRole('button', { name: '保存快捷键' }).click();
  await expect(prefs.getByRole('status')).toContainText('快捷键已更新');
  expect((await state()).shortcutRegistered).toBe(true);
  expect((await state()).settings.shortcut).toBe('Control+Alt+K');
  await action('occupyShortcut', 'F8');
  await prefs.getByRole('button', { name: '录制快捷键' }).click(); await prefs.keyboard.press('F8');
  await prefs.getByRole('button', { name: '保存快捷键' }).click();
  await expect(prefs.getByRole('alert')).toContainText('占用');
  expect((await state()).settings.shortcut).toBe('Control+Alt+K');
  await prefs.getByLabel('主题').selectOption('dark');
  await prefs.getByLabel('始终置顶').check();
  await prefs.getByLabel('呼出时').selectOption('new');
  await expect.poll(async () => (await state()).settings.theme).toBe('dark');
  expect((await state()).alwaysOnTop).toBe(true);
  await desktop.close();
  await launch('preferences', true);
  await expect.poll(async () => (await state()).host).toBe('chat');
  expect((await state()).settings).toMatchObject({ shortcut: 'Control+Alt+K', theme: 'dark', alwaysOnTop: true, summonBehavior: 'new' });
  expect(await web.evaluate(() => document.cookie)).toContain('fixtureSession=active');
  expect(await web.evaluate(() => localStorage.getItem('logged'))).toBe('yes');
});

test('Esc 优先交给网页弹层，第二次才收起；组合输入时不收起', async () => {
  await launch('escape'); await signIn();
  await web.getByRole('button', { name: '打开弹层' }).click();
  await web.keyboard.press('Escape');
  await expect(web.locator('dialog')).not.toBeVisible();
  expect((await state()).visible).toBe(true);
  await web.getByRole('textbox', { name: '给 DeepSeek 发送消息' }).focus();
  await web.evaluate(() => document.activeElement!.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
  await web.keyboard.press('Escape');
  expect((await state()).visible).toBe(true);
  await web.evaluate(() => document.activeElement!.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  await web.keyboard.press('Escape');
  await expect.poll(async () => (await state()).visible).toBe(false);
});

test('关闭后驻留、菜单操作重开，新对话遵从偏好，侧边栏可展开', async () => {
  await launch('lifecycle'); await signIn();
  await shell.getByRole('button', { name: '展开侧边栏' }).click();
  await expect(web.getByRole('complementary', { name: '历史对话' })).toBeVisible();
  await web.getByRole('textbox', { name: '给 DeepSeek 发送消息' }).fill('草稿');
  await shell.getByRole('button', { name: '新对话', exact: true }).click();
  await expect(web.getByRole('textbox', { name: '给 DeepSeek 发送消息' })).toHaveValue('');
  await action('close');
  expect((await state()).visible).toBe(false);
  await action('show');
  expect((await state()).visible).toBe(true);
  const prefs = await settings(); await prefs.getByLabel('呼出时').selectOption('new');
  await expect.poll(async () => (await state()).settings.summonBehavior).toBe('new');
  const before = await web.evaluate(() => (window as any).newCount);
  await action('hide'); await action('shortcut');
  await expect.poll(() => web.evaluate(() => (window as any).newCount)).toBe(before + 1);
});

test('请求失败后显示重试并恢复，损坏设置不阻止启动', async () => {
  await launch('recovery'); await signIn();
  await action('navigate', `${service.url}/unavailable`);
  await expect(shell.getByRole('heading', { name: '暂时无法连接 DeepSeek' })).toBeVisible();
  await shell.getByRole('button', { name: '重试', exact: true }).click();
  await expect.poll(async () => (await state()).loadState).toBe('ready');
  await desktop.close();
  await writeFile(path.join(dataDir, 'settings.json'), '{invalid json');
  await launch('recovery', true);
  expect((await state()).settings.shortcut).toBe('F6');
  await expect.poll(async () => (await state()).settingsWarning).toContain('设置');
  expect(JSON.parse(await readFile(path.join(dataDir, 'settings.json'), 'utf8')).shortcut).toBe('F6');
});

test('设置桥拒绝网页来源、无适配元素仍能完整展示原网页', async () => {
  await launch('security'); await signIn();
  expect(await desktop.evaluate(() => (globalThis as any).__wireTest.untrustedIPC())).toBe(false);
  await web.evaluate(() => { document.body.innerHTML = '<main><h1>官网新布局</h1><input aria-label="新版输入框"></main>'; });
  await shell.getByRole('button', { name: '展开窗口' }).click();
  await expect(web.getByRole('heading', { name: '官网新布局' })).toBeVisible();
  await expect(web.getByRole('textbox', { name: '新版输入框' })).toBeVisible();
});

test('跟随深色系统时窗口主体与文字、设置和网页媒体查询一致，浅色可独立切换', async () => {
  await launch('appearance'); await signIn();
  await desktop.evaluate(({ nativeTheme }) => { nativeTheme.themeSource = 'dark'; });
  await expect.poll(() => shell.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(23, 25, 30)');
  await expect.poll(() => web.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(true);
  const prefs = await settings();
  await expect.poll(() => prefs.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(18, 20, 25)');
  await prefs.getByLabel('主题').selectOption('light');
  await expect.poll(() => shell.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(255, 255, 255)');
  await expect.poll(() => web.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)).toBe(false);
  await prefs.getByLabel('主题').selectOption('dark');
  await expect.poll(() => shell.evaluate(() => getComputedStyle(document.querySelector('.brand')!).color)).toBe('rgb(216, 221, 232)');
});

test('官网无文字标签的侧边栏和新对话图标仍可从壳层操作', async () => {
  await launch('official-controls'); await signIn();
  await shell.getByRole('button', { name: '展开侧边栏' }).click();
  await web.evaluate(() => {
    const toggle = document.querySelector('#sidebar-toggle')!;
    toggle.removeAttribute('aria-label');
    toggle.innerHTML = '<svg><path d="M9.67272 0.522841C10 0 11 1 12 2"></path></svg>';
    const button = document.querySelector('#new')!;
    button.innerHTML = '<svg><path d="M8 0.599609C3.91309 0.599609 0.599609 3.91309 0.599609 8"></path></svg>';
  });
  await web.getByRole('textbox', { name: '给 DeepSeek 发送消息' }).fill('测试草稿');
  await shell.getByRole('button', { name: '新对话', exact: true }).click();
  await expect(web.getByRole('textbox', { name: '给 DeepSeek 发送消息' })).toHaveValue('');
  await shell.getByRole('button', { name: '收起侧边栏' }).click();
  await expect(web.getByRole('complementary')).not.toBeVisible();
});

test('第三方组件持续加载不遮挡可用聊天，重复启动只保留现有实例', async () => {
  await launch('single-instance'); await signIn();
  await web.evaluate(url => { const frame = document.createElement('iframe'); frame.src = `${url}/pending-widget`; document.body.append(frame); }, service.url);
  await expect.poll(async () => (await state()).loadState).toBe('ready');
  const child = spawn(require('electron'), [path.join(root, 'dist/main/main.js')], { env: {
    ...process.env, WIRE_DS_TEST: '1', WIRE_DS_TEST_URL: service.url, WIRE_DS_DATA_DIR: dataDir,
    WIRE_DS_TEST_SHORTCUT: 'F6', TMPDIR: path.join(root, '.cache/tmp'),
  }, stdio: 'ignore' });
  const code = await new Promise<number | null>((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
  expect(code).toBe(0);
  expect((await state()).visible).toBe(true);
  await expect(web.getByRole('textbox', { name: '给 DeepSeek 发送消息' })).toBeVisible();
});

test('Cmd+N / Ctrl+N 触发官网新对话，快捷和完整窗口均聚焦输入框', async () => {
  await launch('new-chat-keyboard'); await signIn();
  const input = web.getByRole('textbox', { name: '给 DeepSeek 发送消息' });
  const shortcut = process.platform === 'darwin' ? 'Meta+n' : 'Control+n';
  for (const mode of ['quick', 'full']) {
    if (mode === 'full') await shell.getByRole('button', { name: '展开窗口' }).click();
    await input.fill(`测试 ${mode} 草稿`);
    const count = await web.evaluate(() => (window as any).newCount);
    await web.keyboard.press(shortcut);
    await expect(input).toHaveValue('');
    await expect.poll(() => web.evaluate(() => (window as any).newCount)).toBe(count + 1);
    await expect(input).toBeFocused();
  }
  await web.keyboard.press(process.platform === 'darwin' ? 'Meta+w' : 'Control+w');
  await expect.poll(async () => (await state()).visible).toBe(false);
  await action('show');
  await expect(input).toBeVisible();
});

test('快捷窗口从 360 高度随对话长高，到屏幕上限后滚动，新对话恢复紧凑', async () => {
  await launch('adaptive-height'); await signIn();
  await expect.poll(async () => (await state()).bounds.height).toBe(360);
  await web.evaluate(() => {
    const area = document.querySelector('#messages')!;
    for (let i = 0; i < 24; i++) { const line = document.createElement('p'); line.textContent = '这是一段用于验证窗口自适应高度的对话内容。'; area.append(line); }
  });
  await expect.poll(async () => (await state()).bounds.height).toBeGreaterThan(360);
  const maximum = await desktop.evaluate(({ screen, BrowserWindow }) => Math.floor(screen.getDisplayMatching(BrowserWindow.getAllWindows()[0].getBounds()).workArea.height * .8));
  expect((await state()).bounds.height).toBeLessThanOrEqual(maximum);
  await shell.getByRole('button', { name: '展开窗口' }).click();
  const fullHeight = (await state()).bounds.height;
  await shell.getByRole('button', { name: '新对话', exact: true }).click();
  expect((await state()).bounds.height).toBe(fullHeight);
  await shell.getByRole('button', { name: '切换到快捷窗口' }).click();
  await expect.poll(async () => (await state()).bounds.height).toBe(360);
});

test('退出重启后继续上次会话，不只保留账号登录', async () => {
  await launch('restore-conversation'); await signIn();
  await web.evaluate(() => history.pushState({}, '', '/a/chat/s/fixture-conversation'));
  await expect.poll(async () => (await state()).settings.lastChatPath).toBe('/a/chat/s/fixture-conversation');
  await desktop.close();
  await launch('restore-conversation', true);
  await expect(web).toHaveURL(`${service.url}/a/chat/s/fixture-conversation`);
  await expect.poll(async () => (await state()).host).toBe('chat');
});

test('应用与设置统一显示 ChatDeepSeek，保留稳定应用标识', async () => {
  await launch('application-name'); await signIn();
  expect(await desktop.evaluate(({ app }) => app.getName())).toBe('ChatDeepSeek');
  expect(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => /shell\.html$/.test(w.webContents.getURL()))!.getTitle())).toBe('ChatDeepSeek');
  const prefs = await settings();
  await expect(prefs.getByRole('heading', { name: 'ChatDeepSeek', exact: true })).toBeVisible();
  expect(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).build.appId).toBe('com.wire.deepseek');
});
