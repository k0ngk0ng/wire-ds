export type WindowMode = 'quick' | 'full';
export type Theme = 'system' | 'light' | 'dark';
export interface UpdateState {
  status: 'idle' | 'checking' | 'current' | 'available' | 'downloading' | 'ready' | 'installing' | 'error';
  version: string;
  progress: number;
  message: string;
}
export interface SavedBounds { x?: number; y?: number; width: number; height: number }
export interface Settings {
  shortcut: string;
  theme: Theme;
  alwaysOnTop: boolean;
  launchAtLogin: boolean;
  summonBehavior: 'continue' | 'new';
  defaultMode: WindowMode;
  quickAutoSize: boolean;
  quickMaxHeightRatio: number;
  lastChatPath: string;
  quickBounds: SavedBounds;
  fullBounds: SavedBounds;
}
export interface AppState {
  settings: Settings;
  mode: WindowMode;
  host: 'chat' | 'login';
  loadState: 'loading' | 'ready' | 'error';
  error: string;
  shortcutRegistered: boolean;
  shortcutError: string;
  settingsWarning: string;
  sidebarCollapsed: boolean;
  version: string;
  packaged: boolean;
  testing: boolean;
  platform: string;
  update: UpdateState;
}
export interface Result { ok: boolean; message?: string }
export interface WireAPI {
  getState(): Promise<AppState>;
  action(action: string): Promise<Result>;
  updateSettings(patch: Partial<Settings>): Promise<Result>;
  onState(callback: (state: AppState) => void): () => void;
  onNotice(callback: (message: string) => void): () => void;
}
declare global { interface Window { wire: WireAPI } }
