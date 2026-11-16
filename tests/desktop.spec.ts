import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startFixture } from './fixture';
import { startUpdateFixture } from './update-fixture';

const root = path.resolve(__dirname, '..');
let service: Awaited<ReturnType<typeof startFixture>>;
let releases: Awaited<ReturnType<typeof startUpdateFixture>>;
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
    env: { ...process.env, WIRE_DS_TEST: '1', WIRE_DS_TEST_URL: service.url, WIRE_DS_TEST_UPDATE_URL: `${releases.url}/latest`, WIRE_DS_DATA_DIR: dataDir, WIRE_DS_TEST_SHORTCUT: 'F6', TMPDIR: path.join(root, '.cache/tmp') },
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
  const authenticated = await web.evaluate(() => localStorage.getItem('logged') === 'yes');
  await expect.poll(async () => (await state()).host).toBe(authenticated ? 'chat' : 'login');
}

async function state() { return desktop.evaluate(() => (globalThis as any).__wireTest.state()); }
async function action(name: string, value?: unknown) { return desktop.evaluate((_electron, { name, value }) => (globalThis as any).__wireTest.action(name, value), { name, value }); }
async function signIn() {
  await web.getByRole('button', { name: '登录', exact: true }).click();
  await expect.poll(async () => (await state()).host).toBe('chat');
}
async function settings() {
  const documentPath = (await state()).host === 'login' ? '/login.html' : '/shell.html';
  await expect.poll(() => desktop.windows().some(p => p.url().endsWith(documentPath))).toBe(true);
  const host = desktop.windows().find(p => p.url().endsWith(documentPath))!;
  await host.getByRole('button', { name: '设置', exact: true }).click();
  await expect.poll(() => desktop.windows().some(p => /settings\.html/.test(p.url()))).toBe(true);
  return desktop.windows().find(p => /settings\.html/.test(p.url()))!;
}

test.beforeAll(async () => { service = await startFixture(); releases = await startUpdateFixture(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version); await mkdir(path.join(root, '.cache/tmp'), { recursive: true }); });
test.beforeEach(() => releases.reset());
test.afterAll(async () => { await service.close(); await releases.close(); });
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

test('新对话根据 ARIA 名称、提示和同源链接识别，不依赖图标和类名', async () => {
  await launch('new-chat-semantics'); await signIn();
  const input = web.getByRole('textbox', { name: '给 DeepSeek 发送消息' });
  for (const source of ['aria-labelledby', 'aria-describedby', 'data-tooltip', 'data-testid', 'link']) {
    await web.evaluate(source => {
      document.querySelector('#new')?.remove();
      document.querySelector('#mobile-new')?.remove();
      document.querySelector('#semantic-new')?.remove();
      document.querySelector('#new-label')?.remove();
      document.querySelector('#new-label-suffix')?.remove();
      const main = document.querySelector('main')!;
      const wrapper = document.createElement('div');
      wrapper.tabIndex = 0;
      wrapper.id = 'semantic-new';
      const button = document.createElement(source === 'link' ? 'a' : 'button');
      button.innerHTML = '<svg width="20" height="20"><path d="M1 1L18 18"/></svg>';
      if (source === 'link') {
        button.setAttribute('href', '/');
      } else if (source === 'data-tooltip') {
        button.setAttribute(source, 'Start a new conversation (⌘ N)');
      } else if (source === 'data-testid') {
        button.setAttribute(source, 'create-conversation-button');
      } else {
        const label = document.createElement('span');
        label.id = 'new-label';
        label.hidden = true;
        label.textContent = 'Start a new';
        const suffix = document.createElement('span');
        suffix.id = 'new-label-suffix';
        suffix.hidden = true;
        suffix.textContent = 'conversation';
        main.append(label);
        main.append(suffix);
        button.setAttribute(source, `${label.id} ${suffix.id}`);
      }
      button.addEventListener('click', event => {
        event.preventDefault();
        (window as any).newCount++;
        document.querySelector('textarea')!.value = '';
        history.pushState({}, '', '/');
      });
      wrapper.append(button);
      main.prepend(wrapper);
      history.pushState({}, '', '/a/chat/s/semantic-conversation');
    }, source);
    await input.fill(`验证 ${source}`);
    const count = await web.evaluate(() => (window as any).newCount);
    await web.keyboard.press(process.platform === 'darwin' ? 'Meta+n' : 'Control+n');
    await expect(input).toHaveValue('');
    await expect(web).toHaveURL(`${service.url}/`);
    expect(await web.evaluate(() => (window as any).newCount)).toBe(count + 1);
    await expect(input).toBeFocused();
  }
});

