import http from 'node:http';
import { createHash } from 'node:crypto';

export async function startUpdateFixture(currentVersion: string) {
  let mode = 'available';
  let checks = 0;
  const downloads: string[] = [];
  const installer = Buffer.alloc(256 * 1024, 'ChatDeepSeek installer fixture');
  const digest = `sha256:${createHash('sha256').update(installer).digest('hex')}`;
  let url = '';
  const server = http.createServer((req, res) => {
    if (req.url === '/latest') {
      checks++;
      if (mode === 'offline' || mode === 'limited') { res.writeHead(mode === 'limited' ? 403 : 503); res.end(); return; }
      if (mode === 'invalid-json') { res.end('{invalid'); return; }
      const version = mode === 'current' ? currentVersion : mode === 'older' ? '0.9.9' : '9.10.0';
      const assets = [['arm64', 'dmg'], ['x64', 'dmg'], ['x64', 'exe']].map(([arch, extension]) => {
        const name = `ChatDeepSeek-${version}-${arch}.${extension}`;
        return { name, browser_download_url: `${mode === 'untrusted' ? 'https://example.com' : url}/releases/download/v${version}/${name}`, size: installer.length, digest: mode === 'missing-digest' ? null : mode === 'corrupted' ? `sha256:${'0'.repeat(64)}` : digest };
      });
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ tag_name: mode === 'invalid-version' ? 'latest' : `v${version}`, draft: mode === 'draft', prerelease: mode === 'prerelease', assets: mode === 'missing-asset' ? [] : assets }));
      return;
    }
    if (req.url?.startsWith('/releases/download/')) {
      downloads.push(req.url);
      if (mode === 'download-error') { res.writeHead(500); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': installer.length });
      let offset = 0;
      const timer = setInterval(() => {
        if (mode === 'interrupted' && offset) { res.destroy(); return; }
        const end = Math.min(offset + 32 * 1024, installer.length);
        res.write(installer.subarray(offset, end)); offset = end;
        if (offset === installer.length) res.end();
      }, 80);
      res.on('close', () => clearInterval(timer));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  return {
    url, installer,
    setMode(value: string) { mode = value; },
    reset() { mode = 'available'; checks = 0; downloads.length = 0; },
    state: () => ({ checks, downloads: [...downloads] }),
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
