import { build } from 'esbuild';
import { mkdir, cp, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
process.chdir(root);
await import('./assets.mjs');
await mkdir('dist', { recursive: true });
await Promise.all([
  build({ entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js', bundle: true, platform: 'node', target: 'node22', external: ['electron'], sourcemap: true }),
  build({ entryPoints: ['src/main/install-update.ts'], outfile: 'dist/main/install-update.js', bundle: true, platform: 'node', target: 'node22', sourcemap: true }),
  build({ entryPoints: { app: 'src/preload/app.ts', page: 'src/preload/page.ts' }, outdir: 'dist/preload', bundle: true, platform: 'node', target: 'node22', external: ['electron'], sourcemap: true }),
  build({ entryPoints: { shell: 'src/renderer/shell.ts', settings: 'src/renderer/settings.ts' }, outdir: 'dist/renderer', bundle: true, platform: 'browser', target: 'chrome140', sourcemap: true }),
]);
for (const name of ['shell.html', 'login.html', 'settings.html', 'app.css']) await cp(path.join('src/renderer', name), path.join('dist/renderer', name));
await cp('assets/deepseek.svg', 'dist/renderer/deepseek.svg');
const runtimeDirectory = path.dirname(createRequire(import.meta.url)('electron'));
await writeFile('dist/main/runtime-files.json', JSON.stringify(await readdir(runtimeDirectory)));
console.log('Built main process, isolated preloads and desktop interface.');