test('官网改版没有可识别的新对话入口时回到首页，跳过无效控件并保留登录', async () => {
  await launch('new-chat-route-fallback'); await signIn();
  for (const mode of ['quick', 'full']) {
    if (mode === 'full') await shell.getByRole('button', { name: '展开窗口' }).click();
    await web.evaluate(() => {
      history.pushState({}, '', '/a/chat/s/redesigned-conversation');
      const button = document.querySelector('#mobile-new')!;
      button.removeAttribute('aria-label');
      button.innerHTML = '<svg width="20" height="20"><path d="M1 1L18 18"/></svg>';
      document.querySelector('#new')?.remove();
      const main = document.querySelector('main')!;
      main.insertAdjacentHTML('afterbegin', '<button hidden>New chat</button><button disabled>New chat</button><div role="button" aria-disabled="true">New chat</div><a href="https://example.com/">New chat</a><button>删除新对话</button>');
      document.querySelector('#messages')!.innerHTML = '<div tabindex="0"><button>New chat</button><a href="/">New chat</a></div>';
      localStorage.removeItem('unexpectedNewChatClick');
      for (const control of main.querySelectorAll('button, a, [role="button"]')) {
        if (control === button) continue;
        control.addEventListener('click', event => { event.preventDefault(); localStorage.setItem('unexpectedNewChatClick', 'yes'); });
      }
    });
    await web.getByRole('textbox', { name: '给 DeepSeek 发送消息' }).fill('改版后的草稿');
    await web.keyboard.press(process.platform === 'darwin' ? 'Meta+n' : 'Control+n');
    await expect(web).toHaveURL(`${service.url}/`);
    await expect(web.getByRole('textbox', { name: '给 DeepSeek 发送消息' })).toHaveValue('');
    await expect(web.getByRole('textbox', { name: '给 DeepSeek 发送消息' })).toBeFocused();
    expect(await web.evaluate(() => localStorage.getItem('unexpectedNewChatClick'))).toBeNull();
    expect(await web.evaluate(() => localStorage.getItem('logged'))).toBe('yes');
    expect(await web.evaluate(() => document.cookie)).toContain('fixtureSession=active');
  }
});

