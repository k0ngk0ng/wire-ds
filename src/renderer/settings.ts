import type { AppState, Settings } from '../shared';

const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const record = get<HTMLButtonElement>('record-shortcut');
let current: AppState;
let recording = false;
let candidate = '';
let dirty = false;
let saving = false;

function displayShortcut(shortcut: string) {
  return shortcut.replace(/CommandOrControl/g, '⌘').replace(/Command/g, '⌘').replace(/Control/g, '⌃').replace(/Alt|Option/g, '⌥').replace(/Shift/g, '⇧').replace(/\+/g, ' ');
}
function render(state: AppState) {
  current = state; document.documentElement.dataset.theme = state.settings.theme;
  document.documentElement.dataset.platform = state.platform;
  if (!recording && !dirty) get('shortcut-value').textContent = displayShortcut(state.settings.shortcut);
  get<HTMLSelectElement>('theme').value = state.settings.theme;
  get<HTMLSelectElement>('summon').value = state.settings.summonBehavior;
  get<HTMLSelectElement>('default-mode').value = state.settings.defaultMode;
  get<HTMLInputElement>('always-on-top').checked = state.settings.alwaysOnTop;
  get<HTMLInputElement>('auto-size').checked = state.settings.quickAutoSize;
  get<HTMLSelectElement>('max-height').value = String(state.settings.quickMaxHeightRatio);
  get<HTMLSelectElement>('max-height').disabled = !state.settings.quickAutoSize;
  get<HTMLInputElement>('launch-at-login').checked = state.settings.launchAtLogin;
  get<HTMLInputElement>('launch-at-login').disabled = !state.packaged;
  get('launch-note').hidden = state.packaged;
  get('shortcut-warning').hidden = state.shortcutRegistered && !state.settingsWarning;
  get('shortcut-warning').textContent = state.shortcutError || state.settingsWarning;
  get('version').textContent = `版本 ${state.version}`;
  const update = state.update;
  const busy = update.status === 'checking' || update.status === 'downloading';
  get<HTMLButtonElement>('check-update').disabled = busy;
  get('update-status').textContent = update.message;
  get('update-status').dataset.status = update.status;
  const updateAction = get<HTMLButtonElement>('update-action');
  updateAction.hidden = !['available', 'ready', 'downloading'].includes(update.status);
  updateAction.disabled = busy;
  updateAction.textContent = update.status === 'ready' ? '打开安装包' : update.status === 'downloading' ? '正在下载…' : '下载更新';
  get<HTMLProgressElement>('update-progress').hidden = update.status !== 'downloading';
  get<HTMLProgressElement>('update-progress').value = update.progress;
}
function feedback(message: string, error = false) {
  get('settings-error').hidden = !error; get('settings-error').textContent = error ? message : '';
  get('settings-status').textContent = error ? '' : message;
}
function stopRecording() {
  recording = false; record.classList.remove('recording');
  get('shortcut-help').textContent = dirty ? '保存后立即生效' : '点击右侧按键，录制新的快捷键';
}
record.addEventListener('click', () => {
  if (saving) return;
  recording = true; record.classList.add('recording'); get('shortcut-value').textContent = '请按快捷键';
  get('shortcut-help').textContent = '支持功能键或组合键，Esc 取消';
  get('cancel-shortcut').hidden = false; feedback('');
});
document.addEventListener('keydown', event => {
  if (!recording) return;
  event.preventDefault(); event.stopPropagation();
  if (event.key === 'Escape') { dirty = false; stopRecording(); get('save-shortcut').hidden = true; get('cancel-shortcut').hidden = true; render(current); return; }
  if (['Meta', 'Control', 'Alt', 'Shift', 'Fn'].includes(event.key)) return;
  const keyMap: Record<string, string> = { Space: 'Space', Enter: 'Enter', Tab: 'Tab', Backspace: 'Backspace', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' };
  const key = /^F\d+$/.test(event.key) ? event.key : /^Key[A-Z]$/.test(event.code) ? event.code.slice(3) : /^Digit\d$/.test(event.code) ? event.code.slice(5) : keyMap[event.code];
  if (!key || (!/^F\d+$/.test(key) && !event.metaKey && !event.ctrlKey && !event.altKey)) { feedback('请使用功能键，或搭配 ⌘、⌃、⌥ 的组合键。', true); return; }
  candidate = [event.metaKey ? 'Command' : '', event.ctrlKey ? 'Control' : '', event.altKey ? 'Alt' : '', event.shiftKey ? 'Shift' : '', key].filter(Boolean).join('+');
  dirty = true; stopRecording(); get('shortcut-value').textContent = displayShortcut(candidate);
  get('save-shortcut').hidden = false; get('cancel-shortcut').hidden = false; feedback('');
}, true);
get('cancel-shortcut').addEventListener('click', () => { dirty = false; stopRecording(); get('save-shortcut').hidden = true; get('cancel-shortcut').hidden = true; render(current); });
get('save-shortcut').addEventListener('click', async () => {
  if (!candidate || saving) return;
  saving = true; get<HTMLButtonElement>('save-shortcut').disabled = true;
  try {
    const result = await window.wire.updateSettings({ shortcut: candidate });
    feedback(result.message || '', !result.ok);
    if (result.ok) { dirty = false; get('save-shortcut').hidden = true; get('cancel-shortcut').hidden = true; }
  } catch { feedback('无法保存快捷键，请重试。', true); }
  finally { saving = false; get<HTMLButtonElement>('save-shortcut').disabled = false; }
});
const controls: [string, keyof Settings, boolean?][] = [ ['theme', 'theme'], ['summon', 'summonBehavior'], ['default-mode', 'defaultMode'], ['always-on-top', 'alwaysOnTop', true], ['launch-at-login', 'launchAtLogin', true], ['auto-size', 'quickAutoSize', true], ['max-height', 'quickMaxHeightRatio'] ];
for (const [id, key, boolean] of controls) {
  get(id).addEventListener('change', async () => {
    const input = get<HTMLInputElement | HTMLSelectElement>(id);
    const value = boolean ? (input as HTMLInputElement).checked : key === 'quickMaxHeightRatio' ? Number(input.value) : input.value;
    try { const result = await window.wire.updateSettings({ [key]: value }); feedback(result.message || '', !result.ok); if (!result.ok) render(current); }
    catch { feedback('无法保存设置，请重试。', true); render(current); }
  });
}
document.querySelectorAll<HTMLElement>('[data-action]').forEach(el => el.addEventListener('click', () => { void window.wire.action(el.dataset.action!); }));
get('check-update').addEventListener('click', () => { void window.wire.action('check-update'); });
get('update-action').addEventListener('click', () => { void window.wire.action(current.update.status === 'ready' ? 'install-update' : 'download-update'); });
window.wire.onState(render); void window.wire.getState().then(render);
