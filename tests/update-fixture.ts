import http from 'node:http';
import { createHash } from 'node:crypto';

export async function startUpdateFixture(currentVersion: string) {
  let mode = 'available';
  let checks = 0;
  const downloads: string[] = [];
  const requests: { method: string; url: string; apiHeaders: boolean }[] = [];
  const installer = Buffer.alloc(256 * 1024, 'ChatDeepSeek installer fixture');
  const digest = createHash('sha256').update(installer).digest('hex');
  let url = '';
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method!, url: req.url!, apiHeaders: Boolean(req.headers['x-github-api-version'] || req.headers.accept?.includes('vnd.github')) });
    const version = mode === 'current' || mode === 'draft' || mode === 'prerelease' ? currentVersion : mode === 'older' ? '0.9.9' : '9.10.0';
    if (req.url === '/releases/latest') {
      checks++;
      if (['offline', 'limited', 'rate-limited'].includes(mode)) { res.writeHead(mode === 'limited' ? 403 : mode === 'rate-limited' ? 429 : 503); res.end(); return; }
      if (mode === 'invalid-response') { res.end(); return; }
      const source = mode === 'untrusted' ? 'https://example.com' : url;
      res.writeHead(302, { Location: `${source}/releases/tag/${mode === 'invalid-version' ? 'latest' : `v${version}`}${mode === 'invalid-query' ? '?tag=1' : ''}` });
      res.end();
      return;
    }
    if (req.url?.startsWith('/releases/tag/')) { res.end('<html>Public release</html>'); return; }
    if (/\/SHA256SUMS-(?:mac|win)-(?:arm64|x64)\.txt$/.test(req.url || '')) {
      if (mode === 'missing-digest') { res.writeHead(404); res.end(); return; }
      const entries = [['arm64', 'zip'], ['x64', 'zip'], ['x64', 'exe']].map(([arch, extension]) => `${mode === 'corrupted' ? '0'.repeat(64) : digest}  ChatDeepSeek-${version}-${arch}.${extension}`);
      const content = mode === 'invalid-checksum' ? 'invalid' : mode === 'wrong-file' ? `${digest}  other.zip` : mode === 'duplicate-checksum' ? [...entries, ...entries].join('\n') : mode === 'oversized-checksum' ? 'x'.repeat(65537) : entries.join('\r\n') + '\r\n';
      res.setHeader('Content-Type', 'text/plain');
      res.end(content);
      return;
    }
    if (req.url?.startsWith('/releases/download/')) {
      if (req.method === 'HEAD') {
        if (mode === 'missing-asset') { res.writeHead(404); res.end(); return; }
        if (mode !== 'missing-size') res.setHeader('Content-Length', mode === 'oversized-asset' ? 1024 ** 3 + 1 : mode === 'empty-asset' ? 0 : installer.length);
        res.end();
        return;
      }
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
    reset() { mode = 'available'; checks = 0; downloads.length = 0; requests.length = 0; },
    state: () => ({ checks, downloads: [...downloads], requests: [...requests] }),
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}
