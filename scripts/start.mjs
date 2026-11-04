import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url));
await mkdir(path.join(root, '.cache/tmp'), { recursive: true });
process.env.electron_config_cache = path.join(root, '.cache/electron');
process.env.TMPDIR = path.join(root, '.cache/tmp');
const { default: electron } = await import('electron');
const child = spawn(electron, [path.join(root, 'dist/main/main.js'), ...process.argv.slice(2)], {
  cwd: root, stdio: 'inherit',
  env: { ...process.env, WIRE_DS_DATA_DIR: process.env.WIRE_DS_DATA_DIR || path.join(root, '.runtime/development'), TMPDIR: path.join(root, '.cache/tmp') },
});
child.on('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
