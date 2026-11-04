import type { AppState } from '../shared';
import { icon } from './icons';

document.querySelectorAll<HTMLElement>('[data-icon]').forEach(button => { button.innerHTML = icon(button.dataset.icon!); });
let latest: AppState | undefined;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
function render(state: AppState) {
  latest = state;
  if (state.testing) { const brand = document.querySelector('.brand span:nth-child(2)'); if (brand) brand.textContent = 'DeepSeek · 测试'; }
  document.documentElement.dataset.theme = state.settings.theme;
  document.documentElement.dataset.platform = state.platform;
  document.body.classList.toggle('has-error', state.loadState === 'error');
  const connection = document.getElementById('connection')!;
  connection.className = `connection ${state.loadState}`;
  connection.setAttribute('aria-label', state.loadState === 'ready' ? '已连接' : state.loadState === 'error' ? '连接失败' : '正在连接');
  if (state.loadState === 'error') {
    document.getElementById('error-title')!.textContent = '暂时无法连接 DeepSeek';
    document.getElementById('error-detail')!.textContent = state.error;
  }
  const mode = document.getElementById('mode');
  if (mode) {
    const label = state.mode === 'quick' ? '展开窗口' : '切换到快捷窗口';
    mode.innerHTML = icon(state.mode === 'quick' ? 'expand' : 'collapse');
    mode.setAttribute('aria-label', label); mode.setAttribute('title', `${label} ⌘⇧E`);
  }
  const pin = document.getElementById('pin');
  pin?.setAttribute('aria-pressed', String(state.settings.alwaysOnTop));
  const sidebar = document.getElementById('sidebar');
  if (sidebar) { sidebar.innerHTML = icon('sidebar'); const label = state.sidebarCollapsed ? '展开侧边栏' : '收起侧边栏'; sidebar.setAttribute('aria-label', label); sidebar.setAttribute('title', label); }
  if (!state.shortcutRegistered) {
    const notice = document.getElementById('notice')!;
    notice.textContent = '快捷键不可用'; notice.classList.add('warning'); notice.title = state.shortcutError;
  }
}
document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(button => button.addEventListener('click', () => { void window.wire.action(button.dataset.action!); }));
document.getElementById('notice')!.addEventListener('click', () => { if (latest && !latest.shortcutRegistered) void window.wire.action('settings'); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && document.body.dataset.surface === 'chat') void window.wire.action('hide'); });
window.wire.onState(render);
window.wire.onNotice(message => {
  clearTimeout(noticeTimer); const element = document.getElementById('notice')!; element.classList.remove('warning'); element.textContent = message; element.title = message;
  noticeTimer = setTimeout(() => { element.textContent = ''; if (latest) render(latest); }, 6000);
});
void window.wire.getState().then(render);
