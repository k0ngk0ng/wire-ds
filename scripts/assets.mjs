import { Resvg } from '@resvg/resvg-js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const brand = await readFile('assets/deepseek.svg', 'utf8');
// The original DeepSeek mark is used intact, with a macOS icon background.
const inner = brand.replace(/<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><rect x="52" y="52" width="920" height="920" rx="220" fill="#ffffff"/><svg x="165" y="165" width="694" height="694" viewBox="0 0 50 50">${inner}</svg></svg>`;
const png = width => new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng();
await writeFile('assets/icon.png', png(1024));
const icoPNG = Buffer.from(png(256));
const icoHeader = Buffer.alloc(22);
icoHeader.writeUInt16LE(1, 2); icoHeader.writeUInt16LE(1, 4);
icoHeader[6] = 0; icoHeader[7] = 0;
icoHeader.writeUInt16LE(1, 10); icoHeader.writeUInt16LE(32, 12);
icoHeader.writeUInt32LE(icoPNG.length, 14); icoHeader.writeUInt32LE(22, 18);
await writeFile('assets/icon.ico', Buffer.concat([icoHeader, icoPNG]));
await mkdir('.cache/ChatDeepSeek.iconset', { recursive: true });
for (const size of [16, 32, 128, 256, 512]) {
  await writeFile(`.cache/ChatDeepSeek.iconset/icon_${size}x${size}.png`, png(size));
  await writeFile(`.cache/ChatDeepSeek.iconset/icon_${size}x${size}@2x.png`, png(size * 2));
}
if (process.platform === 'darwin') execFileSync('iconutil', ['-c', 'icns', '.cache/ChatDeepSeek.iconset', '-o', 'assets/icon.icns']);
const tray = brand.replace(/fill="#[0-9a-f]{6}"/gi, 'fill="#000000"').replace(/fill="rgb\([^)]+\)"/g, 'fill="#000000"');
for (const [size, suffix] of [[18, ''], [36, '@2x']]) await writeFile(`assets/trayTemplate${suffix}.png`, new Resvg(tray, { fitTo: { mode: 'width', value: size } }).render().asPng());
