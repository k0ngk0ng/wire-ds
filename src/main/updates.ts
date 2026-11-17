import { net } from 'electron';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Result, UpdateState } from '../shared';
import { readInstallState } from './install-update';

interface UpdateOptions {
  version: string;
  platform: NodeJS.Platform;
  arch: string;
  directory: string;
  endpoint?: string;
  onChange: () => void;
  installUpdate: (file: string, version: string) => Promise<void>;
}
interface ReleaseAsset { name: string; url: string; digest: string; size: number }

const repository = 'https://github.com/k0ngk0ng/wire-ds';
const versionParts = (version: string) => /^\d+\.\d+\.\d+$/.test(version) ? version.split('.').map(Number) : undefined;
function newerVersion(next: string, current: string) {
  const left = versionParts(next), right = versionParts(current);
  if (!left || !right || [...left, ...right].some(value => !Number.isSafeInteger(value))) throw new Error('GitHub 返回了无效的版本号，请稍后重试。');
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i];
  return false;
}

async function checksumText(response: Response) {
  if (!response.body) throw new Error('更新校验文件为空，请稍后重试。');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 65536) throw new Error('更新校验文件过大，请稍后重试。');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
}

export class ReleaseUpdater {
  state: UpdateState = { status: 'idle', version: '', progress: 0, message: '更新来源：GitHub Releases' };
  private target?: ReleaseAsset;
  private controller?: AbortController;
  private pending?: Promise<Result>;

  constructor(private options: UpdateOptions) {
    const result = readInstallState(path.dirname(options.directory));
    if (result?.status === 'failed') this.state = { status: 'error', version: '', progress: 0, message: '更新未完成，已保留或恢复原应用。请重新检查更新。' };
  }

