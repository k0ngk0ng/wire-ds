import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { access, appendFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const execute = promisify(execFile);
interface InstallOptions {
  archive: string;
  executablePath: string;
  dataDirectory: string;
  platform: NodeJS.Platform;
  version: string;
  parentPID: number;
  restartTimeout?: number;
}
interface InstallState { status: string; version: string; pid?: number; reason?: string }
const stateFile = (directory: string) => path.join(directory, 'updates/install-state.json');
export function readInstallState(directory: string): InstallState | undefined {
  try { return JSON.parse(readFileSync(stateFile(directory), 'utf8')); } catch { return undefined; }
}
function acknowledgeStartup(directory: string, version: string, complete: boolean) {
  const state = readInstallState(directory);
  if (state?.status !== 'awaiting-restart' || state.version !== version) return;
  const file = stateFile(directory);
  const result = { ...state, status: complete ? 'completed' : state.status, pid: process.pid };
  if (complete) {
    const acknowledgement = path.join(directory, 'updates', `completed-${version}.json`);
    writeFileSync(`${acknowledgement}.tmp`, JSON.stringify(result), { mode: 0o600 });
    renameSync(`${acknowledgement}.tmp`, acknowledgement);
  }
  writeFileSync(`${file}.tmp`, JSON.stringify(result), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}
export function beginUpdateStartup(directory: string, version: string) { acknowledgeStartup(directory, version, false); }
export function completeUpdateStartup(directory: string, version: string) { acknowledgeStartup(directory, version, true); }

const macHelper = `set -eEuo pipefail
target="$1"; staged="$2"; backup="$3"; parent="$4"; data="$5"; state="$6"; version="$7"; timeout="$8"; acknowledgement="$9"
moved=0
write_state() {
  printf '{"status":"%s","reason":"%s","version":"%s"}' "$1" "$2" "$version" > "$state.tmp"
  /bin/mv -f "$state.tmp" "$state"
}
launch() { /usr/bin/open -n --env "WIRE_DS_DATA_DIR=$data" "$target" --args --updated; }
rollback() {
  trap - ERR
  set +e
  local pid
  pid="$(/bin/ps -axo pid=,comm= | /usr/bin/awk -v executable="$target/Contents/MacOS/ChatDeepSeek" '{pid=$1;sub(/^[[:space:]]*[0-9]+[[:space:]]+/,"",$0);if($0==executable)print pid}' | /usr/bin/head -1)"
  if [ -n "$pid" ] && [ "$pid" != "$parent" ]; then
    kill -TERM "$pid" 2>/dev/null
    for attempt in {1..30}; do kill -0 "$pid" 2>/dev/null || break; /bin/sleep 0.1; done
    kill -KILL "$pid" 2>/dev/null || true
  fi
  if [ "$moved" = 1 ]; then /bin/rm -rf "$target"; /bin/mv "$backup" "$target"; fi
  write_state failed "$1"
  launch
  exit 1
}
trap 'rollback replace-failed' ERR
write_state waiting-parent ""
for attempt in {1..600}; do kill -0 "$parent" 2>/dev/null || break; /bin/sleep 0.1; done
if kill -0 "$parent" 2>/dev/null; then rollback parent-timeout; fi
/bin/rm -rf "$backup"
/bin/mv "$target" "$backup"
moved=1
/bin/mv "$staged" "$target"
/usr/bin/codesign --verify --deep --strict "$target"
write_state awaiting-restart ""
launch
attempts=$((timeout / 100))
for ((attempt=0;attempt<attempts;attempt++)); do
  if [ -f "$acknowledgement" ]; then /bin/rmdir "$(/usr/bin/dirname "$staged")" 2>/dev/null || true; exit 0; fi
  /bin/sleep 0.1
done
rollback restart-timeout
`;

export function windowsHelper(planFile: string) {
  const quoted = planFile.replace(/'/g, "''");
  return `$ErrorActionPreference='Stop'
$plan=[IO.File]::ReadAllText('${quoted}') | ConvertFrom-Json
$launched=$null
$attempted=$false
function Write-State($status,$reason) {
  $value=@{status=$status;reason=$reason;version=$plan.version} | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($plan.state+'.tmp',$value)
  Move-Item -LiteralPath ($plan.state+'.tmp') -Destination $plan.state -Force
}
try {
  Write-State 'waiting-parent' ''
  [Console]::WriteLine('Waiting for previous process '+$plan.parentPID)
  [Console]::Out.Flush()
  $deadline=[DateTime]::UtcNow.AddSeconds(60)
  while(Get-Process -Id $plan.parentPID -ErrorAction SilentlyContinue){if([DateTime]::UtcNow -gt $deadline){throw 'parent-timeout'};Start-Sleep -Milliseconds 100}
  $env:WIRE_DS_DATA_DIR=$plan.dataDirectory
  $env:TEMP=$plan.temporary
  $env:TMP=$plan.temporary
  $attempted=$true
  Write-State 'installing' ''
  [Console]::WriteLine('Starting silent installer')
  [Console]::Out.Flush()
  $installer=Start-Process -FilePath $plan.archive -ArgumentList ('/S --updated /D='+$plan.target) -PassThru
  $null=$installer.Handle
  if(-not $installer.WaitForExit(120000)){Stop-Process -Id $installer.Id -Force -ErrorAction SilentlyContinue;throw 'installer-timeout'}
  $installer.Refresh()
  [Console]::WriteLine('Installer exited with '+$installer.ExitCode)
  [Console]::Out.Flush()
  if($installer.ExitCode -ne 0){throw 'installer-failed'}
  $installed=[Diagnostics.FileVersionInfo]::GetVersionInfo($plan.executable).ProductVersion
  if($installed -notmatch ('^'+[Regex]::Escape($plan.version)+'(?:\\.0)?$')){throw 'version-mismatch'}
  Write-State 'awaiting-restart' ''
  [Console]::WriteLine('Restarting updated application')
  [Console]::Out.Flush()
  $launched=Start-Process -FilePath $plan.executable -ArgumentList '--updated' -PassThru
  $deadline=[DateTime]::UtcNow.AddMilliseconds($plan.restartTimeout)
  while([DateTime]::UtcNow -lt $deadline){
    if(Test-Path -LiteralPath $plan.acknowledgement){exit 0}
    Start-Sleep -Milliseconds 100
  }
  throw 'restart-timeout'
} catch {
  if($launched){Stop-Process -Id $launched.Id -Force -ErrorAction SilentlyContinue}
  if($attempted){Get-ChildItem -LiteralPath $plan.backup | Copy-Item -Destination $plan.target -Recurse -Force}
  Write-State 'failed' $_.Exception.Message
  $env:WIRE_DS_DATA_DIR=$plan.dataDirectory
  Start-Process -FilePath $plan.executable -ArgumentList '--updated'
  exit 1
}
`;
}

export async function prepareUpdate(options: InstallOptions) {
  if (!/^\d+\.\d+\.\d+$/.test(options.version) || !Number.isSafeInteger(options.parentPID) || options.parentPID <= 0) throw new Error('更新安装参数无效。');
  const mac = options.platform === 'darwin';
  if (!mac && options.platform !== 'win32') throw new Error('更新暂不支持此系统。');
  const executable = path.resolve(options.executablePath);
  const target = mac ? path.resolve(path.dirname(executable), '../..') : path.dirname(executable);
  if (path.basename(executable) !== (mac ? 'ChatDeepSeek' : 'ChatDeepSeek.exe') || (mac && !target.endsWith('.app'))) throw new Error('更新无法确认当前应用目录。');
  const parent = path.dirname(target);
  try { await access(parent, constants.W_OK); await access(target, constants.W_OK); }
  catch { throw new Error('更新安装目录不可写，请将应用移到可写目录后重试。'); }
  const directory = path.join(options.dataDirectory, 'updates');
  await mkdir(directory, { recursive: true });
  const state = stateFile(options.dataDirectory);
  const acknowledgement = path.join(directory, `completed-${options.version}.json`);
  const backup = path.join(parent, mac ? '.ChatDeepSeek.previous.app' : '.ChatDeepSeek.previous');
  const restartTimeout = Math.max(1000, Math.min(60_000, options.restartTimeout ?? 30_000));
  let command: string;
  let args: string[];
  let staging = '';
  try {
    if (mac) {
      staging = path.join(parent, `.ChatDeepSeek-update-${randomUUID()}`);
      await mkdir(staging);
      await execute('/usr/bin/ditto', ['-x', '-k', options.archive, staging]);
      const bundle = path.join(staging, 'ChatDeepSeek.app');
      await execute('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]);
      const plist = path.join(bundle, 'Contents/Info.plist');
      const identity = (await execute('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist])).stdout.trim();
      const version = (await execute('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist])).stdout.trim();
      if (identity !== 'com.wire.deepseek' || version !== options.version) throw new Error('更新应用标识或版本不匹配。');
      await execute('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', bundle]);
      const helper = path.join(directory, 'install-mac.sh');
      await writeFile(helper, macHelper, { mode: 0o600 });
      command = '/bin/bash';
      args = [helper, target, bundle, backup, String(options.parentPID), options.dataDirectory, state, options.version, String(restartTimeout), acknowledgement];
    } else {
      const runtimeFiles: string[] = JSON.parse(await readFile(path.join(__dirname, 'runtime-files.json'), 'utf8'));
      await rm(backup, { recursive: true, force: true });
      await mkdir(backup, { recursive: true });
      for (const name of [...runtimeFiles, 'Uninstall ChatDeepSeek.exe']) {
        if (!name || path.basename(name) !== name || name === '.' || name === '..') throw new Error('更新文件清单无效。');
        const file = name.toLowerCase() === 'electron.exe' ? 'ChatDeepSeek.exe' : name;
        await cp(path.join(target, file), path.join(backup, file), { recursive: true }).catch(error => { if (error.code !== 'ENOENT') throw error; });
      }
      const temporary = path.join(directory, 'temporary');
      await mkdir(temporary, { recursive: true });
      const planFile = path.join(directory, 'install-plan.json');
      await writeFile(planFile, JSON.stringify({ ...options, executable, target, backup, state, acknowledgement, temporary, restartTimeout }), { mode: 0o600 });
      command = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
      args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsHelper(planFile), 'utf16le').toString('base64')];
    }
    return {
      async start(): Promise<number> {
        await rm(acknowledgement, { force: true });
        await writeFile(state, JSON.stringify({ status: 'prepared', version: options.version }), { mode: 0o600 });
        const log = openSync(path.join(directory, 'install.log'), 'a', 0o600);
        try {
          const child = spawn(command, args, { detached: options.platform !== 'win32', windowsHide: true, stdio: ['ignore', log, log] });
          await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
          child.unref();
          for (let attempt = 0; attempt < 600; attempt++) {
            const status = readInstallState(options.dataDirectory);
            if (status?.version === options.version && ['waiting-parent', 'installing', 'awaiting-restart', 'completed'].includes(status.status)) return child.pid!;
            if (child.exitCode !== null || child.signalCode !== null || status?.status === 'failed') break;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          await appendFile(path.join(directory, 'install.log'), `Helper exited before readiness: code=${child.exitCode}, signal=${child.signalCode}\n`);
          child.kill();
          if (staging) await rm(staging, { recursive: true, force: true });
          throw new Error('更新辅助进程启动失败，请重试。');
        } finally { closeSync(log); }
      },
    };
  } catch (error) {
    if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
    if (error instanceof Error && error.message.startsWith('更新')) throw error;
    throw new Error('更新安装准备失败，请重新检查更新并重试。');
  }
}
