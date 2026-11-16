import { net } from 'electron';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Result, UpdateState } from '../shared';

interface UpdateOptions {
  version: string;
  platform: NodeJS.Platform;
  arch: string;
  directory: string;
  endpoint?: string;
  onChange: () => void;
  openInstaller: (file: string) => Promise<string>;
}
interface ReleaseAsset { name: string; browser_download_url: string; digest: string; size: number }

const repository = 'https://github.com/k0ngk0ng/wire-ds';
const versionParts = (version: string) => /^\d+\.\d+\.\d+$/.test(version) ? version.split('.').map(Number) : undefined;
function newerVersion(next: string, current: string) {
  const left = versionParts(next), right = versionParts(current);
  if (!left || !right || [...left, ...right].some(value => !Number.isSafeInteger(value))) throw new Error('GitHub 返回了无效的版本号，请稍后重试。');
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i];
  return false;
}

export class ReleaseUpdater {
  state: UpdateState = { status: 'idle', version: '', progress: 0, message: '更新来源：GitHub Releases' };
  private target?: ReleaseAsset;
  private controller?: AbortController;
  private pending?: Promise<Result>;

  constructor(private options: UpdateOptions) {}

  private publish(state: UpdateState) { this.state = state; this.options.onChange(); }
  private error(error: unknown) {
    const message = error instanceof Error && /^(更新|GitHub|下载|安装包|无法打开)/.test(error.message)
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
  private async request(url: string, timeout: number) {
    const response = await net.fetch(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `ChatDeepSeek/${this.options.version}`, 'X-GitHub-Api-Version': '2022-11-28' },
      cache: 'no-store', signal: AbortSignal.any([this.controller!.signal, AbortSignal.timeout(timeout)]),
    });
    if (response.status === 403 || response.status === 429) throw new Error('GitHub 请求受限，请稍后重试。');
    if (!response.ok) throw new Error(`GitHub 请求失败（HTTP ${response.status}），请稍后重试。`);
    return response;
  }
  check(): Promise<Result> {
    return this.run(async () => {
      this.target = undefined;
      this.publish({ status: 'checking', version: '', progress: 0, message: '正在检查更新…' });
      try {
        const response = await this.request(this.options.endpoint || 'https://api.github.com/repos/k0ngk0ng/wire-ds/releases/latest', 20_000);
        const release = await response.json() as { tag_name?: unknown; draft?: unknown; prerelease?: unknown; assets?: unknown };
        if (!release || typeof release.tag_name !== 'string' || !Array.isArray(release.assets) || typeof release.draft !== 'boolean' || typeof release.prerelease !== 'boolean') throw new Error('GitHub 返回了无效的更新信息，请稍后重试。');
        const version = release.tag_name.replace(/^v/, '');
        const newer = newerVersion(version, this.options.version);
        if (!newer || release.draft || release.prerelease) {
          this.publish({ status: 'current', version: this.options.version, progress: 0, message: '已是最新稳定版本' });
          return { ok: true };
        }
        const extension = this.options.platform === 'darwin' ? 'dmg' : this.options.platform === 'win32' ? 'exe' : '';
        if (!extension || !['arm64', 'x64'].includes(this.options.arch)) throw new Error('更新暂不支持此系统或架构，请查看 GitHub Releases。');
        const name = `ChatDeepSeek-${version}-${this.options.arch}.${extension}`;
        const asset = release.assets.find(value => value && typeof value === 'object' && value.name === name) as ReleaseAsset | undefined;
        const source = this.options.endpoint ? new URL(this.options.endpoint).origin : repository;
        const expectedURL = `${source}/releases/download/${release.tag_name}/${name}`;
        if (!asset) throw new Error('更新安装包尚未就绪，请稍后重试。');
        if (asset.browser_download_url !== expectedURL || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest || '') || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 1024 ** 3) throw new Error('更新安装包的来源或校验信息无效，请稍后重试。');
        this.target = { ...asset };
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
        const response = await this.request(target.browser_download_url, 300_000);
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
        if (received !== target.size || hash.digest('hex') !== target.digest.slice(7).toLowerCase()) throw new Error('下载校验失败，请重新检查更新并下载。');
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
        if (hash.digest('hex') !== target.digest.slice(7).toLowerCase()) throw new Error('安装包校验失败，请重新检查更新并下载。');
        const error = await this.options.openInstaller(file);
        if (error) throw new Error('无法打开安装包，请重新下载或前往 GitHub Releases 安装。');
        this.publish({ ...this.state, message: '安装包已打开。请退出应用后完成安装，再重新启动。' });
        return { ok: true };
      } catch (error) { return this.error(error); }
    });
  }
  async stop() { this.controller?.abort(); await this.pending; }
}
