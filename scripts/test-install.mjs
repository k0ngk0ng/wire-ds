import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(path.join(root, '.cache/tmp'), { recursive: true });
const env = { ...process.env, TMPDIR: path.join(root, '.cache/tmp'), TEMP: path.join(root, '.cache/tmp'), TMP: path.join(root, '.cache/tmp'), ELECTRON_BUILDER_CACHE: path.join(root, '.cache/electron-builder'), ELECTRON_CACHE: path.join(root, '.cache/electron'), electron_config_cache: path.join(root, '.cache/electron'), CSC_IDENTITY_AUTO_DISCOVERY: 'false' };
async function run(args) {
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: 'inherit' });
  const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
  if (code !== 0) process.exit(Number(code) || 1);
}
if (process.platform === 'win32') {
  await run(['node_modules/electron-builder/out/cli/cli.js', '--win', '--x64', '--prepackaged', path.join(root, 'release/win-unpacked'), '--publish', 'never', '--config.directories.output=.runtime/installer-fixture', '--config.nsis.createDesktopShortcut=false', '--config.nsis.createStartMenuShortcut=false']);
}
await run(['node_modules/@playwright/test/cli.js', 'test', '-c', 'playwright.install.config.ts']);