test('新对话按钮失效后自动回到首页，首页与登录页不重复刷新', async () => {
  await launch('new-chat-inactive-control'); await signIn();
  await web.evaluate(() => {
    history.pushState({}, '', '/a/chat/s/inactive-control');
    document.querySelector('#mobile-new')!.replaceWith(document.querySelector('#mobile-new')!.cloneNode(true));
  });
  await web.keyboard.press(process.platform === 'darwin' ? 'Meta+n' : 'Control+n');
  await expect(web).toHaveURL(`${service.url}/`);
  await web.evaluate(() => {
    document.querySelector('#new')?.remove();
    document.querySelector('#mobile-new')?.remove();
  });
  const instance = await web.evaluate(() => (window as any).instanceId);
  await web.keyboard.press(process.platform === 'darwin' ? 'Meta+n' : 'Control+n');
  await expect(web.getByRole('textbox', { name: '给 DeepSeek 发送消息' })).toBeFocused();
  await expect.poll(() => web.evaluate(() => (window as any).instanceId)).toBe(instance);
  await shell.getByRole('button', { name: '展开侧边栏' }).click();
  await web.getByRole('button', { name: '退出登录' }).click();
  await expect.poll(async () => (await state()).host).toBe('login');
  await web.keyboard.press(process.platform === 'darwin' ? 'Meta+n' : 'Control+n');
  await expect(web.getByRole('button', { name: '登录', exact: true })).toBeVisible();
  expect(await web.evaluate(() => (window as any).instanceId)).toBe(instance);
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

test('Thinking 出现时只点击一次折叠，每次提问生效，手动展开后保持展开', async () => {
  await launch('thinking-stream'); await signIn();
  await web.evaluate(() => { (window as any).thinkingMode = 'streaming'; });
  await web.getByRole('button', { name: '发送', exact: true }).click();
  const first = web.locator('[data-virtual-list-item-key="0"]');
  await expect(first.locator('.thinking-title')).toBeVisible();
  await expect(first.locator('.ds-think-content')).toHaveCount(0);
  expect(await web.evaluate(() => (window as any).thoughts[0].clicks)).toBe(1);
  await first.locator('.thinking-toggle').click();
  await expect(first.locator('.ds-think-content')).toBeVisible();
  await expect(first).toHaveAttribute('data-complete', 'true');
  await expect(first.locator('.ds-think-content')).toBeVisible();
  expect(await web.evaluate(() => (window as any).thoughts[0].clicks)).toBe(2);
  await expect(first.locator('.ds-assistant-message-main-content')).toContainText('回答片段 回答片段');
  await web.getByRole('button', { name: '发送', exact: true }).click();
  const second = web.locator('[data-virtual-list-item-key="1"]');
  await expect(second.locator('.thinking-title')).toBeVisible();
  await expect(second.locator('.ds-think-content')).toHaveCount(0);
  expect(await web.evaluate(() => (window as any).thoughts[1].clicks)).toBe(1);
});

test('官网已折叠的 Thinking 保持原状态，用户可展开；普通回答中的 Thinking 文本不受影响', async () => {
  await launch('thinking-collapsed'); await signIn();
  await web.evaluate(() => { (window as any).thinkingMode = 'collapsed'; });
  await web.getByRole('button', { name: '发送', exact: true }).click();
  const row = web.locator('[data-virtual-list-item-key="0"]');
  await expect(row).toHaveAttribute('data-complete', 'true');
  expect(await web.evaluate(() => (window as any).thoughts[0].clicks)).toBe(0);
  await row.locator('.thinking-toggle').click();
  await expect(row.locator('.ds-think-content')).toBeVisible();
  await web.evaluate(() => {
    const text = document.createElement('div'); text.className = 'ds-message';
    text.innerHTML = '<p class="ds-markdown">Thinking is part of this ordinary answer.</p>';
    document.querySelector('#messages')!.append(text);
    (window as any).thoughts[0].title.textContent = '已深度思考（用时 2 秒）';
  });
  await expect(row.locator('.thinking-title')).toContainText('已深度思考');
  await web.getByRole('button', { name: '发送', exact: true }).click();
  await expect(web.locator('[data-virtual-list-item-key="1"]')).toHaveAttribute('data-complete', 'true');
  expect(await web.evaluate(() => (window as any).thoughts[0].clicks)).toBe(1);
  await expect(row.locator('.ds-think-content')).toBeVisible();
  await expect(web.getByText('Thinking is part of this ordinary answer.', { exact: true })).toBeVisible();
});

test('快捷键呼出后等待输入框挂载并 focus，不模拟鼠标点击', async () => {
  await launch('focus-late-composer'); await signIn();
  const input = web.getByRole('textbox', { name: '给 DeepSeek 发送消息' });
  await expect(input).toBeFocused();
  await web.evaluate(() => {
    (window as any).inputClicks = 0;
    (window as any).savedComposer = document.querySelector('textarea');
    (window as any).savedComposer.addEventListener('mousedown', (event: MouseEvent) => { if (event.isTrusted) (window as any).inputClicks++; });
    (window as any).savedComposer.remove();
  });
  await action('hide'); await action('shortcut');
  await expect.poll(async () => (await state()).visible).toBe(true);
  await web.evaluate(() => document.querySelector('main')!.append((window as any).savedComposer));
  await expect(input).toBeFocused();
  expect(await web.evaluate(() => (window as any).inputClicks)).toBe(0);
  await web.keyboard.type('直接输入');
  await expect(input).toHaveValue('直接输入');
});

test('呼出后用户选择其他输入框或打开网页弹层时尊重焦点，后台刷新不抢焦点', async () => {
  await launch('focus-user-intent'); await signIn();
  await action('hide'); await action('shortcut');
  const input = web.getByRole('textbox', { name: '给 DeepSeek 发送消息' });
  await expect(input).toBeFocused();
  await web.evaluate(() => {
    const search = document.createElement('input'); search.setAttribute('aria-label', '网页搜索');
    document.querySelector('main')!.append(search);
  });
  const search = web.getByRole('textbox', { name: '网页搜索' });
  await search.click(); await search.fill('保留搜索焦点');
  await web.evaluate(() => { const input = document.querySelector('textarea')!; input.replaceWith(input.cloneNode(true)); });
  await expect(search).toBeFocused();
  await web.getByRole('button', { name: '打开弹层' }).click();
  await expect(web.getByRole('button', { name: '关闭', exact: true })).toBeFocused();
  await action('hide');
  await web.reload({ waitUntil: 'domcontentloaded' });
  await expect.poll(async () => (await state()).loadState).toBe('ready');
  await expect.poll(async () => (await state()).visible).toBe(false);
  await expect(input).not.toBeFocused();
});

test('从 GitHub Release 检查更新，匹配平台下载并校验后交给系统安装', async () => {
  await launch('updates-download'); await signIn();
  expect((await state()).version).toBe(JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version);
  const prefs = await settings();
  await prefs.getByRole('button', { name: '检查更新', exact: true }).click();
  await expect(prefs.locator('#update-status')).toContainText('9.10.0');
  expect(await desktop.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items.some(item => item.submenu?.items.some(child => child.label === '检查更新…')))).toBe(true);
  await prefs.getByRole('button', { name: '下载更新', exact: true }).click();
  await expect(prefs.getByRole('progressbar', { name: '更新下载进度' })).toBeVisible();
  await expect(prefs.getByRole('button', { name: '打开安装包', exact: true })).toBeVisible();
  const extension = process.platform === 'darwin' ? 'dmg' : 'exe';
  const name = `ChatDeepSeek-9.10.0-${process.arch}.${extension}`;
  expect(releases.state().downloads).toEqual([`/releases/download/v9.10.0/${name}`]);
  expect(await readFile(path.join(dataDir, 'updates', name))).toEqual(releases.installer);
  await prefs.getByRole('button', { name: '打开安装包', exact: true }).click();
  await expect.poll(async () => (await state()).openedInstaller).toBe(path.join(dataDir, 'updates', name));
  await expect(prefs.locator('#update-status')).toContainText('安装包已打开');
  expect(await web.evaluate(() => localStorage.getItem('logged'))).toBe('yes');
});

test('更新检查忽略旧版本、当前版本、草稿和预发行版本', async () => {
  await launch('updates-version-policy');
  const prefs = await settings();
  for (const mode of ['current', 'older', 'draft', 'prerelease']) {
    releases.setMode(mode);
    await prefs.getByRole('button', { name: '检查更新', exact: true }).click();
    await expect(prefs.locator('#update-status')).toContainText('已是最新稳定版本');
    await expect(prefs.getByRole('button', { name: '下载更新', exact: true })).toBeHidden();
  }
  expect(releases.state().downloads).toEqual([]);
});

test('更新检查拒绝无效版本、损坏元数据、缺失平台安装包及不可信下载地址', async () => {
  await launch('updates-invalid-release');
  const prefs = await settings();
  for (const mode of ['invalid-version', 'invalid-json', 'missing-asset', 'untrusted', 'missing-digest']) {
    releases.setMode(mode);
    await prefs.getByRole('button', { name: '检查更新', exact: true }).click();
    await expect.poll(async () => (await state()).update.status).toBe('error');
    await expect(prefs.locator('#update-status')).not.toBeEmpty();
    await expect(prefs.getByRole('button', { name: '下载更新', exact: true })).toBeHidden();
  }
  expect(releases.state().downloads).toEqual([]);
});

test('更新网络故障和限流可重试，重复操作只发送一次请求', async () => {
  await launch('updates-retry');
  const prefs = await settings();
  for (const mode of ['offline', 'limited']) {
    releases.setMode(mode);
    await prefs.getByRole('button', { name: '检查更新', exact: true }).click();
    await expect.poll(async () => (await state()).update.status).toBe('error');
  }
  releases.reset();
  await prefs.evaluate(() => { const button = document.querySelector<HTMLButtonElement>('#check-update')!; button.click(); button.click(); });
  await expect(prefs.locator('#update-status')).toContainText('9.10.0');
  expect(releases.state().checks).toBe(1);
  await prefs.evaluate(() => { const button = document.querySelector<HTMLButtonElement>('#update-action')!; button.click(); button.click(); });
  await expect(prefs.getByRole('button', { name: '打开安装包', exact: true })).toBeVisible();
  expect(releases.state().downloads).toHaveLength(1);
});

test('更新下载失败、中断或校验不匹配时清理文件，重试后可安装', async () => {
  await launch('updates-integrity');
  const prefs = await settings();
  for (const mode of ['download-error', 'interrupted', 'corrupted']) {
    releases.setMode(mode);
    await prefs.getByRole('button', { name: '检查更新', exact: true }).click();
    await expect(prefs.getByRole('button', { name: '下载更新', exact: true })).toBeVisible();
    await prefs.getByRole('button', { name: '下载更新', exact: true }).click();
    await expect.poll(async () => (await state()).update.status).toBe('error');
    expect(await readdir(path.join(dataDir, 'updates'))).toEqual([]);
    expect((await state()).openedInstaller).toBe('');
  }
  releases.setMode('available');
  await prefs.getByRole('button', { name: '检查更新', exact: true }).click();
  await expect(prefs.getByRole('button', { name: '下载更新', exact: true })).toBeVisible();
  await prefs.getByRole('button', { name: '下载更新', exact: true }).click();
  await expect(prefs.getByRole('button', { name: '打开安装包', exact: true })).toBeVisible();
});

test('打开更新安装包前重新校验，文件被修改或系统拒绝时不报告安装成功', async () => {
  await launch('updates-open-validation');
  const prefs = await settings();
  await prefs.getByRole('button', { name: '检查更新', exact: true }).click();
  await expect(prefs.getByRole('button', { name: '下载更新', exact: true })).toBeVisible();
  await prefs.getByRole('button', { name: '下载更新', exact: true }).click();
  await expect(prefs.getByRole('button', { name: '打开安装包', exact: true })).toBeVisible();
  const [file] = await readdir(path.join(dataDir, 'updates'));
  await writeFile(path.join(dataDir, 'updates', file), 'modified installer');
  await prefs.getByRole('button', { name: '打开安装包', exact: true }).click();
  await expect.poll(async () => (await state()).update.status).toBe('error');
  expect((await state()).openedInstaller).toBe('');
  await prefs.getByRole('button', { name: '检查更新', exact: true }).click();
  await expect(prefs.getByRole('button', { name: '下载更新', exact: true })).toBeVisible();
  await prefs.getByRole('button', { name: '下载更新', exact: true }).click();
  await expect(prefs.getByRole('button', { name: '打开安装包', exact: true })).toBeVisible();
  await action('failInstallerOpen');
  await prefs.getByRole('button', { name: '打开安装包', exact: true }).click();
  await expect(prefs.locator('#update-status')).toContainText('无法打开安装包');
});