  private publish(state: UpdateState) { this.state = state; this.options.onChange(); }
  private error(error: unknown) {
    const message = error instanceof Error && /^(更新|GitHub|下载|安装包|无法安装)/.test(error.message)
      ? error.message : '更新失败，请检查网络或磁盘空间后重试。';
    this.publish({ ...this.state, status: 'error', progress: 0, message });
    return { ok: false, message };
  }
  private run(task: () => Promise<Result>): Promise<Result> {
    if (this.pending) return this.pending;
    this.controller = new AbortController();
    this.pending = task().finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private releaseLocation(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const request = net.request({ url, method: 'HEAD', redirect: 'manual' });
      const signal = AbortSignal.any([this.controller!.signal, AbortSignal.timeout(20_000)]);
      let settled = false;
      const finish = (error?: Error, location?: string) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        request.abort();
        if (error) reject(error); else resolve(location!);
      };
      const abort = () => finish(new Error('GitHub 更新检查已取消或超时，请重试。'));
      request.setHeader('User-Agent', `ChatDeepSeek/${this.options.version}`);
      request.once('redirect', (_status, _method, location) => finish(undefined, location));
      request.once('response', response => {
        finish(new Error(response.statusCode === 403 || response.statusCode === 429 ? 'GitHub 请求受限，请稍后重试。' : 'GitHub 未返回稳定版本地址，请稍后重试。'));
      });
      request.once('error', error => finish(error));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort(); else request.end();
    });
  }
  private async request(url: string, timeout: number, options: Pick<RequestInit, 'method'> = {}) {
    const response = await net.fetch(url, {
      ...options,
      headers: { 'User-Agent': `ChatDeepSeek/${this.options.version}` },
      cache: 'no-store', signal: AbortSignal.any([this.controller!.signal, AbortSignal.timeout(timeout)]),
    });
    if (response.status === 403 || response.status === 429) throw new Error('GitHub 请求受限，请稍后重试。');
    if (!response.ok) throw new Error(`GitHub 请求失败（HTTP ${response.status}），请稍后重试。`);
    return response;
  }
  check(): Promise<Result> {
    if (this.state.status === 'installing') return Promise.resolve({ ok: false, message: '正在安装更新。' });
    return this.run(async () => {
      this.target = undefined;
      this.publish({ status: 'checking', version: '', progress: 0, message: '正在检查更新…' });
      try {
        const endpoint = this.options.endpoint || `${repository}/releases/latest`;
        const source = this.options.endpoint ? new URL(endpoint).origin : repository;
        const release = new URL(await this.releaseLocation(endpoint), endpoint);
        const prefix = `${source}/releases/tag/v`;
        if (!release.href.startsWith(prefix) || release.search || release.hash) throw new Error('GitHub 返回了无效的稳定版本地址，请稍后重试。');
        const version = release.href.slice(prefix.length);
        const newer = newerVersion(version, this.options.version);
        if (!newer) {
          this.publish({ status: 'current', version: this.options.version, progress: 0, message: '已是最新稳定版本' });
          return { ok: true };
        }
        const extension = this.options.platform === 'darwin' ? 'zip' : this.options.platform === 'win32' ? 'exe' : '';
        if (!extension || !['arm64', 'x64'].includes(this.options.arch)) throw new Error('更新暂不支持此系统或架构，请查看 GitHub Releases。');
        const name = `ChatDeepSeek-${version}-${this.options.arch}.${extension}`;
        const download = `${source}/releases/download/v${version}`;
        const checksums = await checksumText(await this.request(`${download}/SHA256SUMS-${this.options.platform === 'darwin' ? 'mac' : 'win'}-${this.options.arch}.txt`, 20_000));
        const matches = checksums.split(/\r?\n/).map(line => line.match(/^([a-f0-9]{64}) [ *](.+)$/i)).filter(match => match?.[2] === name);
        if (matches.length !== 1) throw new Error('更新安装包的校验信息无效，请稍后重试。');
        const url = `${download}/${name}`;
        const metadata = await this.request(url, 20_000, { method: 'HEAD' });
        const size = Number(metadata.headers.get('content-length'));
        if (!Number.isSafeInteger(size) || size <= 0 || size > 1024 ** 3) throw new Error('更新安装包的大小无效，请稍后重试。');
        this.target = { name, url, size, digest: matches[0]![1].toLowerCase() };
        this.publish({ status: 'available', version, progress: 0, message: `发现新版本 ${version}` });
        return { ok: true };
      } catch (error) { return this.error(error); }
    });
  }
  download(): Promise<Result> {
    return this.run(async () => {
      const target = this.target;
      if (!target || this.state.status !== 'available') return { ok: false, message: '请先检查更新。' };
      const file = path.join(this.options.directory, target.name);
      const partial = `${file}.part`;
      this.publish({ ...this.state, status: 'downloading', progress: 0, message: '正在下载更新…' });
      try {
        await mkdir(this.options.directory, { recursive: true });
        const response = await this.request(target.url, 300_000);
        if (!response.body) throw new Error('下载响应为空，请重新检查更新。');
        const handle = await open(partial, 'w', 0o600);
        const hash = createHash('sha256');
        const reader = response.body.getReader();
        let received = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            received += value.byteLength;
            if (received > target.size) throw new Error('下载文件大小不匹配，请重新检查更新。');
            hash.update(value);
            await handle.writeFile(value);
            const progress = Math.floor(received / target.size * 100);
            if (progress !== this.state.progress) this.publish({ ...this.state, progress, message: `正在下载更新… ${progress}%` });
          }
        } finally { await reader.cancel().catch(() => {}); await handle.close(); }
        if (received !== target.size || hash.digest('hex') !== target.digest) throw new Error('下载校验失败，请重新检查更新并下载。');
        await rename(partial, file);
        this.publish({ ...this.state, status: 'ready', progress: 100, message: `版本 ${this.state.version} 已下载并通过校验` });
        return { ok: true };
      } catch (error) { await rm(partial, { force: true }).catch(() => {}); return this.error(error); }
    });
  }
  install(): Promise<Result> {
    return this.run(async () => {
      const target = this.target;
      if (!target || this.state.status !== 'ready') return { ok: false, message: '请先下载更新。' };
      const file = path.join(this.options.directory, target.name);
      try {
        if ((await stat(file)).size !== target.size) throw new Error('安装包校验失败，请重新检查更新并下载。');
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(file)) hash.update(chunk);
        if (hash.digest('hex') !== target.digest) throw new Error('安装包校验失败，请重新检查更新并下载。');
        this.publish({ ...this.state, status: 'installing', message: '正在安装更新，应用即将自动重启…' });
        await this.options.installUpdate(file, this.state.version);
        return { ok: true };
      } catch (error) { return this.error(error); }
    });
  }
  async update(): Promise<Result> {
    if (this.state.status === 'installing') return { ok: true };
    const result = this.state.status === 'ready' ? { ok: true } : await this.download();
    return result.ok ? this.install() : result;
  }
  async stop() { this.controller?.abort(); await this.pending; }
}
