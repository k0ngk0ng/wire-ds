import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test';
import { cp, mkdir, readFile, writeFile, rm, readdir, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const platform = process.platform;
const version = JSON.parse(require('node:fs').readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const newVersion = platform === 'darwin' ? '9.10.0' : version;
let directory: string;
let desktop: ElectronApplication | undefined;
let childPID = 0;
let helperPID = 0;

async function fixtureBundle(destination: string, bundleVersion: string, actual = false) {
  const source = platform === 'darwin' ? path.join(root, 'release', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'ChatDeepSeek.app') : path.join(root, 'release/win-unpacked');
  if (platform === 'darwin') execFileSync('ditto', [source, destination]);
  else await cp(source, destination, { recursive: true });
  const resources = platform === 'darwin' ? path.join(destination, 'Contents/Resources') : path.join(destination, 'resources');
  if (actual) {
    require('@electron/asar').extractAll(path.join(resources, 'app.asar'), path.join(resources, 'app'));
    const packageFile = path.join(resources, 'app/package.json');
    const metadata = JSON.parse(await readFile(packageFile, 'utf8'));
    await writeFile(packageFile, JSON.stringify({ ...metadata, version: bundleVersion }));
  }
  await rm(path.join(resources, 'app.asar'), { force: true });
  if (!actual) {
    await mkdir(path.join(resources, 'app'), { recursive: true });
    await cp(path.join(root, 'dist/main/install-update.js'), path.join(resources, 'app/install-update.cjs'));
  await cp(path.join(root, 'dist/main/runtime-files.json'), path.join(resources, 'app/runtime-files.json'));
    await writeFile(path.join(resources, 'app/package.json'), JSON.stringify({ name: 'wire-ds', version: bundleVersion, main: 'main.cjs' }));
    await writeFile(path.join(resources, 'app/main.cjs'), `const {app,BrowserWindow}=require('electron');const fs=require('node:fs');const path=require('node:path');const updater=require('./install-update.cjs');globalThis.__installer=updater;const data=process.env.WIRE_DS_DATA_DIR;for(const name of ['userData','sessionData','logs','crashDumps']){const dir=path.join(data,name);fs.mkdirSync(dir,{recursive:true});app.setPath(name,dir)}app.setPath('userData',data);if(process.argv.includes('/S'))process.exit(3);if(app.getVersion()==='9.10.0'&&fs.existsSync(path.join(data,'fail-start')))process.exit(4);app.whenReady().then(()=>{updater.beginUpdateStartup(data,app.getVersion());const win=new BrowserWindow({width:400,height:300,show:false,webPreferences:{backgroundThrottling:false}});win.loadURL('data:text/html,<h1>Update restart '+app.getVersion()+'</h1>');win.once('ready-to-show',()=>{updater.completeUpdateStartup(data,app.getVersion());fs.writeFileSync(path.join(data,'startup.json'),JSON.stringify({version:app.getVersion(),pid:process.pid}));win.show()})});process.on('SIGTERM',()=>app.quit());`);
  }
  if (platform === 'darwin') {
    const plist = path.join(destination, 'Contents/Info.plist');
    for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${bundleVersion}`, plist]);
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', destination], { stdio: 'ignore' });
  }
  return platform === 'darwin' ? path.join(destination, 'Contents/MacOS/ChatDeepSeek') : path.join(destination, 'ChatDeepSeek.exe');
}

async function setup(name: string) {
  directory = path.join(root, '.runtime/install-e2e', name);
  await rm(directory, { recursive: true, force: true });
  const data = path.join(directory, 'profile');
  await mkdir(data, { recursive: true });
  await writeFile(path.join(data, 'preserved.txt'), 'keep-login-and-settings');
  await writeFile(path.join(data, 'settings.json'), JSON.stringify({ theme: 'dark', shortcut: 'F9' }));
  const target = path.join(directory, platform === 'darwin' ? 'target/ChatDeepSeek.app' : 'target/ChatDeepSeek');
  const executable = await fixtureBundle(target, '0.1.0');
  desktop = await electron.launch({ executablePath: executable, args: [], artifactsDir: path.join(directory, 'electron'), env: { ...process.env, WIRE_DS_DATA_DIR: data, TMPDIR: path.join(root, '.cache/tmp') } });
  await expect.poll(async () => JSON.parse(await readFile(path.join(data, 'startup.json'), 'utf8').catch(() => '{}')).version).toBe('0.1.0');
  const parentPID = await desktop.evaluate(() => process.pid);
  let archive = path.join(root, '.runtime/installer-fixture', `ChatDeepSeek-${version}-x64.exe`);
  if (platform === 'darwin') {
    const candidate = path.join(directory, 'candidate/ChatDeepSeek.app');
    await fixtureBundle(candidate, newVersion, name === 'restart');
    archive = path.join(directory, 'update.zip');
    execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', candidate, archive]);
  }
  return { data, target, executable, parentPID, archive };
}

test.skip(platform !== 'darwin' && (platform !== 'win32' || !process.env.CI), 'Native update tests use workspace bundles and a disposable Windows CI installation.');
test.afterEach(async ({}, info) => {
  if (directory) {
    const file = path.join(directory, 'profile/updates/install-state.json');
    const result = JSON.parse(await readFile(file, 'utf8').catch(() => '{}'));
    childPID = Number(result.pid) || childPID;
    await info.attach('native-install-state', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
    const log = await readFile(path.join(directory, 'profile/updates/install.log'), 'utf8').catch(() => '');
    await info.attach('native-install-log', { body: log, contentType: 'text/plain' });
    if (platform === 'win32' && helperPID) {
      const processes = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -eq ${helperPID} -or $_.ParentProcessId -eq ${helperPID} } | Select-Object Name,ProcessId,ParentProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`], { encoding: 'utf8', timeout: 15_000 });
      await info.attach('native-update-processes', { body: processes, contentType: 'text/plain' });
      if (info.status !== info.expectedStatus) {
        const files: Record<string, string> = {};
        for (const name of ['resources/app/package.json', 'resources/app/main.cjs']) files[name] = await readFile(path.join(directory, 'target/ChatDeepSeek', name), 'utf8').catch(String);
        await info.attach('restored-application-files', { body: JSON.stringify(files, null, 2), contentType: 'application/json' });
        const screenFile = info.outputPath('native-desktop.png');
        const literal = screenFile.replace(/'/g, "''");
        try {
          execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $r=[Windows.Forms.Screen]::PrimaryScreen.Bounds; $b=New-Object Drawing.Bitmap($r.Width,$r.Height); $g=[Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($r.Left,$r.Top,0,0,$r.Size); $b.Save('${literal}',[Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $b.Dispose()`], { timeout: 15_000 });
          await info.attach('native-desktop', { path: screenFile, contentType: 'image/png' });
        } catch {}
      }
    }
  }
  for (const pid of [helperPID, childPID]) if (pid) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  await desktop?.close().catch(() => {});
  desktop = undefined; childPID = 0; helperPID = 0; directory = '';
});

test('真实应用更新后替换原目录、自动重启并保留数据', async () => {
  const setupResult = await setup('restart');
  const installer = require('../dist/main/install-update.js');
  helperPID = await desktop!.evaluate(async (_electron, options) => {
    const prepared = await (globalThis as any).__installer.prepareUpdate(options);
    return prepared.start();
  }, { ...setupResult, executablePath: setupResult.executable, dataDirectory: setupResult.data, platform, version: newVersion, restartTimeout: 15_000 });
  await desktop!.close(); desktop = undefined;
  await expect.poll(async () => JSON.parse(await readFile(path.join(setupResult.data, 'updates/install-state.json'), 'utf8').catch(() => '{}')).status, { timeout: 150_000 }).toBe('completed');
  const result = JSON.parse(await readFile(path.join(setupResult.data, 'updates/install-state.json'), 'utf8'));
  expect(result.version).toBe(newVersion);
  expect(result.pid).not.toBe(setupResult.parentPID);
  expect(JSON.parse(await readFile(path.join(setupResult.data, 'updates', `completed-${newVersion}.json`), 'utf8')).pid).toBe(result.pid);
  expect(await readFile(path.join(setupResult.data, 'preserved.txt'), 'utf8')).toBe('keep-login-and-settings');
  const preferences = JSON.parse(await readFile(path.join(setupResult.data, 'settings.json'), 'utf8'));
  expect(preferences).toMatchObject({ theme: 'dark', shortcut: 'F9' });
});

test('预检发现版本不匹配时保持原应用运行', async () => {
  test.skip(platform !== 'darwin');
  const setupResult = await setup('version-mismatch');
  const installer = require('../dist/main/install-update.js');
  await expect(installer.prepareUpdate({ ...setupResult, executablePath: setupResult.executable, dataDirectory: setupResult.data, platform, version: '9.11.0' })).rejects.toThrow(/版本/);
  expect(await desktop!.evaluate(({ app }) => app.getVersion())).toBe('0.1.0');
});

test('更新后的应用无法启动时自动恢复旧版并重启', async () => {
  test.skip(platform !== 'darwin');
  const setupResult = await setup('rollback');
  await writeFile(path.join(setupResult.data, 'fail-start'), 'fail');
  await rm(path.join(setupResult.data, 'startup.json'), { force: true });
  const installer = require('../dist/main/install-update.js');
  const prepared = await installer.prepareUpdate({ ...setupResult, executablePath: setupResult.executable, dataDirectory: setupResult.data, platform, version: newVersion, restartTimeout: 5000 });
  helperPID = await prepared.start();
  await desktop!.close(); desktop = undefined;
  await expect.poll(async () => JSON.parse(await readFile(path.join(setupResult.data, 'updates/install-state.json'), 'utf8').catch(() => '{}')).status, { timeout: 30_000 }).toBe('failed');
  await expect.poll(async () => JSON.parse(await readFile(path.join(setupResult.data, 'startup.json'), 'utf8').catch(() => '{}')).version).toBe('0.1.0');
  childPID = JSON.parse(await readFile(path.join(setupResult.data, 'startup.json'), 'utf8')).pid;
  expect(childPID).not.toBe(setupResult.parentPID);
  expect(await readFile(path.join(setupResult.data, 'preserved.txt'), 'utf8')).toBe('keep-login-and-settings');
});

test('替换文件失败时恢复原应用并自动重新打开', async () => {
  test.skip(platform !== 'darwin');
  const setupResult = await setup('replace-failure');
  const installer = require('../dist/main/install-update.js');
  const prepared = await installer.prepareUpdate({ ...setupResult, executablePath: setupResult.executable, dataDirectory: setupResult.data, platform, version: newVersion, restartTimeout: 5000 });
  const parent = path.dirname(setupResult.target);
  const staged = (await readdir(parent)).find(name => name.startsWith('.ChatDeepSeek-update-'))!;
  await rm(path.join(parent, staged, 'ChatDeepSeek.app'), { recursive: true, force: true });
  await rm(path.join(setupResult.data, 'startup.json'), { force: true });
  helperPID = await prepared.start();
  await desktop!.close(); desktop = undefined;
  await expect.poll(async () => JSON.parse(await readFile(path.join(setupResult.data, 'updates/install-state.json'), 'utf8').catch(() => '{}')).status).toBe('failed');
  await expect.poll(async () => JSON.parse(await readFile(path.join(setupResult.data, 'startup.json'), 'utf8').catch(() => '{}')).version).toBe('0.1.0');
  childPID = JSON.parse(await readFile(path.join(setupResult.data, 'startup.json'), 'utf8')).pid;
  expect(childPID).not.toBe(setupResult.parentPID);
});

test('安装目录不可写时不退出或覆盖原应用', async () => {
  test.skip(platform !== 'darwin' || process.getuid?.() === 0);
  const setupResult = await setup('read-only');
  const installer = require('../dist/main/install-update.js');
  const parent = path.dirname(setupResult.target);
  await chmod(parent, 0o555);
  try {
    await expect(installer.prepareUpdate({ ...setupResult, executablePath: setupResult.executable, dataDirectory: setupResult.data, platform, version: newVersion })).rejects.toThrow(/不可写/);
    expect(await desktop!.evaluate(({ app }) => app.getVersion())).toBe('0.1.0');
  } finally { await chmod(parent, 0o755); }
});

test('辅助进程无法启动时保持原应用运行', async () => {
  test.skip(platform !== 'darwin' || process.getuid?.() === 0);
  const setupResult = await setup('helper-failure');
  const installer = require('../dist/main/install-update.js');
  const prepared = await installer.prepareUpdate({ ...setupResult, executablePath: setupResult.executable, dataDirectory: setupResult.data, platform, version: newVersion });
  await chmod(path.join(setupResult.data, 'updates/install-mac.sh'), 0o000);
  await expect(prepared.start()).rejects.toThrow(/辅助进程/);
  expect(await desktop!.evaluate(({ app }) => app.getVersion())).toBe('0.1.0');
});

test('Windows 安装器异常退出时恢复旧版并重启', async () => {
  test.skip(platform !== 'win32');
  const setupResult = await setup('windows-rollback');
  const failedInstaller = await fixtureBundle(path.join(directory, 'failed-installer'), '0.1.0');
  await writeFile(path.join(directory, 'failed-installer/resources/app/main.cjs'), 'process.exit(3);');
  await rm(path.join(setupResult.data, 'startup.json'), { force: true });
  helperPID = await desktop!.evaluate(async (_electron, options) => {
    const prepared = await (globalThis as any).__installer.prepareUpdate(options);
    return prepared.start();
  }, { ...setupResult, archive: failedInstaller, executablePath: setupResult.executable, dataDirectory: setupResult.data, platform, version: newVersion, restartTimeout: 15_000 });
  await desktop!.close(); desktop = undefined;
  await expect.poll(async () => JSON.parse(await readFile(path.join(setupResult.data, 'updates/install-state.json'), 'utf8').catch(() => '{}')).status, { timeout: 150_000 }).toBe('failed');
  await expect.poll(async () => JSON.parse(await readFile(path.join(setupResult.data, 'startup.json'), 'utf8').catch(() => '{}')).version).toBe('0.1.0');
  childPID = JSON.parse(await readFile(path.join(setupResult.data, 'startup.json'), 'utf8')).pid;
  expect(childPID).not.toBe(setupResult.parentPID);
  expect(await readFile(path.join(setupResult.data, 'preserved.txt'), 'utf8')).toBe('keep-login-and-settings');
});
