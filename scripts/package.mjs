import { spawn } from 'node:child_process';
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
for (const dir of ['.cache/tmp', '.cache/electron', '.cache/electron-builder']) await mkdir(path.join(root, dir), { recursive: true });
const platform = process.argv.includes('--win') || process.platform === 'win32' ? 'win' : 'mac';
const arch = process.argv.includes('--universal') ? 'universal' : process.argv.includes('--x64') || platform === 'win' ? 'x64' : 'arm64';
const args = ['node_modules/electron-builder/out/cli/cli.js', `--${platform}`, `--${arch}`, '--publish', 'never', `--config.electronDownload.cache=${path.join(root, '.cache/electron')}`];
const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', env: {
  ...process.env, ELECTRON_CACHE: path.join(root, '.cache/electron'), electron_config_cache: path.join(root, '.cache/electron'), ELECTRON_BUILDER_CACHE: path.join(root, '.cache/electron-builder'), TMPDIR: path.join(root, '.cache/tmp'),
  // Without an explicitly supplied identity, produce an ad-hoc signed local application.
  ...(!process.env.CSC_LINK && !process.env.CSC_NAME ? { CSC_IDENTITY_AUTO_DISCOVERY: 'false' } : {}),
} });
const code = await new Promise(resolve => child.on('exit', resolve));
if (code !== 0) process.exit(Number(code) || 1);
const lines = [];
for (const name of await readdir(path.join(root, 'release'))) {
  if (/\.(dmg|zip|exe)$/.test(name) && name.includes(`-${arch}.`)) lines.push(`${createHash('sha256').update(await readFile(path.join(root, 'release', name))).digest('hex')}  ${name}`);
}
await writeFile(path.join(root, `release/SHA256SUMS-${platform}-${arch}.txt`), lines.join('\n') + '\n');
console.log('Release artifacts and SHA256 checksums are ready in release/.');
