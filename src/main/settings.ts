import fs from 'node:fs';
import path from 'node:path';
import type { Settings, SavedBounds } from '../shared';

export const defaultSettings = (): Settings => ({
  shortcut: process.env.WIRE_DS_TEST === '1' ? (process.env.WIRE_DS_TEST_SHORTCUT || 'F2') : 'F2',
  theme: 'system', alwaysOnTop: false, launchAtLogin: false,
  summonBehavior: 'continue', defaultMode: 'quick',
  quickAutoSize: true, quickMaxHeightRatio: .8,
  lastChatPath: '',
  quickBounds: { width: 740, height: 360 }, fullBounds: { width: 1180, height: 800 },
});

function bounds(value: unknown, fallback: SavedBounds): SavedBounds {
  if (!value || typeof value !== 'object') return fallback;
  const b = value as SavedBounds;
  if (!Number.isFinite(b.width) || !Number.isFinite(b.height)) return fallback;
  return {
    width: Math.max(460, Math.min(4000, b.width)), height: Math.max(360, Math.min(2400, b.height)),
    ...(Number.isFinite(b.x) && Number.isFinite(b.y) ? { x: b.x, y: b.y } : {}),
  };
}

export function sanitizeSettings(value: unknown): Settings {
  const d = defaultSettings();
  const v = value && typeof value === 'object' ? value as Partial<Settings> : {};
  return {
    shortcut: typeof v.shortcut === 'string' && v.shortcut.length <= 90 && v.shortcut.length > 0 ? v.shortcut : d.shortcut,
    theme: ['system', 'light', 'dark'].includes(v.theme || '') ? v.theme! : d.theme,
    alwaysOnTop: typeof v.alwaysOnTop === 'boolean' ? v.alwaysOnTop : d.alwaysOnTop,
    launchAtLogin: typeof v.launchAtLogin === 'boolean' ? v.launchAtLogin : d.launchAtLogin,
    summonBehavior: v.summonBehavior === 'new' ? 'new' : 'continue',
    defaultMode: v.defaultMode === 'full' ? 'full' : 'quick',
    quickAutoSize: typeof v.quickAutoSize === 'boolean' ? v.quickAutoSize : true,
    quickMaxHeightRatio: [.6, .8, .9].includes(v.quickMaxHeightRatio || 0) ? v.quickMaxHeightRatio! : .8,
    lastChatPath: typeof v.lastChatPath === 'string' && /^\/a\/chat\/s\/[a-z0-9-]+$/i.test(v.lastChatPath) ? v.lastChatPath : '',
    quickBounds: bounds(v.quickBounds, d.quickBounds), fullBounds: bounds(v.fullBounds, d.fullBounds),
  };
}

export class SettingsStore {
  value: Settings;
  warning = '';
  private file: string;
  constructor(directory: string) {
    fs.mkdirSync(directory, { recursive: true });
    this.file = path.join(directory, 'settings.json');
    this.value = defaultSettings();
    if (fs.existsSync(this.file)) {
      try { this.value = sanitizeSettings(JSON.parse(fs.readFileSync(this.file, 'utf8'))); }
      catch {
        this.warning = '设置文件损坏，已恢复默认设置。原文件已保留。';
        fs.renameSync(this.file, path.join(directory, `settings.invalid-${Date.now()}.json`));
      }
    }
    this.save(this.value);
  }
  save(next: Settings) {
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temporary, this.file);
    this.value = next;
  }
}
