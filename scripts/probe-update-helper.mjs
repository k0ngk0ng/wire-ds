import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { openSync, closeSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { windowsHelper } from '../src/main/install-update.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const directory = path.join(root, '.runtime/helper-probe');
await mkdir(directory, { recursive: true });
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const results = [];
for (const actual of [false, true]) for (const detached of [false, true]) for (const encoded of [false, true]) {
  const name = `${actual ? 'actual' : 'control'}-${detached ? 'detached' : 'attached'}-${encoded ? 'encoded' : 'command'}`;
  const state = path.join(directory, `${name}.json`);
  const done = path.join(directory, `${name}.done`);
  const planFile = path.join(directory, `${name}-plan.json`);
  await writeFile(state, JSON.stringify({ status: 'prepared', version: '0.0.0' }));
  await writeFile(planFile, JSON.stringify({ state, version: '0.0.0', parentPID: process.pid }));
  const script = actual ? windowsHelper(planFile) : `[IO.File]::WriteAllText('${done.replace(/'/g, "''")}','ready')`;
  const args = ['-NoProfile', '-NonInteractive', encoded ? '-EncodedCommand' : '-Command', encoded ? Buffer.from(script, 'utf16le').toString('base64') : script];
  const logFile = path.join(directory, `${name}.log`);
  const log = openSync(logFile, 'w');
  const executable = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const child = spawn(executable, args, { detached, windowsHide: true, stdio: ['ignore', log, log] });
  const error = await new Promise(resolve => { child.once('spawn', () => resolve('')); child.once('error', e => resolve(String(e))); });
  closeSync(log);
  let ready = false;
  for (let i = 0; !error && i < 100; i++) {
    const value = JSON.parse(await readFile(state, 'utf8'));
    ready = actual ? value.status === 'waiting-parent' : existsSync(done);
    if (ready || child.exitCode !== null || child.signalCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const result = { name, ready, error, code: child.exitCode, signal: child.signalCode, log: await readFile(logFile, 'utf8').catch(() => '') };
  if (child.exitCode === null && child.signalCode === null) child.kill();
  results.push(result);
  console.log(JSON.stringify(result));
}
await writeFile(path.join(root, 'artifacts/helper-probe.json'), JSON.stringify(results, null, 2));
